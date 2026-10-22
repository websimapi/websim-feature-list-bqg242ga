const URGENCY = [
  { key: 'urgent', label: 'Urgent', color: '#e0313f', icon: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  { key: 'high', label: 'High', color: '#e07a2e', icon: '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>' },
  { key: 'medium', label: 'Medium', color: '#d4a84b', icon: '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>' },
  { key: 'low', label: 'Low', color: '#5fa37a', icon: '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>' },
];
const RANK = Object.fromEntries(URGENCY.map((u, i) => [u.key, i]));
const byKey = (key) => URGENCY.find((u) => u.key === key) ?? URGENCY[2];

// ---------- IndexedDB storage ----------
const DB_NAME = 'feature-list';
const STORE = 'features';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbPromise = openDB();

async function tx(mode, run) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const request = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(request?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const getAll = () => tx('readonly', (s) => s.getAll());
const putItem = (item) => tx('readwrite', (s) => s.put(item));
const deleteItem = (id) => tx('readwrite', (s) => s.delete(id));

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

// ---------- State & UI ----------
const list = document.getElementById('list');
const form = document.getElementById('add-form');
const titleInput = document.getElementById('new-title');
const newUrgency = makeUrgencyPicker('medium');
document.getElementById('new-urgency').replaceWith(newUrgency.el);

let items = [];
let freshId = null;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sortedItems() {
  return [...items].sort(
    (a, b) => RANK[a.urgency] - RANK[b.urgency] || a.created - b.created,
  );
}

function render() {
  list.replaceChildren(...sortedItems().map(renderItem));
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item' + (item.id === freshId ? ' fresh' : '');
  li.style.setProperty('--c', byKey(item.urgency).color);

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

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete feature');
  del.addEventListener('click', () => removeItem(item.id));

  li.append(title, urgency.el, del);
  return li;
}

async function update(id, patch) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  render();
  await putItem(item);
}

async function removeItem(id) {
  items = items.filter((i) => i.id !== id);
  render();
  await deleteItem(id);
}

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

// ---------- Start ----------
try {
  items = (await getAll()) ?? [];
} catch (err) {
  console.error('Could not load saved features', err);
}
render();
