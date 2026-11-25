/**
 * End-to-end checks for My Shopping List in real Chrome, driven over the
 * DevTools Protocol with no third-party dependencies.
 *
 * Run with: npm run test:e2e
 * Against a deployment: E2E_BASE_URL=https://example.com/app/ npm run test:e2e
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
const STORAGE_KEY = 'my-shopping-list:v2';
const LEGACY_KEY = 'my-shopping-list:v1';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
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
  const externalBase = process.env.E2E_BASE_URL;
  const server = externalBase ? null : createStaticServer({ root: ROOT });
  if (server) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const port = server ? server.address().port : null;
  const baseUrl = externalBase
    ? new URL(externalBase.endsWith('/') ? externalBase : `${externalBase}/`).href
    : `http://127.0.0.1:${port}/`;

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
  }, 240000);
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
        const readRow = (li) => {
          const qtyText = li.querySelector('.qty-badge') ? li.querySelector('.qty-badge').textContent : '';
          const toggle = li.querySelector('.item-toggle');
          return {
            id: li.dataset.id,
            text: li.querySelector('.item-text') ? li.querySelector('.item-text').textContent : null,
            status: li.dataset.status,
            qty: Number(qtyText.replace(/[^0-9]/g, '')),
            checked: toggle ? toggle.checked : null,
            editing: li.classList.contains('is-editing'),
          };
        };
        const groups = Array.from(document.querySelectorAll('#groups .group')).map((section) => ({
          status: section.dataset.status,
          heading: section.querySelector('h2') ? section.querySelector('h2').textContent.trim() : '',
          count: section.querySelector('.count') ? section.querySelector('.count').textContent : '',
          items: Array.from(section.querySelectorAll('.item')).map(readRow),
        }));
        const editingRow = document.querySelector('.item.is-editing');
        const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
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
          filters: Array.from(document.querySelectorAll('.filter-chip')).map((chip) => ({
            filter: chip.dataset.filter,
            count: Number(chip.querySelector('.filter-count').textContent),
            pressed: chip.getAttribute('aria-pressed') === 'true',
          })),
          groups,
          emptyVisible: !document.querySelector('#empty-state').hidden,
          emptyText: document.querySelector('#empty-state').textContent,
          clearCheckedDisabled: document.querySelector('#clear-checked').disabled,
          clearListDisabled: document.querySelector('#clear-list').disabled,
          editing: editingRow
            ? {
                text: editingRow.querySelector('.edit-input') ? editingRow.querySelector('.edit-input').value : null,
                qty: Number(editingRow.querySelector('.qty-value') ? editingRow.querySelector('.qty-value').textContent : 0),
                selectedStatus: editingRow.querySelector('.status-option.is-selected')
                  ? editingRow.querySelector('.status-option.is-selected').dataset.status
                  : null,
                upDisabled: editingRow.querySelector('.qty-up') ? editingRow.querySelector('.qty-up').disabled : null,
                downDisabled: editingRow.querySelector('.qty-down') ? editingRow.querySelector('.qty-down').disabled : null,
                focused: document.activeElement === editingRow.querySelector('.edit-input'),
              }
            : null,
          snackbarVisible: !document.querySelector('#snackbar').hidden,
          snackbarText: document.querySelector('#snackbar-text').textContent,
          undoVisible: !document.querySelector('#undo-btn').hidden,
          stored,
          legacyStored: localStorage.getItem(${JSON.stringify(LEGACY_KEY)}),
          qtyControls: document.querySelectorAll('.qty-btn').length,
        };
      })()`);

    const texts = (rows) => rows.map((row) => row.text);
    const groupTexts = (snap, status) => texts(snap.groups.find((group) => group.status === status)?.items ?? []);
    const allRows = (snap) => snap.groups.flatMap((group) => group.items);
    const rowByText = (snap, text) => allRows(snap).find((row) => row.text === text);
    const groupOf = (snap, status) => snap.groups.find((group) => group.status === status);

    const addItem = (text) =>
      evaluate(`(() => {
        const input = document.querySelector('#new-item');
        input.value = ${JSON.stringify(text)};
        document.querySelector('#add-form').requestSubmit();
        return true;
      })()`);

    const rowAction = (id, selector) =>
      evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.item')).find((entry) => entry.dataset.id === ${JSON.stringify(id)});
        if (!row) throw new Error('row not found');
        const target = row.querySelector(${JSON.stringify(selector)});
        if (!target) throw new Error('control not found: ' + ${JSON.stringify(selector)});
        target.click();
        return true;
      })()`);

    const toggleItem = (id) => rowAction(id, '.item-toggle');
    const editItem = (id) => rowAction(id, '.btn-edit');
    const deleteItem = (id) => rowAction(id, '.btn-delete');
    const clickSave = () => evaluate(`document.querySelector('.btn-save').click()`);
    const clickCancel = () => evaluate(`document.querySelector('.btn-cancel').click()`);
    const setEditText = (text) =>
      evaluate(`(() => {
        const input = document.querySelector('.edit-input');
        if (!input) throw new Error('no edit input');
        input.value = ${JSON.stringify(text)};
        return input.value;
      })()`);
    const pressEditKey = (key) =>
      evaluate(`(() => {
        const input = document.querySelector('.edit-input');
        if (!input) throw new Error('no edit input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
        return true;
      })()`);
    const chooseStatus = (status) =>
      evaluate(`document.querySelector('.status-option[data-status=${JSON.stringify(status)}]').click()`);
    const clickQty = (direction, times = 1) =>
      evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(direction === 'up' ? '.qty-up' : '.qty-down')});
        if (!button) throw new Error('no quantity button');
        for (let i = 0; i < ${times}; i += 1) button.click();
        return Number(document.querySelector('.qty-value').textContent);
      })()`);
    const setEditorQty = async (target) => {
      let current = Number(await evaluate(`document.querySelector('.qty-value').textContent`));
      while (current < target) {
        await clickQty('up');
        current += 1;
      }
      while (current > target) {
        await clickQty('down');
        current -= 1;
      }
      assert.equal(Number(await evaluate(`document.querySelector('.qty-value').textContent`)), target);
    };
    const selectFilter = (filter) =>
      evaluate(`document.querySelector('.filter-chip[data-filter=${JSON.stringify(filter)}]').click()`);
    const clearChecked = () => evaluate(`document.querySelector('#clear-checked').click()`);
    const clearList = () => evaluate(`document.querySelector('#clear-list').click()`);
    const undo = () => evaluate(`document.querySelector('#undo-btn').click()`);

    const idFor = async (text) => {
      const snap = await snapshot();
      const row = rowByText(snap, text);
      assert.ok(row, `row "${text}" should exist`);
      return row.id;
    };

    const reorderByKeyboard = async (id, key) => {
      await evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.item')).find((entry) => entry.dataset.id === ${JSON.stringify(id)});
        if (!row) throw new Error('row not found');
        const handle = row.querySelector('.drag-handle');
        if (!handle) throw new Error('no drag handle');
        handle.focus();
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
        return true;
      })()`);
      await delay(50);
    };

    const dragItem = async (id, targetId) => {
      await cdp.send('Page.bringToFront');
      const points = await evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('.item'));
        const source = rows.find((entry) => entry.dataset.id === ${JSON.stringify(id)});
        const target = rows.find((entry) => entry.dataset.id === ${JSON.stringify(targetId)});
        if (!source || !target) throw new Error('drag rows not found');
        const handle = source.querySelector('.drag-handle');
        const sourceRect = handle.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          from: { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 },
          to: { x: targetRect.left + targetRect.width / 2, y: targetRect.top + 4 },
        };
      })()`);

      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        x: points.from.x,
        y: points.from.y,
      });
      await delay(30);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        buttons: 1,
        x: points.from.x,
        y: points.from.y + 12,
      });
      await delay(50);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        buttons: 1,
        x: points.to.x,
        y: points.to.y,
      });
      await delay(80);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        x: points.to.x,
        y: points.to.y,
      });
      await delay(200);
    };

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
      assert.deepEqual(snap.groups, []);
      assert.equal(snap.emptyVisible, true);
      assert.match(snap.emptyText, /Your list is empty/);
      assert.equal(snap.clearCheckedDisabled, true);
      assert.equal(snap.clearListDisabled, true);
      assert.equal(snap.legacyStored, null);

      const addInput = await evaluate(`(() => {
        const input = document.querySelector('#new-item');
        const placeholder = getComputedStyle(input, '::placeholder');
        return {
          placeholder: input.placeholder,
          value: input.value,
          placeholderColor: placeholder.color,
          placeholderOpacity: placeholder.opacity,
          fontSize: placeholder.fontSize,
        };
      })()`);
      assert.equal(addInput.placeholder, 'Add an item…');
      assert.equal(addInput.value, '');
      assert.notEqual(addInput.placeholderColor, 'rgba(0, 0, 0, 0)');

      const filters = Object.fromEntries(snap.filters.map((filter) => [filter.filter, filter]));
      assert.deepEqual(Object.keys(filters), ['all', 'to-buy', 'bought', 'substituted', 'skipped']);
      assert.equal(filters.all.pressed, true);
      for (const filter of snap.filters) assert.equal(filter.count, 0);
    });

    await step('adds items in order with quantity 1 and To buy status', async () => {
      await addItem('Milk');
      const first = await snapshot();
      assert.equal(first.summary, '1 item to buy');
      assert.deepEqual(groupTexts(first, 'to-buy'), ['Milk']);
      assert.equal(groupOf(first, 'to-buy').count, '1');
      assert.equal(rowByText(first, 'Milk').qty, 1);
      assert.equal(rowByText(first, 'Milk').checked, false);

      await addItem('   Eggs   ');
      await addItem('Bread');
      await addItem('Coffee');

      const snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Milk', 'Eggs', 'Bread', 'Coffee']);
      assert.equal(snap.summary, '4 items to buy');
      assert.equal(snap.emptyVisible, false);
      assert.equal(snap.clearListDisabled, false);
      assert.equal(snap.clearCheckedDisabled, true);
      assert.equal(snap.stored.items.length, 4);
      assert.ok(snap.stored.items.every((item) => item.qty === 1 && item.status === 'to-buy'));

      await addItem('     ');
      assert.equal(allRows(await snapshot()).length, 4, 'blank submissions must be ignored');
    });

    await step('does not expose quantity controls outside edit mode', async () => {
      const snap = await snapshot();
      assert.equal(snap.qtyControls, 0);
      assert.equal(snap.editing, null);
    });

    await step('changes quantity with the up/down arrows in edit mode', async () => {
      const milkId = await idFor('Milk');
      await editItem(milkId);

      let snap = await snapshot();
      assert.deepEqual(snap.editing, {
        text: 'Milk',
        qty: 1,
        selectedStatus: 'to-buy',
        upDisabled: false,
        downDisabled: true,
        focused: true,
      });

      await clickQty('up', 2);
      snap = await snapshot();
      assert.equal(snap.editing.qty, 3);
      assert.equal(snap.editing.downDisabled, false);

      await clickSave();
      snap = await snapshot();
      assert.equal(snap.editing, null);
      assert.equal(rowByText(snap, 'Milk').qty, 3);
      assert.equal(snap.stored.items.find((item) => item.text === 'Milk').qty, 3);
    });

    await step('changes status in edit mode and moves the item to its group', async () => {
      const eggsId = await idFor('Eggs');
      await editItem(eggsId);
      assert.equal((await snapshot()).editing.selectedStatus, 'to-buy');
      await chooseStatus('bought');
      assert.equal((await snapshot()).editing.selectedStatus, 'bought');
      await clickSave();

      const snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Milk', 'Bread', 'Coffee']);
      assert.deepEqual(groupTexts(snap, 'bought'), ['Eggs']);
      assert.equal(snap.summary, '1 of 4 checked');
      assert.equal(rowByText(snap, 'Eggs').checked, true);
      assert.equal(rowByText(snap, 'Eggs').qty, 1);
      assert.equal(snap.clearCheckedDisabled, false);
      assert.equal(snap.filters.find((filter) => filter.filter === 'bought').count, 1);
    });

    await step('filters by every status and returns to All', async () => {
      await selectFilter('bought');
      let snap = await snapshot();
      assert.deepEqual(snap.groups.map((group) => group.status), ['bought']);
      assert.equal(snap.emptyVisible, false);
      assert.equal(snap.filters.find((filter) => filter.filter === 'bought').pressed, true);

      await selectFilter('substituted');
      snap = await snapshot();
      assert.deepEqual(snap.groups, []);
      assert.equal(snap.emptyVisible, true);
      assert.equal(snap.emptyText, 'No substituted items.');
      assert.equal(snap.summary, '1 of 4 checked', 'summary stays global');

      await selectFilter('to-buy');
      snap = await snapshot();
      assert.deepEqual(snap.groups.map((group) => group.status), ['to-buy']);

      await selectFilter('all');
      snap = await snapshot();
      assert.deepEqual(snap.groups.map((group) => group.status), ['to-buy', 'bought']);
      assert.equal(snap.filters.find((filter) => filter.filter === 'all').pressed, true);
    });

    await step('reorders items with the keyboard reorder handle', async () => {
      let snap = await snapshot();
      const milkId = rowByText(snap, 'Milk').id;

      await reorderByKeyboard(milkId, 'ArrowDown');
      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Bread', 'Milk', 'Coffee']);

      await reorderByKeyboard(milkId, 'ArrowDown');
      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Bread', 'Coffee', 'Milk']);

      await reorderByKeyboard(milkId, 'ArrowUp');
      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Bread', 'Milk', 'Coffee']);

      const stored = snap.stored.items.map((item) => item.text);
      assert.deepEqual(stored, ['Bread', 'Eggs', 'Milk', 'Coffee'], 'the order is persisted');
    });

    await step('reorders items with a pointer drag', async () => {
      let snap = await snapshot();
      const coffeeId = rowByText(snap, 'Coffee').id;
      const breadId = rowByText(snap, 'Bread').id;

      await dragItem(coffeeId, breadId);

      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Coffee', 'Bread', 'Milk']);
      assert.deepEqual(snap.groups.find((group) => group.status === 'bought').items.map((row) => row.text), ['Eggs']);
      assert.deepEqual(
        snap.stored.items.map((item) => item.text),
        ['Coffee', 'Eggs', 'Bread', 'Milk'],
      );
    });

    await step('edits text with Enter/Escape and keeps blank edits out', async () => {
      const breadId = await idFor('Bread');
      await editItem(breadId);
      await setEditText('Sourdough bread');
      await pressEditKey('Enter');
      assert.deepEqual(groupTexts(await snapshot(), 'to-buy'), ['Coffee', 'Sourdough bread', 'Milk']);

      const sourdoughId = await idFor('Sourdough bread');
      await editItem(sourdoughId);
      await setEditText('Wholemeal bread');
      await pressEditKey('Escape');
      assert.deepEqual(groupTexts(await snapshot(), 'to-buy'), ['Coffee', 'Sourdough bread', 'Milk']);

      await editItem(sourdoughId);
      await setEditText('    ');
      await clickSave();
      const snap = await snapshot();
      assert.ok(rowByText(snap, 'Sourdough bread'));
      assert.equal(snap.stored.items.length, 4);
    });

    await step('supports substituted and skipped statuses, plus completion', async () => {
      const milkId = await idFor('Milk');
      await editItem(milkId);
      await chooseStatus('substituted');
      await clickSave();

      const sourdoughId = await idFor('Sourdough bread');
      await editItem(sourdoughId);
      await chooseStatus('skipped');
      await clickSave();

      let snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Coffee']);
      assert.deepEqual(groupTexts(snap, 'bought'), ['Eggs']);
      assert.deepEqual(groupTexts(snap, 'substituted'), ['Milk']);
      assert.deepEqual(groupTexts(snap, 'skipped'), ['Sourdough bread']);
      assert.equal(snap.summary, '3 of 4 checked');
      assert.equal(rowByText(snap, 'Milk').qty, 3);

      const coffeeId = rowByText(snap, 'Coffee').id;
      await toggleItem(coffeeId);
      snap = await snapshot();
      assert.deepEqual(snap.groups.map((group) => group.status), ['bought', 'substituted', 'skipped']);
      assert.equal(snap.summary, '4 of 4 checked');
      assert.equal(snap.emptyVisible, true);
      assert.match(snap.emptyText, /All done/);

      await toggleItem(coffeeId);
      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Coffee']);
      assert.equal(snap.summary, '3 of 4 checked');
    });

    await step('clears checked items and restores them with Undo', async () => {
      await clearChecked();

      let snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Coffee']);
      assert.equal(allRows(snap).length, 1);
      assert.equal(snap.snackbarVisible, true);
      assert.equal(snap.snackbarText, 'Cleared 3 checked items');
      assert.equal(snap.undoVisible, true);
      assert.equal(snap.clearCheckedDisabled, true);

      await undo();
      await delay(350);
      snap = await snapshot();
      assert.deepEqual(
        allRows(snap).map((row) => [row.text, row.status, row.qty]),
        [
          ['Coffee', 'to-buy', 1],
          ['Eggs', 'bought', 1],
          ['Milk', 'substituted', 3],
          ['Sourdough bread', 'skipped', 1],
        ],
      );
      assert.deepEqual(
        snap.stored.items.map((item) => [item.text, item.status, item.qty]),
        [
          ['Coffee', 'to-buy', 1],
          ['Eggs', 'bought', 1],
          ['Sourdough bread', 'skipped', 1],
          ['Milk', 'substituted', 3],
        ],
        'the original positions are restored',
      );
      assert.equal(snap.snackbarVisible, false);
      assert.equal(snap.summary, '3 of 4 checked');
    });

    await step('clears the whole list and restores it with Undo', async () => {
      await clearList();

      let snap = await snapshot();
      assert.deepEqual(snap.groups, []);
      assert.equal(snap.emptyVisible, true);
      assert.match(snap.emptyText, /Your list is empty/);
      assert.equal(snap.snackbarText, 'Cleared all 4 items');
      assert.equal(snap.clearListDisabled, true);
      assert.equal(snap.clearCheckedDisabled, true);

      await undo();
      await delay(350);
      snap = await snapshot();
      assert.deepEqual(
        allRows(snap).map((row) => [row.text, row.status, row.qty]),
        [
          ['Coffee', 'to-buy', 1],
          ['Eggs', 'bought', 1],
          ['Milk', 'substituted', 3],
          ['Sourdough bread', 'skipped', 1],
        ],
      );
      assert.deepEqual(
        snap.stored.items.map((item) => [item.text, item.status, item.qty]),
        [
          ['Coffee', 'to-buy', 1],
          ['Eggs', 'bought', 1],
          ['Sourdough bread', 'skipped', 1],
          ['Milk', 'substituted', 3],
        ],
      );
      assert.equal(snap.snackbarVisible, false);
    });

    await step('deletes one item and Undo restores its position', async () => {
      const coffeeId = await idFor('Coffee');
      await deleteItem(coffeeId);

      let snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), []);
      assert.equal(allRows(snap).length, 3);
      assert.match(snap.snackbarText, /Deleted “Coffee”/);

      await undo();
      await delay(350);
      snap = await snapshot();
      assert.deepEqual(allRows(snap).map((row) => row.text), [
        'Coffee',
        'Eggs',
        'Milk',
        'Sourdough bread',
      ]);
      assert.deepEqual(
        snap.stored.items.map((item) => item.text),
        ['Coffee', 'Eggs', 'Sourdough bread', 'Milk'],
      );
      assert.equal(snap.snackbarVisible, false);
    });

    await step('renders item text literally, with no HTML injection', async () => {
      const payload = '<img src=x onerror="window.__xss = 1">';
      await addItem(payload);

      const snap = await snapshot();
      assert.equal(rowByText(snap, payload).text, payload);
      assert.equal(await evaluate(`document.querySelectorAll('#groups img').length`), 0);
      assert.equal(await evaluate(`typeof window.__xss`), 'undefined');

      const payloadId = rowByText(snap, payload).id;
      await deleteItem(payloadId);
      await delay(250);
    });

    await step('persists quantities, statuses, and order across a reload', async () => {
      const before = await snapshot();

      await reload();

      const after = await snapshot();
      assert.equal(after.summary, before.summary);
      assert.deepEqual(
        allRows(after).map((row) => [row.text, row.status, row.qty]),
        allRows(before).map((row) => [row.text, row.status, row.qty]),
      );
      assert.equal(after.filters.find((filter) => filter.filter === 'all').pressed, true);
      assert.equal(after.editing, null);
      assert.equal(after.snackbarVisible, false);
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

      assert.deepEqual(sw, { supported: true, ready: true, active: true, controller: true });

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

    await step('is installable as a PWA', async () => {
      const appManifest = await cdp.send('Page.getAppManifest');
      assert.equal(appManifest.errors?.length ?? 0, 0, 'manifest must parse without errors');
      assert.match(appManifest.url, /manifest\.webmanifest$/);

      const { installabilityErrors = [] } = await cdp.send('Page.getInstallabilityErrors');
      assert.deepEqual(installabilityErrors, []);
    });

    await step('loads and renders without console errors or failed requests', async () => {
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(failedRequests, []);
    });

    await step('still works offline, with quantities, statuses, and order intact', async () => {
      const before = await snapshot();

      await cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });

      try {
        await reload();

        const snap = await snapshot();
        assert.deepEqual(
          allRows(snap).map((row) => [row.text, row.status, row.qty]),
          allRows(before).map((row) => [row.text, row.status, row.qty]),
        );
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

    await step('fits a phone with 44px tap targets in both list and edit modes', async () => {
      const layout = await evaluate(`(() => {
        const selectors = '.filter-chip, .text-btn, .check, .icon-btn, .add-btn';
        const visible = (element) => element.offsetParent !== null && !element.disabled;
        const controls = Array.from(document.querySelectorAll(selectors))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.className || element.id,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          inputFontSize: parseFloat(getComputedStyle(document.querySelector('#new-item')).fontSize),
          controls,
        };
      })()`);

      assert.ok(layout.scrollWidth <= layout.innerWidth, `overflow in list view: ${layout.scrollWidth} > ${layout.innerWidth}`);
      assert.ok(layout.inputFontSize >= 16);
      assert.ok(layout.controls.length >= 6);
      for (const control of layout.controls) {
        assert.ok(control.height >= 44, `${control.name} is ${control.height}px tall`);
        assert.ok(control.width >= 44, `${control.name} is ${control.width}px wide`);
      }

      const coffeeId = await idFor('Coffee');
      await editItem(coffeeId);

      const editLayout = await evaluate(`(() => {
        const selectors = '.qty-btn:not(:disabled), .status-option, .btn-save, .btn-cancel';
        const controls = Array.from(document.querySelectorAll(selectors)).map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            name: element.className || element.id,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          editFontSize: parseFloat(getComputedStyle(document.querySelector('.edit-input')).fontSize),
          controls,
        };
      })()`);

      assert.ok(editLayout.scrollWidth <= editLayout.innerWidth, `overflow in edit view: ${editLayout.scrollWidth} > ${editLayout.innerWidth}`);
      assert.ok(editLayout.editFontSize >= 16);
      assert.ok(editLayout.controls.length >= 5);
      for (const control of editLayout.controls) {
        assert.ok(control.height >= 44, `${control.name} is ${control.height}px tall`);
        assert.ok(control.width >= 44, `${control.name} is ${control.width}px wide`);
      }

      await clickCancel();
    });

    await step('fits a narrow 320px phone, including edit mode', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 700,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await delay(150);

      let layout = await evaluate(`({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })`);
      assert.ok(layout.scrollWidth <= layout.innerWidth, `overflow: ${layout.scrollWidth} > ${layout.innerWidth}`);

      const coffeeId = await idFor('Coffee');
      await editItem(coffeeId);
      layout = await evaluate(`({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })`);
      assert.ok(layout.scrollWidth <= layout.innerWidth, `overflow in edit mode: ${layout.scrollWidth} > ${layout.innerWidth}`);
      await clickCancel();

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await delay(150);
    });

    await step('migrates a v1 list automatically', async () => {
      await evaluate(`localStorage.clear(); localStorage.setItem(${JSON.stringify(LEGACY_KEY)}, JSON.stringify({
        version: 1,
        items: [
          { id: 'old-1', text: 'Legacy milk', done: true, createdAt: 5 },
          { id: 'old-2', text: 'Legacy eggs', done: false, createdAt: 6 }
        ]
      }))`);
      await reload();

      let snap = await snapshot();
      assert.equal(snap.stored, null, 'v2 is not written until the next change');
      assert.ok(snap.legacyStored, 'the legacy copy is still present before a save');
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Legacy eggs']);
      assert.deepEqual(groupTexts(snap, 'bought'), ['Legacy milk']);
      assert.equal(snap.summary, '1 of 2 checked');
      assert.equal(rowByText(snap, 'Legacy milk').qty, 1);

      await addItem('Legacy apples');
      snap = await snapshot();
      assert.equal(snap.stored.items.length, 3);
      assert.equal(snap.legacyStored, null, 'the legacy key is cleaned up after saving');
      assert.equal(rowByText(snap, 'Legacy apples').status, 'to-buy');
    });

    await step('recovers gracefully from corrupt local storage', async () => {
      await evaluate(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, '{{{not json')`);
      await reload();

      let snap = await snapshot();
      assert.deepEqual(snap.groups, []);
      assert.equal(snap.summary, 'Nothing on your list yet');
      assert.equal(snap.emptyVisible, true);

      await addItem('Apples');
      snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Apples']);
      assert.equal(snap.stored.items.length, 1);
    });

    await step('renders realistic light and dark screenshots', async () => {
      await evaluate(`localStorage.clear()`);
      await reload();

      for (const text of ['Milk', 'Eggs', 'Sourdough bread', 'Bananas', 'Coffee beans']) {
        await addItem(text);
      }

      const milkId = await idFor('Milk');
      await editItem(milkId);
      await setEditorQty(3);
      await chooseStatus('bought');
      await clickSave();

      const eggsId = await idFor('Eggs');
      await editItem(eggsId);
      await chooseStatus('substituted');
      await clickSave();

      const bananasId = await idFor('Bananas');
      await editItem(bananasId);
      await chooseStatus('skipped');
      await clickSave();

      const coffeeId = await idFor('Coffee beans');
      await editItem(coffeeId);
      await setEditorQty(2);
      await clickSave();

      const snap = await snapshot();
      assert.deepEqual(groupTexts(snap, 'to-buy'), ['Sourdough bread', 'Coffee beans']);
      assert.deepEqual(groupTexts(snap, 'bought'), ['Milk']);
      assert.deepEqual(groupTexts(snap, 'substituted'), ['Eggs']);
      assert.deepEqual(groupTexts(snap, 'skipped'), ['Bananas']);
      assert.equal(snap.summary, '3 of 5 checked');

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 960,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await delay(150);

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
      await evaluate(`document.activeElement && document.activeElement.blur()`);
      await delay(150);
      await screenshot('screenshot-light.png');

      const coffeeBeansId = await idFor('Coffee beans');
      await editItem(coffeeBeansId);
      await delay(200);
      await screenshot('screenshot-edit.png');
      await clickCancel();
      await evaluate(`document.activeElement && document.activeElement.blur()`);

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
      await delay(150);
      await screenshot('screenshot-dark.png');

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
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
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
