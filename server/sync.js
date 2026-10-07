// Lõi đồng bộ Google Sheet → Firestore. Chạy được với Firestore thật (firestoreStore) và kho bộ nhớ (memory-store.js).
//
// Bố cục Firestore:
//   dashboard/meta, dashboard/staff, dashboard_chunks/{cNNN}, phieu/{id}   – client đọc (qua security rules)
//   config/access, config/syncState, config/syncLock                       – chỉ máy chủ
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  SCHEMA_VERSION, hash53, levelOf, levelName, tsToInstant, gradeOf,
  parseFormTable, parseStaffTable, chunkRecords,
} from '../lib/shared.js';
import { splitEmails, uniqSorted, envEmails, envDomains, accessFromSheetMode } from './auth.js';

export const PATHS = Object.freeze({
  meta: 'dashboard/meta',
  staff: 'dashboard/staff',
  chunks: 'dashboard_chunks',
  phieu: 'phieu',
  access: 'config/access',
  state: 'config/syncState',
  lock: 'config/syncLock',
});
export const DEFAULT_FORM_GID = '948197065';
export const DEFAULT_STAFF_GID = '979319376';
export const LOCK_TTL_MS = 55_000;
export const RATE_LIMIT_MS = 60_000;
export const PHIEU_BATCH = 400;
export const MAX_BATCH_OPS = 500;
// chunkRecords đo độ dài theo đơn vị UTF-16; mỗi đơn vị ≤ 3 byte UTF-8 → 340 000 × 3 < 1 MiB (giới hạn tài liệu Firestore).
export const CHUNK_OPTS = Object.freeze({ maxBytes: 340_000, maxRecords: 500 });
const RERUN_BUDGET_MS = 25_000; // chỉ chạy lại (do có yêu cầu chờ) khi tổng thời gian còn dưới mức này
const MAX_RERUNS = 2;

const publicError = (message, code = 'SYNC_ERROR') => Object.assign(new Error(message), { expose: true, code });

