/*
 * Mesa · Encargos — v1.3
 *
 * FIRESTORE DATA MODEL
 * orders/{id}
 *   date           'YYYY-MM-DD' day the order is for (explicit day, or production day at creation)
 *   customer, place, note, clientId
 *   items[]        { key, productId, variantId, productName, variantName, category, priceCents, qty, readyQty, note }
 *   totalCents     euro cents
 *   delivered, deliveredAt
 *   payments[]     { id, amountCents, rateEUR, method, date, by }   (legacy: paid / paidRateEUR / paidAt)
 *   archived, archivedAt, deleted, deletedAt
 *   createdBy, createdByUid, createdByName, createdAt, updatedAt, updatedBy, revision
 * clients/{id}     name, normalizedName, place, phone (digits only), createdAt, updatedAt
 * products/{id}    name, category, variants[{ id, name, priceCents }], active, updatedAt
 * events/{id}      date, orderId, text, actor, at
 * settings/rate        eurRate, updatedDay, updatedBy, updatedAt
 * settings/production  productionDay, updatedBy, updatedAt
 * settings/payment     text
 * settings/people      { <uid>: 'Nombre' }   (optional display names)
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, orderBy, limit, writeBatch, runTransaction,
  serverTimestamp, setDoc
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const APP_VERSION = '1.3';

const firebaseConfig = {
  apiKey: 'AIzaSyCq_zGQTQmzw6vwEr5WJQ2KyR6YvZ_G4jQ',
  authDomain: 'encargos-selulu.firebaseapp.com',
  projectId: 'encargos-selulu',
  storageBucket: 'encargos-selulu.firebasestorage.app',
  messagingSenderId: '876342743214',
  appId: '1:876342743214:web:0120fd149e10465bb19d3f'
};

const NEW_KEY = 'mesa-new-orders';
const LAST_OPEN_KEY = 'mesa-last-open';
const HINT_KEY = 'mesa-ios-hint-dismissed';
const METHODS = ['Efectivo', 'Pago móvil', 'Zelle', 'Transferencia', 'Otro'];

/* ---------- Small helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const asDate = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shortDate = (iso) => (iso
  ? asDate(iso).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })
  : 'sin fecha');
const numFmt = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const euro = (cents) => `€ ${((cents || 0) / 100).toLocaleString('es-VE', numFmt)}`;
const bs = (cents, rate) => `Bs ${(((cents || 0) / 100) * (rate || 0)).toLocaleString('es-VE', numFmt)}`;
const parseMoney = (v) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) throw Error('Escribe un monto válido con hasta dos decimales, sin separadores de miles.');
  return Math.round(Number(s) * 100);
};
const parseRate = (v) => {
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const normalizeName = (s) => String(s || '').trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const ms = (v) => v?.toMillis?.() ?? null;
const loadJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const docToObj = (d) => ({ id: d.id, ...d.data() });

/* ---------- State ---------- */
const state = {
  user: null,
  products: [], orders: [], events: [], clients: [],
  rate: { eurRate: 0, updatedDay: '' },
  productionDay: '',
  paymentInfo: '',
  people: {},
  tab: 'day',
  search: '',
  unsubs: [],
  loaded: { products: false, orders: false, events: false, clients: false, settings: false },
  syncError: false,
  newIds: new Set(loadJSON(NEW_KEY, [])),
  ordersReady: false,
  creatingProduction: false,
  open: { archived: false, trash: false },
  bellOpen: false
};
const saveNew = () => { try { localStorage.setItem(NEW_KEY, JSON.stringify([...state.newIds])); } catch { /* ignore */ } };

/* ---------- Firebase init ---------- */
let auth, db;
try {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (err) {
    console.warn('Persistent cache unavailable, using default.', err);
    db = getFirestore(app);
  }
} catch (e) {
  $('#login-error').textContent = e.message;
  $('#login-error').classList.remove('hidden');
  $('#login-form button[type="submit"]').disabled = true;
}

/* ---------- Toasts, errors, sync indicator ---------- */
function toast(msg, kind = 'info') {
  const box = $('#toasts');
  const t = el('div', `toast ${kind}`, msg);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  const life = kind === 'error' ? 6500 : kind === 'good' ? 2800 : 4200;
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, life);
}
const flash = (msg, good = false) => toast(msg, good ? 'good' : 'error');

function problem(e) {
  console.error(e);
  const code = e?.code || '';
  let msg = e?.message || 'No se pudo completar la operación.';
  if (code === 'permission-denied') msg = 'Permiso denegado. Comprueba los UID de las reglas de Firestore y vuelve a iniciar sesión.';
  else if (code === 'unavailable') msg = 'Sin conexión con el servidor. Tus cambios se enviarán cuando vuelva la conexión.';
  toast(msg, 'error');
}

function updateSync() {
  const dot = $('#sync-dot');
  const txt = $('#sync-text');
  if (!dot || !txt) return;
  let kind = 'ok';
  let label = 'En línea';
  if (!navigator.onLine) { kind = 'warn'; label = 'Sin conexión'; }
  else if (state.syncError) { kind = 'bad'; label = 'Revisar conexión'; }
  else if (!Object.values(state.loaded).every(Boolean)) { kind = 'warn'; label = 'Sincronizando…'; }
  dot.className = `dot ${kind}`;
  txt.textContent = label;
}
window.addEventListener('online', updateSync);
window.addEventListener('offline', updateSync);

/* ---------- Scroll lock + layers (modals and dialogs) ---------- */
const layers = [];
let lockDepth = 0;
let lockY = 0;

function lockScroll() {
  if (lockDepth++ > 0) return;
  lockY = window.scrollY;
  const b = document.body;
  b.style.position = 'fixed';
  b.style.top = `-${lockY}px`;
  b.style.left = '0';
  b.style.right = '0';
  b.style.width = '100%';
  document.documentElement.classList.add('scroll-locked');
}
function unlockScroll() {
  if (lockDepth === 0) return;
  if (--lockDepth > 0) return;
  const b = document.body;
  b.style.position = '';
  b.style.top = '';
  b.style.left = '';
  b.style.right = '';
  b.style.width = '';
  document.documentElement.classList.remove('scroll-locked');
  window.scrollTo(0, lockY);
}

function pushLayer({ kind = 'modal', title, body, foot, onClose, dismissible = true }) {
  const veil = el('div', `veil layer-${kind}`);
  const box = el('div', kind === 'dialog' ? 'modal dialog' : 'modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.tabIndex = -1;
  const head = el('div', 'modal-head');
  head.append(el('h2', '', title));
  const layer = { veil, box, dismissible, onClose, closed: false, close: () => {} };
  if (dismissible) {
    const x = el('button', 'small', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Cerrar');
    x.onclick = () => layer.close();
    head.append(x);
  }
  const bodyEl = el('div', 'modal-body');
  bodyEl.append(body);
  box.append(head, bodyEl);
  if (foot) {
    const f = el('div', 'modal-foot');
    f.append(foot);
    box.append(f);
  }
  veil.append(box);
  let downOnVeil = false;
  veil.addEventListener('pointerdown', (e) => { downOnVeil = e.target === veil; });
  veil.addEventListener('click', (e) => {
    if (dismissible && downOnVeil && e.target === veil) layer.close();
    downOnVeil = false;
  });
  layer.close = () => {
    if (layer.closed) return;
    layer.closed = true;
    veil.remove();
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    unlockScroll();
    layer.onClose?.();
  };
  $('#layers').append(veil);
  layers.push(layer);
  lockScroll();
  box.focus({ preventScroll: true });
  return layer;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  closeBell();
  const top = layers[layers.length - 1];
  if (top?.dismissible) top.close();
});

function choiceDialog({ title, message, choices, dismissible = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = el('div');
    const p = el('p', 'dialog-msg');
    p.innerHTML = esc(message).replace(/\n/g, '<br>');
    body.append(p);
    const foot = el('div', 'dialog-actions');
    let layer = null;
    for (const c of choices) {
      const b = el('button', c.kind || '', c.label);
      b.type = 'button';
      b.onclick = () => { finish(c.value); layer?.close(); };
      foot.append(b);
    }
    layer = pushLayer({ kind: 'dialog', title, body, foot, dismissible, onClose: () => finish(null) });
  });
}
async function confirmDialog({ title, message, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
  const r = await choiceDialog({
    title, message,
    choices: [
      { label: cancelText, value: false },
      { label: confirmText, kind: danger ? 'danger-solid' : 'accent', value: true }
    ]
  });
  return r === true;
}

/* ---------- Writes ---------- */
const myName = () => {
  const u = state.user;
  if (!u) return '';
  return state.people?.[u.uid] || capitalize((u.email || '').split('@')[0]) || 'Usuario';
};

// Waits for the server ack, but never blocks the UI for long: offline writes stay queued locally.
async function settle(promise, waitMs = 4000) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('queued'), waitMs); });
  try {
    const r = await Promise.race([promise, timeout]);
    if (r === 'queued') {
      toast('Guardado en este dispositivo. Se enviará cuando vuelva la conexión.');
      promise.catch(problem);
    }
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// Disables only the pressed button; releases in finally (and after 1.2s so offline writes never hang the button).
async function withBusy(btn, task) {
  if (btn) btn.disabled = true;
  const release = () => { if (btn) btn.disabled = false; };
  const timer = setTimeout(release, 1200);
  try { await task(); } catch (e) { problem(e); } finally { clearTimeout(timer); release(); }
}

function writeEvent(w, date, orderId, text) {
  w.set(doc(collection(db, 'events')), {
    date: date || '', orderId: orderId || null, text, actor: myName(), at: serverTimestamp()
  });
}

function orderUpdate(o, changes, text) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'orders', o.id), { ...changes, updatedAt: serverTimestamp(), updatedBy: myName() });
  if (text) writeEvent(batch, o.date, o.id, text);
  return settle(batch.commit());
}

function ensureRate(what) {
  if (!state.loaded.settings) { toast('Cargando datos… inténtalo de nuevo en un momento.'); return false; }
  if ((state.rate.eurRate || 0) > 0) return true;
  toast(`Define la tasa del euro antes de ${what}.`, 'error');
  return false;
}

/* ---------- Domain: payments, preparation, grouping ---------- */
const categoryOf = (item) => item.category
  || state.products.find((p) => p.id === item.productId)?.category
  || 'Sin categoría';

