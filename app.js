const URGENCY = [
  { key: 'urgent', label: 'Urgent', color: '#e0313f', icon: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  { key: 'high', label: 'High', color: '#e07a2e', icon: '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>' },
  { key: 'medium', label: 'Medium', color: '#d4a84b', icon: '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>' },
  { key: 'low', label: 'Low', color: '#5fa37a', icon: '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>' },
];
const RANK = Object.fromEntries(URGENCY.map((u, i) => [u.key, i]));
const byKey = (key) => URGENCY.find((u) => u.key === key) ?? URGENCY[2];

const UPLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>';
const svgIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Enter adds the feature on desktop; on phones Enter is a new line.
const desktopPointer = matchMedia('(hover: hover) and (pointer: fine)');

// ---------- IndexedDB storage ----------
const DB_NAME = 'feature-list';
const STORE = 'features';
const FILES = 'attachments';
const DRAFTS = 'drafts'; // composer text and files staged but not yet saved to a feature

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: 'id' }).createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbPromise = openDB();

async function tx(store, mode, run) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const request = run(t.objectStore(store));
    t.oncomplete = () => resolve(request?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const getAll = () => tx(STORE, 'readonly', (s) => s.getAll());
const putItem = (item) => tx(STORE, 'readwrite', (s) => s.put(item));
const getAllAttachments = () => tx(FILES, 'readonly', (s) => s.getAll());
const putAttachments = (list) => tx(FILES, 'readwrite', (s) => {
  for (const a of list) s.put(a);
});
const deleteAttachment = (id) => tx(FILES, 'readwrite', (s) => s.delete(id));
const getAllDrafts = () => tx(DRAFTS, 'readonly', (s) => s.getAll());
const putDrafts = (list) => tx(DRAFTS, 'readwrite', (s) => {
  for (const d of list) s.put(d);
});
const deleteDraft = (id) => tx(DRAFTS, 'readwrite', (s) => s.delete(id));

async function deleteItemWithAttachments(id, attachmentIds) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE, FILES], 'readwrite');
    t.objectStore(STORE).delete(id);
    for (const aid of attachmentIds) t.objectStore(FILES).delete(aid);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Saving a new feature: store it, move its staged files into attachments, and drop them from drafts, in one transaction.
async function commitFeature(item, added) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE, FILES, DRAFTS], 'readwrite');
    t.objectStore(STORE).put(item);
    for (const a of added) {
      t.objectStore(FILES).put(a);
      t.objectStore(DRAFTS).delete(a.id);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- Urgency picker: icon, native select overlaid for input ----------
function makeUrgencyPicker(initial, onChange, label) {
  const wrap = document.createElement('label');
  wrap.className = 'urgency';

  const icon = document.createElement('span');
  icon.className = 'icon';

  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const u of URGENCY) select.add(new Option(u.label, u.key));

  const paint = (key) => {
    const u = byKey(key);
    select.value = u.key;
    wrap.style.setProperty('--c', u.color);
    wrap.title = `Urgency: ${u.label}`;
    icon.innerHTML = svgIcon(u.icon);
  };

  paint(initial);
  select.addEventListener('change', () => {
    paint(select.value);
    onChange?.(select.value);
  });

  wrap.append(icon, select);
  return { el: wrap, select, set: paint, get value() { return select.value; } };
}

// ---------- Attachment helpers ----------
const isImage = (att) => att.type.startsWith('image/');
const extOf = (name) => (name.includes('.') ? name.split('.').pop() : 'file').slice(0, 4);
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

// Clipboard images often arrive without a name, so give them one.
const nameFor = (file, stamp) =>
  file.name || `pasted-${stamp}.${(file.type.split('/')[1] || 'bin').split('+')[0]}`;

