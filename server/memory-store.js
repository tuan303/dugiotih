// Kho dữ liệu trong bộ nhớ, cùng giao diện với firestoreStore() (server/sync.js).
// Dùng cho scripts/dry-run.mjs và kiểm thử offline (máy không có Firestore emulator).
//
// Giao diện kho (store):
//   get(path)                       → Promise<object|null>         path dạng 'col/doc'
//   listIds(collection)             → Promise<string[]>
//   commitBatch(ops)                → ghi nguyên tử (≤ 500 thao tác)
//   commitMany(ops, size = 400)     → ghi theo từng lô ≤ size (mỗi lô nguyên tử)
//   acquireLock(nowMs, ttlMs)       → Promise<string|null>  mã khóa, hoặc null nếu đang bị khóa (khi đó ghi nhận “có yêu cầu chờ”)
//   releaseLock(token, {nowMs, ttlMs, rerun}) → Promise<boolean>  true = có yêu cầu chờ → khóa được gia hạn để chạy lại
//   serverTimestamp()               → giá trị đặc biệt, thay bằng thời điểm ghi
//   timestamp(date)                 → giá trị thời điểm của kho
// ops: { type: 'set', path, data, merge? } | { type: 'delete', path }

import { randomUUID } from 'node:crypto';

export const MAX_BATCH_OPS = 500;
const SERVER_TS = Object.freeze({ __memoryServerTimestamp: true });
const LOCK_PATH = 'config/syncLock';

const isDocPath = p => typeof p === 'string' && /^[^/]+\/[^/]+(\/[^/]+\/[^/]+)*$/.test(p);

// Giống Firestore thật (firebase-admin mặc định ignoreUndefinedProperties = false): giá trị undefined → lỗi,
// để kiểm thử phát hiện sớm thay vì chỉ lỗi khi chạy thật.
function resolveSentinels(v, now, at = '') {
  if (v === undefined) throw new Error(`Không thể ghi giá trị undefined vào Firestore (trường “${at || '?'}”).`);
  if (v === SERVER_TS) return new Date(now);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map((x, i) => resolveSentinels(x, now, `${at}[${i}]`));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveSentinels(x, now, at ? `${at}.${k}` : k);
    return o;
  }
  return v;
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.clock]  thời điểm (ms) dùng cho serverTimestamp
 * @param {Record<string, object>} [opts.initial]  dữ liệu ban đầu { path: data }
 */
export function memoryStore({ clock = Date.now, initial = {} } = {}) {
  const docs = new Map();
  for (const [p, d] of Object.entries(initial)) docs.set(p, structuredClone(d));
  const log = []; // mỗi lần commit: { kind: 'batch'|'many', ops: [{type, path}] }

  function applyAtomic(ops, kind) {
    if (!Array.isArray(ops)) throw new TypeError('ops phải là mảng');
    if (ops.length > MAX_BATCH_OPS) throw new Error(`Lô ghi vượt quá ${MAX_BATCH_OPS} thao tác (${ops.length}).`);
    for (const op of ops) {
      if (!isDocPath(op.path)) throw new Error(`Đường dẫn tài liệu không hợp lệ: ${op.path}`);
      if (op.type !== 'set' && op.type !== 'delete') throw new Error(`Thao tác không hợp lệ: ${op.type}`);
      if (op.type === 'set' && (!op.data || typeof op.data !== 'object')) throw new Error(`Thiếu dữ liệu cho ${op.path}`);
    }
    const now = clock();
    // Kiểm tra/chuyển đổi toàn bộ dữ liệu trước khi ghi để lô ghi vẫn nguyên tử khi có lỗi.
    const resolved = ops.map(op => (op.type === 'set' ? resolveSentinels(op.data, now) : null));
    ops.forEach((op, i) => {
      if (op.type === 'delete') docs.delete(op.path);
      else docs.set(op.path, op.merge && docs.has(op.path) ? { ...docs.get(op.path), ...resolved[i] } : resolved[i]);
    });
    if (ops.length) log.push({ kind, ops: ops.map(o => ({ type: o.type, path: o.path })) });
  }

  return {
    // ---- giao diện kho ----
    async get(path) {
      const d = docs.get(path);
      return d === undefined ? null : structuredClone(d);
    },
    async listIds(collection) {
      const pre = collection + '/';
      const ids = [];
      for (const p of docs.keys()) if (p.startsWith(pre) && !p.slice(pre.length).includes('/')) ids.push(p.slice(pre.length));
      return ids.sort();
    },
    async commitBatch(ops) { applyAtomic(ops, 'batch'); },
    async commitMany(ops, size = 400) {
      for (let i = 0; i < ops.length; i += size) applyAtomic(ops.slice(i, i + size), 'many');
    },
    async acquireLock(nowMs, ttlMs) {
      const cur = docs.get(LOCK_PATH) || {};
      if ((cur.until || 0) > nowMs) {
        if (!((cur.pendingAt || 0) > 0)) docs.set(LOCK_PATH, { ...cur, pendingAt: nowMs }); // chỉ ghi nhận một lần
        return null;
      }
      const token = randomUUID();
      docs.set(LOCK_PATH, { until: nowMs + ttlMs, token, acquiredAt: nowMs, pendingAt: 0 });
      return token;
    },
    async releaseLock(token, { nowMs = clock(), ttlMs = 0, rerun = false } = {}) {
      const cur = docs.get(LOCK_PATH);
      if (!cur || cur.token !== token) return false;
      if (rerun && (cur.pendingAt || 0) > 0 && ttlMs > 0) {
        docs.set(LOCK_PATH, { until: nowMs + ttlMs, token, acquiredAt: nowMs, pendingAt: 0 });
        return true;
      }
      docs.set(LOCK_PATH, { until: 0, token: null, acquiredAt: cur.acquiredAt || 0, pendingAt: 0 });
      return false;
    },
    serverTimestamp: () => SERVER_TS,
    timestamp: date => new Date(date.getTime()),

    // ---- tiện ích cho kiểm thử / dry-run ----
    docs,
    log,
    clearLog() { log.length = 0; },
    writtenPaths() { return log.flatMap(c => c.ops.map(o => `${o.type}:${o.path}`)); },
    dump(prefix = '') {
      const out = {};
      for (const [p, d] of docs) if (p.startsWith(prefix)) out[p] = structuredClone(d);
      return out;
    },
  };
}
