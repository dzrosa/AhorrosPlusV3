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

// Prueba un endpoint y devuelve { status, body_sample }
async function probe(ep, headers) {
    try {
        const r = await fetch(ep, { headers });
        let body = null;
        try { body = await r.json(); } catch {}
        return {
            status: r.status,
            keys:   body ? Object.keys(body).slice(0, 8) : [],
            sample: body ? JSON.stringify(body).substring(0, 200) : null,
        };
    } catch(e) {
        return { status: 'ERR', error: e.message };
    }
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const path   = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (path === '/' || path === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        try { res.end(fs.readFileSync('./index.html')); }
        catch { res.end('<h1>index.html no encontrado</h1>'); }
        return;
    }

    res.setHeader('Content-Type', 'application/json');

    // Mapeo completo de endpoints alternativos
    if (path === '/api/scan') {
        try {
            const token = await getToken();
            const h = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };
            const CAT = 'MLA47769'; // Termos - de domain_discovery

            const results = {
                // Endpoints de items directos
                highlights_cat:     await probe(`https://api.mercadolibre.com/highlights/MLA/category/${CAT}`, h),
                highlights_general: await probe(`https://api.mercadolibre.com/highlights/MLA`, h),
                // Items de una categoría
                category_items:     await probe(`https://api.mercadolibre.com/categories/${CAT}/items?limit=5`, h),
                // Trends
                trends:             await probe(`https://api.mercadolibre.com/trends/MLA`, h),
                trends_cat:         await probe(`https://api.mercadolibre.com/trends/MLA/${CAT}`, h),
                // Visits / top items
                top_items:          await probe(`https://api.mercadolibre.com/sites/MLA/items/visits?date_from=2024-01-01&category=${CAT}&limit=5`, h),
                // Promotions
                promotions:         await probe(`https://api.mercadolibre.com/sites/MLA/promotions?type=discount&category=${CAT}`, h),
                // Item directo de ejemplo (sabemos que MLA se puede leer)
                item_direct:        await probe(`https://api.mercadolibre.com/items/MLA1400594269`, h),
                // Multiget de items conocidos de la categoría
                items_multiget:     await probe(`https://api.mercadolibre.com/items?ids=MLA1400594269,MLA1500594270&attributes=id,title,price,permalink,thumbnail`, h),
            };

            res.end(JSON.stringify(results, null, 2));
        } catch(e) {
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
