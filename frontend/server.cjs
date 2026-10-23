'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  // Serve from node_modules if path starts with /node_modules/
  const safePath = reqPath.startsWith('/node_modules/')
    ? path.join(ROOT, reqPath)
    : path.join(ROOT, reqPath);

  // Security: prevent path traversal
  const resolved = path.resolve(safePath);
  const rootResolved = path.resolve(ROOT);
  if (!resolved.startsWith(rootResolved)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404: ${reqPath}`);
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [BARQ LINK Frontend] http://localhost:${PORT}`);
});
