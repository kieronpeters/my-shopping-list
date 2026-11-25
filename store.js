/**
 * Pure list logic and persistence helpers for My Shopping List.
 * No DOM access here, so this module is unit-testable in Node.
 */

export const STORAGE_KEY = 'my-shopping-list:v2';
export const LEGACY_STORAGE_KEY = 'my-shopping-list:v1';
export const SCHEMA_VERSION = 2;
export const MAX_ITEM_LENGTH = 200;
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 99;

export const STATUSES = Object.freeze(['to-buy', 'bought', 'substituted', 'skipped']);

export const STATUS_LABELS = Object.freeze({
  'to-buy': 'To buy',
  bought: 'Bought',
  substituted: 'Substituted',
  skipped: 'Skipped',
});

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

/** Clamp a quantity to a whole number between MIN_QUANTITY and MAX_QUANTITY. */
export function cleanQuantity(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return MIN_QUANTITY;
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(number)));
}

export function isValidStatus(value) {
  return STATUSES.includes(value);
}

export function emptyState() {
  return { version: SCHEMA_VERSION, items: [] };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;

  let status = isValidStatus(raw.status) ? raw.status : null;
  if (!status) status = raw.done === true ? 'bought' : 'to-buy';

  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : createId(),
    text,
    qty: cleanQuantity(raw.qty ?? MIN_QUANTITY),
    status,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Parse stored JSON (v1 or v2) into a valid v2 state. Never throws. */
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
    const storage = globalThis.localStorage;
    const current = storage.getItem(STORAGE_KEY);
    if (current !== null) return parseState(current);

    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) return parseState(legacy);

    return emptyState();
  } catch {
    return emptyState();
  }
}

/** Persist state. Throws when storage is unavailable or full; callers decide how to react. */
export function saveState(state) {
  const storage = globalThis.localStorage;
  storage.setItem(STORAGE_KEY, serializeState(state));
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* Cleaning up the old copy is optional. */
  }
}

export function addItem(state, text, options = {}) {
  const clean = cleanText(text);
  if (!clean) return { state, item: null };

  const item = {
    id: createId(),
    text: clean,
    qty: cleanQuantity(options.qty ?? MIN_QUANTITY),
    status: isValidStatus(options.status) ? options.status : 'to-buy',
    createdAt: Date.now(),
  };
  return { state: { ...state, items: [...state.items, item] }, item };
}

/**
 * Update one item. The patch may contain text, qty, and/or status.
 * Blank text and invalid statuses are ignored, so an item can never be emptied.
 */
export function updateItem(state, id, patch = {}) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1 || !patch || typeof patch !== 'object') return state;

  const current = state.items[index];
  const next = { ...current };

  if (patch.text !== undefined) {
    const text = cleanText(patch.text);
    if (text) next.text = text;
  }
  if (patch.qty !== undefined) next.qty = cleanQuantity(patch.qty);
  if (patch.status !== undefined && isValidStatus(patch.status)) next.status = patch.status;

  if (next.text === current.text && next.qty === current.qty && next.status === current.status) {
    return state;
  }

  const items = [...state.items];
  items[index] = next;
  return { ...state, items };
}

export function setStatus(state, id, status) {
  if (!isValidStatus(status)) return state;
  return updateItem(state, id, { status });
}

/** Tap the circle: to-buy becomes bought; anything checked becomes to-buy again. */
export function toggleChecked(state, id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return state;
  return setStatus(state, id, item.status === 'to-buy' ? 'bought' : 'to-buy');
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

/** Remove many items at once, remembering where each one lived. */
export function removeMany(state, ids) {
  const wanted = new Set(ids);
  if (wanted.size === 0) return { state, removed: [] };

  const removed = [];
  const items = [];
  state.items.forEach((item, index) => {
    if (wanted.has(item.id)) removed.push({ item: { ...item }, index });
    else items.push(item);
  });

  if (removed.length === 0) return { state, removed: [] };
  return { state: { ...state, items }, removed };
}

/** Restore entries produced by removeMany; original indices keep the order. */
export function insertMany(state, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return state;

  const items = [...state.items];
  const sorted = [...entries].sort((a, b) => a.index - b.index);
  for (const entry of sorted) {
    if (!entry || !entry.item) continue;
    const at = Number.isInteger(entry.index)
      ? Math.min(Math.max(entry.index, 0), items.length)
      : items.length;
    items.splice(at, 0, { ...entry.item });
  }
  return { ...state, items };
}

/**
 * Reorder the items of one status without disturbing other statuses.
 * The new ids are placed into the positions that group already occupied.
 */
export function reorderGroup(state, status, orderedIds) {
  if (!isValidStatus(status) || !Array.isArray(orderedIds)) return state;

  const positions = [];
  state.items.forEach((item, index) => {
    if (item.status === status) positions.push(index);
  });
  if (positions.length !== orderedIds.length) return state;
  if (new Set(orderedIds).size !== orderedIds.length) return state;

  const groupItems = positions.map((index) => state.items[index]);
  const groupIds = new Set(groupItems.map((item) => item.id));
  if (orderedIds.some((id) => !groupIds.has(id))) return state;
  if (orderedIds.every((id, i) => groupItems[i].id === id)) return state;

  const byId = new Map(state.items.map((item) => [item.id, item]));
  const items = [...state.items];
  positions.forEach((position, i) => {
    items[position] = byId.get(orderedIds[i]);
  });
  return { ...state, items };
}

/** Move an item one place up or down within its own status group. */
export function moveWithinGroup(state, id, direction) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return state;

  const group = state.items
    .filter((entry) => entry.status === item.status)
    .map((entry) => entry.id);
  const from = group.indexOf(id);
  const step = direction === 'up' ? -1 : 1;
  const to = from + step;
  if (from === -1 || to < 0 || to >= group.length) return state;

  [group[from], group[to]] = [group[to], group[from]];
  return reorderGroup(state, item.status, group);
}

export function counts(state) {
  const byStatus = { 'to-buy': 0, bought: 0, substituted: 0, skipped: 0 };
  for (const item of state.items) byStatus[item.status] += 1;

  const total = state.items.length;
  return {
    total,
    checked: total - byStatus['to-buy'],
    remaining: byStatus['to-buy'],
    byStatus,
  };
}
