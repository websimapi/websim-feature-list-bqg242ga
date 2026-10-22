const URGENCY = [
  { key: 'urgent', label: 'Urgent', color: '#e5484d' },
  { key: 'high', label: 'High', color: '#f76b15' },
  { key: 'medium', label: 'Medium', color: '#e0a800' },
  { key: 'low', label: 'Low', color: '#30a46c' },
];
const RANK = Object.fromEntries(URGENCY.map((u, i) => [u.key, i]));
const colorOf = (key) => URGENCY.find((u) => u.key === key)?.color ?? '#888';

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

// ---------- State & UI ----------
const list = document.getElementById('list');
const form = document.getElementById('add-form');
const titleInput = document.getElementById('new-title');
const urgencySelect = document.getElementById('new-urgency');

let items = [];

for (const u of URGENCY) urgencySelect.add(new Option(u.label, u.key));
urgencySelect.value = 'medium';

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
  li.className = 'item';
  li.style.setProperty('--c', colorOf(item.urgency));

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

  const urgency = document.createElement('select');
  urgency.className = 'urgency';
  urgency.setAttribute('aria-label', 'Urgency');
  for (const u of URGENCY) urgency.add(new Option(u.label, u.key));
  urgency.value = item.urgency;
  urgency.addEventListener('change', () => update(item.id, { urgency: urgency.value }));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete feature');
  del.addEventListener('click', () => removeItem(item.id));

  li.append(title, urgency, del);
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
    urgency: urgencySelect.value,
    created: Date.now(),
  };
  items.push(item);
  titleInput.value = '';
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