function getPayments(o) {
  if (Array.isArray(o.payments)) return o.payments;
  if (o.paid) {
    return [{ id: 'legacy', amountCents: o.totalCents || 0, rateEUR: o.paidRateEUR || 0, method: '', date: o.paidAt || o.date || '', by: '' }];
  }
  return [];
}
const paidCents = (o) => getPayments(o).reduce((s, p) => s + (p.amountCents || 0), 0);
const balanceCents = (o) => (o.totalCents || 0) - paidCents(o);
const isPaid = (o) => (o.totalCents || 0) > 0 && balanceCents(o) <= 0;

function payInfo(o) {
  const total = o.totalCents || 0;
  const paid = paidCents(o);
  const bal = total - paid;
  if (total > 0 && bal <= 0) {
    return paid > total
      ? { key: 'over', label: `Pagado de más ${euro(paid - total)}`, cls: 'warm' }
      : { key: 'paid', label: 'Pagado', cls: 'good' };
  }
  if (paid > 0) return { key: 'partial', label: `Falta ${euro(bal)}`, cls: 'warm' };
  return { key: 'none', label: 'Por cobrar', cls: 'warm' };
}

function unitCounts(o) {
  let total = 0;
  let ready = 0;
  for (const i of o.items || []) {
    total += i.qty || 0;
    ready += Math.min(i.qty || 0, i.readyQty || 0);
  }
  return { total, ready };
}
function prepState(o) {
  const { total, ready } = unitCounts(o);
  if (total > 0 && ready >= total) return 'full';
  return ready > 0 ? 'partial' : 'none';
}
function deliveryLabel(o) {
  if (o.delivered) return 'Entregado';
  const s = prepState(o);
  if (s === 'full') return 'Preparado';
  return s === 'partial' ? 'En preparación' : 'Pendiente';
}
function needsPicker(o) {
  const lines = o.items || [];
  return lines.length > 1 || (lines.length === 1 && lines[0].qty > 1);
}
const setReady = (o, full) => (o.items || []).map((i) => ({ ...i, readyQty: full ? i.qty : 0 }));

