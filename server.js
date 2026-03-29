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

    // Paso 1: domain_discovery → obtenemos category_id (funciona ✅)
    const catR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=5`,
        { headers }
    );

    if (catR.status !== 200) {
        console.error('domain_discovery falló:', catR.status);
        return { source: 'none', items: [] };
    }

    const cats = await catR.json();
    console.log('Categorías encontradas:', cats.map(c => `${c.category_id}:${c.domain_id}`).join(', '));

    // Probamos todas las categorías devueltas hasta encontrar resultados
    for (const cat of cats) {
        const catId = cat.category_id;
        if (!catId) continue;

        // Paso 2A: search por categoría + keyword
        const r1 = await fetch(
            `https://api.mercadolibre.com/sites/MLA/search?category=${catId}&q=${encodeURIComponent(q)}&limit=20&sort=price_asc&condition=new`,
            { headers }
        );
        console.log(`search cat ${catId} + q:`, r1.status);
        if (r1.status === 200) {
            const body = await r1.json();
            if (body.results?.length > 0) {
                console.log('✅ Encontrado con cat+q:', body.results.length, 'items');
                return { source: 'cat_q', items: body.results };
            }
        }

        // Paso 2B: search solo por categoría sin keyword
        const r2 = await fetch(
            `https://api.mercadolibre.com/sites/MLA/search?category=${catId}&limit=20&sort=price_asc&condition=new`,
            { headers }
        );
        console.log(`search cat ${catId} solo:`, r2.status);
        if (r2.status === 200) {
            const body = await r2.json();
            if (body.results?.length > 0) {
                console.log('✅ Encontrado con cat sola:', body.results.length, 'items');
                return { source: 'cat_only', items: body.results };
            }
        }
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

    // Diagnóstico extendido
    if (path === '/api/test') {
        try {
            const token  = await getToken();
            const userId = await getUserId(token);
            const h = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };

            // Probamos domain_discovery y el search con la categoría que devuelve
            const discR = await fetch('https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=termo&limit=1', { headers: h });
            const discStatus = discR.status;
            let catTest = null;
            if (discStatus === 200) {
                const disc = await discR.json();
                const catId = disc?.[0]?.category_id;
                if (catId) {
                    const searchR = await fetch(`https://api.mercadolibre.com/sites/MLA/search?category=${catId}&q=termo&limit=1&sort=price_asc`, { headers: h });
                    catTest = { category_id: catId, status: searchR.status };
                }
            }

            res.end(JSON.stringify({
                token_ok: !!token,
                user_id:  userId,
                domain_discovery: discStatus,
                cat_search_test:  catTest,
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

            if (!items.length) {
                res.end(JSON.stringify({ error: 'sin_resultados', source }));
                return;
            }

            // Filtro de reputación — si no hay suficientes con buena rep, mostramos todos
            const buenos = items.filter(p => {
                const rep = p.seller?.seller_reputation?.level_id;
                return !rep || ['5_green', '4_light_green'].includes(rep);
            });
            const lista = buenos.length >= 3 ? buenos : items;

            const productos = lista.slice(0, 5).map(p => ({
                title:     p.title || p.name || 'Sin título',
                price:     p.price || null,
                thumbnail: (p.thumbnail || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
                permalink: addAffiliateTag(p.permalink),
                shipping:  { free_shipping: p.shipping?.free_shipping ?? false },
                condition: p.condition,
                source,
            }));

            res.end(JSON.stringify(productos));
        } catch(e) {
            console.error('Error:', e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
