import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ITEM_LENGTH,
  STORAGE_KEY,
  addItem,
  cleanText,
  counts,
  emptyState,
  insertItem,
  loadState,
  parseState,
  removeItem,
  saveState,
  serializeState,
  toggleItem,
  updateItem,
} from '../store.js';

function withItems(...texts) {
  let state = emptyState();
  for (const text of texts) state = addItem(state, text).state;
  return state;
}

function useFakeStorage(initial = {}) {
  const backing = new Map(Object.entries(initial));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => {
      backing.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    configurable: true,
    writable: true,
  });
  return {
    backing,
    restore() {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete globalThis.localStorage;
    },
  };
}

test('cleanText trims, collapses whitespace, and clamps length', () => {
  assert.equal(cleanText('  Milk   (2 L)  '), 'Milk (2 L)');
  assert.equal(cleanText('a\n b\tc'), 'a b c');
  assert.equal(cleanText(''), '');
  assert.equal(cleanText('   '), '');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(42), '');
  assert.equal(cleanText('x'.repeat(500)).length, MAX_ITEM_LENGTH);
});

test('addItem appends an incomplete item without mutating the old state', () => {
  const state = emptyState();
  const { state: next, item } = addItem(state, '  Milk  ');

  assert.equal(state.items.length, 0);
  assert.equal(next.items.length, 1);
  assert.equal(item.text, 'Milk');
  assert.equal(item.done, false);
  assert.equal(typeof item.id, 'string');
  assert.ok(item.id.length > 0);
  assert.equal(typeof item.createdAt, 'number');
  assert.notEqual(next, state);
});

test('addItem keeps insertion order', () => {
  const state = withItems('Milk', 'Eggs', 'Bread');
  assert.deepEqual(state.items.map((item) => item.text), ['Milk', 'Eggs', 'Bread']);
});

test('addItem rejects blank input', () => {
  const state = emptyState();
  for (const bad of ['', '   ', '\n\t', null, undefined]) {
    const result = addItem(state, bad);
    assert.equal(result.item, null);
    assert.equal(result.state, state);
  }
});

test('updateItem edits text, normalizes it, and never blanks an item', () => {
  const state = withItems('Eggs', 'Milk');
  const id = state.items[0].id;

  const updated = updateItem(state, id, '  Free-range   eggs ');
  assert.equal(updated.items[0].text, 'Free-range eggs');
  assert.equal(updated.items[1].text, 'Milk');
  assert.equal(state.items[0].text, 'Eggs');

  assert.equal(updateItem(state, id, '   '), state);
  assert.equal(updateItem(state, id, 'Eggs'), state);
  assert.equal(updateItem(state, 'missing', 'Something'), state);
});

test('toggleItem flips state or sets it explicitly', () => {
  const state = withItems('Milk');
  const id = state.items[0].id;

  const done = toggleItem(state, id);
  assert.equal(done.items[0].done, true);
  assert.equal(state.items[0].done, false);

  const undone = toggleItem(done, id);
  assert.equal(undone.items[0].done, false);

  const forced = toggleItem(state, id, true);
  assert.equal(forced.items[0].done, true);
  assert.equal(toggleItem(state, 'missing'), state);
});

test('removeItem reports the removed item and its original index', () => {
  const state = withItems('Milk', 'Eggs', 'Bread');
  const middle = state.items[1];

  const result = removeItem(state, middle.id);
  assert.deepEqual(result.removed, { item: middle, index: 1 });
  assert.deepEqual(result.state.items.map((item) => item.text), ['Milk', 'Bread']);
  assert.equal(state.items.length, 3);

  const missing = removeItem(state, 'nope');
  assert.equal(missing.removed, null);
  assert.equal(missing.state, state);
});

test('insertItem restores an item at its original index', () => {
  const state = withItems('Milk', 'Eggs', 'Bread');
  const removed = removeItem(state, state.items[1].id);

  const restored = insertItem(removed.state, removed.removed.item, removed.removed.index);
  assert.deepEqual(restored.items.map((item) => item.text), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(removed.state.items.map((item) => item.text), ['Milk', 'Bread']);

  const clamped = insertItem(emptyState(), { id: 'x', text: 'Last', done: false, createdAt: 1 }, 99);
  assert.equal(clamped.items.length, 1);
  assert.equal(clamped.items[0].text, 'Last');
});

test('counts summarizes total, purchased, and remaining items', () => {
  assert.deepEqual(counts(emptyState()), { total: 0, done: 0, remaining: 0 });

  let state = withItems('Milk', 'Eggs', 'Bread');
  state = toggleItem(state, state.items[0].id);
  assert.deepEqual(counts(state), { total: 3, done: 1, remaining: 2 });
});

test('parseState survives missing, corrupt, or hostile stored data', () => {
  for (const bad of [null, undefined, 42, '', '   ', 'not json', '{}', '{"items":{}}', '[]', 'null']) {
    assert.deepEqual(parseState(bad), { version: 1, items: [] });
  }

  const json = JSON.stringify({
    version: 99,
    items: [
      { id: 'a', text: ' Milk ', done: true, createdAt: 5 },
      { id: 'a', text: 'duplicate id' },
      { id: 'b', text: '   ' },
      null,
      'nope',
      { id: 'c', text: 'Eggs', done: 'yes' },
      { text: 'Bread' },
    ],
  });

  const state = parseState(json);
  assert.equal(state.items.length, 3);
  assert.deepEqual(state.items[0], { id: 'a', text: 'Milk', done: true, createdAt: 5 });
  assert.equal(state.items[1].id, 'c');
  assert.equal(state.items[1].done, false);
  assert.equal(state.items[2].text, 'Bread');
  assert.equal(typeof state.items[2].id, 'string');
  assert.ok(state.items[2].id.length > 0);
  assert.equal(state.items[2].done, false);
  assert.equal(typeof state.items[2].createdAt, 'number');
});

test('serializeState and parseState round-trip', () => {
  const state = withItems('Milk', 'Eggs');
  state.items[1] = { ...state.items[1], done: true };

  const restored = parseState(serializeState(state));
  assert.deepEqual(restored, state);
});

test('loadState and saveState persist through the storage key', () => {
  const storage = useFakeStorage();
  try {
    const state = withItems('Milk', 'Eggs');
    saveState(state);

    assert.ok(storage.backing.has(STORAGE_KEY));
    const loaded = loadState();
    assert.deepEqual(loaded, state);
  } finally {
    storage.restore();
  }
});

test('loadState returns an empty list when storage is unavailable or throws', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    assert.deepEqual(loadState(), emptyState());

    const state = withItems('Milk');
    assert.throws(() => saveState(state), /blocked/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