function production(orders) {
  const groups = new Map();
  let total = 0;
  let ready = 0;
  for (const order of orders) {
    for (const i of order.items || []) {
      const key = `${i.productId}|${i.variantId}`;
      const g = groups.get(key) || { name: `${i.productName} · ${i.variantName}`, total: 0, ready: 0 };
      const r = Math.min(i.qty || 0, i.readyQty || 0);
      g.total += i.qty || 0;
      g.ready += r;
      groups.set(key, g);
      total += i.qty || 0;
      ready += r;
    }
  }
  return { total, ready, groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')) };
}

const isActive = (o) => !o.archived && !o.deleted;
const createdMs = (o) => ms(o.createdAt) ?? Date.now();
const currentOrders = () => state.orders
  .filter((o) => o.date === state.productionDay && isActive(o))
  .sort((a, b) => createdMs(a) - createdMs(b));

function orderMatches(o, term) {
  if (!term) return true;
  const hay = `${o.customer} ${o.place || ''} ${(o.items || []).map((i) => `${i.productName} ${i.variantName}`).join(' ')}`;
  return hay.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

function ordersOfClient(c) {
  return state.orders.filter((o) => !o.deleted
    && (o.clientId ? o.clientId === c.id : normalizeName(o.customer) === c.normalizedName));
}

function groupUnits(orders) {
  const cats = new Map();
  let units = 0;
  for (const o of orders) {
    for (const i of o.items || []) {
      const cat = categoryOf(i);
      const c = cats.get(cat) || { name: cat, total: 0, products: new Map() };
      const p = c.products.get(i.productName) || { name: i.productName, total: 0, variants: new Map() };
      const q = i.qty || 0;
      c.total += q;
      p.total += q;
      p.variants.set(i.variantName, (p.variants.get(i.variantName) || 0) + q);
      c.products.set(i.productName, p);
      cats.set(cat, c);
      units += q;
    }
  }
  return { units, cats: [...cats.values()].sort((a, b) => b.total - a.total) };
}

function bellGroups() {
  const act = state.orders.filter((o) => isActive(o) && o.date);
  const next = act.filter((o) => o.date > state.productionDay);
  const late = act.filter((o) => o.date < state.productionDay && !(o.delivered && isPaid(o)));
  const group = (list) => {
    const m = new Map();
    list.forEach((o) => m.set(o.date, (m.get(o.date) || 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  return { next: group(next), late: group(late), count: next.length + late.length };
}

/* ---------- Domain actions (shared by Jornada and Simple) ---------- */
function togglePrepared(o, quick) {
  const s = prepState(o);
  if (s === 'full') {
    return orderUpdate(o, { items: setReady(o, false), delivered: false, deliveredAt: null },
      `Desmarcó preparado el pedido de ${o.customer}`);
  }
  if (!quick && needsPicker(o)) { openPrepare(o); return null; }
  return orderUpdate(o, { items: setReady(o, true) }, `Marcó preparado el pedido de ${o.customer}`);
}

function toggleDelivered(o) {
  if (o.delivered) {
    return orderUpdate(o, { delivered: false, deliveredAt: null }, `Desmarcó entregado el pedido de ${o.customer}`);
  }
  return orderUpdate(o, { delivered: true, deliveredAt: localDate(), items: setReady(o, true) },
    `Entregó el pedido de ${o.customer}`);
}

async function addPayment(o, amountCents, method) {
  if (!ensureRate('registrar pagos')) return false;
  if (!(amountCents > 0)) return false;
  const cur = state.orders.find((x) => x.id === o.id) || o;
  const payment = {
    id: crypto.randomUUID(), amountCents, rateEUR: state.rate.eurRate,
    method: method || '', date: localDate(), by: myName()
  };
  await orderUpdate(cur, { payments: [...getPayments(cur), payment] },
    `Registró un pago de ${euro(amountCents)} de ${cur.customer}${method ? ` (${method})` : ''}`);
  return true;
}

async function undoLastPayment(o) {
  const cur = state.orders.find((x) => x.id === o.id) || o;
  const pays = getPayments(cur);
  if (!pays.length) return;
  await orderUpdate(cur, { payments: pays.slice(0, -1) }, `Deshizo el último pago de ${cur.customer}`);
}

async function onPayTap(o, quick) {
  if (isPaid(o)) {
    const choice = await choiceDialog({
      title: 'Pedido pagado',
      message: `El pedido de ${o.customer} está pagado (${euro(paidCents(o))}).`,
      choices: [
        { label: 'Cerrar', value: 'close' },
        { label: 'Deshacer último pago', kind: 'danger-solid', value: 'undo' }
      ]
    });
    if (choice === 'undo') await undoLastPayment(o);
    return;
  }
  if (!ensureRate('registrar pagos')) return;
  if (quick) { await addPayment(o, balanceCents(o), ''); return; }
  openPaymentSheet(o);
}

async function askTrash(o) {
  const ok = await confirmDialog({
    title: 'Eliminar pedido',
    message: `¿Enviar a la papelera el pedido de ${o.customer}?\nPodrás restaurarlo desde Historial › Papelera.`,
    confirmText: 'Eliminar', danger: true
  });
  if (!ok) return;
  await orderUpdate(o, { deleted: true, deletedAt: serverTimestamp() }, `Envió a la papelera el pedido de ${o.customer}`);
}
const restoreFromTrash = (o) => orderUpdate(o, { deleted: false, deletedAt: null }, `Restauró de la papelera el pedido de ${o.customer}`);
const restoreArchived = (o) => orderUpdate(o, { archived: false, archivedAt: null }, `Restauró el pedido archivado de ${o.customer}`);

async function archiveClosed() {
  const day = state.productionDay;
  const dayOrders = state.orders.filter((o) => o.date === day && isActive(o));
  const closed = dayOrders.filter((o) => o.delivered && isPaid(o));
  const staying = dayOrders.length - closed.length;
  if (!closed.length) {
    toast(staying
      ? `Aún no hay pedidos entregados y pagados. Quedan ${staying} pendientes.`
      : 'No hay pedidos para archivar en este día.');
    return;
  }
  const ok = await confirmDialog({
    title: 'Limpiar la jornada',
    message: `Se archivarán ${closed.length} pedido(s) entregados y pagados.\n${staying
      ? `Se quedan a la vista ${staying} pedido(s) pendientes.`
      : 'No queda ningún pedido pendiente.'}\nSeguirán contando en Clientes e Historial y podrás restaurarlos desde Historial › Archivados.`,
    confirmText: 'Archivar'
  });
  if (!ok) return;
  try {
    for (let i = 0; i < closed.length; i += 400) {
      const chunk = closed.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach((o) => batch.update(doc(db, 'orders', o.id), {
        archived: true, archivedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName()
      }));
      if (i + 400 >= closed.length) writeEvent(batch, day, null, `Archivó ${closed.length} pedidos del día ${day}`);
      await settle(batch.commit());
    }
    toast(`${closed.length} pedido(s) archivados.`, 'good');
  } catch (e) { problem(e); }
}

async function emptyTrash() {
  const trash = state.orders.filter((o) => o.deleted);
  if (!trash.length) return;
  const ok = await confirmDialog({
    title: 'Vaciar papelera',
    message: `Se borrarán definitivamente ${trash.length} pedido(s). Esta acción no se puede deshacer.`,
    confirmText: 'Borrar definitivamente', danger: true
  });
  if (!ok) return;
  try {
    for (let i = 0; i < trash.length; i += 400) {
      const chunk = trash.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach((o) => batch.delete(doc(db, 'orders', o.id)));
      if (i + 400 >= trash.length) writeEvent(batch, '', null, `Vació la papelera (${trash.length} pedidos)`);
      await settle(batch.commit());
    }
    toast('Papelera vaciada.', 'good');
  } catch (e) { problem(e); }
}

/* Client helper: works with both a WriteBatch and a Transaction (both expose set/update). */
function queueClient(w, { name, place, phone, selectedId }) {
  const key = normalizeName(name);
  const client = (selectedId && state.clients.find((c) => c.id === selectedId))
    || state.clients.find((c) => c.normalizedName === key);
  if (client) {
    const changes = {};
    if (place && !client.place) changes.place = place;
    if (phone && !client.phone) changes.phone = phone;
    if (Object.keys(changes).length) {
      w.update(doc(db, 'clients', client.id), { ...changes, updatedAt: serverTimestamp() });
    }
    return client.id;
  }
  const ref = doc(collection(db, 'clients'));
  w.set(ref, {
    name: name.trim(), normalizedName: key, place: place || '', phone: phone || '',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  return ref.id;
}

/* ---------- Rendering (keyed patches, no full rebuilds) ---------- */
let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    try { renderNow(); } catch (e) { console.error(e); }
  });
}

function setHtml(node, html) {
  if (node && node._sig !== html) { node.innerHTML = html; node._sig = html; }
}
function mountSkeleton(name, html) {
  const v = $('#view');
  if (v.dataset.skel !== name) { v.innerHTML = html; v.dataset.skel = name; v._sig = null; }
}
function setStaticView(name, html) {
  const v = $('#view');
  if (v.dataset.skel !== name || v._sig !== html) { v.innerHTML = html; v.dataset.skel = name; v._sig = html; }
}

function reconcile(container, items, emptyHtml) {
  if (!container) return;
  if (!items.length) {
    if (container._empty !== emptyHtml) { container.innerHTML = emptyHtml; container._empty = emptyHtml; }
    return;
  }
  if (container._empty) { container.innerHTML = ''; container._empty = null; }
  const existing = new Map();
  for (const child of [...container.children]) existing.set(child.dataset.id, child);
  const keep = new Set();
  items.forEach((item, i) => {
    keep.add(item.id);
    let node = existing.get(item.id);
    if (!node || node._sig !== item.html) {
      const t = document.createElement('template');
      t.innerHTML = item.html.trim();
      const fresh = t.content.firstElementChild;
      fresh._sig = item.html;
      if (node) container.replaceChild(fresh, node);
      node = fresh;
    }
    const at = container.children[i];
    if (at !== node) container.insertBefore(node, at || null);
  });
  for (const [id, node] of existing) if (!keep.has(id)) node.remove();
}

const bar = (label, ready, total, green = false) => `
  <div class="meter-row">
    <div class="meter-top"><span>${esc(label)}</span><b>${ready} / ${total}</b></div>
    <div class="meter ${green ? 'green' : ''}"><i style="width:${total ? Math.round((ready / total) * 100) : 0}%"></i></div>
  </div>`;

function updateChrome() {
  const tab = state.tab;
  const inDay = tab === 'day' || tab === 'simple';
  $('#new-order').classList.toggle('hidden', tab !== 'day');
  $('#clean-btn').classList.toggle('hidden', tab !== 'day');
  $('#rate-box').classList.toggle('hidden', !inDay);
  $('#day-box').classList.toggle('hidden', !inDay);
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  const meta = {
    day: ['Jornada', 'Los encargos', state.productionDay ? shortDate(state.productionDay) : 'Define el día de producción.'],
    simple: ['Vista simple', 'Entregas y cobros', state.productionDay ? shortDate(state.productionDay) : 'Define el día de producción.'],
    catalog: ['Productos', 'La carta', 'Productos y precios en euros que ambos pueden usar.'],
    clients: ['Base de datos', 'Clientes', 'Quién compra, cuánto y con qué frecuencia.'],
    history: ['Resumen', 'Historial', 'Ventas, archivados y actividad compartida.']
  }[tab];
  $('#kicker').textContent = meta[0];
  $('#page-title').textContent = meta[1];
  $('#page-sub').textContent = meta[2];

  const hasRate = (state.rate.eurRate || 0) > 0;
  const warn = $('#rate-warn');
  if (!state.loaded.settings) warn.classList.add('hidden');
  else if (!hasRate) { warn.textContent = 'Sin tasa'; warn.classList.remove('hidden'); }
  else if (state.rate.updatedDay !== localDate()) { warn.textContent = 'Tasa de otro día'; warn.classList.remove('hidden'); }
  else warn.classList.add('hidden');
  if (document.activeElement !== $('#rate-input')) $('#rate-input').value = hasRate ? state.rate.eurRate : '';
  if (document.activeElement !== $('#day-input')) $('#day-input').value = state.productionDay || '';

  const g = bellGroups();
  const badge = $('#bell-badge');
  badge.textContent = g.count;
  badge.classList.toggle('hidden', !g.count);
  const rows = (list) => list.map(([d, n]) => `<button type="button" class="bell-row" data-goto="${esc(d)}">${esc(shortDate(d))}<small>${n} pedido(s)</small></button>`).join('');
  setHtml($('#bell-panel'), g.count
    ? (g.next.length ? `<div class="bp-head">Próximos</div>${rows(g.next)}` : '')
      + (g.late.length ? `<div class="bp-head">Atrasados</div>${rows(g.late)}` : '')
    : '<div class="bp-head">Encargos en otras fechas</div><div class="bell-empty">No hay encargos en otras fechas.</div>');
  updateSync();
}

function renderNow() {
  if (!state.user) return;
  const y = lockDepth ? null : window.scrollY;
  updateChrome();
  if (state.tab === 'day') renderDay();
  else if (state.tab === 'simple') renderSimple();
  else if (state.tab === 'catalog') setStaticView('catalog', catalogHtml());
  else if (state.tab === 'clients') setStaticView('clients', clientsHtml());
  else setStaticView('history', historyHtml());
  if (y !== null && Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
}

/* ----- Jornada ----- */
function toggleBtn(action, id, label, mode) {
  const cls = mode === 'on' ? 'tgl on' : mode === 'partial' ? 'tgl partial' : 'tgl';
  return `<button type="button" class="${cls}" data-action="${action}" data-id="${esc(id)}" aria-pressed="${mode === 'on'}">${mode === 'on' ? '<span class="tick" aria-hidden="true">✓</span>' : ''}<span>${label}</span></button>`;
}
const prepMode = (o) => { const s = prepState(o); return s === 'full' ? 'on' : s === 'partial' ? 'partial' : 'off'; };
const payMode = (o) => (isPaid(o) ? 'on' : paidCents(o) > 0 ? 'partial' : 'off');

function deliveryPillClass(o) {
  const l = deliveryLabel(o);
  return l === 'Entregado' || l === 'Preparado' ? 'good' : l === 'En preparación' ? 'warm' : '';
}

function orderCardHtml(o) {
  const items = (o.items || []).map((i) => `<div>${i.qty} × ${esc(i.productName)} · ${esc(i.variantName)}${i.note ? ` <span class="item-note">— ${esc(i.note)}</span>` : ''}</div>`).join('');
  const pay = payInfo(o);
  const tags = [
    state.newIds.has(o.id) ? '<span class="tag tag-new">Nuevo</span>' : '',
    o.date && o.date !== state.productionDay ? `<span class="tag">Para: ${esc(shortDate(o.date))}</span>` : ''
  ].join('');
  return `
  <article class="order" data-id="${esc(o.id)}">
    <div class="order-top">
      <div class="order-who">
        <h3>${esc(o.customer)}</h3>
        <div class="where">${esc(o.place || 'Sin lugar indicado')}</div>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
      </div>
      <div class="order-pills">
        <span class="pill ${deliveryPillClass(o)}">${deliveryLabel(o)}</span>
        <span class="pill ${pay.cls}">${esc(pay.label)}</span>
      </div>
    </div>
    ${o.note ? `<div class="order-note">📝 ${esc(o.note)}</div>` : ''}
    <div class="order-items">${items}</div>
    <div class="order-total-row">${euro(o.totalCents)}</div>
    <div class="order-actions">
      ${toggleBtn('prepared', o.id, 'Preparado', prepMode(o))}
      ${toggleBtn('delivered', o.id, 'Entregado', o.delivered ? 'on' : 'off')}
      ${toggleBtn('pay', o.id, 'Pagado', payMode(o))}
      <button type="button" class="small btn-msg" data-action="charge" data-id="${esc(o.id)}">Mensaje</button>
      <button type="button" class="small more-btn" data-action="menu" data-id="${esc(o.id)}" aria-label="Más acciones">⋯</button>
    </div>
  </article>`;
}

function renderDay() {
  mountSkeleton('day', `
    <div id="stats" class="stats"></div>
    <div class="grid">
      <section class="panel panel-pad">
        <div class="listhead">
          <h2 class="sectiontitle">Pedidos del día de producción</h2>
          <input id="search" class="search" type="search" placeholder="Buscar cliente…" value="${esc(state.search)}" aria-label="Buscar pedido">
        </div>
        <div id="orders-list"></div>
      </section>
      <aside class="panel panel-pad" id="prod-panel"></aside>
    </div>`);
  const orders = currentOrders();
  const prod = production(orders);
  const owed = orders.reduce((s, o) => s + Math.max(0, balanceCents(o)), 0);
  setHtml($('#stats'), `
    <div class="panel stat"><span>Pedidos</span><strong>${orders.length}</strong></div>
    <div class="panel stat"><span>Por preparar</span><strong>${Math.max(0, prod.total - prod.ready)}</strong></div>
    <div class="panel stat"><span>Por cobrar</span><strong>${euro(owed)}</strong></div>`);
  const shown = orders.filter((o) => orderMatches(o, state.search));
  reconcile($('#orders-list'), shown.map((o) => ({ id: o.id, html: orderCardHtml(o) })),
    `<div class="empty">${orders.length ? 'No hay coincidencias.' : 'Todavía no hay encargos para este día de producción.'}</div>`);
  setHtml($('#prod-panel'), `
    <div class="eyebrow">Producción</div>
    <h2 class="sectiontitle" style="margin:5px 0 20px">Qué falta preparar</h2>
    ${bar('Progreso total', prod.ready, prod.total)}
    ${prod.groups.length ? prod.groups.map((g) => bar(g.name, g.ready, g.total, true)).join('') : '<p class="note">Los productos aparecerán al registrar pedidos.</p>'}
    <div class="note">Cuenta unidades encargadas, no clientes ni pagos.</div>`);
}

/* ----- Simple ----- */
function simpleRowHtml(o) {
  return `
  <div class="simple-row" data-id="${esc(o.id)}">
    <div class="simple-name">${esc(o.customer)}<small>${esc(o.place || 'Sin lugar indicado')}</small>${state.newIds.has(o.id) ? '<span class="tag tag-new">Nuevo</span>' : ''}</div>
    <div class="simple-actions">
      ${toggleBtn('prepared', o.id, 'Preparado', prepMode(o))}
      ${toggleBtn('delivered', o.id, 'Entregado', o.delivered ? 'on' : 'off')}
      ${toggleBtn('pay', o.id, 'Pagado', payMode(o))}
      <button type="button" class="danger" data-action="trash" data-id="${esc(o.id)}">Eliminar</button>
    </div>
  </div>`;
}
function renderSimple() {
  mountSkeleton('simple', '<div id="simple-list" class="simple-list"></div>');
  const orders = currentOrders();
  reconcile($('#simple-list'), orders.map((o) => ({ id: o.id, html: simpleRowHtml(o) })),
    '<div class="panel panel-pad"><div class="empty">Todavía no hay encargos para este día de producción.</div></div>');
}

/* ----- Carta ----- */
function productCardHtml(p) {
  return `
  <article class="panel catalog-card">
    <div class="product-head">
      <div>
        <h3>${esc(p.name)}</h3>
        <div class="fine muted">${p.active === false ? 'No aparece en nuevos pedidos' : `${(p.variants || []).length} presentacion(es)`}${p.category ? ` · ${esc(p.category)}` : ''}</div>
      </div>
      <button type="button" class="small" data-action="edit-product" data-id="${esc(p.id)}">Editar</button>
    </div>
    ${(p.variants || []).map((v) => `<div class="variant-row"><span>${esc(v.name)}</span><strong>${euro(v.priceCents)}</strong></div>`).join('')}
  </article>`;
}
function catalogHtml() {
  const list = state.products.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const archived = state.products.filter((p) => p.active === false);
  return `
  <div class="sectionline" style="margin-bottom:16px">
    <p class="note" style="margin:0">Cada presentación tiene su propio precio, en euros.</p>
    <button type="button" class="accent" data-action="new-product">+ Crear producto</button>
  </div>
  <div class="catalog">${list.length ? list.map(productCardHtml).join('') : '<div class="panel empty full">Crea el primer producto para empezar a recibir encargos.</div>'}</div>
  ${archived.length ? `<h2 class="sectiontitle" style="margin-top:29px">Desactivados</h2><div class="catalog">${archived.map(productCardHtml).join('')}</div>` : ''}`;
}

/* ----- Clientes ----- */
function clientsHtml() {
  const rows = [...state.clients].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!rows.length) return '<div class="panel empty">Todavía no hay clientes registrados. Se crean automáticamente al guardar un pedido.</div>';
  return `<div class="clients-grid">${rows.map((c) => {
    const os = ordersOfClient(c);
    const total = os.reduce((s, o) => s + (o.totalCents || 0), 0);
    return `
    <article class="panel client-card" data-action="open-client" data-id="${esc(c.id)}" role="button" tabindex="0">
      <h3>${esc(c.name)}</h3>
      <div class="client-meta">${esc(c.place || 'Sin lugar registrado')}</div>
      <div class="client-meta">${c.phone ? esc(c.phone) : 'Sin teléfono registrado'}</div>
      <div class="client-stats">
        <div><b>${os.length}</b><span class="fine muted">pedidos</span></div>
        <div><b>${euro(total)}</b><span class="fine muted">acumulado</span></div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

/* ----- Historial ----- */
function monday(iso) {
  const d = asDate(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}
function weekEnd(iso) {
  const d = asDate(iso);
  d.setDate(d.getDate() + 6);
  return localDate(d);
}
function historyHtml() {
  const weeks = new Map();
  for (const o of state.orders) {
    if (o.deleted || !o.date) continue;
    const key = monday(o.date);
    const v = weeks.get(key) || { orders: 0, committed: 0, paid: 0, paidCount: 0 };
    v.orders += 1;
    v.committed += o.totalCents || 0;
    v.paid += paidCents(o);
    if (isPaid(o)) v.paidCount += 1;
    weeks.set(key, v);
  }
  const ws = [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const archived = state.orders.filter((o) => o.archived && !o.deleted)
    .sort((a, b) => (ms(b.archivedAt) || 0) - (ms(a.archivedAt) || 0));
  const trash = state.orders.filter((o) => o.deleted)
    .sort((a, b) => (ms(b.deletedAt) || 0) - (ms(a.deletedAt) || 0));
  const row = (o, action) => `
    <div class="log-item row-between">
      <div><b>${esc(o.customer)}</b><div class="fine muted">${esc(shortDate(o.date))} · ${euro(o.totalCents)}</div></div>
      <button type="button" class="small" data-action="${action}" data-id="${esc(o.id)}">Restaurar</button>
    </div>`;
  const events = state.events;
  return `
  <div class="history">
    <section class="panel panel-pad">
      <h2 class="sectiontitle">Ventas por semana</h2>
      <p class="note">Toca una semana para ver el desglose. Encargado = total de pedidos; cobrado = pagos registrados, cada uno con su tasa congelada.</p>
      ${ws.length ? ws.map(([week, v]) => `
        <div class="log-item week-row" data-action="week" data-week="${esc(week)}" role="button" tabindex="0">
          <b>${esc(week)} al ${esc(weekEnd(week))}</b>
          <div class="fine muted">${v.orders} pedidos · ${v.paidCount} pagados</div>
          <div style="margin-top:5px">Encargado: <b>${euro(v.committed)}</b> · Cobrado: <b>${euro(v.paid)}</b></div>
        </div>`).join('') : '<div class="empty">Todavía no hay ventas registradas.</div>'}
    </section>
    <section class="panel panel-pad">
      <h2 class="sectiontitle">Actividad reciente</h2>
      ${events.length ? events.map((e) => `
        <div class="log-item">${esc(e.text)}
          <time>${esc(e.actor || 'Usuario')}${e.at?.toDate?.() ? ' · ' + esc(e.at.toDate().toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })) : ''}</time>
        </div>`).join('') : '<div class="empty">Aún no hay movimientos.</div>'}
    </section>
  </div>
  <details class="fold" data-section="archived" ${state.open.archived ? 'open' : ''}>
    <summary>Archivados <span class="muted">(${archived.length})</span></summary>
    <div class="fold-body">${archived.length ? archived.slice(0, 50).map((o) => row(o, 'restore-archived')).join('') + (archived.length > 50 ? '<p class="note">Mostrando los 50 más recientes.</p>' : '') : '<div class="empty">No hay pedidos archivados.</div>'}</div>
  </details>
  <details class="fold" data-section="trash" ${state.open.trash ? 'open' : ''}>
    <summary>Papelera <span class="muted">(${trash.length})</span></summary>
    <div class="fold-body">
      ${trash.length ? `<div class="sectionline" style="margin-bottom:6px"><span class="note">Los pedidos eliminados se pueden restaurar.</span><button type="button" class="small danger" data-action="empty-trash">Vaciar papelera</button></div>` + trash.slice(0, 50).map((o) => row(o, 'restore-trash')).join('') : '<div class="empty">La papelera está vacía.</div>'}
    </div>
  </details>`;
}

/* ---------- Menu "⋯" and bell ---------- */
let menuFor = null;
function closeMenu() {
  const m = $('#menu-pop');
  if (m) m.classList.add('hidden');
  menuFor = null;
}
function toggleMenu(btn, id) {
  const m = $('#menu-pop');
  if (menuFor === id && !m.classList.contains('hidden')) { closeMenu(); return; }
  closeBell();
  menuFor = id;
  m.innerHTML = `<button type="button" class="menu-item" data-menu="edit" data-id="${esc(id)}">Editar</button><button type="button" class="menu-item danger" data-menu="trash" data-id="${esc(id)}">Eliminar</button>`;
  m.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}
function closeBell() {
  state.bellOpen = false;
  $('#bell-panel').classList.add('hidden');
}
function toggleBell() {
  closeMenu();
  if (state.bellOpen) { closeBell(); return; }
  state.bellOpen = true;
  const r = $('#bell-btn').getBoundingClientRect();
  const p = $('#bell-panel');
  p.style.top = `${Math.round(r.bottom + 8)}px`;
  p.classList.remove('hidden');
}

/* ---------- Production day change (+ mandatory rate check) ---------- */
function requestDayChange(newDay) {
  return new Promise((resolve) => {
    if (!newDay) { resolve(false); return; }
    if (newDay === state.productionDay) { resolve(true); return; }
    const hasRate = (state.rate.eurRate || 0) > 0;
    let finished = false;
    const finish = (v) => { if (!finished) { finished = true; resolve(v); } };
    const body = el('div');
    body.innerHTML = `
      <p class="dialog-msg">Vas a cambiar el día de producción a <b>${esc(shortDate(newDay))}</b>.<br>Revisa la tasa del euro antes de continuar.</p>
      <div class="field">
        <label for="rd-rate">Tasa del euro (Bs por €)</label>
        <input id="rd-rate" type="text" inputmode="decimal" placeholder="Ej: 45,50" value="${hasRate ? esc(state.rate.eurRate) : ''}">
        <p class="note" style="margin-top:6px">${hasRate ? `Última actualización: ${esc(state.rate.updatedDay ? shortDate(state.rate.updatedDay) : 'sin fecha')}.` : 'Todavía no hay una tasa definida.'}</p>
      </div>
      <div id="rd-err" class="notice hidden"></div>`;
    const foot = el('div', 'dialog-actions');
    const keep = el('button', '', 'Mantener tasa actual');
    keep.type = 'button';
    const save = el('button', 'accent', 'Guardar tasa y continuar');
    save.type = 'button';
    if (hasRate) foot.append(keep);
    foot.append(save);
    const layer = pushLayer({
      kind: 'dialog', title: 'Asegúrate de que la tasa esté actualizada', body, foot,
      dismissible: hasRate, onClose: () => finish(false)
    });
    const commitChange = async (rateValue) => {
      save.disabled = true;
      keep.disabled = true;
      try {
        const batch = writeBatch(db);
        if (rateValue) {
          batch.set(doc(db, 'settings', 'rate'), {
            eurRate: rateValue, updatedDay: localDate(), updatedBy: myName(), updatedAt: serverTimestamp()
          }, { merge: true });
        }
        batch.set(doc(db, 'settings', 'production'), {
          productionDay: newDay, updatedBy: myName(), updatedAt: serverTimestamp()
        }, { merge: true });
        await settle(batch.commit());
        toast('Día de producción actualizado para los dos.', 'good');
        finish(true);
        layer.close();
      } catch (e) {
        problem(e);
        save.disabled = false;
        keep.disabled = false;
      }
    };
    save.onclick = () => {
      const v = parseRate(body.querySelector('#rd-rate').value);
      const err = body.querySelector('#rd-err');
      if (!v) { err.textContent = 'Escribe una tasa mayor que cero.'; err.classList.remove('hidden'); return; }
      commitChange(v);
    };
    keep.onclick = () => commitChange(0);
  });
}

/* ---------- Order modal (new / edit) ---------- */
function openOrder(order = null) {
  const products = state.products.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const keyOf = (i) => i.key || `${i.productId}:${i.variantId}`;
  const chosen = new Map((order?.items || []).map((i) => [keyOf(i), { ...i, key: keyOf(i) }]));
  let selectedClientId = order?.clientId || null;

  const wrap = el('div');
  wrap.innerHTML = `
    <div class="twocol">
      <div class="field field-client">
        <label for="c-name">Cliente *</label>
        <input id="c-name" maxlength="90" placeholder="Nombre de la persona" autocomplete="off" value="${esc(order?.customer || '')}">
        <div id="c-suggest" class="suggest hidden"></div>
      </div>
      <div class="field">
        <label for="c-place">Lugar de entrega</label>
        <input id="c-place" maxlength="150" placeholder="Dirección o referencia" value="${esc(order?.place || '')}">
      </div>
    </div>
    <div class="field hidden" id="phone-field">
      <label for="c-phone">Teléfono (opcional, se guarda una sola vez)</label>
      <input id="c-phone" inputmode="tel" maxlength="20" placeholder="Ej: 584121234567">
    </div>
    <div class="field">
      <label for="c-date">Día específico (opcional)</label>
      <input id="c-date" type="date" value="${esc(order?.date || '')}">
      <p class="note" style="margin-top:6px">Si lo dejas vacío, el pedido queda en el día de producción: <b>${esc(shortDate(state.productionDay))}</b>.</p>
    </div>
    <div class="field">
      <label for="c-note">Nota del pedido (opcional)</label>
      <textarea id="c-note" maxlength="350" placeholder="Indicaciones generales del pedido">${esc(order?.note || '')}</textarea>
    </div>
    <div class="sectionline"><b>Productos y presentaciones</b><span class="fine muted">Toca para sumar · mantén para quitar</span></div>
    <div id="chip-groups" class="chip-groups"></div>
    <div id="summary" class="summary"></div>`;

  const foot = el('div', 'foot-row');
  foot.innerHTML = '<strong id="order-total">€ 0,00</strong><button type="button" id="save-order" class="accent">Guardar pedido</button>';
  const layer = pushLayer({ title: order ? 'Editar pedido' : 'Nuevo pedido', body: wrap, foot });

  const nameInput = wrap.querySelector('#c-name');
  const placeInput = wrap.querySelector('#c-place');
  const phoneField = wrap.querySelector('#phone-field');
  const phoneInput = wrap.querySelector('#c-phone');
  const dateInput = wrap.querySelector('#c-date');
  const suggestBox = wrap.querySelector('#c-suggest');
  const chipGroups = wrap.querySelector('#chip-groups');
  const summaryBox = wrap.querySelector('#summary');
  const totalLabel = foot.querySelector('#order-total');
  const saveBtn = foot.querySelector('#save-order');

  const findClient = () => (selectedClientId && state.clients.find((c) => c.id === selectedClientId))
    || state.clients.find((c) => c.normalizedName === normalizeName(nameInput.value));
  const updatePhoneField = () => {
    const hasName = nameInput.value.trim();
    const cl = findClient();
    phoneField.classList.toggle('hidden', !(hasName && !(cl && cl.phone)));
  };
  updatePhoneField();

  nameInput.addEventListener('input', () => {
    selectedClientId = null;
    updatePhoneField();
    const term = normalizeName(nameInput.value);
    if (!term) { suggestBox.classList.add('hidden'); return; }
    const matches = state.clients.filter((c) => c.normalizedName.includes(term)).slice(0, 6);
    if (!matches.length) { suggestBox.classList.add('hidden'); return; }
    suggestBox.innerHTML = matches.map((c) => `<button type="button" data-client="${esc(c.id)}">${esc(c.name)}<small>${esc(c.place || 'Sin lugar registrado')}</small></button>`).join('');
    suggestBox.classList.remove('hidden');
  });
  suggestBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-client]');
    if (!b) return;
    const client = state.clients.find((c) => c.id === b.dataset.client);
    if (!client) return;
    selectedClientId = client.id;
    nameInput.value = client.name;
    if (client.place) placeInput.value = client.place;
    suggestBox.classList.add('hidden');
    updatePhoneField();
  });
  wrap.addEventListener('click', (e) => { if (!e.target.closest('.field-client')) suggestBox.classList.add('hidden'); });

  const chipHtml = (p, v) => {
    const key = `${p.id}:${v.id}`;
    const item = chosen.get(key);
    const qty = item?.qty || 0;
    return `<button type="button" class="chip ${qty ? 'on' : ''}" data-key="${esc(key)}">${esc(v.name)}<small>${euro(item?.priceCents ?? v.priceCents)}</small>${qty ? `<span class="badge">${qty}</span>` : ''}</button>`;
  };
  const renderChips = () => {
    chipGroups.innerHTML = products.length
      ? products.map((p) => `<div class="chip-group"><h4>${esc(p.name)}</h4><div class="chip-grid">${(p.variants || []).map((v) => chipHtml(p, v)).join('')}</div></div>`).join('')
      : '<p class="note">No hay productos activos. Crea uno en la pestaña Carta.</p>';
  };
  const renderSummary = () => {
    const list = [...chosen.values()].filter((i) => i.qty > 0);
    summaryBox.innerHTML = list.length ? list.map((i) => `
      <div class="summary-row">
        <div class="name">${esc(i.productName)} · ${esc(i.variantName)}
          <input class="note-input" data-note-key="${esc(i.key)}" placeholder="Nota de este producto (opcional)" maxlength="120" value="${esc(i.note || '')}">
        </div>
        <div class="stepper">
          <button type="button" data-step="-1" data-key="${esc(i.key)}" aria-label="Quitar uno">−</button>
          <b>${i.qty}</b>
          <button type="button" data-step="1" data-key="${esc(i.key)}" aria-label="Añadir uno">+</button>
        </div>
        <button type="button" class="small" data-remove="${esc(i.key)}" aria-label="Quitar producto">✕</button>
      </div>`).join('') : '<p class="note">Todavía no has agregado productos.</p>';
    totalLabel.textContent = euro(list.reduce((s, i) => s + i.qty * i.priceCents, 0));
  };
  const setChipVisual = (key) => {
    const chip = chipGroups.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!chip) return;
    const qty = chosen.get(key)?.qty || 0;
    chip.classList.toggle('on', qty > 0);
    let badge = chip.querySelector('.badge');
    if (qty > 0) {
      if (!badge) { badge = el('span', 'badge'); chip.append(badge); }
      badge.textContent = qty;
    } else if (badge) badge.remove();
  };
  const changeQty = (key, delta) => {
    let item = chosen.get(key);
    if (!item) {
      const [pid, vid] = key.split(':');
      const p = products.find((x) => x.id === pid);
      const v = p?.variants.find((x) => x.id === vid);
      if (!v) return;
      item = { key, productId: p.id, variantId: v.id, productName: p.name, variantName: v.name, category: p.category || '', priceCents: v.priceCents, qty: 0, readyQty: 0, note: '' };
    }
    const qty = Math.max(0, Math.min(999, item.qty + delta));
    if (qty === 0) chosen.delete(key);
    else chosen.set(key, { ...item, qty, readyQty: Math.min(item.readyQty || 0, qty) });
    setChipVisual(key);
    renderSummary();
  };
  renderChips();
  renderSummary();

  chipGroups.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    b._held = false;
    b._sx = e.clientX;
    b._sy = e.clientY;
    clearTimeout(b._timer);
    b._timer = setTimeout(() => {
      b._held = true;
      if (chosen.delete(b.dataset.key)) navigator.vibrate?.(25);
      setChipVisual(b.dataset.key);
      renderSummary();
    }, 900);
  });
  chipGroups.addEventListener('pointermove', (e) => {
    const b = e.target.closest('[data-key]');
    if (b && b._timer && (Math.abs(e.clientX - b._sx) > 10 || Math.abs(e.clientY - b._sy) > 10)) clearTimeout(b._timer);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => chipGroups.addEventListener(evt, (e) => {
    const b = e.target.closest('[data-key]');
    if (b) clearTimeout(b._timer);
  }));
  chipGroups.addEventListener('contextmenu', (e) => e.preventDefault());
  chipGroups.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    if (b._held) { b._held = false; return; }
    changeQty(b.dataset.key, 1);
  });
  summaryBox.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) { changeQty(step.dataset.key, Number(step.dataset.step)); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm) { chosen.delete(rm.dataset.remove); setChipVisual(rm.dataset.remove); renderSummary(); }
  });
  summaryBox.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-note-key]');
    const item = inp && chosen.get(inp.dataset.noteKey);
    if (item) item.note = inp.value;
  });

  saveBtn.onclick = async () => {
    const customer = nameInput.value.trim();
    const place = placeInput.value.trim();
    const note = wrap.querySelector('#c-note').value.trim();
    const items = [...chosen.values()].filter((i) => i.qty > 0).map((i) => ({
      key: i.key, productId: i.productId, variantId: i.variantId,
      productName: i.productName, variantName: i.variantName,
      category: i.category || state.products.find((p) => p.id === i.productId)?.category || '',
      priceCents: i.priceCents, qty: i.qty,
      readyQty: Math.min(i.readyQty || 0, i.qty), note: (i.note || '').trim()
    }));
    if (!customer) { flash('Escribe el nombre del cliente.'); return; }
    if (!items.length) { flash('Agrega al menos un producto.'); return; }
    if (!ensureRate('guardar pedidos')) return;
    const finalDate = dateInput.value || state.productionDay;
    if (!finalDate) { flash('Define primero el día de producción.'); return; }
    const totalCents = items.reduce((s, i) => s + i.qty * i.priceCents, 0);
    const phone = phoneField.classList.contains('hidden') ? '' : onlyDigits(phoneInput.value);

    saveBtn.disabled = true;
    try {
      if (order) {
        if (!navigator.onLine) { flash('Necesitas conexión para editar.'); return; }
        const cur = state.orders.find((o) => o.id === order.id) || order;
        if (cur.delivered) { flash('Desmarca Entregado antes de editar el pedido.'); return; }
        const paid = paidCents(cur);
        if (paid > totalCents) {
          const ok = await confirmDialog({
            title: 'Pagado de más',
            message: `Este pedido ya tiene ${euro(paid)} pagados y el nuevo total es ${euro(totalCents)}.\nQuedará como "Pagado de más ${euro(paid - totalCents)}". ¿Guardar igual?`,
            confirmText: 'Guardar igual'
          });
          if (!ok) return;
        }
        await runTransaction(db, async (tx) => {
          const ref = doc(db, 'orders', order.id);
          const snap = await tx.get(ref);
          if (!snap.exists()) throw Error('Este pedido ya no existe.');
          const c = snap.data();
          if ((c.revision || 0) !== (order.revision || 0)) throw Error('Este pedido cambió en el otro dispositivo. Cierra y vuelve a abrir para editar la versión actual.');
          if (c.delivered) throw Error('Desmarca Entregado antes de editar el pedido.');
          if (c.deleted) throw Error('Este pedido está en la papelera.');
          const merged = items.map((i) => {
            const prev = (c.items || []).find((x) => (x.key || `${x.productId}:${x.variantId}`) === i.key);
            return { ...i, readyQty: Math.min(i.qty, prev?.readyQty || 0) };
          });
          const clientId = queueClient(tx, { name: customer, place, phone, selectedId: selectedClientId });
          tx.update(ref, {
            customer, place, note, items: merged, totalCents, clientId, date: finalDate,
            payments: getPayments(c), revision: (c.revision || 0) + 1,
            updatedAt: serverTimestamp(), updatedBy: myName()
          });
          writeEvent(tx, finalDate, order.id, `Editó el pedido de ${customer}`);
        });
      } else {
        const batch = writeBatch(db);
        const ref = doc(collection(db, 'orders'));
        const clientId = queueClient(batch, { name: customer, place, phone, selectedId: selectedClientId });
        batch.set(ref, {
          date: finalDate, customer, place, note, items, totalCents, clientId,
          delivered: false, deliveredAt: null, payments: [], archived: false, deleted: false, revision: 0,
          createdBy: state.user.email || state.user.uid, createdByUid: state.user.uid, createdByName: myName(),
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName()
        });
        writeEvent(batch, finalDate, ref.id, `Creó el pedido de ${customer}`);
        await settle(batch.commit());
      }
      layer.close();
    } catch (err) {
      if (order && (err?.code === 'unavailable' || err?.code === 'failed-precondition')) flash('Necesitas conexión para editar.');
      else problem(err);
    } finally {
      saveBtn.disabled = false;
    }
  };
}

