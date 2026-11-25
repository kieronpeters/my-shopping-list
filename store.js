/**
 * Pure list logic and persistence helpers for My Shopping List.
 * No DOM access here, so this module is unit-testable in Node.
 */

export const STORAGE_KEY = 'my-shopping-list:v1';
export const SCHEMA_VERSION = 1;
export const MAX_ITEM_LENGTH = 200;

export function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Trim, collapse inner whitespace, and clamp the text to the maximum length. */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_LENGTH);
}

export function emptyState() {
  return { version: SCHEMA_VERSION, items: [] };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : createId(),
    text,
    done: raw.done === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Parse stored JSON into a valid state. Never throws; bad data yields an empty list. */
export function parseState(json) {
  if (typeof json !== 'string' || json.trim() === '') return emptyState();

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return emptyState();
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return emptyState();

  const seen = new Set();
  const items = [];
  for (const raw of data.items) {
    const item = normalizeItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { version: SCHEMA_VERSION, items };
}

export function serializeState(state) {
  return JSON.stringify({ version: SCHEMA_VERSION, items: state.items });
}

export function loadState() {
  try {
    return parseState(globalThis.localStorage.getItem(STORAGE_KEY));
  } catch {
    return emptyState();
  }
}

/** Persist state. Throws when storage is unavailable or full; callers decide how to react. */
export function saveState(state) {
  globalThis.localStorage.setItem(STORAGE_KEY, serializeState(state));
}

export function addItem(state, text) {
  const clean = cleanText(text);
  if (!clean) return { state, item: null };

  const item = { id: createId(), text: clean, done: false, createdAt: Date.now() };
  return { state: { ...state, items: [...state.items, item] }, item };
}

export function updateItem(state, id, text) {
  const clean = cleanText(text);
  if (!clean) return state;

  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== id || item.text === clean) return item;
    changed = true;
    return { ...item, text: clean };
  });
  return changed ? { ...state, items } : state;
}

export function toggleItem(state, id, done) {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    const next = typeof done === 'boolean' ? done : !item.done;
    if (next === item.done) return item;
    changed = true;
    return { ...item, done: next };
  });
  return changed ? { ...state, items } : state;
}

export function removeItem(state, id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) return { state, removed: null };

  const removed = { item: { ...state.items[index] }, index };
  const items = state.items.filter((_, i) => i !== index);
  return { state: { ...state, items }, removed };
}

/** Put a removed item back at its original position (used by Undo). */
export function insertItem(state, item, index) {
  const items = [...state.items];
  const max = items.length;
  const at = Number.isInteger(index) ? Math.min(Math.max(index, 0), max) : max;
  items.splice(at, 0, { ...item });
  return { ...state, items };
}

export function counts(state) {
  const total = state.items.length;
  let done = 0;
  for (const item of state.items) if (item.done) done += 1;
  return { total, done, remaining: total - done };
}
