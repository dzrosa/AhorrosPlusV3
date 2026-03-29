const http = require('http');
const url  = require('url');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const CLIENT_ID     = process.env.MELI_CLIENT_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN;
const AFFILIATE_TAG = 'laisa9320492524395';

let cachedToken = null;
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
        cachedToken = data.access_token;
        tokenExpiry  = Date.now() + (data.expires_in - 300) * 1000;
    }
    return data.access_token || null;
}

// Busca IDs via /sites/MLA/search (puede dar 403),
// si falla usa /highlights + búsqueda por keyword en catálogo
async function buscarIds(q, token) {
    // Intento 1: search directo (a veces funciona con user token)
    const r1 = await fetch(
        `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10&sort=price_asc&condition=new`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (r1.status === 200) {
        const body = await r1.json();
        if (body.results?.length > 0) {
            console.log('✅ Search directo funcionó');
            return { source: 'search', items: body.results };
        }
    }
    console.log('⚠️ Search directo bloqueado, usando catálogo...');

    // Intento 2: product search (catálogo) — este sí funciona desde servidores
    const r2 = await fetch(
        `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=20&sort=price_asc`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-Format-New': 'true' } }
    );
    if (r2.status === 200) {
        const body = await r2.json();
        if (body.results?.length > 0) {
            console.log('✅ Catálogo funcionó');
            return { source: 'search', items: body.results };
        }
    }

    // Intento 3: products/search (catálogo de productos, no listings)
    const r3 = await fetch(
        `https://api.mercadolibre.com/sites/MLA/products/search?q=${encodeURIComponent(q)}&limit=10`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (r3.status === 200) {
        const body = await r3.json();
        if (body.results?.length > 0) {
            console.log('✅ Products/search funcionó, buscando listings...');
            // Para cada producto del catálogo, buscamos el listing más barato
            const ids = body.results.slice(0, 8).map(p => p.id);
            const listings = await Promise.all(ids.map(id =>
                fetch(`https://api.mercadolibre.com/products/${id}/items?limit=3&sort=price_asc`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                }).then(r => r.json()).catch(() => null)
            ));

            const items = [];
            for (let i = 0; i < body.results.length; i++) {
                const prod = body.results[i];
                const listing = listings[i]?.results?.[0];
                if (listing?.price) {
                    items.push({
                        id: listing.id,
                        title: prod.name,
                        price: listing.price,
                        thumbnail: prod.pictures?.[0]?.url || listing.thumbnail,
                        permalink: listing.permalink,
                        shipping: listing.shipping,
                        seller: listing.seller,
                        condition: listing.condition,
                    });
                }
                if (items.length >= 5) break;
            }
            if (items.length > 0) return { source: 'catalog', items };
        }
    }

    return { source: 'none', items: [] };
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

    if (path === '/api/buscar') {
        const q = params.q;
        if (!q) { res.end('[]'); return; }

        try {
            const token = await getToken();
            if (!token) {
                res.statusCode = 401;
                res.end(JSON.stringify({ error: 'No se pudo obtener token' }));
                return;
            }

            const { source, items } = await buscarIds(q, token);

            if (!items.length) {
                res.end(JSON.stringify({ error: 'sin_resultados', source }));
                return;
            }

            // Filtramos vendedores con buena reputación cuando hay info
            const filtrados = items.filter(p => {
                const rep = p.seller?.seller_reputation?.level_id;
                if (!rep) return true;
                return ['5_green', '4_light_green'].includes(rep);
            });
            const lista = filtrados.length >= 3 ? filtrados : items;

            const productos = lista.slice(0, 5).map(p => ({
                title:     p.title || 'Sin título',
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

    // Endpoint de diagnóstico
    if (path === '/api/test') {
        try {
            const token = await getToken();
            const tests = await Promise.all([
                fetch(`https://api.mercadolibre.com/sites/MLA/search?q=termo&limit=1`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status),
                fetch(`https://api.mercadolibre.com/sites/MLA/products/search?q=termo&limit=1`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status),
                fetch(`https://api.mercadolibre.com/users/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.status),
            ]);
            res.end(JSON.stringify({ token_ok: !!token, search: tests[0], products_search: tests[1], users_me: tests[2] }));
        } catch(e) {
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