/* ---------- Per-line preparation picker ---------- */
function openPrepare(order) {
  let latest = order;
  let layer = null;
  const wrap = el('div');
  wrap.innerHTML = '<p class="note">Marca cuántas unidades están realmente listas. Ambos verán el avance.</p><div id="prep-lines"></div>';
  const foot = el('div');
  const done = el('button', 'primary', 'Cerrar');
  done.type = 'button';
  foot.append(done);
  const lines = wrap.querySelector('#prep-lines');
  const paint = () => {
    lines.innerHTML = (latest.items || []).map((i, index) => `
      <div class="qtyrow">
        <span>${esc(i.productName)} · ${esc(i.variantName)}<br><span class="muted">${i.qty} encargado(s)${i.note ? ' · ' + esc(i.note) : ''}</span></span>
        <div class="stepper">
          <button type="button" data-index="${index}" data-delta="-1">−</button>
          <b>${Math.min(i.qty, i.readyQty || 0)}/${i.qty}</b>
          <button type="button" data-index="${index}" data-delta="1">+</button>
        </div>
      </div>`).join('');
  };
  paint();
  const unsub = onSnapshot(doc(db, 'orders', order.id), (snap) => {
    if (!snap.exists() || snap.data().deleted) { layer?.close(); return; }
    latest = { id: snap.id, ...snap.data() };
    paint();
  }, problem);
  layer = pushLayer({ title: `Preparación · ${order.customer}`, body: wrap, foot, onClose: () => unsub() });
  done.onclick = () => layer.close();
  lines.addEventListener('click', (e) => {
    const b = e.target.closest('[data-index]');
    if (!b) return;
    if (latest.delivered) { toast('Desmarca Entregado para cambiar la preparación.'); return; }
    const ix = Number(b.dataset.index);
    const items = (latest.items || []).map((i) => ({ ...i }));
    const it = items[ix];
    if (!it) return;
    it.readyQty = Math.max(0, Math.min(it.qty, (it.readyQty || 0) + Number(b.dataset.delta)));
    latest = { ...latest, items };
    paint();
    orderUpdate(latest, { items }, null).catch(problem);
  });
}

