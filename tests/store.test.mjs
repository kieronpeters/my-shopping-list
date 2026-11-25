import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_STORAGE_KEY,
  MAX_ITEM_LENGTH,
  MAX_QUANTITY,
  MIN_QUANTITY,
  STATUSES,
  STORAGE_KEY,
  addItem,
  cleanQuantity,
  cleanText,
  counts,
  emptyState,
  insertItem,
  insertMany,
  loadState,
  moveWithinGroup,
  parseState,
  removeItem,
  removeMany,
  reorderGroup,
  saveState,
  serializeState,
  setStatus,
  toggleChecked,
  updateItem,
} from '../store.js';

function withItems(...texts) {
  let state = emptyState();
  for (const text of texts) state = addItem(state, text).state;
  return state;
}

function idOf(state, text) {
  return state.items.find((item) => item.text === text).id;
}

function textsOf(state) {
  return state.items.map((item) => item.text);
}

function useFakeStorage(initial = {}) {
  const backing = new Map(Object.entries(initial));
  const removed = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => {
      backing.set(key, String(value));
    },
    removeItem: (key) => {
      removed.push(key);
      backing.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    configurable: true,
    writable: true,
  });
  return {
    backing,
    removed,
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

test('cleanQuantity clamps to whole numbers between 1 and 99', () => {
  assert.equal(cleanQuantity(1), 1);
  assert.equal(cleanQuantity(7), 7);
  assert.equal(cleanQuantity('12'), 12);
  assert.equal(cleanQuantity(2.9), 2);
  assert.equal(cleanQuantity(0), MIN_QUANTITY);
  assert.equal(cleanQuantity(-4), MIN_QUANTITY);
  assert.equal(cleanQuantity(1000), MAX_QUANTITY);
  assert.equal(cleanQuantity('lots'), MIN_QUANTITY);
  assert.equal(cleanQuantity(undefined), MIN_QUANTITY);
  assert.equal(cleanQuantity(null), MIN_QUANTITY);
});

test('addItem defaults to one unit with the To buy status', () => {
  const state = emptyState();
  const { state: next, item } = addItem(state, '  Milk  ');

  assert.equal(state.items.length, 0);
  assert.equal(item.text, 'Milk');
  assert.equal(item.qty, MIN_QUANTITY);
  assert.equal(item.status, 'to-buy');
  assert.equal(typeof item.id, 'string');
  assert.ok(item.id.length > 0);
  assert.equal(typeof item.createdAt, 'number');
  assert.equal(next.items[0], item);
});

test('addItem accepts quantity and status options and keeps insertion order', () => {
  let state = emptyState();
  state = addItem(state, 'Milk', { qty: 3, status: 'bought' }).state;
  state = addItem(state, 'Eggs', { qty: '2' }).state;

  assert.deepEqual(textsOf(state), ['Milk', 'Eggs']);
  assert.equal(state.items[0].qty, 3);
  assert.equal(state.items[0].status, 'bought');
  assert.equal(state.items[1].qty, 2);
  assert.equal(state.items[1].status, 'to-buy');
});

test('addItem rejects blank input and invalid options', () => {
  const state = emptyState();
  for (const bad of ['', '   ', '\n\t', null, undefined]) {
    const result = addItem(state, bad);
    assert.equal(result.item, null);
    assert.equal(result.state, state);
  }

  const { item } = addItem(state, 'Milk', { qty: 0, status: 'nonsense' });
  assert.equal(item.qty, MIN_QUANTITY);
  assert.equal(item.status, 'to-buy');
});

test('updateItem edits text, quantity, and status without mutating the old state', () => {
  const state = withItems('Eggs', 'Milk');
  const id = idOf(state, 'Eggs');

  const updated = updateItem(state, id, {
    text: '  Free-range   eggs ',
    qty: 4,
    status: 'substituted',
  });
  assert.equal(updated.items[0].text, 'Free-range eggs');
  assert.equal(updated.items[0].qty, 4);
  assert.equal(updated.items[0].status, 'substituted');
  assert.equal(state.items[0].text, 'Eggs');
  assert.equal(state.items[0].qty, 1);
  assert.equal(state.items[0].status, 'to-buy');

  assert.equal(updateItem(state, id, { text: '   ' }), state);
  assert.equal(updateItem(state, id, { text: 'Eggs' }), state);
  assert.equal(updateItem(state, id, { qty: 1 }), state);
  assert.equal(updateItem(state, id, { status: 'nonsense' }), state);
  assert.equal(updateItem(state, 'missing', { text: 'Something' }), state);
});

test('updateItem clamps quantities and ignores invalid statuses', () => {
  const state = withItems('Milk');
  const id = idOf(state, 'Milk');

  const big = updateItem(state, id, { qty: 500 });
  assert.equal(big.items[0].qty, MAX_QUANTITY);

  const small = updateItem(state, id, { qty: 0 });
  assert.equal(small.items[0].qty, MIN_QUANTITY);

  const invalidStatus = updateItem(state, id, { status: 'lost' });
  assert.equal(invalidStatus, state);
});

test('setStatus accepts known statuses only', () => {
  const state = withItems('Milk');
  const id = idOf(state, 'Milk');

  for (const status of STATUSES) {
    const next = setStatus(state, id, status);
    assert.equal(next.items[0].status, status);
  }
  assert.equal(setStatus(state, id, 'nonsense'), state);
});

test('toggleChecked marks bought and unchecks any completed status', () => {
  let state = withItems('Milk');
  const id = idOf(state, 'Milk');

  state = toggleChecked(state, id);
  assert.equal(state.items[0].status, 'bought');

  state = setStatus(state, id, 'substituted');
  state = toggleChecked(state, id);
  assert.equal(state.items[0].status, 'to-buy');

  state = setStatus(state, id, 'skipped');
  state = toggleChecked(state, id);
  assert.equal(state.items[0].status, 'to-buy');

  assert.equal(toggleChecked(state, 'missing'), state);
});

test('removeItem reports the removed item and its original index', () => {
  const state = withItems('Milk', 'Eggs', 'Bread');
  const middle = state.items[1];

  const result = removeItem(state, middle.id);
  assert.deepEqual(result.removed, { item: middle, index: 1 });
  assert.deepEqual(textsOf(result.state), ['Milk', 'Bread']);
  assert.equal(state.items.length, 3);

  const missing = removeItem(state, 'nope');
  assert.equal(missing.removed, null);
  assert.equal(missing.state, state);
});

test('insertItem restores an item at its original index', () => {
  const state = withItems('Milk', 'Eggs', 'Bread');
  const removed = removeItem(state, state.items[1].id);

  const restored = insertItem(removed.state, removed.removed.item, removed.removed.index);
  assert.deepEqual(textsOf(restored), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(textsOf(removed.state), ['Milk', 'Bread']);

  const clamped = insertItem(emptyState(), { id: 'x', text: 'Last', qty: 1, status: 'to-buy', createdAt: 1 }, 99);
  assert.equal(clamped.items.length, 1);
  assert.equal(clamped.items[0].text, 'Last');
});

test('removeMany and insertMany preserve positions and data', () => {
  let state = withItems('Milk', 'Eggs', 'Bread', 'Coffee');
  state = updateItem(state, idOf(state, 'Eggs'), { status: 'bought', qty: 2 });
  state = updateItem(state, idOf(state, 'Coffee'), { status: 'skipped' });

  const ids = [idOf(state, 'Eggs'), idOf(state, 'Coffee'), 'missing'];
  const result = removeMany(state, ids);

  assert.deepEqual(textsOf(result.state), ['Milk', 'Bread']);
  assert.deepEqual(
    result.removed.map((entry) => [entry.item.text, entry.index]),
    [['Eggs', 1], ['Coffee', 3]],
  );

  const restored = insertMany(result.state, result.removed);
  assert.deepEqual(textsOf(restored), ['Milk', 'Eggs', 'Bread', 'Coffee']);
  assert.equal(restored.items[1].qty, 2);
  assert.equal(restored.items[1].status, 'bought');
  assert.equal(restored.items[3].status, 'skipped');

  assert.deepEqual(removeMany(state, []).removed, []);
  assert.deepEqual(removeMany(state, ['nope']).removed, []);
  assert.equal(insertMany(state, []), state);
});

test('reorderGroup reorders one status without disturbing the others', () => {
  let state = withItems('A', 'B', 'C', 'D');
  state = setStatus(state, idOf(state, 'B'), 'bought');

  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((text) => idOf(state, text));
  const next = reorderGroup(state, 'to-buy', [d, a, c]);

  assert.deepEqual(textsOf(next), ['D', 'B', 'A', 'C']);
  assert.equal(state.items[0].text, 'A', 'the old state is untouched');
  assert.equal(next.items[1].id, b, 'the bought item stays in place');

  assert.equal(reorderGroup(state, 'to-buy', [a, c]), state, 'wrong length is rejected');
  assert.equal(reorderGroup(state, 'to-buy', [a, a, c]), state, 'duplicates are rejected');
  assert.equal(reorderGroup(state, 'to-buy', [a, c, 'nope']), state, 'foreign ids are rejected');
  assert.equal(reorderGroup(state, 'to-buy', [a, c, d]), state, 'the same order is a no-op');
  assert.equal(reorderGroup(state, 'bought', [a]), state, 'ids from another group are rejected');
});

test('moveWithinGroup moves only inside the item status group', () => {
  let state = withItems('A', 'B', 'C');
  state = setStatus(state, idOf(state, 'B'), 'bought');

  const a = idOf(state, 'A');
  const c = idOf(state, 'C');

  const movedUp = moveWithinGroup(state, c, 'up');
  assert.deepEqual(textsOf(movedUp), ['C', 'B', 'A']);

  const movedDown = moveWithinGroup(state, a, 'down');
  assert.deepEqual(textsOf(movedDown), ['C', 'B', 'A']);

  assert.equal(moveWithinGroup(state, a, 'up'), state, 'top boundary');
  assert.equal(moveWithinGroup(state, c, 'down'), state, 'bottom boundary');
  assert.equal(moveWithinGroup(state, idOf(state, 'B'), 'up'), state, 'single-item group');
});

test('counts summarizes checked and per-status totals', () => {
  assert.deepEqual(counts(emptyState()), {
    total: 0,
    checked: 0,
    remaining: 0,
    byStatus: { 'to-buy': 0, bought: 0, substituted: 0, skipped: 0 },
  });

  let state = withItems('Milk', 'Eggs', 'Bread', 'Coffee');
  state = setStatus(state, idOf(state, 'Eggs'), 'bought');
  state = setStatus(state, idOf(state, 'Bread'), 'substituted');
  state = setStatus(state, idOf(state, 'Coffee'), 'skipped');

  assert.deepEqual(counts(state), {
    total: 4,
    checked: 3,
    remaining: 1,
    byStatus: { 'to-buy': 1, bought: 1, substituted: 1, skipped: 1 },
  });
});

test('parseState migrates v1 (done) data and validates v2 data', () => {
  const legacy = JSON.stringify({
    version: 1,
    items: [
      { id: 'a', text: ' Milk ', done: true, createdAt: 5 },
      { id: 'b', text: 'Eggs', done: false },
    ],
  });
  const migrated = parseState(legacy);
  assert.deepEqual(migrated.items, [
    { id: 'a', text: 'Milk', qty: 1, status: 'bought', createdAt: 5 },
    { id: 'b', text: 'Eggs', qty: 1, status: 'to-buy', createdAt: migrated.items[1].createdAt },
  ]);

  const current = JSON.stringify({
    version: 2,
    items: [
      { id: 'c', text: 'Coffee', qty: 4, status: 'substituted', createdAt: 7 },
      { id: 'd', text: 'Tea', qty: 0, status: 'skipped' },
      { id: 'e', text: 'Sugar', qty: 500, status: 'nonsense', done: true },
      { id: 'c', text: 'duplicate' },
      { id: 'f', text: '   ' },
      null,
      'nope',
    ],
  });
  const parsed = parseState(current);
  assert.deepEqual(
    parsed.items.map((item) => [item.text, item.qty, item.status]),
    [
      ['Coffee', 4, 'substituted'],
      ['Tea', 1, 'skipped'],
      ['Sugar', 99, 'bought'],
    ],
  );
});

test('parseState survives missing, corrupt, or hostile stored data', () => {
  for (const bad of [null, undefined, 42, '', '   ', 'not json', '{}', '{"items":{}}', '[]', 'null']) {
    assert.deepEqual(parseState(bad), { version: 2, items: [] });
  }

  const withoutIds = parseState(JSON.stringify({ items: [{ text: 'Bread' }] }));
  assert.equal(withoutIds.items.length, 1);
  assert.equal(withoutIds.items[0].text, 'Bread');
  assert.equal(typeof withoutIds.items[0].id, 'string');
  assert.ok(withoutIds.items[0].id.length > 0);
  assert.equal(withoutIds.items[0].status, 'to-buy');
});

test('serializeState and parseState round-trip', () => {
  let state = withItems('Milk', 'Eggs');
  state = updateItem(state, idOf(state, 'Eggs'), { qty: 6, status: 'bought' });

  const restored = parseState(serializeState(state));
  assert.deepEqual(restored, state);
});

test('loadState reads v2, falls back to legacy v1, and ignores broken storage', () => {
  const current = useFakeStorage({
    [STORAGE_KEY]: JSON.stringify({ version: 2, items: [{ id: 'x', text: 'Milk', qty: 2, status: 'bought' }] }),
    [LEGACY_STORAGE_KEY]: JSON.stringify({ version: 1, items: [{ id: 'y', text: 'Old', done: true }] }),
  });
  try {
    const state = loadState();
    assert.deepEqual(state.items.map((item) => [item.text, item.qty, item.status]), [['Milk', 2, 'bought']]);
  } finally {
    current.restore();
  }

  const legacyOnly = useFakeStorage({
    [LEGACY_STORAGE_KEY]: JSON.stringify({ version: 1, items: [{ id: 'z', text: 'Eggs', done: true }] }),
  });
  try {
    const state = loadState();
    assert.deepEqual(state.items.map((item) => [item.text, item.status]), [['Eggs', 'bought']]);
  } finally {
    legacyOnly.restore();
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
      removeItem() {
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

test('saveState writes v2 and clears the legacy key', () => {
  const storage = useFakeStorage({
    [LEGACY_STORAGE_KEY]: JSON.stringify({ version: 1, items: [{ id: 'a', text: 'Old', done: true }] }),
  });
  try {
    const state = withItems('Milk');
    saveState(state);

    assert.ok(storage.backing.has(STORAGE_KEY));
    assert.equal(storage.backing.has(LEGACY_STORAGE_KEY), false);
    assert.ok(storage.removed.includes(LEGACY_STORAGE_KEY));
    assert.deepEqual(loadState(), state);
  } finally {
    storage.restore();
  }
});
