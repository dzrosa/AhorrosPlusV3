const http = require('http');
const url  = require('url');

const PORT = process.env.PORT || 3000;

const CLIENT_ID     = process.env.MELI_CLIENT_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN;
const REDIRECT_URI  = process.env.REDIRECT_URI || '';

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

    // Servir index.html
    if (path === '/' || path === '/index.html') {
        const fs = require('fs');
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync('./index.html'));
        return;
    }

    // Endpoint gettoken
    if (path === '/api/gettoken' && params.code) {
        const r = await fetch('https://api.mercadolibre.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type:    'authorization_code',
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code:          params.code,
                redirect_uri:  REDIRECT_URI
            })
        });
        res.end(JSON.stringify(await r.json()));
        return;
    }

    // Endpoint buscar
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

            const searchRes = await fetch(
                `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=10&sort=price_asc&condition=new`,
                { headers: { 'Authorization': `Bearer ${auth.access_token}` } }
            );
            const data = await searchRes.json();

            if (data.error) {
                res.end(JSON.stringify({ error: data.error, message: data.message, status: searchRes.status }));
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

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