/* ---------- Payment sheet ---------- */
function openPaymentSheet(order) {
  const cur = () => state.orders.find((o) => o.id === order.id) || order;
  const o0 = cur();
  const bal0 = Math.max(0, balanceCents(o0));
  const rate = state.rate.eurRate || 0;
  const pays = getPayments(o0);
  const wrap = el('div');
  wrap.innerHTML = `
    <div class="pay-summary">
      <div><span class="fine muted">Total</span><b>${euro(o0.totalCents)}</b></div>
      <div><span class="fine muted">Pagado</span><b>${euro(paidCents(o0))}</b></div>
      <div><span class="fine muted">Falta</span><b>${euro(bal0)}</b></div>
    </div>
    <div class="field">
      <label for="pay-amount">Monto a registrar (€)</label>
      <input id="pay-amount" inputmode="decimal" value="${(bal0 / 100).toFixed(2)}">
      <p class="note" id="pay-bs" style="margin-top:6px"></p>
    </div>
    <div class="sectionline"><b>Método de pago</b><span class="fine muted">Toca uno para confirmar</span></div>
    <div class="method-grid">
      ${METHODS.map((m) => `<button type="button" data-method="${esc(m)}">${esc(m)}</button>`).join('')}
      <button type="button" class="quiet" data-method="">Omitir</button>
    </div>
    ${pays.length ? `<button type="button" class="small danger" id="pay-undo" style="margin-top:14px">Deshacer último pago (${euro(pays[pays.length - 1].amountCents)})</button>` : ''}`;
  const foot = el('div');
  const cancel = el('button', '', 'Cancelar');
  cancel.type = 'button';
  foot.append(cancel);
  const layer = pushLayer({ title: `Pago · ${order.customer}`, body: wrap, foot });
  cancel.onclick = () => layer.close();
  const amountInput = wrap.querySelector('#pay-amount');
  const bsNote = wrap.querySelector('#pay-bs');
  const paintBs = () => {
    try { bsNote.textContent = `Equivale a ${bs(parseMoney(amountInput.value), rate)} con la tasa de hoy (${rate.toLocaleString('es-VE', numFmt)} Bs/€).`; }
    catch { bsNote.textContent = ''; }
  };
  paintBs();
  amountInput.addEventListener('input', paintBs);
  wrap.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-method]');
    if (m) {
      let cents;
      try { cents = parseMoney(amountInput.value); } catch (err) { flash(err.message); return; }
      const latest = cur();
      const bal = balanceCents(latest);
      if (cents <= 0) { flash('El monto debe ser mayor que cero.'); return; }
      if (cents > bal) { flash(`El monto no puede superar lo que falta (${euro(Math.max(0, bal))}).`); return; }
      m.disabled = true;
      try { if (await addPayment(latest, cents, m.dataset.method)) layer.close(); } catch (err) { problem(err); } finally { m.disabled = false; }
      return;
    }
    if (e.target.closest('#pay-undo')) {
      try { await undoLastPayment(cur()); layer.close(); } catch (err) { problem(err); }
    }
  });
}

