/**
 * Minimal static file server for My Shopping List.
 *
 *   npm start            → http://localhost:4173
 *   PORT=8080 npm start  → custom port
 *
 * Bind address defaults to 0.0.0.0 so a phone on the same Wi-Fi can reach it
 * for layout testing. The PWA install prompt requires HTTPS (see README.md).
 */
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function cacheControlFor(ext) {
  if (ext === '.png' || ext === '.svg' || ext === '.ico') {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

export function createStaticServer({ root = ROOT } = {}) {
  const resolvedRoot = path.resolve(root);

  return createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
        return;
      }

      const url = new URL(request.url ?? '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Bad Request');
        return;
      }

      if (pathname.endsWith('/')) pathname += 'index.html';

      const relative = path.normalize(pathname).replace(/^[\\/]+/, '');
      const filePath = path.resolve(resolvedRoot, relative);

      if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
      }

      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cacheControlFor(ext),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      createReadStream(filePath)
        .on('error', () => response.destroy())
        .pipe(response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal Server Error');
    }
  });
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  const server = createStaticServer();
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log('My Shopping List is running:');
    console.log(`  http://localhost:${port}`);
    for (const address of lanAddresses()) {
      console.log(`  http://${address}:${port}   (same Wi-Fi, for testing)`);
    }
    console.log('');
    console.log('Install it on your phone from an HTTPS host — see README.md.');
    console.log('Listening on all interfaces; set HOST=127.0.0.1 to keep it local.');
  });
  server.on('error', (error) => {
    console.error(`Could not start the server: ${error.message}`);
    process.exitCode = 1;
  });
}
