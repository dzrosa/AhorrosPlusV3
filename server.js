const http = require('http');
const url  = require('url');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const CLIENT_ID     = process.env.MELI_CLIENT_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN;
const AFFILIATE_TAG = 'laisa9320492524395';

let cachedToken = null;
let tokenExpiry = 0;

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
        tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    }
    return data.access_token || null;
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
    res.setHeader('Content-Type', 'application/json');

    if (path === '/api/debug') {
        // Muestra el flujo completo paso a paso para diagnosticar
        try {
            const token = await getToken();
            const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };
            const CAT = 'MLA47769';

            // Paso 1: raw de highlights
            const hlR = await fetch(`https://api.mercadolibre.com/highlights/MLA/category/${CAT}`, { headers });
            const hl  = await hlR.json();

            // Los primeros 5 items del content
            const content5 = (hl.content || []).slice(0, 5);
            const ids = content5.map(x => x.id);

            // Paso 2: multiget con esos IDs tal cual
            const mgR = await fetch(
                `https://api.mercadolibre.com/items?ids=${ids.join(',')}&attributes=id,title,price,permalink,thumbnail`,
                { headers }
            );
            const mg = await mgR.json();

            // Paso 3: probar endpoint de productos con esos IDs
            const prodR = await fetch(
                `https://api.mercadolibre.com/products/${ids[0]}?attributes=id,name,pictures,buy_box_winner`,
                { headers }
            );
            const prod = await prodR.json();

            res.end(JSON.stringify({
                highlights_status: hlR.status,
                content_sample:    content5,
                ids_probados:      ids,
                multiget_status:   mgR.status,
                multiget_result:   mg,
                producto_directo_status: prodR.status,
                producto_directo_sample: { id: prod.id, name: prod.name, buy_box: prod.buy_box_winner },
            }, null, 2));

        } catch(e) {
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (path === '/api/buscar') {
        const q = params.q;
        if (!q) { res.end('[]'); return; }
        try {
            const token = await getToken();
            if (!token) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Token fallido' })); return; }

            const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };

            // domain_discovery → category_id
            const discR = await fetch(
                `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=3`,
                { headers }
            );
            const cats  = await discR.json();
            const catId = cats?.[0]?.category_id;
            if (!catId) { res.end('[]'); return; }

            // highlights → IDs
            const hlR  = await fetch(`https://api.mercadolibre.com/highlights/MLA/category/${catId}`, { headers });
            const hl   = await hlR.json();
            const content = (hl.content || []).slice(0, 12);
            const ids  = content.map(x => x.id);
            if (!ids.length) { res.end('[]'); return; }

            // Para cada ID, intentamos como ITEM primero, luego como PRODUCT
            // IDs de tipo PRODUCT necesitan ir a /products/{id}, no a /items
            const itemIds    = ids.filter(id => /^MLA\d{10,}$/.test(id));  // IDs largos = items
            const productIds = ids.filter(id => /^MLA\d{1,9}$/.test(id));  // IDs cortos = products

            let items = [];

            // Multiget de items reales
            if (itemIds.length > 0) {
                const ATTRS = 'id,title,price,thumbnail,permalink,shipping,seller,condition';
                const mgR = await fetch(
                    `https://api.mercadolibre.com/items?ids=${itemIds.slice(0,10).join(',')}&attributes=${ATTRS}`,
                    { headers }
                );
                const mg = await mgR.json();
                items = mg.filter(r => r.code === 200 && r.body?.price).map(r => r.body);
            }

            // Si son product IDs, buscar listings vía /products/{id}/items
            if (items.length < 3 && productIds.length > 0) {
                const prodItems = await Promise.all(
                    productIds.slice(0, 6).map(async pid => {
                        const r = await fetch(
                            `https://api.mercadolibre.com/products/${pid}/items?limit=1&sort=price_asc`,
                            { headers }
                        );
                        if (r.status !== 200) return null;
                        const d = await r.json();
                        return d.results?.[0] || null;
                    })
                );
                const extras = prodItems.filter(Boolean).filter(p => p.price);
                items = [...items, ...extras];
            }

            if (!items.length) { res.end('[]'); return; }

            const buenos = items.filter(p => {
                const rep = p.seller?.seller_reputation?.level_id;
                return !rep || ['5_green', '4_light_green'].includes(rep);
            });
            const lista = buenos.length >= 3 ? buenos : items;

            const productos = lista.slice(0, 5).map(p => ({
                title:     p.title,
                price:     p.price,
                thumbnail: (p.thumbnail || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
                permalink: addAffiliateTag(p.permalink),
                shipping:  { free_shipping: p.shipping?.free_shipping ?? false },
                condition: p.condition,
            }));

            res.end(JSON.stringify(productos));
        } catch(e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (path === '/' || path === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        try { res.end(fs.readFileSync('./index.html')); }
        catch { res.end('<h1>index.html no encontrado</h1>'); }
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