/* ---------- Charge message ---------- */
function buildChargeMessage(o) {
  const rate = state.rate.eurRate || 0;
  const total = o.totalCents || 0;
  const paid = paidCents(o);
  const bal = total - paid;
  const lines = (o.items || []).map((i) => `- ${i.qty} x ${i.productName} (${i.variantName}): ${euro(i.qty * i.priceCents)}`);
  let t = `Hola ${o.customer}, tu pedido:\n${lines.join('\n')}\n\nTotal: ${euro(total)}`;
  if (paid > 0) t += `\nPagado: ${euro(paid)}`;
  if (bal <= 0) {
    t += '\n\n¡Pago recibido, gracias!';
  } else {
    if (paid > 0) t += `\nPor pagar: ${euro(bal)}`;
    if (rate > 0) t += `\nTasa: ${rate.toLocaleString('es-VE', numFmt)} Bs/€\nEquivalente en bolívares: ${bs(bal, rate)}`;
    else t += '\n(Falta definir la tasa del euro para calcular los bolívares.)';
  }
  if ((state.paymentInfo || '').trim()) t += `\n\n${state.paymentInfo.trim()}`;
  return t;
}

function openCharge(order) {
  const cur = () => state.orders.find((o) => o.id === order.id) || order;
  const clientOf = (o) => state.clients.find((c) => c.id === o.clientId)
    || state.clients.find((c) => c.normalizedName === normalizeName(o.customer));
  const wrap = el('div');
  wrap.innerHTML = `
    <textarea id="charge-text" class="charge-text" readonly></textarea>
    <div id="phone-inline" class="field hidden" style="margin-top:14px">
      <label for="ph-input">Teléfono del cliente (se guarda una sola vez)</label>
      <div class="inline-form"><input id="ph-input" inputmode="tel" maxlength="20" placeholder="Ej: 584121234567"><button type="button" class="small accent" id="ph-save">Guardar teléfono</button></div>
    </div>
    <details class="fold" style="margin-top:14px">
      <summary>Datos de pago (se agregan al mensaje)</summary>
      <div class="fold-body">
        <textarea id="pay-info" maxlength="600" placeholder="Banco, pago móvil, Zelle…"></textarea>
        <div class="sectionline" style="margin-top:8px"><span class="note">Se comparte entre los dos.</span><button type="button" class="small" id="pay-info-save">Guardar datos de pago</button></div>
      </div>
    </details>`;
  const foot = el('div', 'foot-actions');
  const layer = pushLayer({ title: 'Mensaje de cobro', body: wrap, foot });
  const ta = wrap.querySelector('#charge-text');
  const phoneInline = wrap.querySelector('#phone-inline');
  const infoArea = wrap.querySelector('#pay-info');
  infoArea.value = state.paymentInfo || '';

  const copy = () => {
    const text = ta.value;
    const fallback = () => {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, 99999);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      if (ok) toast('Mensaje copiado.', 'good');
      else toast('No se pudo copiar automáticamente. El texto quedó seleccionado: mantén presionado y elige Copiar.', 'error');
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast('Mensaje copiado.', 'good'), fallback);
    else fallback();
  };
  const refresh = () => {
    const o = cur();
    const client = clientOf(o);
    ta.value = buildChargeMessage(o);
    phoneInline.classList.toggle('hidden', !client || !!client.phone);
    const digits = onlyDigits(client?.phone);
    foot.innerHTML = `<button type="button" class="accent" id="copy-charge">Copiar mensaje</button>${digits ? `<a class="btn primary" id="wa-link" target="_blank" rel="noopener" href="https://wa.me/${digits}?text=${encodeURIComponent(ta.value)}">Abrir WhatsApp</a>` : ''}`;
    foot.querySelector('#copy-charge').onclick = copy;
  };
  refresh();

  wrap.querySelector('#ph-save').onclick = async () => {
    const client = clientOf(cur());
    const digits = onlyDigits(wrap.querySelector('#ph-input').value);
    if (!client || digits.length < 8) { flash('Escribe el teléfono con código de país, solo números.'); return; }
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'clients', client.id), { phone: digits, updatedAt: serverTimestamp() });
      client.phone = digits;
      refresh();
      await settle(batch.commit());
    } catch (err) { problem(err); }
  };
  wrap.querySelector('#pay-info-save').onclick = async () => {
    const text = infoArea.value.trim();
    try {
      state.paymentInfo = text;
      refresh();
      await settle(setDoc(doc(db, 'settings', 'payment'), { text, updatedAt: serverTimestamp(), updatedBy: myName() }, { merge: true }));
      toast('Datos de pago guardados.', 'good');
    } catch (err) { problem(err); }
  };
  return layer;
}

