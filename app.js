import {
  MAX_ITEM_LENGTH,
  MAX_QUANTITY,
  MIN_QUANTITY,
  STATUSES,
  STATUS_LABELS,
  STORAGE_KEY,
  addItem,
  cleanQuantity,
  counts,
  insertItem,
  insertMany,
  loadState,
  moveWithinGroup,
  removeItem,
  removeMany,
  reorderGroup,
  saveState,
  toggleChecked,
  updateItem,
} from './store.js';

const els = {
  form: document.querySelector('#add-form'),
  input: document.querySelector('#new-item'),
  summary: document.querySelector('#summary'),
  filters: document.querySelector('#filters'),
  groups: document.querySelector('#groups'),
  empty: document.querySelector('#empty-state'),
  clearChecked: document.querySelector('#clear-checked'),
  clearList: document.querySelector('#clear-list'),
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
  swap: ['M4 8h12', 'M13 5l3 3-3 3', 'M20 16H8', 'M11 13l-3 3 3 3'],
  minus: ['M5 12h14'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
};

function icon(name, strokeWidth = 2) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
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
let activeFilter = 'all';
let editingId = null;
let editQty = 1;
let editStatus = 'to-buy';
let dragState = null;
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

function focusDragHandle(id) {
  rowFor(id)?.querySelector('.drag-handle')?.focus();
}

/* ---------- Rendering ---------- */

function render() {
  const stats = counts(state);

  if (stats.total === 0) {
    els.summary.textContent = 'Nothing on your list yet';
  } else if (stats.checked === 0) {
    els.summary.textContent = `${stats.remaining} ${stats.remaining === 1 ? 'item' : 'items'} to buy`;
  } else {
    els.summary.textContent = `${stats.checked} of ${stats.total} checked`;
  }

  renderFilterCounts(stats);
  els.clearChecked.disabled = stats.checked === 0;
  els.clearList.disabled = stats.total === 0;

  const statuses = activeFilter === 'all' ? STATUSES : [activeFilter];
  const groups = statuses
    .map((status) => ({
      status,
      items: state.items.filter((item) => item.status === status),
    }))
    .filter((group) => group.items.length > 0);

  els.groups.replaceChildren(...groups.map(renderGroup));

  let emptyMessage = '';
  if (stats.total === 0) {
    emptyMessage = 'Your list is empty. Add something you need to buy.';
  } else if (groups.length === 0) {
    emptyMessage =
      activeFilter === 'all'
        ? 'Nothing to show.'
        : `No ${STATUS_LABELS[activeFilter].toLowerCase()} items.`;
  } else if (activeFilter === 'all' && stats.remaining === 0) {
    emptyMessage = 'All done — everything is checked off.';
  } else if (activeFilter === 'to-buy' && stats.remaining === 0) {
    emptyMessage = 'You have nothing left to buy.';
  }

  els.empty.hidden = emptyMessage === '';
  if (emptyMessage) els.empty.textContent = emptyMessage;
}

function renderFilterCounts(stats) {
  const countByFilter = { all: stats.total, ...stats.byStatus };
  for (const chip of els.filters.querySelectorAll('.filter-chip')) {
    const filter = chip.dataset.filter;
    const countEl = chip.querySelector('.filter-count');
    if (countEl) countEl.textContent = String(countByFilter[filter] ?? 0);
    chip.setAttribute('aria-pressed', String(filter === activeFilter));
  }
}

function renderGroup(group) {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.status = group.status;

  const heading = document.createElement('h2');
  heading.id = `heading-${group.status}`;
  heading.append(document.createTextNode(STATUS_LABELS[group.status] + ' '));

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(group.items.length);
  heading.append(count);

  const list = document.createElement('ul');
  list.className = 'item-list';
  list.dataset.status = group.status;
  list.setAttribute('aria-labelledby', heading.id);
  list.append(...group.items.map(createRow));

  section.append(heading, list);
  return section;
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

function toggleLabel(item) {
  if (item.status === 'to-buy') return `Mark ${item.text} as bought`;
  return `Change ${item.text} from ${STATUS_LABELS[item.status]} to To buy`;
}

function statusIconName(status) {
  if (status === 'substituted') return 'swap';
  if (status === 'skipped') return 'minus';
  return 'check';
}

function createRow(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.id = item.id;
  li.dataset.status = item.status;

  if (editingId === item.id) {
    li.classList.add('is-editing');
    return createEditRow(li, item);
  }

  const label = document.createElement('label');
  label.className = 'check';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'item-toggle';
  toggle.checked = item.status !== 'to-buy';
  toggle.setAttribute('aria-label', toggleLabel(item));
  toggle.addEventListener('change', () => onToggle(item.id));

  const mark = document.createElement('span');
  mark.className = 'checkmark';
  mark.append(icon(statusIconName(item.status)));
  label.append(toggle, mark);

  const content = document.createElement('div');
  content.className = 'item-content';

  const text = document.createElement('span');
  text.className = 'item-text';
  text.textContent = item.text;

  const qty = document.createElement('span');
  qty.className = 'qty-badge';
  qty.textContent = `×${item.qty}`;
  qty.setAttribute('aria-label', `Quantity ${item.qty}`);
  qty.title = `Quantity: ${item.qty}`;

  content.append(text, qty);

  const edit = iconButton('edit', `Edit ${item.text}`, () => startEdit(item.id), 'btn-edit');
  const remove = iconButton('trash', `Delete ${item.text}`, () => onDelete(item.id), 'btn-delete');

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'icon-btn drag-handle';
  handle.setAttribute('aria-label', `Reorder ${item.text}. Drag, or use the up and down arrow keys.`);
  handle.title = 'Drag to reorder';
  handle.append(icon('grip', 3));
  attachDrag(handle, item);

  li.append(label, content, edit, remove, handle);
  return li;
}

function createEditRow(li, item) {
  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const inputRow = document.createElement('div');
  inputRow.className = 'edit-input-row';

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
  inputRow.append(input, save, cancel);

  const options = document.createElement('div');
  options.className = 'edit-options';

  const qtyField = document.createElement('div');
  qtyField.className = 'edit-field';

  const qtyLabel = document.createElement('span');
  qtyLabel.className = 'edit-label';
  qtyLabel.textContent = 'Quantity';
  qtyLabel.setAttribute('aria-hidden', 'true');

  const qtyStepper = document.createElement('div');
  qtyStepper.className = 'qty-stepper';
  qtyStepper.setAttribute('role', 'group');
  qtyStepper.setAttribute('aria-label', 'Quantity');

  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'qty-btn qty-down';
  down.setAttribute('aria-label', 'Decrease quantity');
  down.append(icon('chevron-down'));
  down.disabled = editQty <= MIN_QUANTITY;

  const value = document.createElement('span');
  value.className = 'qty-value';
  value.setAttribute('aria-live', 'polite');
  value.textContent = String(editQty);

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'qty-btn qty-up';
  up.setAttribute('aria-label', 'Increase quantity');
  up.append(icon('chevron-up'));
  up.disabled = editQty >= MAX_QUANTITY;

  down.addEventListener('click', () => changeEditQty(-1, value, down, up));
  up.addEventListener('click', () => changeEditQty(1, value, down, up));

  qtyStepper.append(down, value, up);
  qtyField.append(qtyLabel, qtyStepper);

  const statusField = document.createElement('div');
  statusField.className = 'edit-field';

  const statusLabel = document.createElement('span');
  statusLabel.className = 'edit-label';
  statusLabel.textContent = 'Status';
  statusLabel.setAttribute('aria-hidden', 'true');

  const picker = document.createElement('div');
  picker.className = 'status-picker';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Status');

  for (const status of STATUSES) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'status-option';
    option.dataset.status = status;
    option.textContent = STATUS_LABELS[status];
    option.setAttribute('aria-pressed', String(editStatus === status));
    option.classList.toggle('is-selected', editStatus === status);
    option.addEventListener('click', () => {
      editStatus = status;
      for (const candidate of picker.querySelectorAll('.status-option')) {
        const selected = candidate.dataset.status === status;
        candidate.setAttribute('aria-pressed', String(selected));
        candidate.classList.toggle('is-selected', selected);
      }
      announce(`Status ${STATUS_LABELS[status]}`);
    });
    picker.append(option);
  }

  statusField.append(statusLabel, picker);
  options.append(qtyField, statusField);
  panel.append(inputRow, options);
  li.append(panel);
  return li;
}

/* ---------- Editing ---------- */

function startEdit(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;

  editingId = id;
  editQty = item.qty;
  editStatus = item.status;
  render();

  const input = document.querySelector('.item.is-editing .edit-input');
  if (input) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function changeEditQty(delta, valueEl, downBtn, upBtn) {
  const next = cleanQuantity(editQty + delta);
  if (next === editQty) return;

  editQty = next;
  valueEl.textContent = String(editQty);
  downBtn.disabled = editQty <= MIN_QUANTITY;
  upBtn.disabled = editQty >= MAX_QUANTITY;
  announce(`Quantity ${editQty}`);
}

function commitEdit(id, text) {
  const next = updateItem(state, id, { text, qty: editQty, status: editStatus });
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

  const wasChecked = item.status !== 'to-buy';
  const next = toggleChecked(state, id);
  if (next === state) return;

  state = next;
  persist();
  render();
  focusToggle(id);
  announce(
    wasChecked ? `${item.text} moved back to To buy` : `${item.text} marked as bought`,
  );
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

function clearItems(ids, kind) {
  if (ids.length === 0) return;

  const result = removeMany(state, ids);
  if (result.removed.length === 0) return;

  state = result.state;
  persist();
  render();
  els.input.focus();

  const total = result.removed.length;
  const message =
    kind === 'all'
      ? `Cleared all ${total} ${total === 1 ? 'item' : 'items'}`
      : `Cleared ${total} checked ${total === 1 ? 'item' : 'items'}`;

  showSnackbar(message, 'Undo', () => {
    state = insertMany(state, result.removed);
    persist();
    render();
    els.input.focus();
    announce(`Restored ${total} ${total === 1 ? 'item' : 'items'}`);
  });
}

function onClearChecked() {
  clearItems(
    state.items.filter((item) => item.status !== 'to-buy').map((item) => item.id),
    'checked',
  );
}

function onClearList() {
  clearItems(
    state.items.map((item) => item.id),
    'all',
  );
}

/* ---------- Reordering ---------- */

function attachDrag(handle, item) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (editingId) return;

    const row = handle.closest('.item');
    const list = handle.closest('.item-list');
    if (!row || !list) return;

    dragState = {
      id: item.id,
      status: item.status,
      row,
      list,
      pointerId: event.pointerId,
      startY: event.clientY,
      active: false,
    };
  });

  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();

    const direction = event.key === 'ArrowUp' ? 'up' : 'down';
    const next = moveWithinGroup(state, item.id, direction);
    if (next === state) {
      announce(direction === 'up' ? 'Already first in this group' : 'Already last in this group');
      return;
    }

    state = next;
    persist();
    render();
    focusDragHandle(item.id);
    announce(direction === 'up' ? 'Moved up' : 'Moved down');
  });
}

