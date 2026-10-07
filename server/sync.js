// Lõi đồng bộ v2 (Dashboard toàn trường): Google Sheet của từng cấp (+ Sheet phân quyền) → Firestore.
// Chạy được với Firestore thật (firestoreStore) và kho bộ nhớ (memory-store.js).
//
// CHỈ ghi các collection v2 (v1 – dashboard/*, dashboard_chunks/*, phieu/*, config/* – giữ nguyên để bản v1 đang chạy không bị ảnh hưởng):
//   v2_meta/global                         { version: 2, syncedAtMs, levels:[{cap,label,color,enabled,count,syncedAtMs,stale}], trigger, durationMs }
//   v2_access/{email}                      { email, name, roles:{bghAll,bghCaps,toTruong,person}, scopes:[scopeId], updatedAtMs }
//   v2_scopes/{scopeId}                    { kind, …, count, chunkIds, crit, staff?, bgh?, benchmarks?, syncedAtMs, hash }
//   v2_scopes/{scopeId}/chunks/{cNNN}      { i, n, data (JSON bản ghi gọn), hash }
//   v2_config/state, v2_config/lock, v2_config/staff_<cap>, v2_config/roles   – chỉ máy chủ
//     (state còn giữ số liệu đối sánh đã công bố – state.bench – để chỉ công bố lại khi đủ phiếu mới, xem scopes.js)
// Client đọc v2_access/<email> của mình rồi các v2_scopes được liệt kê trong đó (firestore.rules kiểm soát).
// v2_meta/global.trigger KHÔNG chứa email người bấm đồng bộ ('user'); email chỉ lưu ở v2_config/state.lastTrigger.
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { SCHEMA_VERSION_V2, CAPS, CAP_INFO, hash53, parseFormTable, parseStaffTable } from '../lib/shared.js';
import { envDomains } from './auth.js';
import { resolveAccess, parseRolesTable, adminEmails, DEFAULT_ROLES_TAB } from './roles.js';
import { buildScopes, scopeIdLevel, CHUNK_OPTS, benchCutoff, benchGroups, publishBenchmarks } from './scopes.js';

export const PATHS = Object.freeze({
  meta: 'v2_meta/global',
  access: 'v2_access',
  scopes: 'v2_scopes',
  state: 'v2_config/state',
  lock: 'v2_config/lock',
  roles: 'v2_config/roles',
});
export const staffCachePath = cap => `v2_config/staff_${cap}`;
export const scopePath = id => `${PATHS.scopes}/${id}`;
export const chunksCol = id => `${PATHS.scopes}/${id}/chunks`;
export const chunkPath = (id, cid) => `${chunksCol(id)}/${cid}`;
export const accessPath = email => `${PATHS.access}/${email}`;

export const DEFAULT_FORM_TAB = 'Câu trả lời biểu mẫu 1';
export const DEFAULT_STAFF_TAB = 'DS Nhân sự';
export const LOCK_TTL_MS = 55_000;
export const RATE_LIMIT_MS = 60_000;
export const WRITE_BATCH = 400;
export const MAX_BATCH_OPS = 500;
// Firestore giới hạn mỗi yêu cầu ghi ~10 MiB (REST còn mã hóa lại chuỗi JSON của khối) → mỗi lô ≤ 6 MiB (ước lượng theo JSON).
export const MAX_BATCH_BYTES = 6 * 1024 * 1024;
export { CHUNK_OPTS };
const RERUN_BUDGET_MS = 25_000; // chỉ chạy lại (do có yêu cầu chờ) khi tổng thời gian còn dưới mức này
const MAX_RERUNS = 2;

const publicError = (message, code = 'SYNC_ERROR') => Object.assign(new Error(message), { expose: true, code });
// Thông điệp lỗi đưa vào cảnh báo: chỉ lỗi do ta tạo (expose) mới giữ nguyên nội dung (lỗi lạ có thể chứa chi tiết nội bộ).
const errMsg = e => (e?.expose ? String(e.message) : 'lỗi không xác định – xem log của hàm /api/sync');
const parseJSON = (s, fallback) => {
  if (typeof s !== 'string' || !s) return fallback;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : fallback; } catch { return fallback; }
};

