const http = require('http');
const url  = require('url');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const CLIENT_ID     = process.env.MELI_CLIENT_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN;
const AFFILIATE_TAG = 'laisa9320492524395';

let cachedToken  = null;
let cachedUserId = null;
let tokenExpiry  = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'refresh_token',
            client_id:     CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: REFRESH_TOKEN,
        })
    });
    const data = await r.json();
    if (data.access_token) {
        cachedToken  = data.access_token;
        cachedUserId = data.user_id;
        tokenExpiry  = Date.now() + (data.expires_in - 300) * 1000;
    }
    return data.access_token || null;
}

async function getUserId(token) {
    if (cachedUserId) return cachedUserId;
    const r = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    cachedUserId = d.id;
    return d.id;
}

function addAffiliateTag(permalink) {
    if (!permalink) return permalink;
    try {
        const u = new URL(permalink);
        u.searchParams.set('matt_tool', AFFILIATE_TAG);
        return u.toString();
    } catch {
        return permalink + (permalink.includes('?') ? '&' : '?') + `matt_tool=${AFFILIATE_TAG}`;
    }
}

async function buscar(q, token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'MercadoLibre/iOS 10.171.0',
    };

    // Estrategia A: search directo
    for (const ep of [
        `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10&sort=price_asc&condition=new`,
        `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10`,
    ]) {
        const r = await fetch(ep, { headers });
        if (r.status === 200) {
            const body = await r.json();
            if (body.results?.length > 0) return { source: 'A', items: body.results };
        }
        console.log('A falló:', r.status);
    }

    // Estrategia B: domain_discovery → search por categoría
    const catR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=3`,
        { headers }
    );
    console.log('domain_discovery:', catR.status);
    if (catR.status === 200) {
        const cats = await catR.json();
        const catId = cats?.[0]?.category_id;
        if (catId) {
            const itemsR = await fetch(
                `https://api.mercadolibre.com/sites/MLA/search?category=${catId}&q=${encodeURIComponent(q)}&limit=10&sort=price_asc`,
                { headers }
            );
            if (itemsR.status === 200) {
                const body = await itemsR.json();
                if (body.results?.length > 0) return { source: 'B', items: body.results };
            }
            console.log('B falló:', itemsR.status);
        }
    }

    // Estrategia C: /sites/MLA/products
    const prodR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/products?status=active&q=${encodeURIComponent(q)}&limit=10`,
        { headers }
    );
    console.log('products:', prodR.status);
    if (prodR.status === 200) {
        const body = await prodR.json();
        if (body.results?.length > 0) return { source: 'C', items: body.results };
    }

    return { source: 'none', items: [] };
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const path   = parsed.pathname;
    const params = parsed.query;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (path === '/' || path === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        try { res.end(fs.readFileSync('./index.html')); }
        catch { res.end('<h1>index.html no encontrado</h1>'); }
        return;
    }

    res.setHeader('Content-Type', 'application/json');

    if (path === '/api/test') {
        try {
            const token  = await getToken();
            const userId = await getUserId(token);
            const check  = async (ep) => fetch(ep, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' } }).then(r => r.status);
            res.end(JSON.stringify({
                token_ok:         !!token,
                user_id:          userId,
                search:           await check('https://api.mercadolibre.com/sites/MLA/search?q=termo&limit=1'),
                domain_discovery: await check('https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=termo&limit=1'),
                products:         await check('https://api.mercadolibre.com/sites/MLA/products?status=active&q=termo&limit=1'),
                users_me:         await check('https://api.mercadolibre.com/users/me'),
            }));
        } catch(e) { res.end(JSON.stringify({ error: e.message })); }
        return;
    }

    if (path === '/api/buscar') {
        const q = params.q;
        if (!q) { res.end('[]'); return; }
        try {
            const token = await getToken();
            if (!token) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Token fallido' })); return; }

            const { source, items } = await buscar(q, token);
            if (!items.length) { res.end(JSON.stringify({ error: 'sin_resultados', source })); return; }

            const filtrados = items.filter(p => {
                const rep = p.seller?.seller_reputation?.level_id;
                return !rep || ['5_green', '4_light_green'].includes(rep);
            });
            const lista = filtrados.length >= 3 ? filtrados : items;

            const productos = lista.slice(0, 5).map(p => ({
                title:     p.title || p.name || 'Sin título',
                price:     p.price || p.buy_box_winner?.price || null,
                thumbnail: (p.thumbnail || p.pictures?.[0]?.url || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
                permalink: addAffiliateTag(p.permalink),
                shipping:  { free_shipping: p.shipping?.free_shipping ?? false },
                source,
            }));

            res.end(JSON.stringify(productos));
        } catch(e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
