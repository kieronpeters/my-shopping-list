import {
  MAX_ITEM_LENGTH,
  STORAGE_KEY,
  addItem,
  counts,
  insertItem,
  loadState,
  removeItem,
  saveState,
  toggleItem,
  updateItem,
} from './store.js';

const els = {
  form: document.querySelector('#add-form'),
  input: document.querySelector('#new-item'),
  summary: document.querySelector('#summary'),
  todoList: document.querySelector('#todo-list'),
  doneList: document.querySelector('#done-list'),
  todoCount: document.querySelector('#todo-count'),
  doneCount: document.querySelector('#done-count'),
  doneGroup: document.querySelector('#done-group'),
  empty: document.querySelector('#empty-todo'),
  snackbar: document.querySelector('#snackbar'),
  snackbarText: document.querySelector('#snackbar-text'),
  undoBtn: document.querySelector('#undo-btn'),
  status: document.querySelector('#status'),
};

const ICON_PATHS = {
  check: ['M5 12.5l4.4 4.4L19 7.2'],
  edit: ['M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17l-1 3z'],
  trash: [
    'M4 7h16',
    'M9.5 7V4.8h5V7',
    'M6.5 7l.9 12.7h9.2L17.5 7',
    'M10 11v5',
    'M14 11v5',
  ],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  save: ['M5 12.5l4.4 4.4L19 7.2'],
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

let state = loadState();
let editingId = null;
let snackbarTimer = 0;
let hideTimer = 0;
let announceTimer = 0;

/* ---------- Persistence ---------- */

function persist() {
  try {
    saveState(state);
    return true;
  } catch {
    showSnackbar('Could not save to this device. Storage may be full or blocked.');
    return false;
  }
}

/* ---------- Accessibility helpers ---------- */

function announce(message) {
  clearTimeout(announceTimer);
  els.status.textContent = '';
  announceTimer = setTimeout(() => {
    els.status.textContent = message;
  }, 60);
}

function rowFor(id) {
  return document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
}

function focusToggle(id) {
  rowFor(id)?.querySelector('.item-toggle')?.focus();
}

/* ---------- Rendering ---------- */

function render() {
  const stats = counts(state);

  if (stats.total === 0) {
    els.summary.textContent = 'Nothing on your list yet';
  } else if (stats.done === 0) {
    els.summary.textContent = `${stats.remaining} ${stats.remaining === 1 ? 'item' : 'items'} to buy`;
  } else {
    els.summary.textContent = `${stats.done} of ${stats.total} purchased`;
  }

  const todo = state.items.filter((item) => !item.done);
  const done = state.items.filter((item) => item.done);

  els.todoCount.textContent = String(todo.length);
  els.doneCount.textContent = String(done.length);
  els.todoList.replaceChildren(...todo.map(createRow));
  els.doneList.replaceChildren(...done.map(createRow));
  els.doneGroup.hidden = done.length === 0;

  if (stats.total === 0) {
    els.empty.hidden = false;
    els.empty.textContent = 'Your list is empty. Add something you need to buy.';
  } else if (stats.remaining === 0) {
    els.empty.hidden = false;
    els.empty.textContent = 'All done — everything is in the basket.';
  } else {
    els.empty.hidden = true;
  }
}

function iconButton(name, label, onClick, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${extraClass}`.trim();
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

function createRow(item) {
  const li = document.createElement('li');
  li.className = item.done ? 'item is-done' : 'item';
  li.dataset.id = item.id;

  if (editingId === item.id) {
    li.classList.add('is-editing');
    return createEditRow(li, item);
  }

  const label = document.createElement('label');
  label.className = 'check';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'item-toggle';
  toggle.checked = item.done;
  toggle.setAttribute(
    'aria-label',
    item.done ? `Mark ${item.text} as not purchased` : `Mark ${item.text} as purchased`,
  );
  toggle.addEventListener('change', () => onToggle(item.id));

  const mark = document.createElement('span');
  mark.className = 'checkmark';
  mark.append(icon('check'));
  label.append(toggle, mark);

  const text = document.createElement('span');
  text.className = 'item-text';
  text.textContent = item.text;

  const edit = iconButton('edit', `Edit ${item.text}`, () => startEdit(item.id), 'btn-edit');
  const remove = iconButton('trash', `Delete ${item.text}`, () => onDelete(item.id), 'btn-delete');

  li.append(label, text, edit, remove);
  return li;
}

function createEditRow(li, item) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = item.text;
  input.maxLength = MAX_ITEM_LENGTH;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `Edit ${item.text}`);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(item.id, input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(item.id);
    }
  });

  const save = iconButton('save', 'Save changes', () => commitEdit(item.id, input.value), 'btn-save');
  const cancel = iconButton('close', 'Cancel editing', () => cancelEdit(item.id), 'btn-cancel');

  li.append(input, save, cancel);
  return li;
}

/* ---------- Actions ---------- */

function onAdd(event) {
  event.preventDefault();
  const result = addItem(state, els.input.value);

  if (!result.item) {
    els.input.focus();
    return;
  }

  state = result.state;
  persist();
  render();
  els.input.value = '';
  els.input.focus();
  announce(`Added ${result.item.text}`);
}

function onToggle(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;

  const nowDone = !item.done;
  const next = toggleItem(state, id);
  if (next === state) return;

  state = next;
  persist();
  render();
  focusToggle(id);
  announce(nowDone ? `${item.text} marked as purchased` : `${item.text} moved back to your list`);
}

function startEdit(id) {
  editingId = id;
  render();
  const input = document.querySelector('.item.is-editing .edit-input');
  if (input) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function commitEdit(id, value) {
  const next = updateItem(state, id, value);
  const changed = next !== state;
  if (changed) {
    state = next;
    persist();
  }
  editingId = null;
  render();
  focusToggle(id);
  if (changed) announce('Item updated');
}

function cancelEdit(id) {
  editingId = null;
  render();
  focusToggle(id);
}

function onDelete(id) {
  const result = removeItem(state, id);
  if (!result.removed) return;

  const { item, index } = result.removed;
  state = result.state;
  persist();
  render();
  els.input.focus();

  showSnackbar(`Deleted “${item.text}”`, 'Undo', () => {
    state = insertItem(state, item, index);
    persist();
    render();
    els.input.focus();
    announce(`Restored ${item.text}`);
  });
}

/* ---------- Snackbar ---------- */

function showSnackbar(message, actionLabel, action) {
  clearTimeout(snackbarTimer);
  clearTimeout(hideTimer);

  els.snackbarText.textContent = message;

  if (actionLabel && action) {
    els.undoBtn.hidden = false;
    els.undoBtn.textContent = actionLabel;
    els.undoBtn.onclick = () => {
      hideSnackbar();
      action();
    };
  } else {
    els.undoBtn.hidden = true;
    els.undoBtn.onclick = null;
  }

  els.snackbar.hidden = false;
  // Flush styles so the entrance transition runs. Using a frame callback here
  // would let a very fast Undo hide the bar and then have the class re-added.
  void els.snackbar.offsetWidth;
  els.snackbar.classList.add('is-visible');
  snackbarTimer = setTimeout(hideSnackbar, 6000);
}

function hideSnackbar() {
  clearTimeout(snackbarTimer);
  els.snackbar.classList.remove('is-visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!els.snackbar.classList.contains('is-visible')) els.snackbar.hidden = true;
  }, 220);
}

/* ---------- Wiring ---------- */

els.form.addEventListener('submit', onAdd);

window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  state = loadState();
  editingId = null;
  render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch((error) => console.warn('Offline support unavailable:', error));
  });
}

render();
