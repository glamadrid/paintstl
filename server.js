// Servidor estático básico (sin dependencias) para probar PaintSTL localmente
// y desde el navegador del Oculus Quest 2 a través de la red local.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT) || 8000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.stl': 'model/stl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(req.url.split('?')[0]);
  const safeSuffix = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(ROOT_DIR, safeSuffix === '/' || safeSuffix === '\\' ? '' : safeSuffix);

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Prohibido');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (!statErr && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.stat(filePath, (err, fileStats) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 - No encontrado: ' + requestPath);
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': fileStats.size,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
});

function listLocalIPv4Addresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, () => {
  console.log(`PaintSTL servidor en marcha:\n`);
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const ip of listLocalIPv4Addresses()) {
    console.log(`  Red LAN:  http://${ip}:${PORT}  <- usa esta URL en el navegador del Quest 2`);
  }
  console.log(`\nWebXR requiere un "contexto seguro" (HTTPS) salvo en localhost.`);
  console.log(`Para probar en el Quest 2 sobre http:// simple, habilita en su navegador:`);
  console.log(`  chrome://flags/#unsafely-treat-insecure-origin-as-secure`);
  console.log(`  y añade la URL de "Red LAN" de arriba como origen permitido.\n`);
});
