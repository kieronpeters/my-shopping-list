/**
 * End-to-end checks for My Shopping List in real Chrome, driven over the
 * DevTools Protocol with no third-party dependencies.
 *
 * Run with: npm run test:e2e
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!CHROME) {
  console.error('No Chrome or Edge installation found. Set CHROME_PATH to a Chromium-based browser.');
  process.exit(1);
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, delay(ms).then(() => Promise.reject(new Error(message)))]);
}

class CDP {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Could not connect to the Chrome DevTools endpoint'));
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });

    const cdp = new CDP(ws);
    ws.addEventListener('message', (event) => cdp.#handleMessage(event.data));
    return cdp;
  }

  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    if (message.id && this.#pending.has(message.id)) {
      const { resolve, reject } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (code ${message.error.code})`));
      else resolve(message.result ?? {});
      return;
    }

    if (message.method) {
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  waitFor(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const listeners = this.#listeners.get(method) ?? [];
      const onEvent = (params) => {
        clearTimeout(timer);
        const index = listeners.indexOf(onEvent);
        if (index !== -1) listeners.splice(index, 1);
        resolve(params);
      };
      const timer = setTimeout(() => {
        const index = listeners.indexOf(onEvent);
        if (index !== -1) listeners.splice(index, 1);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      listeners.push(onEvent);
      this.#listeners.set(method, listeners);
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function findPageTarget(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* browser is still starting */
    }
    await delay(150);
  }
  throw new Error('Chrome did not expose a page target');
}

