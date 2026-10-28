// In-memory stand-in for firebase-firestore (offline tests only — no network).
// Mirrors the small surface src/rtc.js actually uses, including serialized
// transactions and synchronous onSnapshot notification on write.

const store = new Map(); // path -> data
const listeners = new Map(); // path -> Set<cb>

function notify(path) {
  const cbs = listeners.get(path);
  if (!cbs || cbs.size === 0) return;
  const data = store.get(path);
  const snap = {
    exists: !!data,
    id: path.split('/').pop(),
    data: () => (data ? { ...data } : undefined),
  };
  for (const cb of [...cbs]) cb(snap);
}

export function getFirestore() {
  return { __db: true };
}

export function doc(db, coll, id) {
  return { __ref: true, path: `${coll}/${id}`, id };
}

export function collection(db, name) {
  return { __coll: true, name };
}

export function where(field, op, val) {
  return { __where: true, field, op, val };
}

export function limit(n) {
  return { __limit: n };
}

export function query(coll, ...parts) {
  return { __query: true, coll, parts };
}

export async function getDocs(q) {
  const prefix = `${q.coll.name}/`;
  const out = [];
  for (const [path, data] of store) {
    if (!path.startsWith(prefix)) continue;
    const d = { ...data };
    let ok = true;
    for (const p of q.parts) {
      if (p.__limit) continue;
      if (p.op === '==' && d[p.field] !== p.val) ok = false;
      if (p.op === '>=' && !(d[p.field] >= p.val)) ok = false;
    }
    if (!ok) continue;
    out.push({ id: path.slice(prefix.length), path, data: () => d });
  }
  out.sort((a, b) => (b.data().createdAt || 0) - (a.data().createdAt || 0));
  const lim = q.parts.find((p) => p.__limit);
  return { docs: lim ? out.slice(0, lim.__limit) : out };
}

export async function getDoc(ref) {
  const data = store.get(ref.path);
  return { exists: !!data, id: ref.id, data: () => (data ? { ...data } : undefined) };
}

export async function setDoc(ref, data) {
  store.set(ref.path, { ...data });
  notify(ref.path);
}

export async function updateDoc(ref, patch) {
  const cur = store.get(ref.path) || {};
  Object.assign(cur, patch);
  store.set(ref.path, cur);
  notify(ref.path);
}

export async function deleteDoc(ref) {
  store.delete(ref.path);
  notify(ref.path);
}

// Firestore transactions are serialized; the mock keeps the same guarantee
let txChain = Promise.resolve();

export function runTransaction(db, fn) {
  const run = txChain.then(async () => {
    const tx = {
      get: async (ref) => {
        const data = store.get(ref.path);
        return { exists: !!data, id: ref.id, data: () => (data ? { ...data } : undefined) };
      },
      update: async (ref, patch) => updateDoc(ref, patch),
      set: async (ref, data) => setDoc(ref, data),
    };
    return fn(tx);
  });
  txChain = run.catch(() => {});
  return run;
}

export function onSnapshot(ref, cb, errCb) {
  if (!listeners.has(ref.path)) listeners.set(ref.path, new Set());
  listeners.get(ref.path).add(cb);
  return () => listeners.get(ref.path).delete(cb);
}

export function serverTimestamp() {
  return { __serverTs: true };
}

/** Test helpers: direct store access + reset between scenarios. */
export const _store = store;
export function _reset() {
  store.clear();
  listeners.clear();
  txChain = Promise.resolve();
}
