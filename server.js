const http = require('http');
const url  = require('url');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const CLIENT_ID     = process.env.MELI_CLIENT_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN;
const AFFILIATE_ID  = 'laisa9320492524395';

async function getToken() {
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
    return r.json();
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const path   = parsed.pathname;
    const params = parsed.query;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    if (path === '/' || path === '/index.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync('./index.html'));
        return;
    }

    if (path === '/api/buscar') {
        const q = params.q;
        if (!q) { res.end('[]'); return; }

        try {
            const auth = await getToken();
            if (!auth.access_token) {
                res.statusCode = 401;
                res.end(JSON.stringify({ error: 'Token fallido', detalle: auth }));
                return;
            }

            // Probar múltiples variantes del endpoint
            const endpoints = [
                `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10&sort=price_asc&condition=new`,
                `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10&sort=price_asc`,
                `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10`,
            ];

            let data = null;
            let lastStatus = 0;

            for (const endpoint of endpoints) {
                const r = await fetch(endpoint, {
                    headers: { 
                        'Authorization': `Bearer ${auth.access_token}`,
                        'User-Agent': 'Mozilla/5.0',
                        'X-Forwarded-For': '200.45.249.0', // IP argentina
                    }
                });
                lastStatus = r.status;
                const body = await r.json();
                if (r.status === 200 && body.results?.length > 0) {
                    data = body;
                    break;
                }
                console.log(`Endpoint ${endpoint} → ${r.status}:`, JSON.stringify(body).substring(0, 100));
            }

            if (!data) {
                res.end(JSON.stringify({ error: 'forbidden', status: lastStatus, message: 'MeLi bloquea desde este servidor' }));
                return;
            }

            const results = data.results || [];
            const filtrados = results.filter(p => {
                const rep = p.seller?.seller_reputation?.level_id;
                if (!rep) return true;
                return ['5_green', '4_light_green'].includes(rep);
            });
            const lista = filtrados.length >= 3 ? filtrados : results;
            const productos = lista.slice(0, 5).map(p => ({
                title:     p.title,
                price:     p.price,
                thumbnail: (p.thumbnail || '').replace('http://', 'https://').replace('-I.jpg', '-O.jpg'),
                permalink: p.permalink,
                shipping:  { free_shipping: p.shipping?.free_shipping ?? false },
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