/* ---------- Week detail ---------- */
function openWeek(weekKey) {
  const orders = state.orders.filter((o) => !o.deleted && o.date && monday(o.date) === weekKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  const wrap = el('div');
  wrap.innerHTML = orders.length ? orders.map((o) => {
    const pays = getPayments(o);
    const payLines = pays.length
      ? pays.map((p) => `<div class="fine">${euro(p.amountCents)}${p.rateEUR ? ` · ${bs(p.amountCents, p.rateEUR)} (tasa congelada: ${p.rateEUR.toLocaleString('es-VE', numFmt)})` : ' · sin tasa registrada'}${p.method ? ` · ${esc(p.method)}` : ''}</div>`).join('')
      : '<div class="fine muted">Pendiente de cobro</div>';
    return `
    <div class="log-item">
      <b>${esc(shortDate(o.date))} · ${esc(o.customer)}</b>${o.archived ? ' <span class="tag">Archivado</span>' : ''}
      <div class="fine muted">${(o.items || []).map((i) => `${i.qty} x ${esc(i.productName)} (${esc(i.variantName)})`).join(', ')}</div>
      <div style="margin-top:4px"><b>${euro(o.totalCents)}</b> · ${esc(payInfo(o).label)}</div>
      ${payLines}
    </div>`;
  }).join('') : '<div class="empty">No hay pedidos en esta semana.</div>';
  const foot = el('div');
  const close = el('button', 'primary', 'Cerrar');
  close.type = 'button';
  foot.append(close);
  const layer = pushLayer({ title: `Semana del ${weekKey}`, body: wrap, foot });
  close.onclick = () => layer.close();
}

/* ---------- Product modal ---------- */
function openProduct(product = null) {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const wrap = el('div');
  wrap.innerHTML = `
    <div class="field">
      <label for="p-name">Nombre del producto *</label>
      <input id="p-name" maxlength="90" placeholder="Por ejemplo: Pan de jamón" value="${esc(product?.name || '')}">
    </div>
    <div class="field">
      <label for="p-cat">Categoría (opcional)</label>
      <input id="p-cat" maxlength="40" list="cat-list" placeholder="Panes, Roles, Postres…" value="${esc(product?.category || '')}">
      <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
    </div>
    <div class="sectionline" style="margin-bottom:10px"><b>Presentaciones</b><button type="button" id="add-variant" class="small">+ Presentación</button></div>
    <div id="variants"></div>
    <p class="note">Precio en euros; usa punto o coma decimal, sin separadores de miles. Cambiarlo no altera pedidos anteriores.</p>`;
  const foot = el('div', 'foot-row');
  foot.innerHTML = `
    <button type="button" id="toggle-product" class="small ${product?.active === false ? '' : 'danger'}" ${product ? '' : 'style="visibility:hidden"'}>${product?.active === false ? 'Activar' : 'Desactivar'}</button>
    <button type="button" id="save-product" class="accent">Guardar producto</button>`;
  const layer = pushLayer({ title: product ? 'Editar producto' : 'Crear producto', body: wrap, foot });

  const rows = wrap.querySelector('#variants');
  const addVariant = (v = {}) => {
    const row = el('div', 'variant-edit');
    row.dataset.id = v.id || crypto.randomUUID();
    row.innerHTML = `
      <input class="v-name" maxlength="80" placeholder="Presentación (p. ej. mediano)" value="${esc(v.name || '')}">
      <input class="v-price" inputmode="decimal" placeholder="Precio €" value="${v.priceCents === undefined ? '' : (v.priceCents / 100).toFixed(2)}">
      <button type="button" class="small v-remove" title="Quitar presentación" aria-label="Quitar presentación">✕</button>`;
    rows.append(row);
  };
  (product?.variants || [{ name: 'Unidad' }]).forEach(addVariant);
  wrap.querySelector('#add-variant').onclick = () => addVariant();
  rows.addEventListener('click', (e) => { if (e.target.closest('.v-remove')) e.target.closest('.variant-edit').remove(); });

  const saveBtn = foot.querySelector('#save-product');
  saveBtn.onclick = async () => {
    const name = wrap.querySelector('#p-name').value.trim();
    const category = wrap.querySelector('#p-cat').value.trim();
    if (!name) { flash('Escribe el nombre del producto.'); return; }
    let variants;
    try {
      variants = [...rows.querySelectorAll('.variant-edit')].map((r) => ({
        id: r.dataset.id,
        name: r.querySelector('.v-name').value.trim(),
        priceCents: parseMoney(r.querySelector('.v-price').value)
      }));
      if (!variants.length || variants.some((v) => !v.name)) throw Error('Agrega al menos una presentación con nombre y precio.');
      if (new Set(variants.map((v) => v.name.toLocaleLowerCase())).size !== variants.length) throw Error('No repitas nombres de presentación.');
    } catch (err) { flash(err.message); return; }
    saveBtn.disabled = true;
    try {
      const batch = writeBatch(db);
      const ref = product ? doc(db, 'products', product.id) : doc(collection(db, 'products'));
      const data = { name, category, variants, active: product?.active !== false, updatedAt: serverTimestamp() };
      if (product) batch.update(ref, data); else batch.set(ref, data);
      await settle(batch.commit());
      layer.close();
    } catch (err) { problem(err); } finally { saveBtn.disabled = false; }
  };
  const toggle = foot.querySelector('#toggle-product');
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'products', product.id), { active: product.active === false, updatedAt: serverTimestamp() });
      await settle(batch.commit());
      layer.close();
    } catch (err) { problem(err); } finally { toggle.disabled = false; }
  };
}

/* ---------- Client profile ---------- */
function openClientProfile(client) {
  if (!client) return;
  const orders = ordersOfClient(client).sort((a, b) => (b.date || '').localeCompare(a.date || '') || createdMs(b) - createdMs(a));
  const total = orders.reduce((s, o) => s + (o.totalCents || 0), 0);
  const g = groupUnits(orders);
  const last = orders.length ? orders[0].date : '';
  const wrap = el('div');
  wrap.innerHTML = `
    <div class="field"><label for="cl-name">Nombre</label><input id="cl-name" maxlength="90" value="${esc(client.name)}"></div>
    <div class="twocol">
      <div class="field"><label for="cl-place">Lugar habitual</label><input id="cl-place" maxlength="150" value="${esc(client.place || '')}"></div>
      <div class="field"><label for="cl-phone">Teléfono (código de país, solo números)</label><input id="cl-phone" inputmode="tel" maxlength="20" placeholder="Ej: 584121234567" value="${esc(client.phone || '')}"></div>
    </div>
    <div class="kv-grid">
      <div><b>${orders.length}</b><span class="fine muted">pedidos</span></div>
      <div><b>${euro(total)}</b><span class="fine muted">total gastado</span></div>
      <div><b>${g.units}</b><span class="fine muted">unidades</span></div>
      <div><b>${last ? esc(asDate(last).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' })) : '—'}</b><span class="fine muted">última compra</span></div>
    </div>
    <h3 class="subtitle">Unidades compradas</h3>
    ${g.cats.length ? g.cats.map((c) => `
      <div class="group">
        <div class="group-title">${esc(c.name)} — ${c.total}</div>
        ${[...c.products.values()].sort((a, b) => b.total - a.total).map((p) => `<div class="group-line">${esc(p.name)}: ${p.total} <span class="muted">(${[...p.variants.entries()].map(([v, n]) => `${esc(v)} ${n}`).join(', ')})</span></div>`).join('')}
      </div>`).join('') : '<p class="note">Todavía no ha comprado nada.</p>'}
    <h3 class="subtitle">Compras</h3>
    ${orders.length ? orders.map((o) => `
      <div class="log-item">
        <b>${esc(shortDate(o.date))}</b>${o.archived ? ' <span class="tag">Archivado</span>' : ''}
        <div class="fine muted">${(o.items || []).map((i) => `${i.qty} x ${esc(i.productName)} (${esc(i.variantName)})`).join(', ')}</div>
        <div style="margin-top:3px">${euro(o.totalCents)} · ${esc(payInfo(o).label)}</div>
      </div>`).join('') : '<div class="empty">Sin compras registradas.</div>'}`;
  const foot = el('div', 'foot-row');
  foot.innerHTML = '<span></span><button type="button" id="save-client" class="accent">Guardar cliente</button>';
  const layer = pushLayer({ title: client.name, body: wrap, foot });
  const saveBtn = foot.querySelector('#save-client');
  saveBtn.onclick = async () => {
    const name = wrap.querySelector('#cl-name').value.trim();
    const place = wrap.querySelector('#cl-place').value.trim();
    const phone = onlyDigits(wrap.querySelector('#cl-phone').value);
    if (!name) { flash('El nombre no puede quedar vacío.'); return; }
    saveBtn.disabled = true;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'clients', client.id), { name, normalizedName: normalizeName(name), place, phone, updatedAt: serverTimestamp() });
      await settle(batch.commit());
      layer.close();
    } catch (err) { problem(err); } finally { saveBtn.disabled = false; }
  };
}