/**
 * Dragging is tracked on the window rather than with pointer capture:
 * moving the row in the DOM releases capture, which would cancel the drag.
 */
function onDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  if (dragState.active && event.buttons === 0) {
    finishDrag(true);
    return;
  }

  const distance = Math.abs(event.clientY - dragState.startY);
  if (!dragState.active) {
    if (distance < 6) return;
    dragState.active = true;
    dragState.row.classList.add('dragging');
    document.body.classList.add('is-reordering');
  }

  event.preventDefault();
  autoScroll(event.clientY);

  const rows = [...dragState.list.querySelectorAll('.item')].filter(
    (row) => row !== dragState.row,
  );
  let target = null;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      target = row;
      break;
    }
  }

  if (target) dragState.list.insertBefore(dragState.row, target);
  else dragState.list.appendChild(dragState.row);
}

function autoScroll(clientY) {
  const edge = 88;
  if (clientY < edge) window.scrollBy(0, -14);
  else if (clientY > window.innerHeight - edge) window.scrollBy(0, 14);
}

function finishDrag(commit) {
  if (!dragState) return;

  const { id, status, list, row, active } = dragState;
  dragState = null;

  row.classList.remove('dragging');
  document.body.classList.remove('is-reordering');

  if (!active) return;

  if (!commit) {
    render();
    focusDragHandle(id);
    return;
  }

  const orderedIds = [...list.querySelectorAll('.item')].map((itemRow) => itemRow.dataset.id);
  const next = reorderGroup(state, status, orderedIds);
  if (next !== state) {
    state = next;
    persist();
    announce('Order updated');
  }

  render();
  focusDragHandle(id);
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
els.clearChecked.addEventListener('click', onClearChecked);
els.clearList.addEventListener('click', onClearList);

window.addEventListener('pointermove', onDragMove);
window.addEventListener('pointerup', () => finishDrag(true));
window.addEventListener('pointercancel', () => finishDrag(false));
window.addEventListener('blur', () => finishDrag(false));

els.filters.addEventListener('click', (event) => {
  const chip = event.target.closest('.filter-chip');
  if (!chip) return;

  const filter = chip.dataset.filter;
  if (filter !== 'all' && !STATUSES.includes(filter)) return;

  activeFilter = filter;
  editingId = null;
  render();
});

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
