'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const BACKEND = { hostname: '127.0.0.1', port: 4000 };
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function proxyApi(req, res) {
  const opts = {
    hostname: BACKEND.hostname,
    port: BACKEND.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BACKEND.hostname}:${BACKEND.port}` }
  };
  const p = http.request(opts, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  p.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: 'السيرفر على المنفذ 4000 غير شغال. من مجلد backend نفّذ: node server.js'
    }));
  });
  req.pipe(p);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqPath = req.url.split('?')[0];
  if (reqPath.startsWith('/api')) return proxyApi(req, res);

  const filePath = path.join(ROOT, reqPath === '/' ? 'index.html' : reqPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(ROOT))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      const index = path.join(ROOT, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(index).pipe(res);
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`واجهة: http://localhost:${PORT}  (تحول /api إلى المنفذ 4000)`);
});
