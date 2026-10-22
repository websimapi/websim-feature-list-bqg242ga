const URGENCY = [
  { key: 'urgent', label: 'Urgent', color: '#e0313f', icon: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  { key: 'high', label: 'High', color: '#e07a2e', icon: '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>' },
  { key: 'medium', label: 'Medium', color: '#d4a84b', icon: '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>' },
  { key: 'low', label: 'Low', color: '#5fa37a', icon: '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>' },
];
const RANK = Object.fromEntries(URGENCY.map((u, i) => [u.key, i]));
const byKey = (key) => URGENCY.find((u) => u.key === key) ?? URGENCY[2];

const PAPERCLIP = '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';

// ---------- IndexedDB storage ----------
const DB_NAME = 'feature-list';
const STORE = 'features';
const FILES = 'attachments';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: 'id' }).createIndex('itemId', 'itemId');
      }
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

// ---------- Urgency picker: icon + label, native select overlaid for input ----------
function makeUrgencyPicker(initial, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'urgency';

  const icon = document.createElement('span');
  icon.className = 'icon';
  const text = document.createElement('span');
  text.className = 'text';

  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Urgency');
  for (const u of URGENCY) select.add(new Option(u.label, u.key));

  const paint = (key) => {
    const u = byKey(key);
    select.value = u.key;
    wrap.style.setProperty('--c', u.color);
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${u.icon}</svg>`;
    text.textContent = u.label;
  };

  paint(initial);
  select.addEventListener('change', () => {
    paint(select.value);
    onChange?.(select.value);
  });

  wrap.append(icon, text, select);
  return { el: wrap, get value() { return select.value; } };
}

// ---------- Attachment helpers ----------
const isImage = (att) => att.type.startsWith('image/');
const extOf = (name) => (name.includes('.') ? name.split('.').pop() : 'file').slice(0, 4);

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
const newUrgency = makeUrgencyPicker('medium');
document.getElementById('new-urgency').replaceWith(newUrgency.el);

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.hidden = true;
document.body.append(fileInput);
let pickingFor = null;

let items = [];
let attachments = [];
let freshId = null;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sortedItems() {
  return [...items].sort(
    (a, b) => RANK[a.urgency] - RANK[b.urgency] || a.created - b.created,
  );
}

function attachmentsOf(itemId) {
  return attachments
    .filter((a) => a.itemId === itemId)
    .sort((a, b) => a.created - b.created);
}

function render() {
  list.replaceChildren(...sortedItems().map(renderItem));
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item' + (item.id === freshId ? ' fresh' : '');
  li.dataset.id = item.id;
  li.style.setProperty('--c', byKey(item.urgency).color);

  const row = document.createElement('div');
  row.className = 'row';

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'title';
  title.value = item.title;
  title.setAttribute('aria-label', 'Feature name');
  title.addEventListener('change', () => {
    const value = title.value.trim();
    if (!value) {
      title.value = item.title;
      return;
    }
    update(item.id, { title: value });
  });

  const urgency = makeUrgencyPicker(item.urgency, (key) => update(item.id, { urgency: key }));

  const mine = attachmentsOf(item.id);

  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'attach';
  attach.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PAPERCLIP}</svg>`;
  attach.setAttribute('aria-label', `Attach files to ${item.title}`);
  if (mine.length) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = mine.length;
    attach.append(count);
  }
  // Keep focus where it is so a pending title edit isn't committed (and the list re-rendered) mid-click.
  attach.addEventListener('mousedown', (e) => e.preventDefault());
  attach.addEventListener('click', () => {
    pickingFor = item.id;
    fileInput.click();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete feature');
  del.addEventListener('click', () => removeItem(item.id));

  row.append(title, urgency.el, attach, del);
  li.append(row);

  if (mine.length) li.append(renderFiles(mine));

  // Drag files from the desktop onto a row to attach them.
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
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

function renderFiles(list) {
  const wrap = document.createElement('div');
  wrap.className = 'files';

  for (const att of list) {
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
      thumb.textContent = extOf(att.name);
    }

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = att.name;
    link.append(thumb, name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${att.name}`);
    remove.addEventListener('click', () => removeAttachment(att.id));

    chip.append(link, remove);
    wrap.append(chip);
  }
  return wrap;
}

async function update(id, patch) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  render();
  await putItem(item);
}

async function removeItem(id) {
  const mine = attachmentsOf(id);
  items = items.filter((i) => i.id !== id);
  attachments = attachments.filter((a) => a.itemId !== id);
  mine.forEach(forget);
  render();
  await deleteItemWithAttachments(id, mine.map((a) => a.id));
}

async function attachFiles(itemId, picked) {
  if (!picked.length || !items.some((i) => i.id === itemId)) return;
  const t0 = Date.now();
  const added = picked.map((file, i) => ({
    id: newId(),
    itemId,
    // Clipboard images often arrive without a name (e.g. "image.png" or ""), so give them one.
    name: file.name || `pasted-${t0 + i}.${(file.type.split('/')[1] || 'bin').split('+')[0]}`,
    type: file.type || '',
    size: file.size,
    created: t0 + i,
    blob: file,
  }));
  attachments.push(...added);
  render();
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
  await deleteAttachment(id);
}

fileInput.addEventListener('change', () => {
  const picked = [...fileInput.files];
  const itemId = pickingFor;
  pickingFor = null;
  fileInput.value = '';
  if (itemId) attachFiles(itemId, picked);
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
  items.push(item);
  titleInput.value = '';
  freshId = item.id;
  setTimeout(() => {
    if (freshId === item.id) freshId = null;
  }, 500);
  render();
  titleInput.focus();
  await putItem(item);
});

// ---------- Paste files (Ctrl/Cmd+V) into the feature being worked on ----------
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
  // Target the row with focus, otherwise the row under the pointer.
  const targetId = document.activeElement?.closest?.('.item')?.dataset.id ?? hoveredId;
  if (!targetId) return;
  e.preventDefault();
  attachFiles(targetId, picked);
});

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
render();