/* ---------------- Cấu hình từ biến môi trường ---------------- */
const isOff = v => /^(none|off|false|-|0|khong|không)$/i.test(String(v ?? '').trim());
const tabOf = (v, def) => (v == null || !String(v).trim() ? def : isOff(v) ? '' : String(v).trim());

/**
 * SHEET_ID_TIH / SHEET_ID_THCS / SHEET_ID_THPT (trống → cấp đó “Chưa kết nối dữ liệu”; SHEET_ID_TIH trống → dùng SHEET_ID của v1),
 * SHEET_FORM_TAB_<CẤP> (mặc định “Câu trả lời biểu mẫu 1”), SHEET_STAFF_TAB_<CẤP> (mặc định “DS Nhân sự”; none/off = không đọc),
 * ROLES_SHEET_ID + ROLES_TAB (mặc định “Phân quyền”), ADMIN_EMAILS, ALLOWED_DOMAINS.
 */
export function readSyncConfig(env = {}) {
  const levels = CAPS.map(cap => {
    const U = cap.toUpperCase();
    let sheetId = String(env[`SHEET_ID_${U}`] ?? '').trim();
    if (!sheetId && cap === 'tih') sheetId = String(env.SHEET_ID ?? '').trim();
    return {
      cap, label: CAP_INFO[cap].label, color: CAP_INFO[cap].color,
      sheetId, enabled: !!sheetId,
      formTab: tabOf(env[`SHEET_FORM_TAB_${U}`], DEFAULT_FORM_TAB) || DEFAULT_FORM_TAB,
      staffTab: tabOf(env[`SHEET_STAFF_TAB_${U}`], DEFAULT_STAFF_TAB),
    };
  });
  return {
    levels,
    rolesSheetId: String(env.ROLES_SHEET_ID ?? '').trim(),
    rolesTab: String(env.ROLES_TAB ?? '').trim() || DEFAULT_ROLES_TAB,
    adminEmails: adminEmails(env),
    envDomains: envDomains(env),
  };
}
export const sheetUrlOf = sheetId => (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '');

/* ---------------- Ghi theo lô ---------------- */
// Kích thước ước lượng của một thao tác ghi (byte JSON – gần với yêu cầu REST; gRPC còn nhỏ hơn).
export const opBytes = op => Buffer.byteLength(String(op.path)) + (op.data ? Buffer.byteLength(JSON.stringify(op.data)) : 0) + 64;
// groups: mảng các nhóm thao tác nên nằm CÙNG một lô (vd. tài liệu phạm vi + các khối của nó). Gom nhóm thành lô ≤ max thao tác
// và ≤ maxBytes. Nhóm quá lớn (nhiều khối lớn – vd. ghi lại toàn bộ khi dữ liệu đã nhiều) được tách: các khối (set …/chunks/…)
// ghi ở các lô TRƯỚC, phần đuôi (xóa khối thừa + tài liệu phạm vi) ở lô CUỐI – tài liệu phạm vi chỉ trỏ tới khối đã tồn tại.
export function packGroups(groups, max = WRITE_BATCH, maxBytes = MAX_BATCH_BYTES) {
  const batches = [];
  let cur = [], curB = 0;
  const flush = () => { if (cur.length) { batches.push(cur); cur = []; curB = 0; } };
  for (const g of groups) {
    if (!g.length) continue;
    const sizes = g.map(opBytes);
    const gB = sizes.reduce((a, b) => a + b, 0);
    if (g.length > max || gB > maxBytes) {
      flush();
      let cut = g.findIndex(op => op.type === 'delete');
      if (cut < 0) cut = g.length - 1;
      let b = [], bB = 0;
      for (let i = 0; i < cut; i++) {
        if (b.length && (b.length >= max || bB + sizes[i] > maxBytes)) { batches.push(b); b = []; bB = 0; }
        b.push(g[i]); bB += sizes[i];
      }
      if (b.length) batches.push(b);
      const tail = g.slice(cut);
      for (let i = 0; i < tail.length; i += max) batches.push(tail.slice(i, i + max));
      continue;
    }
    if (cur.length + g.length > max || curB + gB > maxBytes) flush();
    cur.push(...g); curB += gB;
  }
  flush();
  return batches;
}
async function commitGroups(store, groups) {
  let n = 0;
  for (const b of packGroups(groups)) { await store.commitBatch(b); n++; }
  return n;
}