/* ---------- Awareness of the other person's orders (in-app only) ---------- */
function handleOrderChanges(snap) {
  const myUid = state.user.uid;
  if (!state.ordersReady) {
    if (snap.metadata.fromCache) return;
    state.ordersReady = true;
    const last = Number(localStorage.getItem(LAST_OPEN_KEY) || 0);
    let fresh = 0;
    if (last) {
      for (const o of state.orders) {
        if (o.createdByUid && o.createdByUid !== myUid && !o.deleted
          && (ms(o.createdAt) || 0) > last && !state.newIds.has(o.id)) {
          state.newIds.add(o.id);
          fresh += 1;
        }
      }
    }
    const ids = new Set(state.orders.map((o) => o.id));
    for (const id of [...state.newIds]) if (!ids.has(id)) state.newIds.delete(id);
    saveNew();
    localStorage.setItem(LAST_OPEN_KEY, String(Date.now()));
    if (fresh) toast(`${fresh} pedido(s) nuevo(s) desde tu última visita.`);
    return;
  }
  for (const ch of snap.docChanges()) {
    if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites) continue;
    const d = ch.doc.data();
    if (!d.createdByUid || d.createdByUid === myUid || d.deleted) continue;
    if (state.newIds.has(ch.doc.id)) continue;
    state.newIds.add(ch.doc.id);
    saveNew();
    toast(`Nuevo pedido de ${d.customer}, agregado por ${d.createdByName || 'la otra persona'}`);
  }
}
const touchLastOpen = () => { try { localStorage.setItem(LAST_OPEN_KEY, String(Date.now())); } catch { /* ignore */ } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') touchLastOpen(); });
window.addEventListener('pagehide', touchLastOpen);

/* ---------- Auth ---------- */
const AUTH_ERRORS = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/invalid-email': 'El correo no es válido.',
  'auth/too-many-requests': 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
  'auth/network-request-failed': 'No hay conexión a internet.'
};
function showLoginMsg(msg, good = false) {
  const box = $('#login-error');
  box.textContent = msg;
  box.classList.toggle('good', good);
  box.classList.remove('hidden');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#password').value);
  } catch (err) {
    showLoginMsg(AUTH_ERRORS[err.code] || err.message);
  } finally {
    btn.disabled = false;
  }
});
$('#forgot').addEventListener('click', async () => {
  const email = $('#email').value.trim();
  if (!email) { showLoginMsg('Escribe tu correo arriba y vuelve a tocar el enlace.'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    showLoginMsg('Te enviamos un correo para restablecer tu contraseña. Revisa también la carpeta de spam.', true);
  } catch (err) {
    showLoginMsg(AUTH_ERRORS[err.code] || err.message);
  }
});
$('#logout').addEventListener('click', () => signOut(auth).catch(problem));

function startListeners() {
  const onListenError = (err) => { state.syncError = true; problem(err); updateSync(); };
  const watch = (name, qy, assign) => {
    state.unsubs.push(onSnapshot(qy, (snap) => {
      assign(snap);
      state.loaded[name] = true;
      state.syncError = false;
      updateSync();
      scheduleRender();
    }, onListenError));
  };
  watch('products', collection(db, 'products'), (snap) => { state.products = snap.docs.map(docToObj); });
  watch('orders', collection(db, 'orders'), (snap) => {
    state.orders = snap.docs.map(docToObj);
    handleOrderChanges(snap);
  });
  watch('events', query(collection(db, 'events'), orderBy('at', 'desc'), limit(40)), (snap) => { state.events = snap.docs.map(docToObj); });
  watch('clients', collection(db, 'clients'), (snap) => { state.clients = snap.docs.map(docToObj); });
  watch('settings', collection(db, 'settings'), (snap) => {
    const map = {};
    snap.docs.forEach((d) => { map[d.id] = d.data(); });
    state.rate = map.rate || { eurRate: 0, updatedDay: '' };
    state.paymentInfo = map.payment?.text || '';
    state.people = map.people || {};
    const day = map.production?.productionDay;
    state.productionDay = day || localDate();
    if (!day && !snap.metadata.fromCache && !state.creatingProduction) {
      state.creatingProduction = true;
      setDoc(doc(db, 'settings', 'production'), {
        productionDay: localDate(), updatedBy: myName(), updatedAt: serverTimestamp()
      }, { merge: true }).catch(problem);
    }
  });
}

if (auth) {
  onAuthStateChanged(auth, (user) => {
    state.unsubs.forEach((fn) => fn());
    state.unsubs = [];
    layers.slice().forEach((l) => l.close());
    closeMenu();
    closeBell();
    state.user = user;
    state.products = []; state.orders = []; state.events = []; state.clients = [];
    state.loaded = { products: false, orders: false, events: false, clients: false, settings: false };
    state.ordersReady = false;
    state.creatingProduction = false;
    state.syncError = false;
    $('#app').classList.toggle('hidden', !user);
    $('#login-screen').classList.toggle('hidden', !!user);
    const v = $('#view');
    v.dataset.skel = '';
    v.innerHTML = '';
    if (!user) return;
    updateSync();
    startListeners();
  });
}

/* ---------- Wiring ---------- */
$('#rate-input').addEventListener('change', async (e) => {
  const v = parseRate(e.target.value);
  if (!v) { flash('Escribe una tasa válida, mayor que cero.'); e.target.value = state.rate.eurRate || ''; return; }
  try {
    await settle(setDoc(doc(db, 'settings', 'rate'), {
      eurRate: v, updatedDay: localDate(), updatedBy: myName(), updatedAt: serverTimestamp()
    }, { merge: true }));
    toast('Tasa actualizada.', 'good');
  } catch (err) { problem(err); }
});
$('#day-input').addEventListener('change', async (e) => {
  const ok = await requestDayChange(e.target.value);
  if (!ok) e.target.value = state.productionDay || '';
});
$('#new-order').addEventListener('click', () => openOrder());
$('#clean-btn').addEventListener('click', () => archiveClosed());
document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    closeMenu();
    scheduleRender();
    window.scrollTo(0, 0);
  });
});
$('#bell-btn').addEventListener('click', toggleBell);
$('#bell-panel').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-goto]');
  if (!row) return;
  closeBell();
  const ok = await requestDayChange(row.dataset.goto);
  if (ok) { state.tab = 'day'; scheduleRender(); }
});
$('#menu-pop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  const o = state.orders.find((x) => x.id === b.dataset.id);
  closeMenu();
  if (!o) return;
  if (b.dataset.menu === 'edit') openOrder(o); else askTrash(o);
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#menu-pop') && !e.target.closest('[data-action="menu"]')) closeMenu();
  if (!e.target.closest('#bell-panel') && !e.target.closest('#bell-btn')) closeBell();
});
window.addEventListener('scroll', () => closeMenu(), { passive: true, capture: true });

const viewEl = $('#view');
viewEl.addEventListener('input', (e) => {
  if (e.target.id === 'search') { state.search = e.target.value; scheduleRender(); }
});
viewEl.addEventListener('toggle', (e) => {
  const section = e.target?.dataset?.section;
  if (section) state.open[section] = e.target.open;
}, true);
viewEl.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"]')) { e.preventDefault(); e.target.click(); }
});
viewEl.addEventListener('click', async (e) => {
  const card = e.target.closest('article.order[data-id], .simple-row[data-id]');
  if (card && state.newIds.has(card.dataset.id)) { state.newIds.delete(card.dataset.id); saveNew(); scheduleRender(); }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  const quick = state.tab === 'simple';
  const byId = () => state.orders.find((x) => x.id === id);
  switch (action) {
    case 'new-product': openProduct(); return;
    case 'edit-product': openProduct(state.products.find((p) => p.id === id)); return;
    case 'open-client': openClientProfile(state.clients.find((c) => c.id === id)); return;
    case 'week': openWeek(btn.dataset.week); return;
    case 'empty-trash': await emptyTrash(); return;
    case 'menu': toggleMenu(btn, id); return;
    case 'restore-archived': { const o = byId(); if (o) await withBusy(btn, () => restoreArchived(o)); return; }
    case 'restore-trash': { const o = byId(); if (o) await withBusy(btn, () => restoreFromTrash(o)); return; }
    default: break;
  }
  const o = byId();
  if (!o) return;
  if (action === 'prepared') await withBusy(btn, () => togglePrepared(o, quick));
  else if (action === 'delivered') await withBusy(btn, () => toggleDelivered(o));
  else if (action === 'pay') await withBusy(btn, () => onPayTap(o, quick));
  else if (action === 'charge') openCharge(o);
  else if (action === 'trash') await askTrash(o);
});

/* ---------- PWA, install hint, version label ---------- */
$('#version-tag').textContent = `Mesa v${APP_VERSION}`;
(function setupInstallHint() {
  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = !!localStorage.getItem(HINT_KEY); } catch { dismissed = false; }
  if (isIOS && !standalone && !dismissed) $('#ios-hint').classList.remove('hidden');
  $('#ios-hint-close').addEventListener('click', () => {
    $('#ios-hint').classList.add('hidden');
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
  });
})();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker no registrado', err));
  });
}