/* ---------------- Cấu hình từ biến môi trường ---------------- */
// accessFromSheet: 'bgh' | 'all' | '0' (xem accessFromSheetMode trong auth.js)
// envDomains: mặc định ['hoangmaistarschool.edu.vn'] khi ALLOWED_DOMAINS chưa đặt; 'none' → []
export function readSyncConfig(env = {}) {
  const sheetId = String(env.SHEET_ID ?? '').trim();
  const formGid = String(env.SHEET_GID_FORM ?? '').trim() || DEFAULT_FORM_GID;
  const rawStaff = env.SHEET_GID_STAFF;
  const staffGid = rawStaff == null ? DEFAULT_STAFF_GID
    : (/^(|none|off|false|-)$/i.test(String(rawStaff).trim()) ? '' : String(rawStaff).trim());
  return {
    sheetId, formGid, staffGid,
    accessFromSheet: accessFromSheetMode(env),
    envEmails: envEmails(env),
    envDomains: envDomains(env),
  };
}
export const sheetUrlOf = (sheetId, gid) => (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}` : '');

/* ---------------- Ánh xạ bản ghi gọn → tài liệu phieu/{id} ---------------- */
// gradeOf dùng chung với dashboard (lib/shared.js) để phieu/{id}.khoi và bộ lọc “Khối” luôn khớp nhau.
export { gradeOf };
// Phần dữ liệu ổn định (không gồm thời điểm ghi) – dùng để tính hash phát hiện thay đổi
function phieuCore(r, crit) {
  const sc = r.sc || [];
  const valid = sc.filter(v => v != null);
  const total = valid.reduce((a, b) => a + b, 0);
  const avg = valid.length ? total / valid.length : 0;
  const diem = {};
  crit.forEach((k, j) => { diem[k.code] = sc[j] ?? null; });
  return {
    ngayGui: r.ts, ngayDay: r.day,
    toNguoiDu: r.og, nguoiDu: r.on, toGiaoVien: r.tg, giaoVien: r.tn,
    tenBai: r.lesson || '', tiet: r.period || '', mon: r.subject || '', lop: r.cls || '', khoi: gradeOf(r.cls),
    diem, tongDiem: total, diemToiDa: valid.length * 5, diemTB: Math.round(avg * 100) / 100,
    xepLoai: levelName(levelOf(avg)),
    uuDiem: r.pros || '', canKhacPhuc: r.cons || '',
  };
}
export function phieuDoc(r, crit, store) {
  return { thoiGianGui: store.timestamp(tsToInstant(r.ts)), ...phieuCore(r, crit), capNhatLuc: store.serverTimestamp() };
}
export const phieuHash = (r, crit) => hash53(`v${SCHEMA_VERSION}|${JSON.stringify(phieuCore(r, crit))}`);

/* ---------------- Danh sách quyền truy cập ---------------- */
// staff: kết quả parseStaffTable ({ bgh:[{email}], allEmails:[] }). Email viết thường, lọc trùng, sắp xếp.
export function sheetAccessEmails(mode, staff) {
  if (mode === 'all') {
    const all = Array.isArray(staff?.allEmails) ? staff.allEmails
      : [...(staff?.bgh || []), ...(staff?.teach || [])].map(s => s.email);
    return all.flatMap(e => splitEmails(e));
  }
  if (mode === 'bgh') return (staff?.bgh || []).flatMap(b => splitEmails(b.email));
  return [];
}
export function buildAccess(cfg, staff) {
  const fromSheet = sheetAccessEmails(cfg.accessFromSheet, staff);
  return { emails: uniqSorted([...cfg.envEmails, ...fromSheet]), domains: uniqSorted(cfg.envDomains) };
}

const parseJSONObj = s => {
  if (typeof s !== 'string' || !s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
};
const errMsg = e => String(e?.message || e || 'lỗi không xác định');

/* ---------------- Một lượt đồng bộ (đã giữ khóa) ---------------- */
async function syncOnce({ store, fetchTable, cfg, trigger, clock, force }) {
  const startMs = clock();
  const warnings = [];

  // 1) Đọc Sheet (song song hai tab) + kiểm tra Sheet có đang công khai (“Bất kỳ ai có đường liên kết”) không.
  //    fetchTable.isPublic (nếu có – xem makeSheetFetcher) → true | false | null (không rõ).
  const probe = typeof fetchTable.isPublic === 'function'
    ? Promise.resolve().then(() => fetchTable.isPublic(cfg.formGid)).catch(() => null)
    : Promise.resolve(false);
  const [formTable, staffRes, sheetPublic] = await Promise.all([
    fetchTable(cfg.formGid),
    cfg.staffGid ? fetchTable(cfg.staffGid).then(t => ({ t }), e => ({ e })) : Promise.resolve(null),
    probe,
  ]);
  const fetchMs = clock() - startMs;
  if (fetchTable.warnings) for (const w of fetchTable.warnings) warnings.push(w);

  // 2) Phân tích
  let parsed;
  try { parsed = parseFormTable(formTable); } catch (e) { throw publicError(errMsg(e), 'SHEET_STRUCTURE'); }
  const { records, crit } = parsed;
  let staffOk = true, staff = { teach: [], bgh: [], allEmails: [] };
  if (staffRes?.e) {
    staffOk = false;
    warnings.push(`Không đọc được danh sách nhân sự (giữ nguyên dữ liệu cũ): ${errMsg(staffRes.e)}`);
  } else if (staffRes?.t) {
    try { staff = parseStaffTable(staffRes.t); } catch (e) {
      staffOk = false;
      warnings.push(`Không phân tích được danh sách nhân sự (giữ nguyên dữ liệu cũ): ${errMsg(e)}`);
    }
  }
  const parseMs = clock() - startMs - fetchMs;

  // 3) Trạng thái lần trước
  const state = (await store.get(PATHS.state)) || {};
  const prevHashes = parseJSONObj(state.phieuHashes);
  const prevChunkHashes = parseJSONObj(state.chunkHashes) || {};
  const trustState = !force && !!prevHashes;
  const prevIds = trustState ? Object.keys(prevHashes) : await store.listIds(PATHS.phieu);
  const prevIdSet = new Set(prevIds);

  if (!records.length && prevIds.length && !force) {
    throw publicError(`Sheet trả về 0 phiếu trong khi Firestore đang có ${prevIds.length} phiếu – dừng đồng bộ để tránh xóa nhầm dữ liệu. Kiểm tra lại Sheet/SHEET_GID_FORM.`, 'EMPTY_SHEET');
  }
  // Số phiếu giảm quá nửa: thường do Sheet đang bật BỘ LỌC (khi đọc qua gviz) hoặc bị xóa nhầm → dừng, không xóa dữ liệu.
  if (records.length && prevIds.length >= 20 && records.length < prevIds.length * 0.5 && !force) {
    throw publicError(`Số phiếu giảm bất thường từ ${prevIds.length} xuống ${records.length} – có thể Sheet đang bật bộ lọc hoặc bị xóa nhầm dữ liệu. Đã dừng đồng bộ để không xóa dữ liệu trên dashboard.`, 'RECORD_DROP');
  }

  // 4) phieu/{id}: chỉ ghi phiếu mới/thay đổi, xóa phiếu đã bị xóa khỏi Sheet
  const phieuOps = [];
  const newHashes = {};
  let added = 0, updated = 0, removed = 0;
  for (const r of records) {
    const h = phieuHash(r, crit);
    newHashes[r.id] = h;
    const existed = prevIdSet.has(r.id);
    if (!existed) added++;
    else if (!trustState || prevHashes[r.id] !== h) updated++;
    else continue;
    phieuOps.push({ type: 'set', path: `${PATHS.phieu}/${r.id}`, data: phieuDoc(r, crit, store) });
  }
  for (const id of prevIds) {
    if (!(id in newHashes)) { removed++; phieuOps.push({ type: 'delete', path: `${PATHS.phieu}/${id}` }); }
  }

  // 5) dashboard_chunks: ghi khối có hash đổi, xóa khối thừa
  const chunks = chunkRecords(records, CHUNK_OPTS);
  const existingChunks = new Set(await store.listIds(PATHS.chunks));
  const dashOps = [];
  const newChunkHashes = {};
  let chunksWritten = 0, chunksDeleted = 0;
  const chunkInfo = [];
  for (const c of chunks) {
    newChunkHashes[c.id] = c.hash;
    const write = force || !existingChunks.has(c.id) || prevChunkHashes[c.id] !== c.hash;
    chunkInfo.push({ id: c.id, n: c.n, bytes: c.data.length, written: write });
    if (!write) continue;
    chunksWritten++;
    dashOps.push({ type: 'set', path: `${PATHS.chunks}/${c.id}`, data: { i: c.i, n: c.n, data: c.data, hash: c.hash } });
  }
  for (const id of existingChunks) {
    if (!(id in newChunkHashes)) { chunksDeleted++; dashOps.push({ type: 'delete', path: `${PATHS.chunks}/${id}` }); }
  }

  // 6) dashboard/staff (không chứa email)
  const staffDoc = {
    teach: staff.teach.map(({ name, group, role }) => ({ name, group, role })),
    bgh: staff.bgh.map(({ name, role }) => ({ name, role })),
  };
  const staffHash = hash53(JSON.stringify(staffDoc));
  const curStaff = await store.get(PATHS.staff);
  let staffChanged = false;
  if (staffOk && (force || state.staffHash !== staffHash || !curStaff)) {
    staffChanged = true;
    dashOps.push({ type: 'set', path: PATHS.staff, data: staffDoc });
  } else if (!staffOk && !curStaff) {
    // Lần đầu mà chưa đọc được DS Nhân sự: ghi tài liệu rỗng để dashboard không phải chờ; lần sau sẽ ghi đủ.
    staffChanged = true;
    dashOps.push({ type: 'set', path: PATHS.staff, data: { teach: [], bgh: [] } });
  }
  const staffCount = staffOk ? staffDoc.teach.length + staffDoc.bgh.length
    : ((curStaff?.teach?.length || 0) + (curStaff?.bgh?.length || 0));

  // 7) config/access (chỉ máy chủ & security rules đọc)
  const access = buildAccess(cfg, staff);
  const accessHash = hash53(JSON.stringify(access));
  const curAccess = await store.get(PATHS.access);
  // Nếu danh sách lấy từ Sheet mà không đọc được tab nhân sự → giữ nguyên quyền cũ (trừ khi chưa có gì)
  const accessKnown = staffOk || cfg.accessFromSheet === '0';
  let accessChanged = false;
  if ((accessKnown || !curAccess) && (force || state.accessHash !== accessHash || !curAccess)) {
    accessChanged = true;
    dashOps.push({ type: 'set', path: PATHS.access, data: { ...access, updatedAt: store.serverTimestamp() } });
  }
  const effectiveAccess = accessChanged || accessKnown ? access : { emails: curAccess?.emails || [], domains: curAccess?.domains || [] };
  if (!effectiveAccess.emails.length && !effectiveAccess.domains.length) {
    warnings.push('Danh sách quyền truy cập đang trống: chưa ai xem được dashboard. Đặt ALLOWED_DOMAINS (bỏ giá trị none), ALLOWED_EMAILS, hoặc điền cột Email trong tab “DS Nhân sự”.');
  }
  if (cfg.accessFromSheet === 'bgh' && staffOk && cfg.staffGid) {
    const missing = staff.bgh.filter(b => !splitEmails(b.email).length).length;
    if (missing) warnings.push(`${missing} thành viên BGH trong “DS Nhân sự” chưa có email hợp lệ nên chưa được cấp quyền theo danh sách email.`);
  }
  if (cfg.accessFromSheet !== '0' && staffOk && !cfg.staffGid) {
    warnings.push('ACCESS_FROM_SHEET đang bật nhưng SHEET_GID_STAFF bị tắt: không lấy được email nào từ “DS Nhân sự”.');
  }
  // Đường dẫn Sheet chỉ được đưa lên dashboard khi Sheet ĐÃ ở chế độ riêng tư (false). Khi Sheet còn công khai,
  // ai có link đều đọc được toàn bộ câu trả lời và DS Nhân sự (kể cả email) mà không cần đăng nhập → ẩn link.
  const sheetUrl = sheetPublic === false ? sheetUrlOf(cfg.sheetId, cfg.formGid) : '';
  if (sheetPublic === true) {
    warnings.push('Google Sheet đang ở chế độ “Bất kỳ ai có đường liên kết”: ai có link đều đọc được toàn bộ câu trả lời và “DS Nhân sự” (kể cả email) mà không cần đăng nhập. Đường dẫn Sheet đã được ẩn khỏi dashboard. Hãy đặt Sheet ở chế độ “Bị hạn chế” và chia sẻ quyền Xem cho email service account (README, bước 2).');
  }

  // 8) dashboard/meta – luôn ghi lại
  const durationMs = clock() - startMs;
  const syncedAtMs = clock();
  dashOps.push({
    type: 'set', path: PATHS.meta,
    data: {
      version: SCHEMA_VERSION,
      syncedAt: store.serverTimestamp(),
      syncedAtMs,
      count: records.length,
      chunkIds: chunks.map(c => c.id),
      crit,
      staffCount,
      trigger,
      sheetUrl,
      durationMs,
    },
  });
  if (dashOps.length > MAX_BATCH_OPS) throw publicError(`Quá nhiều thao tác ghi dashboard trong một lô (${dashOps.length}).`, 'BATCH_TOO_LARGE');

  // 9) Ghi: dashboard (nguyên tử) → phieu (theo lô) → trạng thái.
  //    Nếu bước phieu lỗi, trạng thái cũ được giữ nên lần sau sẽ ghi lại (thao tác ghi là idempotent).
  const tWrite = clock();
  await store.commitBatch(dashOps);
  await store.commitMany(phieuOps, PHIEU_BATCH);
  const finishedMs = clock();
  const result = {
    ok: true, count: records.length, added, updated, removed,
    chunksWritten, chunksDeleted, staffChanged, accessChanged,
    durationMs: finishedMs - startMs, syncedAtMs, trigger,
  };
  await store.commitBatch([{
    type: 'set', path: PATHS.state,
    data: {
      phieuHashes: JSON.stringify(newHashes),
      chunkHashes: JSON.stringify(newChunkHashes),
      staffHash: staffOk ? staffHash : (state.staffHash || ''),
      accessHash: accessChanged || accessKnown ? accessHash : (state.accessHash || ''),
      lastRunMs: finishedMs,
      lastTrigger: trigger,
      lastResult: { count: result.count, added, updated, removed, chunksWritten, chunksDeleted, staffChanged, accessChanged, durationMs: result.durationMs, warnings: warnings.length },
    },
  }]);

  return {
    ...result,
    warnings,
    debug: {
      fetchMs, parseMs, writeMs: clock() - tWrite,
      records: records.length, crit: crit.length,
      teach: staffDoc.teach.length, bgh: staffDoc.bgh.length,
      accessMode: cfg.accessFromSheet, accessEmails: effectiveAccess.emails.length, accessDomains: [...effectiveAccess.domains],
      sheetPublic,
      chunks: chunkInfo, phieuOps: phieuOps.length, dashOps: dashOps.length,
    },
  };
}

function mergeResults(a, b) {
  if (!a) return { ...b, runs: 1 };
  return {
    ...b,
    added: a.added + b.added, updated: a.updated + b.updated, removed: a.removed + b.removed,
    chunksWritten: a.chunksWritten + b.chunksWritten, chunksDeleted: a.chunksDeleted + b.chunksDeleted,
    staffChanged: a.staffChanged || b.staffChanged, accessChanged: a.accessChanged || b.accessChanged,
    durationMs: a.durationMs + b.durationMs,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
    runs: a.runs + 1,
  };
}

/**
 * Đồng bộ Sheet → kho.
 * @param {object} p
 * @param {object} p.store         firestoreStore(db) hoặc memoryStore()
 * @param {(gid:string)=>Promise<object>} p.fetchTable  trả về `table` của gviz
 * @param {object} [p.env]         biến môi trường (SHEET_ID, SHEET_GID_FORM, SHEET_GID_STAFF, ALLOWED_EMAILS, ALLOWED_DOMAINS, ACCESS_FROM_SHEET)
 * @returns {Promise<object>}  { ok, skipped?, count, added, updated, removed, chunksWritten, chunksDeleted, staffChanged,
 *                               accessChanged, durationMs, syncedAtMs, trigger, warnings, runs, debug }
 *                               skipped: 'recent' (người dùng bấm lại < 60 s: ok:true nếu lượt trước thành công,
 *                                        ok:false + error nếu lượt trước thất bại) | 'locked' (ok:false, đang có lượt khác)
 * @param {string} [p.trigger]     'cron' | 'webhook' | 'user:<email>' | 'dry-run' …
 * @param {number|(()=>number)} [p.nowMs]  thời điểm bắt đầu (ms) hoặc hàm đồng hồ
 * @param {boolean} [p.force]      ghi lại toàn bộ, bỏ qua hash và giới hạn tần suất
 */
export async function runSync({ store, fetchTable, env = {}, trigger = 'manual', nowMs, force = false } = {}) {
  if (!store || typeof fetchTable !== 'function') throw new TypeError('runSync cần store và fetchTable');
  let clock;
  if (typeof nowMs === 'function') clock = () => Math.round(nowMs());
  else {
    const base = Number.isFinite(nowMs) ? nowMs : Date.now();
    const t0 = performance.now();
    clock = () => base + Math.round(performance.now() - t0);
  }
  const startMs = clock();
  const cfg = readSyncConfig(env);
  const empty = { count: null, added: 0, updated: 0, removed: 0, chunksWritten: 0, chunksDeleted: 0, staffChanged: false, accessChanged: false };

  // Giới hạn tần suất cho người dùng bấm “Làm mới” / “Tự đồng bộ” (cron và Apps Script không bị giới hạn).
  //  • lượt trước THÀNH CÔNG < 60 s → { ok:true, skipped:'recent' } (dữ liệu vốn đã mới);
  //  • lượt trước (bắt đầu < 60 s) THẤT BẠI → { ok:false, skipped:'recent', error } (handler trả 429), để không ai
  //    gọi dồn dập vào một lượt đồng bộ đang lỗi. Thời điểm bắt đầu lượt gần nhất = config/syncLock.acquiredAt.
  if (/^user:/.test(trigger) && !force) {
    const [st, lk] = await Promise.all([store.get(PATHS.state), store.get(PATHS.lock)]);
    const lastOk = Number(st?.lastRunMs) || 0;
    const lastTry = Number(lk?.acquiredAt) || 0;
    if (lastOk && startMs - lastOk < RATE_LIMIT_MS) {
      return {
        ok: true, skipped: 'recent', ...empty, count: st?.lastResult?.count ?? null,
        durationMs: clock() - startMs, syncedAtMs: lastOk, trigger,
        retryAfterMs: RATE_LIMIT_MS - (startMs - lastOk),
      };
    }
    const running = (Number(lk?.until) || 0) > startMs; // đang có lượt chạy → để acquireLock trả 'locked'
    if (!running && lastTry > lastOk && startMs >= lastTry && startMs - lastTry < RATE_LIMIT_MS) {
      const retryAfterMs = RATE_LIMIT_MS - (startMs - lastTry);
      return {
        ok: false, skipped: 'recent', ...empty, count: st?.lastResult?.count ?? null,
        durationMs: clock() - startMs, syncedAtMs: lastOk || null, trigger, retryAfterMs,
        error: `Lượt đồng bộ gần nhất chưa thành công. Vui lòng thử lại sau ${Math.ceil(retryAfterMs / 1000)} giây.`,
      };
    }
  }

  const token = await store.acquireLock(startMs, LOCK_TTL_MS);
  if (!token) {
    return { ok: false, skipped: 'locked', ...empty, durationMs: clock() - startMs, syncedAtMs: null, trigger };
  }

  let total = null;
  let released = false;
  try {
    for (;;) {
      const r = await syncOnce({ store, fetchTable, cfg, trigger, clock, force });
      total = mergeResults(total, r);
      const canRerun = total.runs <= MAX_RERUNS && clock() - startMs < RERUN_BUDGET_MS;
      const again = await store.releaseLock(token, { nowMs: clock(), ttlMs: LOCK_TTL_MS, rerun: canRerun });
      if (!again) { released = true; break; }
    }
  } finally {
    if (!released) { try { await store.releaseLock(token); } catch { /* khóa tự hết hạn sau LOCK_TTL_MS */ } }
  }
  total.durationMs = clock() - startMs;
  return total;
}

/* ---------------- Bộ chuyển đổi Firestore (firebase-admin) ---------------- */
export function firestoreStore(db) {
  const lockRef = db.doc(PATHS.lock);
  const applyOps = (batch, ops) => {
    for (const op of ops) {
      const ref = db.doc(op.path);
      if (op.type === 'delete') batch.delete(ref);
      else if (op.merge) batch.set(ref, op.data, { merge: true });
      else batch.set(ref, op.data);
    }
  };
  return {
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? snap.data() : null;
    },
    async listIds(collection) {
      const refs = await db.collection(collection).listDocuments();
      return refs.map(r => r.id).sort();
    },
    async commitBatch(ops) {
      if (!ops.length) return;
      if (ops.length > MAX_BATCH_OPS) throw new Error(`Lô ghi vượt quá ${MAX_BATCH_OPS} thao tác (${ops.length}).`);
      const batch = db.batch();
      applyOps(batch, ops);
      await batch.commit();
    },
    async commitMany(ops, size = PHIEU_BATCH) {
      for (let i = 0; i < ops.length; i += size) {
        const batch = db.batch();
        applyOps(batch, ops.slice(i, i + size));
        await batch.commit();
      }
    },
    async acquireLock(nowMs, ttlMs) {
      const token = randomUUID();
      return db.runTransaction(async tx => {
        const snap = await tx.get(lockRef);
        const cur = snap.exists ? snap.data() : {};
        if ((Number(cur.until) || 0) > nowMs) {
          // Ghi nhận “có yêu cầu chờ” một lần (các yêu cầu bị từ chối tiếp theo không tốn thêm lượt ghi).
          if (!((Number(cur.pendingAt) || 0) > 0)) tx.set(lockRef, { pendingAt: nowMs }, { merge: true });
          return null;
        }
        tx.set(lockRef, { until: nowMs + ttlMs, token, acquiredAt: nowMs, pendingAt: 0 });
        return token;
      });
    },
    async releaseLock(token, { nowMs = Date.now(), ttlMs = 0, rerun = false } = {}) {
      return db.runTransaction(async tx => {
        const snap = await tx.get(lockRef);
        if (!snap.exists || snap.data().token !== token) return false;
        const cur = snap.data();
        if (rerun && (Number(cur.pendingAt) || 0) > 0 && ttlMs > 0) {
          tx.set(lockRef, { until: nowMs + ttlMs, token, acquiredAt: nowMs, pendingAt: 0 });
          return true;
        }
        tx.set(lockRef, { until: 0, token: null, acquiredAt: Number(cur.acquiredAt) || 0, pendingAt: 0 });
        return false;
      });
    },
    serverTimestamp: () => FieldValue.serverTimestamp(),
    timestamp: date => Timestamp.fromDate(date),
  };
}
