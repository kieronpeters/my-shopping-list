import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');

function pngSize(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'file must have the PNG signature',
  );
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('Android manifest launches the published app as a TWA', async () => {
  const manifest = await readFile(
    path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8',
  );

  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /com\.google\.androidbrowserhelper\.trusted\.LauncherActivity/);
  assert.match(
    manifest,
    /android\.support\.customtabs\.trusted\.DEFAULT_URL"\s+android:value="https:\/\/kieronpeters\.github\.io\/my-shopping-list\/"/,
  );
  assert.match(manifest, /android\.support\.customtabs\.trusted\.FALLBACK_STRATEGY/);
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
  assert.match(manifest, /android:exported="true"/);
});

test('Android application id matches the published asset links', async () => {
  const gradle = await readFile(path.join(ANDROID, 'app', 'build.gradle'), 'utf8');
  const assetLinks = JSON.parse(await readFile(path.join(ANDROID, 'assetlinks.json'), 'utf8'));

  assert.match(gradle, /applicationId 'io\.github\.kieronpeters\.shoppinglist'/);
  assert.equal(assetLinks.length, 1);
  assert.deepEqual(assetLinks[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(assetLinks[0].target.namespace, 'android_app');
  assert.equal(assetLinks[0].target.package_name, 'io.github.kieronpeters.shoppinglist');

  const fingerprints = assetLinks[0].target.sha256_cert_fingerprints;
  assert.equal(fingerprints.length, 1);
  assert.match(fingerprints[0], /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/);
});

test('Android launcher icons exist for every density at the right sizes', async () => {
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

  for (const [density, size] of Object.entries(densities)) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const file = path.join(ANDROID, 'app', 'src', 'main', 'res', `mipmap-${density}`, name);
      assert.ok(existsSync(file), `${file} should exist`);
      assert.deepEqual(pngSize(await readFile(file)), { width: size, height: size });
    }

    const foregroundFile = path.join(
      ANDROID,
      'app',
      'src',
      'main',
      'res',
      `mipmap-${density}`,
      'ic_launcher_foreground.png',
    );
    assert.ok(existsSync(foregroundFile), `${foregroundFile} should exist`);
    const foreground = pngSize(await readFile(foregroundFile));
    assert.equal(foreground.width, foreground.height);
  }

  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    assert.ok(
      existsSync(path.join(ANDROID, 'app', 'src', 'main', 'res', 'mipmap-anydpi-v26', name)),
      `${name} should exist`,
    );
  }
});
