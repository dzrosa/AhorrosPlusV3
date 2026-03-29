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

async function buscar(q, token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'MercadoLibre/iOS 10.171.0',
    };

    // Paso 1: domain_discovery → category_id
    const discR = await fetch(
        `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=${encodeURIComponent(q)}&limit=5`,
        { headers }
    );
    if (discR.status !== 200) {
        console.error('domain_discovery falló:', discR.status);
        return [];
    }
    const cats = await discR.json();
    const catId = cats?.[0]?.category_id;
    if (!catId) {
        console.error('No se encontró categoría para:', q);
        return [];
    }
    console.log(`Categoría para "${q}": ${catId}`);

    // Paso 2: highlights de esa categoría → lista de IDs
    const hlR = await fetch(
        `https://api.mercadolibre.com/highlights/MLA/category/${catId}`,
        { headers }
    );
    if (hlR.status !== 200) {
        console.error('highlights falló:', hlR.status);
        return [];
    }
    const hl = await hlR.json();
    const ids = (hl.content || [])
        .filter(x => x.type === 'ITEM' || x.type === 'PRODUCT')
        .slice(0, 10)
        .map(x => x.id);

    if (!ids.length) {
        console.error('Highlights sin IDs');
        return [];
    }
    console.log('IDs de highlights:', ids.join(', '));

    // Paso 3: multiget de items para obtener título, precio, imagen
    const ATTRS = 'id,title,price,thumbnail,permalink,shipping,seller,condition,buying_mode';
    const mgR = await fetch(
        `https://api.mercadolibre.com/items?ids=${ids.join(',')}&attributes=${ATTRS}`,
        { headers }
    );
    if (mgR.status !== 200) {
        console.error('multiget falló:', mgR.status);
        return [];
    }
    const mg = await mgR.json();

    // mg es array de { code, body }
    const items = mg
        .filter(r => r.code === 200 && r.body?.price)
        .map(r => r.body);

    console.log(`Items con precio: ${items.length} de ${mg.length}`);

    // Filtro de reputación
    const buenos = items.filter(p => {
        const rep = p.seller?.seller_reputation?.level_id;
        return !rep || ['5_green', '4_light_green'].includes(rep);
    });
    const lista = buenos.length >= 3 ? buenos : items;

    return lista.slice(0, 5).map(p => ({
        title:     p.title,
        price:     p.price,
        thumbnail: (p.thumbnail || '').replace('http://', 'https://').replace(/-[A-Z]\.jpg$/, '-O.jpg'),
        permalink: addAffiliateTag(p.permalink),
        shipping:  { free_shipping: p.shipping?.free_shipping ?? false },
        condition: p.condition,
    }));
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
