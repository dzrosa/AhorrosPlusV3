const http = require('http');
const url  = require('url');
const fs   = require('fs');

const PORT          = process.env.PORT || 3000;
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

function buildAffiliateLink(pid, listingPermalink) {
    const base = listingPermalink || `https://www.mercadolibre.com.ar/p/${pid}`;
    try {
        const u = new URL(base);
        u.searchParams.set('matt_tool', AFFILIATE_TAG);
        return u.toString();
    } catch {
        return `https://www.mercadolibre.com.ar/p/${pid}?matt_tool=${AFFILIATE_TAG}`;
    }
}

async function getListingForProduct(pid, headers) {
    const [prodR, itemsR] = await Promise.all([
        fetch(`https://api.mercadolibre.com/products/${pid}?attributes=id,name,pictures,buy_box_winner`, { headers }),
        fetch(`https://api.mercadolibre.com/products/${pid}/items?limit=5&sort=price_asc&condition=new`, { headers }),
    ]);
    if (prodR.status !== 200) return null;
    const prod = await prodR.json();
    const name = prod.name || '';
    const img  = (prod.pictures?.[0]?.url || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg');

    if (itemsR.status === 200) {
        const data = await itemsR.json();
        const results = data.results || [];
        const buenos = results.filter(p => {
            const rep = p.seller?.seller_reputation?.level_id;
            return !rep || ['5_green', '4_light_green'].includes(rep);
        });
        const listing = (buenos.length > 0 ? buenos : results)[0];
        if (listing?.price) {
            return {
                title:     name || listing.title,
                price:     listing.price,
                thumbnail: img || (listing.thumbnail || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
                permalink: buildAffiliateLink(pid, listing.permalink),
                shipping:  { free_shipping: listing.shipping?.free_shipping ?? false },
                condition: listing.condition || 'new',
            };
        }
    }
    const bb = prod.buy_box_winner;
    if (bb?.price) {
        return {
            title:     name,
            price:     bb.price,
            thumbnail: img,
            permalink: buildAffiliateLink(pid, null),
            shipping:  { free_shipping: bb.free_shipping ?? false },
            condition: 'new',
        };
    }
    return null;
}

async function getHighlightIds(catId, headers) {
    const r = await fetch(`https://api.mercadolibre.com/highlights/MLA/category/${catId}`, { headers });
    if (r.status !== 200) return [];
    const hl = await r.json();
    return (hl.content || []).map(x => x.id);
}

async function buscar(q, token) {
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };

    // domain_discovery — pedimos hasta 5 categorías
    const discR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=5`,
        { headers }
    );
    if (discR.status !== 200) return [];
    const cats = await discR.json();
    if (!cats.length) return [];

    // Traemos highlights de todas las categorías en paralelo
    const allHighlights = await Promise.all(
        cats.map(c => getHighlightIds(c.category_id, headers))
    );

    // Unimos IDs sin duplicados
    const seen = new Set();
    const ids  = [];
    for (const lote of allHighlights) {
        for (const id of lote) {
            if (!seen.has(id)) { seen.add(id); ids.push(id); }
        }
    }

    console.log(`"${q}": ${cats.length} categorías, ${ids.length} IDs únicos`);
    if (!ids.length) return [];

    // Procesamos en lotes de 6 hasta tener 5 con precio
    const LOTE = 6;
    const productos = [];
    for (let i = 0; i < ids.length && productos.length < 5; i += LOTE) {
        const lote     = ids.slice(i, i + LOTE);
        const results  = await Promise.all(lote.map(pid => getListingForProduct(pid, headers)));
        const validos  = results.filter(Boolean);
        productos.push(...validos);
        console.log(`Lote ${Math.floor(i/LOTE)+1}: ${validos.length} con precio, total: ${productos.length}`);
    }

    return productos.slice(0, 5);
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
            if (!token) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Token fallido' })); return; }
            const productos = await buscar(q, token);
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