const urls = new Map();
function urlOf(att) {
  if (!urls.has(att.id)) urls.set(att.id, URL.createObjectURL(att.blob));
  return urls.get(att.id);
}
function forget(att) {
  const url = urls.get(att.id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(att.id);
}

// ---------- State & UI ----------
const list = document.getElementById('list');
const form = document.getElementById('add-form');
const titleInput = document.getElementById('new-title');
const stagedEl = document.getElementById('staged');
const statusEl = document.getElementById('status');

const newUrgency = makeUrgencyPicker('medium', () => saveComposer(), 'Urgency for new feature');
document.getElementById('new-urgency').replaceWith(newUrgency.el);

const newAttach = document.getElementById('new-attach');
newAttach.innerHTML = svgIcon(UPLOAD);

// One hidden picker shared by the form and every row; onPicked says where the files go.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.hidden = true;
document.body.append(fileInput);
let onPicked = null;

let items = [];
let attachments = [];
let staged = []; // files chosen in the add form, saved to IndexedDB until the feature is added
let freshId = null;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Screen reader announcements via the live region.
function announce(message) {
  statusEl.textContent = '';
  requestAnimationFrame(() => {
    statusEl.textContent = message;
  });
}

// Re-rendering replaces DOM nodes; put focus back on the matching control afterwards.
function keepFocus(root, change) {
  const active = document.activeElement;
  const key = root.contains(active) ? active.dataset.key : undefined;
  change();
  if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

const autosize = (el) => {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

// The new-feature text and urgency are saved as they change, so a reload keeps them.
function saveComposer() {
  putDrafts([{ id: 'composer', title: titleInput.value, urgency: newUrgency.value }]).catch((err) =>
    console.error('Could not save draft', err),
  );
}

// Sorted by the active key (date = created, type = urgency); ties keep oldest first.
function sortedItems() {
  const sign = sortDir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const main = sortKey === 'date' ? a.created - b.created : RANK[a.urgency] - RANK[b.urgency];
    return sign * main || a.created - b.created;
  });
}

function attachmentsOf(itemId) {
  return attachments
    .filter((a) => a.itemId === itemId)
    .sort((a, b) => a.created - b.created);
}

function render() {
  keepFocus(list, () => list.replaceChildren(...sortedItems().map(renderItem)));
  for (const t of list.querySelectorAll('.title')) autosize(t);
}

window.addEventListener('resize', () => {
  for (const t of list.querySelectorAll('.title')) autosize(t);
});

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item' + (item.id === freshId ? ' fresh' : '');
  li.dataset.id = item.id;
  li.style.setProperty('--c', byKey(item.urgency).color);

  const row = document.createElement('div');
  row.className = 'row';

  const title = document.createElement('textarea');
  title.rows = 1;
  title.className = 'title';
  title.value = item.title;
  title.setAttribute('aria-label', 'Feature name');
  title.dataset.key = `${item.id}:title`;
  const commitTitle = () => {
    const value = title.value.trim();
    if (!value) {
      title.value = item.title;
      autosize(title);
    } else if (value !== item.title) {
      update(item.id, { title: value });
    }
  };
  title.addEventListener('input', () => autosize(title));
  title.addEventListener('change', commitTitle);
  title.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      title.blur();
    } else if (e.key === 'Escape') {
      title.value = item.title;
      title.blur();
    }
  });

  const urgency = makeUrgencyPicker(
    item.urgency,
    (key) => update(item.id, { urgency: key }),
    `Urgency for ${item.title}`,
  );
  urgency.select.dataset.key = `${item.id}:urgency`;

  const mine = attachmentsOf(item.id);

  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'attach';
  attach.dataset.key = `${item.id}:attach`;
  attach.innerHTML = svgIcon(UPLOAD);
  attach.setAttribute(
    'aria-label',
    `Attach files to ${item.title}${mine.length ? `, ${mine.length} attached` : ''}`,
  );
  if (mine.length) {
    const count = document.createElement('span');
    count.className = 'count';
    count.setAttribute('aria-hidden', 'true');
    count.textContent = mine.length;
    attach.append(count);
  }
  // Keep focus in the title so a pending edit isn't lost (or re-rendered away) mid-click.
  attach.addEventListener('mousedown', (e) => e.preventDefault());
  attach.addEventListener('click', () => {
    commitTitle();
    onPicked = (picked) => attachFiles(item.id, picked);
    fileInput.click();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.dataset.key = `${item.id}:delete`;
  del.textContent = '×';
  del.setAttribute('aria-label', `Delete ${item.title}`);
  del.addEventListener('click', () => removeItem(item.id));

  row.append(title, urgency.el, attach, del);
  li.append(row);

  if (mine.length) li.append(renderFiles(mine, removeAttachment));

  // Drag files from the desktop onto a row to attach them.
  li.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    li.classList.add('drop');
  });
  li.addEventListener('dragleave', (e) => {
    if (!li.contains(e.relatedTarget)) li.classList.remove('drop');
  });
  li.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    li.classList.remove('drop');
    attachFiles(item.id, [...e.dataTransfer.files]);
  });

  return li;
}