// Chạy fn trên từng phần tử với tối đa `limit` lời gọi song song (giữ thứ tự kết quả).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const LIST_CONCURRENCY = 16;

/* ---------------- Dữ liệu lần trước của một cấp (khi Sheet lỗi) ---------------- */
async function loadPrevLevel(store, cap) {
  const doc = await store.get(scopePath(scopeIdLevel(cap)));
  if (!doc || !Array.isArray(doc.chunkIds)) return null;
  const records = [];
  for (const cid of doc.chunkIds) {
    const c = await store.get(chunkPath(scopeIdLevel(cap), cid));
    if (!c || typeof c.data !== 'string') return null; // không đủ dữ liệu → coi như không có
    records.push(...JSON.parse(c.data));
  }
  return { records, crit: Array.isArray(doc.crit) ? doc.crit : [] };
}

// 'user:<email>' → 'user' (v2_meta/global ai có quyền cũng đọc được – không lộ email người bấm đồng bộ).
export const publicTrigger = t => (/^user:/.test(String(t || '')) ? 'user' : String(t || ''));

// Phiếu mới / sửa / xóa của phạm vi cấp `s` so với bản đang lưu: chỉ đọc các khối có hash khác lần trước.
// prevCh: { cid: hash } của lần trước (null → không xác định, trả null). Khóa nhân thân (tp/op) không tính là “sửa”.
async function levelChanges(store, s, prevCh) {
  if (!s || !prevCh || typeof prevCh !== 'object') return null;
  const now = new Map(s.chunks.map(c => [c.id, c]));
  const oldIds = Object.keys(prevCh).filter(cid => now.get(cid)?.hash !== prevCh[cid]);
  const newIds = s.chunks.filter(c => prevCh[c.id] !== c.hash).map(c => c.id);
  if (!oldIds.length && !newIds.length) return { added: 0, updated: 0, removed: 0 };
  const sig = r => { const { tp, op, ...x } = r; return JSON.stringify(x); }; // eslint-disable-line no-unused-vars
  const before = new Map();
  for (const cid of oldIds) {
    const d = await store.get(chunkPath(s.id, cid));
    if (!d || typeof d.data !== 'string') return null;
    for (const r of parseJSON(d.data, [])) before.set(r.id, sig(r));
  }
  const after = new Map();
  for (const cid of newIds) for (const r of JSON.parse(now.get(cid).data)) after.set(r.id, sig(r));
  let added = 0, updated = 0, removed = 0;
  for (const [id, x] of after) { if (!before.has(id)) added++; else if (before.get(id) !== x) updated++; }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { added, updated, removed };
}