async function waitForDevToolsPort(profileDir, chrome, stderr) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [portText] = (await readFile(portFile, 'utf8')).split('\n');
      if (portText && portText.trim()) return Number(portText.trim());
    }
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited early (code ${chrome.exitCode}).\n${stderr()}`);
    }
    await delay(100);
  }
  throw new Error(`Chrome did not expose a DevTools port.\n${stderr()}`);
}

async function main() {
  const server = createStaticServer({ root: ROOT });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;

  const profileDir = await mkdtemp(path.join(tmpdir(), 'shopping-list-chrome-'));
  let chromeStderr = '';
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--metrics-recording-only',
      '--mute-audio',
      '--hide-scrollbars',
      '--no-sandbox',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr.on('data', (chunk) => {
    chromeStderr += chunk.toString();
  });

  let cdp;
  let currentStep = 'startup';
  const consoleErrors = [];
  const failedRequests = [];
  const watchdog = setTimeout(() => {
    console.error(`\nE2E watchdog timed out during: ${currentStep}`);
    process.exit(1);
  }, 180000);
  watchdog.unref();

  const evaluate = async (expression, timeout = 20000) => {
    const response = await withTimeout(
      cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }),
      timeout,
      `Timed out evaluating page script during ${currentStep}`,
    );
    if (response.exceptionDetails) {
      const message =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'Page script threw an error';
      throw new Error(message);
    }
    return response.result.value;
  };

  try {
    const devToolsPort = await waitForDevToolsPort(profileDir, chrome, () => chromeStderr);
    const target = await findPageTarget(devToolsPort);
    cdp = await CDP.connect(target.webSocketDebuggerUrl);

    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      consoleErrors.push(
        `Uncaught: ${exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'unknown'}`,
      );
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type !== 'error') return;
      consoleErrors.push(`console.error: ${args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') consoleErrors.push(`log: ${entry.text}`);
    });
    cdp.on('Network.loadingFailed', (event) => {
      if (event.canceled) return;
      failedRequests.push(`${event.errorText}${event.blockedReason ? ` (${event.blockedReason})` : ''}`);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    const waitForApp = async (timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const ready = await evaluate(
            `document.readyState === 'complete' && !!document.querySelector('#add-form')`,
            5000,
          );
          if (ready) return;
        } catch {
          /* navigation in progress */
        }
        await delay(100);
      }
      throw new Error('The app did not finish loading');
    };

    const reload = async () => {
      const loaded = cdp.waitFor('Page.loadEventFired', 15000).catch(() => null);
      await cdp.send('Page.reload');
      await loaded;
      await waitForApp();
    };

    const snapshot = () =>
      evaluate(`(() => {
        const readRow = (li) => ({
          id: li.dataset.id,
          text: li.querySelector('.item-text') ? li.querySelector('.item-text').textContent : null,
          done: li.classList.contains('is-done'),
          editing: li.classList.contains('is-editing'),
          checked: li.querySelector('.item-toggle') ? li.querySelector('.item-toggle').checked : null,
        });
        const raw = localStorage.getItem('my-shopping-list:v1');
        let stored = null;
        try {
          stored = raw ? JSON.parse(raw) : null;
        } catch {
          stored = 'invalid';
        }
        return {
          title: document.title,
          heading: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
          summary: document.querySelector('#summary').textContent,
          todo: Array.from(document.querySelectorAll('#todo-list .item')).map(readRow),
          done: Array.from(document.querySelectorAll('#done-list .item')).map(readRow),
          todoCount: document.querySelector('#todo-count').textContent,
          doneCount: document.querySelector('#done-count').textContent,
          doneGroupHidden: document.querySelector('#done-group').hidden,
          emptyVisible: !document.querySelector('#empty-todo').hidden,
          emptyText: document.querySelector('#empty-todo').textContent,
          snackbarVisible: !document.querySelector('#snackbar').hidden,
          snackbarText: document.querySelector('#snackbar-text').textContent,
          undoVisible: !document.querySelector('#undo-btn').hidden,
          stored,
        };
      })()`);

    const addItem = (text) =>
      evaluate(`(() => {
        const input = document.querySelector('#new-item');
        input.value = ${JSON.stringify(text)};
        document.querySelector('#add-form').requestSubmit();
        return true;
      })()`);

    const clickInList = (listSelector, index, buttonClass) =>
      evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('${listSelector} .item'));
        const row = rows[${index}];
        if (!row) throw new Error('No row at index ${index}');
        const button = row.querySelector('${buttonClass}');
        if (!button) throw new Error('No ${buttonClass} in row ${index}');
        button.click();
        return true;
      })()`);

    const toggleTodo = (index) => clickInList('#todo-list', index, '.item-toggle');
    const toggleDone = (index) => clickInList('#done-list', index, '.item-toggle');
    const startEdit = (index) => clickInList('#todo-list', index, '.btn-edit');
    const deleteTodo = (index) => clickInList('#todo-list', index, '.btn-delete');

    const setEditValue = (text) =>
      evaluate(`(() => {
        const input = document.querySelector('.edit-input');
        if (!input) throw new Error('No item is being edited');
        input.value = ${JSON.stringify(text)};
        return input.value;
      })()`);

    const pressKeyInEdit = (key) =>
      evaluate(`(() => {
        const input = document.querySelector('.edit-input');
        if (!input) throw new Error('No item is being edited');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
        return true;
      })()`);

    const clickSave = () => evaluate(`document.querySelector('.btn-save').click()`);
    const clickUndo = () => evaluate(`document.querySelector('#undo-btn').click()`);
    const texts = (rows) => rows.map((row) => row.text);

    const screenshot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const dir = path.join(ROOT, 'docs');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), Buffer.from(data, 'base64'));
      console.log(`      saved docs/${name}`);
    };

    let passed = 0;
    const step = async (name, fn) => {
      currentStep = name;
      process.stdout.write(`  • ${name} ... `);
      try {
        await fn();
        passed += 1;
        console.log('ok');
      } catch (error) {
        console.log('FAILED');
        throw error;
      }
    };

    console.log(`Launching ${path.basename(CHROME)} against ${baseUrl}\n`);

    {
      const loaded = cdp.waitFor('Page.loadEventFired', 20000).catch(() => null);
      await cdp.send('Page.navigate', { url: baseUrl });
      await loaded;
      await waitForApp();
    }

    await step('loads a clean app shell', async () => {
      const snap = await snapshot();
      assert.equal(snap.title, 'My Shopping List');
      assert.equal(snap.heading, 'My Shopping List');
      assert.equal(snap.summary, 'Nothing on your list yet');
      assert.deepEqual(texts(snap.todo), []);
      assert.deepEqual(texts(snap.done), []);
      assert.equal(snap.doneGroupHidden, true);
      assert.equal(snap.emptyVisible, true);
      assert.equal(snap.snackbarVisible, false);
      assert.equal(snap.todoCount, '0');
      assert.equal(snap.stored, null);
    });

    await step('adds items in order and normalizes whitespace', async () => {
      await addItem('Milk');
      const first = await snapshot();
      assert.equal(first.summary, '1 item to buy');

      await addItem('   Eggs   ');
      await addItem('Bread');

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Milk', 'Eggs', 'Bread']);
      assert.equal(snap.summary, '3 items to buy');
      assert.equal(snap.todoCount, '3');
      assert.equal(snap.emptyVisible, false);
      assert.equal(snap.stored.items.length, 3);

      await addItem('     ');
      const afterBlank = await snapshot();
      assert.equal(afterBlank.todo.length, 3, 'blank submissions must be ignored');
      assert.equal(afterBlank.stored.items.length, 3);
    });

    await step('clamps very long entries and keeps the list usable', async () => {
      await addItem('x'.repeat(250));
      const snap = await snapshot();
      assert.equal(snap.todo.at(-1).text.length, 200);
      await deleteTodo(snap.todo.length - 1);

      const after = await snapshot();
      assert.deepEqual(texts(after.todo), ['Milk', 'Eggs', 'Bread']);
    });

    await step('marks items as purchased and separates them', async () => {
      await toggleTodo(0);

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Eggs', 'Bread']);
      assert.deepEqual(texts(snap.done), ['Milk']);
      assert.equal(snap.done[0].checked, true);
      assert.equal(snap.done[0].done, true);
      assert.equal(snap.summary, '1 of 3 purchased');
      assert.equal(snap.doneGroupHidden, false);
      assert.equal(snap.doneCount, '1');
    });

    await step('moves purchased items back to the list', async () => {
      await toggleDone(0);

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Milk', 'Eggs', 'Bread']);
      assert.deepEqual(texts(snap.done), []);
      assert.equal(snap.doneGroupHidden, true);
      assert.equal(snap.summary, '3 items to buy');
      assert.equal(snap.stored.items[0].done, false);
    });

    await step('edits an item inline', async () => {
      await startEdit(1);
      const editing = await evaluate(`(() => {
        const input = document.querySelector('.item.is-editing .edit-input');
        if (!input) return null;
        return {
          value: input.value,
          focused: document.activeElement === input,
          hasSave: !!document.querySelector('.btn-save'),
          hasCancel: !!document.querySelector('.btn-cancel'),
          rowIsEditing: document.querySelectorAll('.item.is-editing').length,
        };
      })()`);
      assert.deepEqual(editing, {
        value: 'Eggs',
        focused: true,
        hasSave: true,
        hasCancel: true,
        rowIsEditing: 1,
      });

      await setEditValue('Free-range eggs');
      await clickSave();

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Milk', 'Free-range eggs', 'Bread']);
      assert.equal(snap.stored.items[1].text, 'Free-range eggs');
      assert.equal(await evaluate(`!!document.querySelector('.edit-input')`), false);
    });

    await step('supports Enter to save and Escape to cancel', async () => {
      await startEdit(0);
      await setEditValue('Oat milk');
      await pressKeyInEdit('Enter');
      assert.deepEqual(texts((await snapshot()).todo), ['Oat milk', 'Free-range eggs', 'Bread']);

      await startEdit(0);
      await setEditValue('Whole milk');
      await pressKeyInEdit('Escape');

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Oat milk', 'Free-range eggs', 'Bread']);
      assert.equal(await evaluate(`!!document.querySelector('.edit-input')`), false);
      assert.equal(snap.stored.items[0].text, 'Oat milk');
    });

    await step('never blanks an item when an edit is emptied', async () => {
      await startEdit(2);
      await setEditValue('    ');
      await clickSave();

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Oat milk', 'Free-range eggs', 'Bread']);
      assert.equal(snap.stored.items.length, 3);
      assert.equal(await evaluate(`!!document.querySelector('.edit-input')`), false);
    });

    await step('shows a completion message when everything is purchased', async () => {
      for (let i = 0; i < 3; i += 1) await toggleTodo(0);

      let snap = await snapshot();
      assert.deepEqual(texts(snap.todo), []);
      assert.equal(snap.done.length, 3);
      assert.equal(snap.summary, '3 of 3 purchased');
      assert.equal(snap.emptyVisible, true);
      assert.match(snap.emptyText, /All done/);
      assert.equal(snap.stored.items.every((item) => item.done), true);

      for (let i = 0; i < 3; i += 1) await toggleDone(0);

      snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Oat milk', 'Free-range eggs', 'Bread']);
      assert.deepEqual(texts(snap.done), []);
      assert.equal(snap.emptyVisible, false);
    });

    await step('deletes an item and Undo restores its position', async () => {
      await deleteTodo(1);

      let snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Oat milk', 'Bread']);
      assert.equal(snap.snackbarVisible, true);
      assert.match(snap.snackbarText, /Free-range eggs/);
      assert.equal(snap.undoVisible, true);
      assert.equal(snap.stored.items.length, 2);

      await clickUndo();
      await delay(350);

      snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Oat milk', 'Free-range eggs', 'Bread']);
      assert.equal(snap.snackbarVisible, false);
      assert.equal(snap.stored.items.length, 3);
    });

    await step('renders item text literally, with no HTML injection', async () => {
      const payload = '<img src=x onerror="window.__xss = 1">';
      await addItem(payload);

      const snap = await snapshot();
      assert.equal(snap.todo.at(-1).text, payload);
      assert.equal(await evaluate(`document.querySelectorAll('#todo-list img').length`), 0);
      assert.equal(await evaluate(`typeof window.__xss`), 'undefined');

      await deleteTodo(snap.todo.length - 1);
    });

    await step('persists items, edits, and purchased state across a reload', async () => {
      await toggleTodo(2); // Bread → purchased

      const before = await snapshot();
      assert.equal(before.summary, '1 of 3 purchased');
      assert.deepEqual(texts(before.done), ['Bread']);

      await reload();

      const after = await snapshot();
      assert.deepEqual(texts(after.todo), ['Oat milk', 'Free-range eggs']);
      assert.deepEqual(texts(after.done), ['Bread']);
      assert.equal(after.summary, '1 of 3 purchased');
      assert.equal(after.doneGroupHidden, false);
      assert.equal(after.done[0].checked, true);
    });

    await step('registers an active service worker with a complete app shell cache', async () => {
      const sw = await evaluate(`(async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        const registration = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
        ]);
        if (!registration) return { supported: true, ready: false };
        const deadline = Date.now() + 5000;
        while (!navigator.serviceWorker.controller && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return {
          supported: true,
          ready: true,
          active: !!registration.active,
          controller: !!navigator.serviceWorker.controller,
        };
      })()`, 25000);

      assert.equal(sw.supported, true);
      assert.equal(sw.ready, true);
      assert.equal(sw.active, true);
      assert.equal(sw.controller, true);

      const manifest = await evaluate(
        `fetch('./manifest.webmanifest').then((response) => {
          if (!response.ok) throw new Error('manifest ' + response.status);
          return response.json();
        })`,
      );
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.start_url, './');
      assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));

      const iconSources = manifest.icons.map((icon) => icon.src);
      const iconsOk = await evaluate(
        `Promise.all(${JSON.stringify(iconSources)}.map((src) => fetch('./' + src).then((response) => response.ok)))`,
      );
      assert.ok(iconsOk.every(Boolean), 'every manifest icon should load');

      const cache = await evaluate(`(async () => {
        const keys = await caches.keys();
        const key = keys.find((name) => name.startsWith('my-shopping-list-'));
        if (!key) return { key: null };
        const shell = await caches.open(key);
        return {
          key,
          index: !!(await shell.match('./index.html')),
          styles: !!(await shell.match('./styles.css')),
          app: !!(await shell.match('./app.js')),
          store: !!(await shell.match('./store.js')),
        };
      })()`);
      assert.ok(cache.key, 'app shell cache should exist');
      assert.deepEqual(
        { index: cache.index, styles: cache.styles, app: cache.app, store: cache.store },
        { index: true, styles: true, app: true, store: true },
      );
    });

    await step('loads and renders without console errors or failed requests', async () => {
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(failedRequests, []);
    });

    await step('still works offline, with data intact', async () => {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });

      try {
        await reload();

        const snap = await snapshot();
        assert.deepEqual(texts(snap.todo), ['Oat milk', 'Free-range eggs']);
        assert.deepEqual(texts(snap.done), ['Bread']);
        assert.equal(snap.summary, '1 of 3 purchased');
        assert.equal(await evaluate(`navigator.onLine`), false);
      } finally {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      }
    });

    await step('fits a 390px phone with 44px tap targets and no overflow', async () => {
      const layout = await evaluate(`(() => {
        const controls = Array.from(document.querySelectorAll('.check, .icon-btn, .add-btn, #undo-btn'))
          .filter((element) => element.offsetParent !== null)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.className || element.id,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const input = document.querySelector('#new-item');
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          inputFontSize: parseFloat(getComputedStyle(input).fontSize),
          controls,
        };
      })()`);

      assert.ok(
        layout.scrollWidth <= layout.innerWidth,
        `horizontal overflow: ${layout.scrollWidth} > ${layout.innerWidth}`,
      );
      assert.ok(layout.inputFontSize >= 16, 'input font size must be at least 16px on mobile');
      assert.ok(layout.controls.length >= 5);
      for (const control of layout.controls) {
        assert.ok(control.height >= 44, `${control.name} is only ${control.height}px tall`);
        assert.ok(control.width >= 44, `${control.name} is only ${control.width}px wide`);
      }
    });

    await step('fits a narrow 320px phone', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 700,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await delay(150);

      const layout = await evaluate(`({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })`);
      assert.ok(
        layout.scrollWidth <= layout.innerWidth,
        `horizontal overflow: ${layout.scrollWidth} > ${layout.innerWidth}`,
      );

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await delay(150);
    });

    await step('recovers gracefully from corrupt local storage', async () => {
      await evaluate(`localStorage.setItem('my-shopping-list:v1', '{{{not json')`);
      await reload();

      let snap = await snapshot();
      assert.deepEqual(texts(snap.todo), []);
      assert.deepEqual(texts(snap.done), []);
      assert.equal(snap.emptyVisible, true);
      assert.equal(snap.summary, 'Nothing on your list yet');

      await addItem('Apples');
      snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Apples']);
      assert.equal(snap.stored.items.length, 1);
    });

    await step('renders realistic light and dark screenshots', async () => {
      await evaluate(`localStorage.clear()`);
      await reload();

      for (const text of ['Milk', 'Eggs', 'Sourdough bread', 'Bananas', 'Coffee beans']) {
        await addItem(text);
      }
      await toggleTodo(0); // Milk
      await toggleTodo(3); // Coffee beans

      const snap = await snapshot();
      assert.deepEqual(texts(snap.todo), ['Eggs', 'Sourdough bread', 'Bananas']);
      assert.deepEqual(texts(snap.done), ['Milk', 'Coffee beans']);
      assert.equal(snap.summary, '2 of 5 purchased');

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
      await delay(150);
      await screenshot('screenshot-light.png');

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
      await delay(150);
      await screenshot('screenshot-dark.png');
    });

    console.log(`\nAll ${passed} end-to-end checks passed.`);
  } catch (error) {
    console.error(`\nE2E failure during: ${currentStep}`);
    console.error(error.stack || String(error));
    try {
      await mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
      if (cdp) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(ROOT, 'artifacts', 'failure.png'), Buffer.from(data, 'base64'));
        const html = await evaluate(`document.documentElement.outerHTML`).catch(() => '');
        if (html) await writeFile(path.join(ROOT, 'artifacts', 'failure.html'), html);
      }
      console.error('Debug artifacts written to artifacts/');
    } catch {
      /* diagnostics are best-effort */
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    cdp?.close();
    if (chrome.exitCode === null) chrome.kill();
    await new Promise((resolve) => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
