import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function pngSize(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'file must have the PNG signature',
  );
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', 'file must start with an IHDR chunk');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

let server;
let port;

before(async () => {
  server = createStaticServer({ root: ROOT });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('page shell has a mobile viewport, title, and no inline script or handlers', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>My Shopping List<\/title>/);
  assert.match(html, /name="viewport"[^>]*width=device-width/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="manifest"/);
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts');
});

test('every local asset referenced by the page exists', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const references = [
    'styles.css',
    'app.js',
    'manifest.webmanifest',
    'icons/icon-32.png',
    'icons/icon-192.png',
    'icons/apple-touch-icon.png',
  ];

  for (const reference of references) {
    assert.ok(html.includes(reference), `index.html should reference ${reference}`);
    assert.ok(existsSync(path.join(ROOT, reference)), `${reference} should exist`);
  }
});

test('manifest is valid and its icons are real PNGs of the declared size', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

  assert.equal(manifest.name, 'My Shopping List');
  assert.equal(manifest.short_name, 'Shopping List');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0d9488');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);

  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    const file = path.join(ROOT, icon.src);
    assert.ok(existsSync(file), `${icon.src} should exist`);

    const { width, height } = pngSize(await readFile(file));
    assert.equal(`${width}x${height}`, icon.sizes);
    sizes.add(`${width}x${height}`);
  }

  assert.ok(sizes.has('192x192'), 'needs a 192px icon');
  assert.ok(sizes.has('512x512'), 'needs a 512px icon');
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === 'maskable'),
    'needs a maskable icon',
  );
});

test('apple touch icon and favicon have the expected dimensions', async () => {
  const apple = pngSize(await readFile(path.join(ROOT, 'icons', 'apple-touch-icon.png')));
  assert.deepEqual(apple, { width: 180, height: 180 });

  const favicon = pngSize(await readFile(path.join(ROOT, 'icons', 'icon-32.png')));
  assert.deepEqual(favicon, { width: 32, height: 32 });
});

test('service worker pre-caches the whole app shell', async () => {
  const source = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
  const block = source.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'APP_SHELL declaration should exist');

  const files = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const file of files) {
    const relative = file === './' ? 'index.html' : file.replace(/^\.\//, '');
    assert.ok(existsSync(path.join(ROOT, relative)), `pre-cached file ${file} should exist`);
  }

  for (const required of ['./index.html', './styles.css', './app.js', './store.js', './manifest.webmanifest']) {
    assert.ok(files.includes(required), `app shell should include ${required}`);
  }
});

test('server serves the app with correct content types and security headers', async () => {
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.match(page.body.toString('utf8'), /My Shopping List/);

  const manifest = await request(port, '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers['content-type'], /application\/manifest\+json/);

  const script = await request(port, '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /text\/javascript/);

  const serviceWorker = await request(port, '/sw.js');
  assert.equal(serviceWorker.status, 200);
  assert.equal(serviceWorker.headers['cache-control'], 'no-cache');

  const icon = await request(port, '/icons/icon-192.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/png');
  assert.match(icon.headers['cache-control'], /max-age=/);
  assert.deepEqual(pngSize(icon.body), { width: 192, height: 192 });
});

test('server supports HEAD, rejects other methods, and returns 404s', async () => {
  const head = await request(port, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.ok(Number(head.headers['content-length']) > 0);

  const post = await request(port, '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');

  const missing = await request(port, '/does-not-exist.js');
  assert.equal(missing.status, 404);
});

test('server never escapes the project root', async () => {
  const attempts = [
    '/%2e%2e/%2e%2e/Windows/win.ini',
    '/..%5c..%5cWindows%5cwin.ini',
    '/%2e%2e/package.json',
  ];

  for (const attempt of attempts) {
    const response = await request(port, attempt);
    assert.notEqual(response.status, 500, `${attempt} should not crash the server`);
    assert.ok(
      response.status === 403 || response.status === 404 || response.status === 200,
      `${attempt} should get a defined response`,
    );
    const body = response.body.toString('utf8');
    if (attempt.includes('win.ini')) {
      assert.equal(response.status, 404, 'win.ini must not be reachable');
      assert.doesNotMatch(body, /\[fonts\]/);
    }
  }
});

test('store module exports everything the app imports', async () => {
  const store = await import('../store.js');
  const app = await readFile(path.join(ROOT, 'app.js'), 'utf8');
  const imported = [...app.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/store\.js'/g)]
    .flatMap((match) => match[1].split(','))
    .map((name) => name.trim())
    .filter(Boolean);

  assert.ok(imported.length > 0, 'app.js should import from store.js');
  for (const name of imported) {
    assert.ok(name in store, `store.js should export ${name}`);
  }
  for (const name of ['addItem', 'updateItem', 'toggleItem', 'removeItem', 'insertItem', 'counts', 'loadState', 'saveState']) {
    assert.equal(typeof store[name], 'function', `store.js should export ${name}()`);
  }
});