/* ---------------- Một lượt đồng bộ (đã giữ khóa) ---------------- */
async function syncOnce({ store, fetchTable, cfg, env, trigger, clock, force, log }) {
  const startMs = clock();
  const warnings = [];
  const logRaw = (what, e) => { if (e && !e.expose) log?.warn?.(`[sync] ${what}:`, e); };
  const settle = p => Promise.resolve().then(() => p()).then(t => ({ t }), e => ({ e }));
  const probe = (sheetId, tab) => (typeof fetchTable.isPublic === 'function'
    ? Promise.resolve().then(() => fetchTable.isPublic(sheetId, tab)).catch(() => null)
    : Promise.resolve(false));

  // 1) Đọc song song: mỗi cấp (biểu mẫu + DS Nhân sự + thăm dò chế độ chia sẻ) và tab Phân quyền.
  const on = cfg.levels.filter(L => L.enabled);
  const [fetchedLevels, rolesRes] = await Promise.all([
    Promise.all(on.map(L => Promise.all([
      settle(() => fetchTable(L.sheetId, { sheet: L.formTab })),
      L.staffTab ? settle(() => fetchTable(L.sheetId, { sheet: L.staffTab })) : Promise.resolve(null),
      probe(L.sheetId, { sheet: L.formTab }),
    ]))),
    cfg.rolesSheetId ? settle(() => fetchTable(cfg.rolesSheetId, { sheet: cfg.rolesTab })) : Promise.resolve(null),
  ]);
  const fetchMs = clock() - startMs;

  const state = (await store.get(PATHS.state)) || {};
  const prevLevels = state.levels && typeof state.levels === 'object' ? state.levels : {};
  const prevStaffHashes = state.staffHashes && typeof state.staffHashes === 'object' ? state.staffHashes : {};
  const cacheOps = [];

  // 2) Từng cấp: phiếu (lỗi → giữ dữ liệu cũ của cấp đó) và DS Nhân sự (lỗi → bản lưu gần nhất)
  const levels = {}, levelMeta = [], levelState = {}, staffHashes = { ...prevStaffHashes };
  let formFailures = 0, firstFormError = null;
  for (const L of cfg.levels) {
    const { cap, label, color } = L;
    if (!L.enabled) {
      levels[cap] = { cap, enabled: false, records: [], crit: [], staffRows: [] };
      levelMeta.push({ cap, label, color, enabled: false, count: 0, syncedAtMs: null, stale: false });
      continue;
    }
    const [formRes, staffRes, isPublic] = fetchedLevels[on.indexOf(L)];
    logRaw(`${label} – biểu mẫu`, formRes.e);
    logRaw(`${label} – DS Nhân sự`, staffRes?.e);
    let records = [], crit = [], stale = false, levelSyncedAtMs = startMs;
    let formErr = formRes.e ? errMsg(formRes.e) : null;
    if (!formErr) {
      try { ({ records, crit } = parseFormTable(formRes.t, { cap })); } catch (e) { formErr = `tab “${L.formTab}”: ${String(e?.message || e)}`; }
    }
    const prevCount = Number(prevLevels[cap]?.count) || 0;
    if (!formErr && !records.length && prevCount > 0 && !force) {
      formErr = `Sheet trả về 0 phiếu trong khi lần trước có ${prevCount} phiếu`;
    }
    if (formErr) {
      formFailures++;
      firstFormError ||= formRes.e || publicError(`${label}: ${formErr}`, 'SHEET_STRUCTURE'); // lỗi lạ giữ nguyên → handler trả thông báo chung
      const prev = await loadPrevLevel(store, cap);
      stale = true;
      levelSyncedAtMs = Number(prevLevels[cap]?.syncedAtMs) || null;
      if (prev) { ({ records, crit } = prev); warnings.push(`${label}: không cập nhật được phiếu (${formErr}) – giữ nguyên dữ liệu lần đồng bộ trước.`); } else { records = []; crit = []; warnings.push(`${label}: không đọc được phiếu (${formErr}).`); }
    }

    let staffRows = [];
    if (staffRes === null) {
      warnings.push(`${label}: không đọc “DS Nhân sự” (SHEET_STAFF_TAB_${cap.toUpperCase()} đang tắt) – cấp này chỉ có quyền từ tab Phân quyền / ADMIN_EMAILS.`);
    } else {
      let err = staffRes.e ? errMsg(staffRes.e) : null, parsed = null;
      if (!err) {
        try { parsed = parseStaffTable(staffRes.t, { cap }); } catch (e) { err = String(e?.message || e); }
        if (parsed && !parsed.recognized) err = `tab “${L.staffTab}” không có cột Họ và tên / Tổ/Bộ phận (sai tên tab? Google trả về tab đầu tiên khi tên tab không tồn tại)`;
        else if (parsed && !parsed.rows.length && prevStaffHashes[cap]) err = 'danh sách trống';
      }
      if (err) {
        const cached = await store.get(staffCachePath(cap));
        staffRows = parseJSON(cached?.rows, []);
        warnings.push(`${label}: không đọc được “DS Nhân sự” (${err}) – ${staffRows.length ? 'dùng bản lưu gần nhất' : 'chưa có bản lưu, tạm thời chưa có quyền tự động cho cấp này'}.`);
      } else {
        staffRows = parsed.rows;
        const h = hash53(JSON.stringify(staffRows));
        if (force || h !== prevStaffHashes[cap]) cacheOps.push({ type: 'set', path: staffCachePath(cap), data: { rows: JSON.stringify(staffRows), hash: h, savedAtMs: startMs } });
        staffHashes[cap] = h;
      }
    }

    // Đường dẫn Sheet chỉ đưa vào phạm vi cấp (BGH đọc) khi Sheet ĐÃ riêng tư.
    if (isPublic === true) warnings.push(`${label}: Google Sheet đang ở chế độ “Bất kỳ ai có đường liên kết” – ai có link đều đọc được toàn bộ phiếu và DS Nhân sự (kể cả email). Hãy đặt “Bị hạn chế” và chia sẻ quyền Xem cho email service account.`);
    levels[cap] = { cap, enabled: true, records, crit, staffRows, sheetUrl: isPublic === false ? sheetUrlOf(L.sheetId) : '', stale };
    levelMeta.push({ cap, label, color, enabled: true, count: records.length, syncedAtMs: levelSyncedAtMs, stale });
    levelState[cap] = { count: records.length, syncedAtMs: levelSyncedAtMs };
  }
  if (!on.length) throw publicError('Chưa cấu hình Google Sheet nào: đặt SHEET_ID_TIH / SHEET_ID_THCS / SHEET_ID_THPT trên Vercel.', 'CONFIG_SHEET_ID');
  // Mọi cấp đều lỗi (thường do mạng/quyền) → dừng, không ghi gì (dữ liệu cũ giữ nguyên).
  if (formFailures === on.length) throw firstFormError;

  // 3) Tab Phân quyền (lỗi → bản lưu gần nhất; chưa có bản lưu → dừng để không cấp nhầm quyền đã bị thu hồi)
  let rolesRows = [], rolesHash = state.rolesHash || '';
  if (rolesRes) {
    logRaw('Phân quyền', rolesRes.e);
    let err = rolesRes.e ? errMsg(rolesRes.e) : null, parsed = null;
    if (!err) {
      parsed = parseRolesTable(rolesRes.t);
      if (!parsed.recognized) err = `tab “${cfg.rolesTab}” không có cột Email và Vai trò (sai tên tab ROLES_TAB? Google trả về tab đầu tiên khi tên tab không tồn tại)`;
    }
    if (err) {
      const cached = await store.get(PATHS.roles);
      if (!cached) throw publicError(`Không đọc được tab Phân quyền (${err}) và chưa có bản lưu trước – dừng đồng bộ để không cấp nhầm quyền.`, 'ROLES_SHEET');
      rolesRows = parseJSON(cached.rows, []);
      warnings.push(`Không đọc được tab Phân quyền (${err}) – dùng bản lưu gần nhất.`);
    } else {
      rolesRows = parsed.rows;
      const h = hash53(JSON.stringify(rolesRows));
      if (force || h !== state.rolesHash) cacheOps.push({ type: 'set', path: PATHS.roles, data: { rows: JSON.stringify(rolesRows), hash: h, savedAtMs: startMs } });
      rolesHash = h;
    }
  }
  const parseMs = clock() - startMs - fetchMs;

  // 4) Quyền + số liệu đối sánh (công bố có “giữ”) + phạm vi
  const { access, people, tos, warnings: roleWarnings, stats, recKeys, rowKey } = resolveAccess({ levels, rolesRows, env });
  warnings.push(...roleWarnings);
  const keyed = r => { const k = recKeys.get(r); return k ? { ...r, tp: k.tp, op: k.op } : r; };
  const { bench, state: benchState } = publishBenchmarks({ groups: benchGroups(levels, keyed), prev: parseJSON(state.bench, {}), cutoff: benchCutoff(startMs) });
  const scopes = buildScopes({ levels, people, tos, recKeys, rowKey, bench });
  const nowMs = clock();

  // 5) So sánh với lần trước (hash) → thao tác ghi
  const prevScopeHashes = parseJSON(state.scopeHashes, null);
  const trust = !force && !!prevScopeHashes;
  const prevChunkHashes = trust ? parseJSON(state.chunkHashes, {}) : {};
  const prevAccess = trust ? parseJSON(state.accessHashes, {}) : {};
  const [prevScopeIds, prevAccessIds] = trust
    ? [Object.keys(prevScopeHashes), Object.keys(prevAccess)]
    : await Promise.all([store.listIds(PATHS.scopes), store.listIds(PATHS.access)]);
  // Không tin trạng thái (lần đầu, mất trạng thái, force): liệt kê khối hiện có của các phạm vi đã tồn tại (song song có giới hạn).
  const listedChunks = new Map();
  if (!trust) {
    const lists = await mapLimit(prevScopeIds, LIST_CONCURRENCY, id => store.listIds(chunksCol(id)));
    prevScopeIds.forEach((id, i) => listedChunks.set(id, lists[i]));
  }

  if (!Object.keys(access).length && prevAccessIds.length && !force) {
    throw publicError(`Không tính được quyền cho ai trong khi đang có ${prevAccessIds.length} tài khoản được cấp quyền – dừng đồng bộ để tránh thu hồi nhầm. Kiểm tra “DS Nhân sự” / tab Phân quyền.`, 'EMPTY_ACCESS');
  }

  // Số phiếu mới / sửa / xóa của từng cấp (để báo cho người bấm “Đồng bộ ngay”): so sánh các khối ĐÃ ĐỔI của phạm vi cấp với
  // bản đang lưu (đọc trước khi ghi). Không tin trạng thái (lần đầu, force) → ước lượng theo số phiếu.
  const changes = {};
  for (const L of cfg.levels.filter(x => x.enabled)) {
    const s = scopes.find(x => x.id === scopeIdLevel(L.cap));
    const count = s?.doc.count || 0;
    const prevCount = Number(prevLevels[L.cap]?.count);
    changes[L.cap] = await levelChanges(store, s, trust ? parseJSON(state.chunkHashes, {})[scopeIdLevel(L.cap)] : null)
      || (Number.isFinite(prevCount) ? { added: Math.max(0, count - prevCount), updated: 0, removed: Math.max(0, prevCount - count) } : { added: count, updated: 0, removed: 0 });
  }

  const newScopeHashes = {}, newChunkHashes = {};
  const scopeGroups = [];
  let scopesWritten = 0, chunksWritten = 0, chunksDeleted = 0, scopesDeleted = 0;
  for (const s of scopes) {
    newScopeHashes[s.id] = s.doc.hash;
    newChunkHashes[s.id] = Object.fromEntries(s.chunks.map(c => [c.id, c.hash]));
    const prevCh = trust ? prevChunkHashes[s.id] || {} : null;
    const ops = [];
    for (const c of s.chunks) {
      if (trust && prevCh[c.id] === c.hash) continue;
      ops.push({ type: 'set', path: chunkPath(s.id, c.id), data: { i: c.i, n: c.n, data: c.data, hash: c.hash } });
      chunksWritten++;
    }
    const oldChunkIds = trust ? Object.keys(prevCh) : listedChunks.get(s.id) || [];
    for (const cid of oldChunkIds) {
      if (!(cid in newChunkHashes[s.id])) { ops.push({ type: 'delete', path: chunkPath(s.id, cid) }); chunksDeleted++; }
    }
    if (!trust || prevScopeHashes[s.id] !== s.doc.hash || ops.length) {
      ops.push({ type: 'set', path: scopePath(s.id), data: { ...s.doc, syncedAtMs: nowMs } });
      scopesWritten++;
    }
    if (ops.length) scopeGroups.push(ops);
  }

  // Quyền: thu hẹp/thu hồi ghi TRƯỚC khi ghi dữ liệu; mở rộng ghi SAU khi các phạm vi mới đã tồn tại.
  const accessFirst = [], accessAfter = [], newAccessHashes = {};
  let accessWritten = 0, accessDeleted = 0;
  for (const [email, a] of Object.entries(access)) {
    const h = hash53(JSON.stringify(a));
    newAccessHashes[email] = { h, s: a.scopes };
    const prev = trust ? prevAccess[email] : null;
    if (prev?.h === h) continue;
    const op = { type: 'set', path: accessPath(email), data: { ...a, updatedAtMs: nowMs } };
    (prev && a.scopes.every(x => (prev.s || []).includes(x)) ? accessFirst : accessAfter).push([op]);
    accessWritten++;
  }
  for (const email of prevAccessIds) {
    if (!(email in access)) { accessFirst.push([{ type: 'delete', path: accessPath(email) }]); accessDeleted++; }
  }
  const staleScopeGroups = [];
  for (const id of prevScopeIds) {
    if (id in newScopeHashes) continue;
    const cids = trust ? Object.keys(prevChunkHashes[id] || {}) : listedChunks.get(id) || [];
    staleScopeGroups.push([...cids.map(cid => ({ type: 'delete', path: chunkPath(id, cid) })), { type: 'delete', path: scopePath(id) }]);
    chunksDeleted += cids.length;
    scopesDeleted++;
  }

  // 6) Ghi: thu hẹp quyền → phạm vi → mở rộng quyền → xóa phạm vi thừa → meta (+ bản lưu) → trạng thái.
  //    Lỗi giữa chừng: trạng thái cũ được giữ nên lần sau ghi lại đúng phần còn thiếu (các thao tác đều idempotent).
  const tWrite = clock();
  let batches = 0;
  batches += await commitGroups(store, accessFirst);
  batches += await commitGroups(store, scopeGroups);
  batches += await commitGroups(store, accessAfter);
  batches += await commitGroups(store, staleScopeGroups);
  const durationMs = clock() - startMs;
  const syncedAtMs = clock();
  const count = levelMeta.reduce((s, l) => s + l.count, 0);
  // trigger công khai cho mọi người có quyền → không ghi email người bấm đồng bộ (chỉ lưu trong v2_config/state.lastTrigger).
  const meta = { version: SCHEMA_VERSION_V2, syncedAtMs, levels: levelMeta, trigger: publicTrigger(trigger), durationMs };
  await store.commitBatch([{ type: 'set', path: PATHS.meta, data: meta }, ...cacheOps]);
  batches++;
  const finishedMs = clock();
  const sum = k => Object.values(changes).reduce((n, c) => n + (c[k] || 0), 0);
  const result = {
    ok: true, count, added: sum('added'), updated: sum('updated'), removed: sum('removed'),
    levels: Object.fromEntries(levelMeta.map(l => [l.cap, { enabled: l.enabled, count: l.count, stale: l.stale, ...(changes[l.cap] || {}) }])),
    scopes: scopes.length, scopesWritten, scopesDeleted, chunksWritten, chunksDeleted,
    accessCount: Object.keys(access).length, accessWritten, accessDeleted,
    durationMs: finishedMs - startMs, syncedAtMs, trigger,
  };
  await store.commitBatch([{
    type: 'set', path: PATHS.state,
    data: {
      version: SCHEMA_VERSION_V2,
      scopeHashes: JSON.stringify(newScopeHashes),
      chunkHashes: JSON.stringify(newChunkHashes),
      accessHashes: JSON.stringify(newAccessHashes),
      levels: levelState,
      staffHashes,
      rolesHash,
      bench: JSON.stringify(benchState),
      lastRunMs: finishedMs,
      lastTrigger: trigger,
      lastResult: { count, scopesWritten, scopesDeleted, chunksWritten, chunksDeleted, accessWritten, accessDeleted, durationMs: result.durationMs, warnings: warnings.length },
    },
  }]);

  return {
    ...result,
    warnings,
    debug: {
      fetchMs, parseMs, writeMs: clock() - tWrite, batches,
      stats,
      scopeSizes: scopes.map(s => ({ id: s.id, kind: s.doc.kind, count: s.doc.count, chunks: s.chunks.length, bytes: s.chunks.reduce((n, c) => n + c.data.length, 0) })),
    },
    // Chỉ dùng cho dry-run / kiểm thử (không trả về qua HTTP)
    _internal: { access, people, scopes, levels },
  };
}

