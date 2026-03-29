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

// Para un product ID, busca el listing más barato con precio real
async function getListingForProduct(pid, headers) {
    // Primero traemos el nombre e imagen del producto del catálogo
    const [prodR, itemsR] = await Promise.all([
        fetch(`https://api.mercadolibre.com/products/${pid}?attributes=id,name,pictures`, { headers }),
        fetch(`https://api.mercadolibre.com/products/${pid}/items?limit=5&sort=price_asc&condition=new`, { headers }),
    ]);

    if (prodR.status !== 200) return null;
    const prod = await prodR.json();

    let listing = null;
    if (itemsR.status === 200) {
        const data = await itemsR.json();
        // Filtramos por buena reputación si hay suficientes
        const results = data.results || [];
        const buenos = results.filter(p => {
            const rep = p.seller?.seller_reputation?.level_id;
            return !rep || ['5_green', '4_light_green'].includes(rep);
        });
        listing = (buenos.length > 0 ? buenos : results)[0] || null;
    }

    if (!listing?.price) return null;

    const img = prod.pictures?.[0]?.url || listing.thumbnail || '';

    return {
        title:     prod.name || listing.title,
        price:     listing.price,
        thumbnail: img.replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
        permalink: addAffiliateTag(listing.permalink),
        shipping:  { free_shipping: listing.shipping?.free_shipping ?? false },
        condition: listing.condition,
    };
}

async function buscar(q, token) {
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'MercadoLibre/iOS 10.171.0' };

    // Paso 1: domain_discovery → category_id
    const discR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=3`,
        { headers }
    );
    if (discR.status !== 200) return [];
    const cats  = await discR.json();
    const catId = cats?.[0]?.category_id;
    if (!catId) return [];

    // Paso 2: highlights → product IDs
    const hlR = await fetch(`https://api.mercadolibre.com/highlights/MLA/category/${catId}`, { headers });
    if (hlR.status !== 200) return [];
    const hl  = await hlR.json();
    const ids = (hl.content || []).slice(0, 12).map(x => x.id);
    if (!ids.length) return [];

    // Paso 3: para cada product ID, buscamos el listing más barato en paralelo
    // Limitamos a 8 paralelos para no sobrecargar
    const resultados = await Promise.all(ids.slice(0, 8).map(pid => getListingForProduct(pid, headers)));

    // Filtramos nulos y tomamos los primeros 5 con precio
    const productos = resultados.filter(Boolean).slice(0, 5);
    return productos;
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