// Chips for saved attachments or staged files; onRemove receives the chip's id.
function renderFiles(files, onRemove) {
  const wrap = document.createElement('div');
  wrap.className = 'files';

  for (const att of files) {
    const chip = document.createElement('div');
    chip.className = 'file';

    const link = document.createElement('a');
    link.className = 'file-link';
    link.href = urlOf(att);
    link.title = att.name;
    if (isImage(att)) {
      link.target = '_blank';
      link.rel = 'noopener';
    } else {
      link.download = att.name;
    }

    let thumb;
    if (isImage(att)) {
      thumb = document.createElement('img');
      thumb.className = 'file-thumb';
      thumb.src = urlOf(att);
      thumb.alt = '';
    } else {
      thumb = document.createElement('span');
      thumb.className = 'file-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      thumb.textContent = extOf(att.name);
    }

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = att.name;
    link.append(thumb, name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.dataset.key = `${att.id}:remove`;
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${att.name}`);
    remove.addEventListener('click', () => onRemove(att.id));

    chip.append(link, remove);
    wrap.append(chip);
  }
  return wrap;
}

function renderStaged() {
  keepFocus(form, () => {
    stagedEl.replaceChildren(...(staged.length ? [renderFiles(staged, unstage)] : []));
    newAttach.querySelector('.count')?.remove();
    newAttach.setAttribute(
      'aria-label',
      `Attach files to new feature${staged.length ? `, ${staged.length} staged` : ''}`,
    );
    if (staged.length) {
      const count = document.createElement('span');
      count.className = 'count';
      count.setAttribute('aria-hidden', 'true');
      count.textContent = staged.length;
      newAttach.append(count);
    }
  });
}

async function stage(picked) {
  const t0 = Date.now();
  const recs = picked.map((file, i) => ({
    id: newId(),
    name: nameFor(file, t0 + i),
    type: file.type || '',
    created: t0 + i,
    blob: file,
  }));
  staged.push(...recs);
  renderStaged();
  announce(`${picked.length} ${picked.length === 1 ? 'file' : 'files'} staged for the new feature`);
  try {
    await putDrafts(recs);
  } catch (err) {
    console.error('Could not save staged files', err);
    staged = staged.filter((s) => !recs.includes(s));
    recs.forEach(forget);
    renderStaged();
    alert('Could not save those files.');
  }
}

async function unstage(id) {
  const rec = staged.find((s) => s.id === id);
  if (!rec) return;
  staged = staged.filter((s) => s.id !== id);
  forget(rec);
  renderStaged();
  announce(`Removed ${rec.name}`);
  try {
    await deleteDraft(id);
  } catch (err) {
    console.error('Could not remove staged file', err);
  }
}

newAttach.dataset.key = 'new:attach';
newAttach.addEventListener('click', () => {
  onPicked = stage;
  fileInput.click();
});

async function update(id, patch) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  render();
  await putItem(item);
}

async function removeItem(id) {
  const item = items.find((i) => i.id === id);
  const mine = attachmentsOf(id);
  items = items.filter((i) => i.id !== id);
  attachments = attachments.filter((a) => a.itemId !== id);
  mine.forEach(forget);
  render();
  if (item) announce(`Deleted ${item.title}`);
  await deleteItemWithAttachments(id, mine.map((a) => a.id));
}

async function attachFiles(itemId, picked) {
  if (!picked.length || !items.some((i) => i.id === itemId)) return;
  const t0 = Date.now();
  const added = picked.map((file, i) => ({
    id: newId(),
    itemId,
    name: nameFor(file, t0 + i),
    type: file.type || '',
    size: file.size,
    created: t0 + i,
    blob: file,
  }));
  attachments.push(...added);
  render();
  announce(`Attached ${added.length} ${added.length === 1 ? 'file' : 'files'}`);
  try {
    await putAttachments(added);
  } catch (err) {
    console.error('Could not save attachments', err);
    attachments = attachments.filter((a) => !added.includes(a));
    added.forEach(forget);
    render();
    alert('Could not save those files.');
  }
}

async function removeAttachment(id) {
  const att = attachments.find((a) => a.id === id);
  if (!att) return;
  attachments = attachments.filter((a) => a.id !== id);
  forget(att);
  render();
  announce(`Removed ${att.name}`);
  await deleteAttachment(id);
}

fileInput.addEventListener('change', () => {
  const picked = [...fileInput.files];
  const handler = onPicked;
  onPicked = null;
  fileInput.value = '';
  if (handler && picked.length) handler(picked);
});

// Drop files onto the add form to stage them for the new feature.
form.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  form.classList.add('drop');
});
form.addEventListener('dragleave', (e) => {
  if (!form.contains(e.relatedTarget)) form.classList.remove('drop');
});
form.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  form.classList.remove('drop');
  stage([...e.dataTransfer.files]);
});

// Enter adds on desktop (Shift+Enter for a new line); Ctrl/Cmd+Enter adds anywhere.
titleInput.addEventListener('input', saveComposer);
titleInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.key !== 'Enter') return;
  if (e.ctrlKey || e.metaKey || (!e.shiftKey && desktopPointer.matches)) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = titleInput.value.trim();
  if (!name) return;
  const item = {
    id: newId(),
    title: name,
    urgency: newUrgency.value,
    created: Date.now(),
  };
  const added = staged.map((s) => ({
    id: s.id,
    itemId: item.id,
    name: s.name,
    type: s.type,
    size: s.blob.size,
    created: s.created,
    blob: s.blob,
  }));
  const previousStaged = staged;
  staged = [];
  renderStaged();

  items.push(item);
  attachments.push(...added);
  titleInput.value = '';
  saveComposer();
  freshId = item.id;
  setTimeout(() => {
    if (freshId === item.id) freshId = null;
  }, 500);
  render();
  announce(`Added ${name}`);
  titleInput.focus();
  try {
    await commitFeature(item, added);
  } catch (err) {
    console.error('Could not save feature', err);
    items = items.filter((i) => i.id !== item.id);
    attachments = attachments.filter((a) => a.itemId !== item.id);
    added.forEach(forget);
    staged = previousStaged;
    titleInput.value = name;
    renderStaged();
    render();
    saveComposer();
    alert('Could not save this feature.');
  }
});

// ---------- Paste files (Ctrl/Cmd+V) ----------
// Goes to the add form when it has focus, otherwise to the row being worked on.
let hoveredId = null;
list.addEventListener('pointerover', (e) => {
  hoveredId = e.target.closest?.('.item')?.dataset.id ?? null;
});
list.addEventListener('pointerleave', () => {
  hoveredId = null;
});

document.addEventListener('paste', (e) => {
  const picked = [...(e.clipboardData?.items ?? [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (!picked.length) return; // plain text paste: leave it to the browser
  e.preventDefault();
  if (form.contains(document.activeElement)) return stage(picked);
  const targetId = document.activeElement?.closest?.('.item')?.dataset.id ?? hoveredId;
  if (targetId) attachFiles(targetId, picked);
  else stage(picked);
});

// ---------- Sort toolbar ----------
// Date and type (urgency) are the sort keys. Tapping the active one flips its direction.
const CAL_ICON = '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';
const TAG_ICON = '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>';
const ARROW_ICON = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';

const SORTS = {
  date: { name: 'Sort by date', icon: CAL_ICON, asc: 'oldest first', desc: 'newest first' },
  type: { name: 'Sort by type', icon: TAG_ICON, asc: 'most urgent first', desc: 'least urgent first' },
};
let sortKey = 'type';
let sortDir = 'asc';

const sortBtns = {
  date: document.getElementById('sort-date'),
  type: document.getElementById('sort-type'),
};
for (const key of Object.keys(SORTS)) {
  const btn = sortBtns[key];
  btn.innerHTML = svgIcon(SORTS[key].icon) + svgIcon(ARROW_ICON).replace('<svg ', '<svg class="dir" ');
  btn.addEventListener('click', () => tapSort(key));
}

function paintSort() {
  for (const key of Object.keys(SORTS)) {
    const s = SORTS[key];
    const active = sortKey === key;
    const btn = sortBtns[key];
    btn.classList.toggle('active', active);
    btn.dataset.dir = active ? sortDir : '';
    btn.setAttribute('aria-label', s.name + ', ' + s[active ? sortDir : 'asc']);
  }
}

function tapSort(key) {
  if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else {
    sortKey = key;
    sortDir = 'asc';
  }
  paintSort();
  render();
  announce(SORTS[key].name + ', ' + SORTS[key][sortDir]);
}
paintSort();

// ---------- Start ----------
try {
  items = (await getAll()) ?? [];
} catch (err) {
  console.error('Could not load saved features', err);
}
try {
  attachments = (await getAllAttachments()) ?? [];
} catch (err) {
  console.error('Could not load saved attachments', err);
}
try {
  const drafts = (await getAllDrafts()) ?? [];
  const composer = drafts.find((d) => d.id === 'composer');
  staged = drafts.filter((d) => d.id !== 'composer').sort((a, b) => a.created - b.created);
  if (composer) {
    titleInput.value = composer.title ?? '';
    newUrgency.set(composer.urgency ?? 'medium');
  }
} catch (err) {
  console.error('Could not load drafts', err);
}
renderStaged();
render();