const SUM_KEYS = ['scopesWritten', 'scopesDeleted', 'chunksWritten', 'chunksDeleted', 'accessWritten', 'accessDeleted', 'added', 'updated', 'removed'];
function mergeResults(a, b) {
  if (!a) return { ...b, runs: 1 };
  const out = { ...b, durationMs: a.durationMs + b.durationMs, warnings: [...new Set([...a.warnings, ...b.warnings])], runs: a.runs + 1 };
  for (const k of SUM_KEYS) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

/**
 * Đồng bộ các Sheet → kho (v2).
 * @param {object} p
 * @param {object} p.store         firestoreStore(db) hoặc memoryStore()
 * @param {(sheetId:string, tab:{sheet:string})=>Promise<object>} p.fetchTable  trả về `table` của gviz (có thể có .isPublic(sheetId, tab))
 * @param {object} [p.env]         biến môi trường (xem readSyncConfig)
 * @param {string} [p.trigger]     'cron' | 'webhook' | 'user:<email>' | 'dry-run' …
 * @param {number|(()=>number)} [p.nowMs]  thời điểm bắt đầu (ms) hoặc hàm đồng hồ
 * @param {boolean} [p.force]      ghi lại toàn bộ, bỏ qua hash, giới hạn tần suất và các chốt chặn “0 phiếu”
 * @param {{warn:Function}} [p.log] nơi ghi chi tiết lỗi lạ (mặc định console)
 * @returns {Promise<object>} { ok, skipped?, count, levels, scopes, scopesWritten, scopesDeleted, chunksWritten, chunksDeleted,
 *   accessCount, accessWritten, accessDeleted, durationMs, syncedAtMs, trigger, warnings, runs, debug }
 *   skipped: 'recent' (người dùng bấm lại < 60 s: ok:true nếu lượt trước thành công, ok:false + error nếu thất bại) | 'locked'
 */
export async function runSync({ store, fetchTable, env = {}, trigger = 'manual', nowMs, force = false, log = console } = {}) {
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
  const empty = { count: null, scopesWritten: 0, scopesDeleted: 0, chunksWritten: 0, chunksDeleted: 0, accessWritten: 0, accessDeleted: 0 };

  // Giới hạn tần suất cho người dùng (cron và Apps Script không bị giới hạn) – như v1:
  //  • lượt trước THÀNH CÔNG < 60 s → { ok:true, skipped:'recent' };
  //  • lượt trước (bắt đầu < 60 s) THẤT BẠI → { ok:false, skipped:'recent', error } (handler trả 429).
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
    const running = (Number(lk?.until) || 0) > startMs;
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
  if (!token) return { ok: false, skipped: 'locked', ...empty, durationMs: clock() - startMs, syncedAtMs: null, trigger };

  let total = null;
  let released = false;
  try {
    for (;;) {
      const r = await syncOnce({ store, fetchTable, cfg, env, trigger, clock, force, log });
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
export function firestoreStore(db, { lockPath = PATHS.lock } = {}) {
  const lockRef = db.doc(lockPath);
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
    async commitMany(ops, size = WRITE_BATCH) {
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
