// Kiểm thử offline (node:test) cho đồng bộ v2 (Sheet các cấp → kho), xác thực /api/sync, đọc gviz và cấu hình Firebase.
// Dùng dữ liệu gviz tổng hợp (scripts/fixtures.mjs) + kho trong bộ nhớ – không cần mạng, Firebase hay Firestore emulator.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getApps } from 'firebase-admin/app';
import { FieldValue } from 'firebase-admin/firestore';

import { SCHEMA_VERSION_V2, hash53 } from '../lib/shared.js';
import {
  runSync, firestoreStore, readSyncConfig, packGroups, opBytes, MAX_BATCH_BYTES, PATHS, CHUNK_OPTS, LOCK_TTL_MS, WRITE_BATCH,
  scopePath, chunkPath, accessPath, staffCachePath, DEFAULT_FORM_TAB, DEFAULT_STAFF_TAB,
} from '../server/sync.js';
import { authorize, secretEquals, bearerToken, envDomains, envAdmins, isEmailAllowed, splitEmails, splitDomains } from '../server/auth.js';
import { memoryStore } from '../server/memory-store.js';
import { parseGvizBody, fetchGvizTable, makeSheetFetcher, makeMultiSheetFetcher, gvizUrl } from '../server/sheet.js';
import { getServiceAccount } from '../server/firebase.js';
import defaultHandler, { createHandler } from '../api/sync.js';
import {
  DOMAIN, SHEET_TIH, SHEET_THCS, SHEET_THPT, SHEET_ROLES, FORM_TAB, STAFF_TAB, ROLES_TAB, T0, em, makeSource, BASE_ENV, silentLog,
  tihDefaultRow, rolesTable, TIH_STAFF_ROWS, tihStaffTable, tihRow, TIH_TEACHERS, TIH_OBSERVERS,
} from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* =====================================================================
 * Môi trường kiểm thử
 * ===================================================================== */
function setup({ tihN = 12, thcsN = 6, env = {}, initial, roles = null } = {}) {
  const t = { now: T0 };
  const clock = () => t.now;
  const store = memoryStore({ clock, initial });
  const src = makeSource({ tihN, thcsN, roles });
  const baseEnv = { ...BASE_ENV, ...(roles ? { ROLES_SHEET_ID: SHEET_ROLES } : {}), ...env };
  const sync = (opts = {}) => runSync({ store, fetchTable: src.fetchTable, env: opts.env || baseEnv, trigger: opts.trigger || 'cron', nowMs: clock, force: !!opts.force, log: silentLog });
  return { t, clock, store, src, env: baseEnv, sync };
}
const paths = store => store.writtenPaths();
const under = (store, prefix) => paths(store).filter(p => p.split(':')[1].startsWith(prefix));
async function scopeRecords(store, id) {
  const doc = await store.get(scopePath(id));
  const out = [];
  for (const cid of doc.chunkIds) out.push(...JSON.parse((await store.get(chunkPath(id, cid))).data));
  return out;
}
const accOf = (store, local) => store.get(accessPath(local.includes('@') ? local : em(local)));
const pIdOf = async (store, local) => `P_${(await accOf(store, local)).roles.person.key}`;
// chỉ số lô (store.log) đầu tiên chứa đường dẫn khớp
const commitIndex = (store, pred) => store.log.findIndex(c => c.ops.some(o => pred(o)));

/* =====================================================================
 * runSync – lần đầu
 * ===================================================================== */
describe('runSync v2 – lần đồng bộ đầu tiên', () => {
  test('ghi meta, quyền, phạm vi, khối, trạng thái, bản lưu DS Nhân sự; nhả khóa', async () => {
    const { store, sync, t } = setup();
    const r = await sync();
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
    assert.equal(r.count, 18);
    const lv = Object.fromEntries(Object.entries(r.levels).map(([k, v]) => [k, { enabled: v.enabled, count: v.count, stale: v.stale }]));
    assert.deepEqual(lv, { tih: { enabled: true, count: 12, stale: false }, thcs: { enabled: true, count: 6, stale: false }, thpt: { enabled: false, count: 0, stale: false } });
    assert.deepEqual([r.added, r.updated, r.removed], [18, 0, 0], 'lần đầu: mọi phiếu là phiếu mới');
    assert.equal(r.scopesWritten, r.scopes);
    assert.equal(r.accessWritten, r.accessCount);
    assert.equal(r.syncedAtMs, t.now);
    assert.equal(r.trigger, 'cron');

    const meta = await store.get(PATHS.meta);
    assert.deepEqual(Object.keys(meta).sort(), ['durationMs', 'levels', 'syncedAtMs', 'trigger', 'version']);
    assert.equal(meta.version, SCHEMA_VERSION_V2);
    assert.deepEqual(meta.levels.map(l => [l.cap, l.label, l.color, l.enabled, l.count]), [
      ['tih', 'Tiểu học', '#ffad00', true, 12], ['thcs', 'THCS', '#2da037', true, 6], ['thpt', 'THPT', '#23328C', false, 0],
    ]);
    assert.equal(meta.levels[0].syncedAtMs, T0);
    assert.equal(meta.levels[2].syncedAtMs, null);

    const L = await store.get(scopePath('L_tih'));
    assert.deepEqual([L.kind, L.cap, L.count, L.chunkIds, L.syncedAtMs], ['level', 'tih', 12, ['c000'], T0]);
    assert.equal(L.crit.length, 3);
    const c = await store.get(chunkPath('L_tih', 'c000'));
    assert.deepEqual(Object.keys(c).sort(), ['data', 'hash', 'i', 'n']);
    assert.equal(c.hash, hash53(c.data));
    const recs = JSON.parse(c.data);
    assert.deepEqual(recs.map(x => x.ts), [...recs.map(x => x.ts)].sort());

    const a = await accOf(store, 'gv.hai');
    assert.deepEqual(Object.keys(a).sort(), ['email', 'name', 'roles', 'scopes', 'updatedAtMs']);
    assert.equal(a.updatedAtMs, T0);
    for (const id of a.scopes) assert.ok(await store.get(scopePath(id)), `phạm vi ${id} tồn tại`);

    const st = await store.get(PATHS.state);
    assert.equal(Object.keys(JSON.parse(st.scopeHashes)).length, r.scopes);
    assert.equal(st.lastRunMs, t.now);
    assert.equal(st.lastResult.count, 18);
    assert.ok((await store.get(staffCachePath('tih'))).rows.includes('Phạm Văn Hai'));
    assert.equal((await store.get(PATHS.lock)).until, 0, 'khóa được nhả');
  });

  test('CHỈ ghi collection v2 – dữ liệu v1 (dashboard/*, config/*, phieu/*) giữ nguyên', async () => {
    const initial = {
      'dashboard/meta': { version: 1, count: 5 }, 'dashboard_chunks/c000': { data: '[]' }, 'phieu/abc': { x: 1 },
      'config/access': { emails: ['a@b.vn'], domains: [] }, 'config/syncLock': { until: T0 + 30_000, token: 'v1' },
    };
    const { store, sync } = setup({ initial });
    const r = await sync();
    assert.equal(r.ok, true, 'khóa v1 không chặn đồng bộ v2');
    assert.ok(paths(store).every(p => /^(set|delete):v2_/.test(p)), paths(store).filter(p => !/:v2_/.test(p)).join(', '));
    for (const [p, d] of Object.entries(initial)) assert.deepEqual(await store.get(p), d, p);
  });

  test('mỗi phạm vi (tài liệu + khối) nằm trong CÙNG một lô; lô ≤ 400; quyền ghi sau phạm vi nó tham chiếu', async () => {
    const { store, sync } = setup({ tihN: 1001 });
    await sync();
    assert.ok(store.log.every(c => c.ops.length <= WRITE_BATCH));
    const L = await store.get(scopePath('L_tih'));
    assert.deepEqual(L.chunkIds, ['c000', 'c001', 'c002']);
    const iDoc = commitIndex(store, o => o.path === scopePath('L_tih'));
    for (const cid of L.chunkIds) assert.equal(commitIndex(store, o => o.path === chunkPath('L_tih', cid)), iDoc);
    for (const cid of L.chunkIds) {
      const c = await store.get(chunkPath('L_tih', cid));
      assert.ok(c.n <= CHUNK_OPTS.maxRecords && Buffer.byteLength(c.data, 'utf8') < 1_000_000);
    }
    for (const id of await store.listIds(PATHS.access)) {
      const a = await store.get(accessPath(id));
      const ia = commitIndex(store, o => o.path === accessPath(id));
      for (const s of a.scopes) assert.ok(commitIndex(store, o => o.path === scopePath(s)) < ia, `${id}: ${s} phải được ghi trước`);
    }
  });

  test('dữ liệu lớn (≈ 5 000 phiếu, nhận xét dài) → mọi lô ghi < 9 MiB (Firestore giới hạn 10 MiB/yêu cầu); tài liệu phạm vi ghi sau các khối của nó', async () => {
    const long = 'Nhận xét rất dài về tiết dạy, có “ngoặc kép” và xuống\ndòng. '.repeat(14);
    const row = i => tihRow(i, { ...TIH_TEACHERS[i % TIH_TEACHERS.length], ...TIH_OBSERVERS[i % TIH_OBSERVERS.length], pros: long, cons: long });
    const { store, src, sync } = setup({ tihN: 0 });
    src.tables[SHEET_TIH][FORM_TAB].rows = Array.from({ length: 5000 }, (_, i) => row(i));
    const r = await sync({ force: true });
    assert.equal(r.levels.tih.count, 5000);
    assert.ok(store.maxCommitBytes < 9 * 1024 * 1024, `lô lớn nhất ${(store.maxCommitBytes / 1048576).toFixed(2)} MiB`);
    const L = await store.get(scopePath('L_tih'));
    const iDoc = commitIndex(store, o => o.path === scopePath('L_tih'));
    for (const cid of L.chunkIds) assert.ok(commitIndex(store, o => o.path === chunkPath('L_tih', cid)) <= iDoc, cid);
    assert.equal((await scopeRecords(store, 'L_tih')).length, 5000);
  });

  test('THPT chưa kết nối; SHEET_ID (v1) làm dự phòng cho Tiểu học', async () => {
    const { store, sync } = setup({ env: { SHEET_ID_TIH: '', SHEET_ID: SHEET_TIH } });
    const r = await sync();
    assert.equal(r.levels.tih.count, 12);
    assert.equal(await store.get(scopePath('L_thpt')), null);
  });
});

/* =====================================================================
 * runSync – tăng dần
 * ===================================================================== */
describe('runSync v2 – đồng bộ tăng dần', () => {
  test('không có thay đổi → chỉ ghi lại meta và trạng thái', async () => {
    const { store, sync, t } = setup();
    await sync();
    store.clearLog();
    t.now += 5_000;
    const r = await sync();
    assert.deepEqual([r.scopesWritten, r.chunksWritten, r.accessWritten, r.scopesDeleted, r.accessDeleted], [0, 0, 0, 0, 0]);
    assert.deepEqual(paths(store), [`set:${PATHS.meta}`, `set:${PATHS.state}`]);
    assert.equal((await store.get(PATHS.meta)).syncedAtMs, t.now);
    assert.equal((await store.get(scopePath('L_tih'))).syncedAtMs, T0, 'syncedAtMs của phạm vi = lúc nội dung đổi lần cuối');
  });

  test('sửa nhận xét một phiếu → chỉ ghi các phạm vi chứa phiếu đó (cấp, tổ, người dạy, người dự)', async () => {
    const { store, src, sync } = setup();
    await sync();
    const pHai = await pIdOf(store, 'gv.hai'), pOne = await pIdOf(store, 'totruong1'), pBa = await pIdOf(store, 'gv.ba');
    src.tables[SHEET_TIH][FORM_TAB].rows[0].c[21] = { v: 'Ưu điểm đã sửa' };
    store.clearLog();
    const r = await sync();
    const written = under(store, 'v2_scopes/').filter(p => !p.includes('/chunks/')).map(p => p.split(':')[1].slice(10)).sort();
    assert.deepEqual(written, ['L_tih', pHai, pOne, 'T_tih_to-1'].sort());
    assert.ok(!written.includes(pBa));
    assert.equal(r.accessWritten, 0);
    assert.equal((await scopeRecords(store, 'L_tih'))[0].pros, 'Ưu điểm đã sửa');
    assert.equal((await scopeRecords(store, pHai)).find(x => x.rel === 't').pros, 'Ưu điểm đã sửa');
  });

  test('thêm MỘT phiếu mới → chỉ ghi phạm vi cấp, tổ, người dạy, người dự (số liệu đối sánh được giữ – P_ của người khác không bị ghi lại); báo added/updated/removed', async () => {
    const { store, src, sync, t } = setup();
    await sync();
    const pHai = await pIdOf(store, 'gv.hai'), pOne = await pIdOf(store, 'totruong1'), pBa = await pIdOf(store, 'gv.ba');
    const benchBa = (await store.get(scopePath(pBa))).benchmarks;
    // phiếu gửi trong tuần hiện tại (06/10/2026) và một phiếu gửi “trễ” của tuần trước
    src.tables[SHEET_TIH][FORM_TAB].rows.push(tihRow(36 * 1440 + 60, { ...TIH_TEACHERS[0], ...TIH_OBSERVERS[0] }));
    store.clearLog();
    t.now += 60_000;
    const r = await sync();
    const written = under(store, 'v2_scopes/').filter(p => !p.includes('/chunks/')).map(p => p.split(':')[1].slice(10)).sort();
    assert.deepEqual(written, ['L_tih', pHai, pOne, 'T_tih_to-1'].sort());
    assert.deepEqual([r.added, r.updated, r.removed, r.levels.tih.added, r.levels.thcs.added], [1, 0, 0, 1, 0]);
    assert.deepEqual((await store.get(scopePath(pBa))).benchmarks, benchBa);
    src.tables[SHEET_TIH][FORM_TAB].rows[2].c[22] = { v: 'Khắc phục đã sửa' };
    t.now += 60_000;
    const r2 = await sync();
    assert.deepEqual([r2.added, r2.updated, r2.removed], [0, 1, 0]);
    src.tables[SHEET_TIH][FORM_TAB].rows.splice(4, 1);
    t.now += 60_000;
    const r3 = await sync();
    assert.deepEqual([r3.added, r3.updated, r3.removed], [0, 0, 1]);
  });

  test('tuần mới có ≥ 5 phiếu (đã chốt) của ≥ 3 GV → số liệu đối sánh được công bố lại (một lần), không phải mỗi lượt', async () => {
    const { store, src, sync, t } = setup();
    await sync();
    const pBa = await pIdOf(store, 'gv.ba');
    const b0 = (await store.get(scopePath(pBa))).benchmarks.levels.tih;
    const W = 36 * 1440; // 07/10/2026 (tuần hiện tại)
    for (let k = 0; k < 5; k++) src.tables[SHEET_TIH][FORM_TAB].rows.push(tihRow(W + 60 * k, { ...TIH_TEACHERS[k % 3], ...TIH_OBSERVERS[k % 3], sc: [1, 2, 1] }));
    t.now += 60_000;
    await sync();
    assert.deepEqual((await store.get(scopePath(pBa))).benchmarks.levels.tih, b0, 'phiếu của tuần hiện tại chưa được tính');
    t.now = Date.UTC(2026, 9, 12, 1, 0, 0); // thứ Hai tuần sau 08:00 giờ VN
    store.clearLog();
    await sync();
    const b1 = (await store.get(scopePath(pBa))).benchmarks.levels.tih;
    assert.equal(b1.n, b0.n + 5);
    assert.ok(b1.avg < b0.avg);
    assert.equal(b1.asOf, '2026-10-12');
    store.clearLog();
    t.now += 60_000;
    const r = await sync();
    assert.deepEqual([r.scopesWritten, r.chunksWritten], [0, 0], 'lượt sau trong cùng tuần: không ghi lại gì');
  });

  test('xóa dòng trên Sheet → phiếu biến mất khỏi mọi phạm vi', async () => {
    const { store, src, sync } = setup();
    await sync();
    const gone = (await scopeRecords(store, 'L_tih'))[5].id;
    src.tables[SHEET_TIH][FORM_TAB].rows.splice(5, 1);
    const r = await sync();
    assert.equal(r.levels.tih.count, 11);
    const ids = Object.keys(JSON.parse((await store.get(PATHS.state)).scopeHashes));
    for (const id of ids) assert.ok(!(await scopeRecords(store, id)).some(x => x.id === gone), id);
  });

  test('thêm dòng cuối → phạm vi cấp chỉ ghi lại khối cuối', async () => {
    const { store, src, sync } = setup({ tihN: 600 });
    await sync();
    assert.deepEqual((await store.get(scopePath('L_tih'))).chunkIds, ['c000', 'c001']);
    src.tables[SHEET_TIH][FORM_TAB].rows.push(tihDefaultRow(600));
    store.clearLog();
    await sync();
    const lw = under(store, 'v2_scopes/L_tih');
    assert.deepEqual(lw.sort(), [`set:${chunkPath('L_tih', 'c001')}`, `set:${scopePath('L_tih')}`].sort());
    assert.equal((await store.get(chunkPath('L_tih', 'c001'))).n, 101);
  });

  test('số khối giảm → xóa khối thừa', async () => {
    const { store, src, sync } = setup({ tihN: 600 });
    await sync();
    src.tables[SHEET_TIH][FORM_TAB].rows.length = 450;
    const r = await sync();
    assert.ok(r.chunksDeleted >= 1);
    assert.deepEqual(await store.listIds('v2_scopes/L_tih/chunks'), ['c000']);
  });

  test('nhân sự mới (có email) → thêm quyền + phạm vi cá nhân; nhân sự nghỉ → xóa quyền, phạm vi và khối', async () => {
    const { store, src, sync } = setup();
    await sync();
    src.tables[SHEET_TIH][STAFF_TAB] = tihStaffTable([...TIH_STAFF_ROWS, [100999, 'Người Mới', 'Tiểu học', 'Tổ 3', 'GVCN 3A1', em('moi')]]);
    const r1 = await sync();
    assert.equal(r1.accessWritten, 1);
    const pMoi = await pIdOf(store, 'moi');
    assert.ok(await store.get(scopePath(pMoi)));
    const pHai = await pIdOf(store, 'gv.hai');
    const chunkIds = (await store.get(scopePath(pHai))).chunkIds;
    assert.ok(chunkIds.length);
    src.tables[SHEET_TIH][STAFF_TAB] = tihStaffTable(TIH_STAFF_ROWS.map(r => (r[5] === em('gv.hai') ? [...r.slice(0, 7), 'Nghỉ việc'] : r)));
    store.clearLog();
    const r2 = await sync();
    assert.ok(r2.accessDeleted >= 1 && r2.scopesDeleted >= 1);
    assert.equal(await accOf(store, 'gv.hai'), null);
    assert.equal(await store.get(scopePath(pHai)), null);
    assert.deepEqual(await store.listIds(`v2_scopes/${pHai}/chunks`), [], 'khối của phạm vi bị xóa cũng bị xóa');
  });

  test('thu hồi quyền (tab Phân quyền) được ghi TRƯỚC mọi thay đổi dữ liệu trong cùng lượt', async () => {
    const { store, src, sync } = setup({ roles: [] });
    await sync();
    const pHai = await pIdOf(store, 'gv.hai');
    src.tables[SHEET_ROLES][ROLES_TAB] = rolesTable([[em('gv.hai'), 'Không truy cập', '', '', '']]);
    src.tables[SHEET_TIH][FORM_TAB].rows[3].c[21] = { v: 'sửa để có thao tác ghi phạm vi' };
    store.clearLog();
    await sync();
    const iRevoke = commitIndex(store, o => o.type === 'delete' && o.path === accessPath(em('gv.hai')));
    const iFirstScope = commitIndex(store, o => o.type === 'set' && o.path.startsWith('v2_scopes/'));
    assert.ok(iRevoke >= 0 && iFirstScope > iRevoke, `thu hồi (lô ${iRevoke}) trước khi ghi phạm vi (lô ${iFirstScope})`);
    assert.ok(commitIndex(store, o => o.type === 'delete' && o.path === scopePath(pHai)) > iFirstScope, 'phạm vi cá nhân bị xóa sau');
  });

  test('mất vai trò tổ trưởng → quyền thu hẹp ghi trước, phạm vi tổ bị xóa', async () => {
    const { store, src, sync } = setup();
    await sync();
    assert.ok((await accOf(store, 'totruong1')).scopes.includes('T_tih_to-1'));
    src.tables[SHEET_TIH][STAFF_TAB] = tihStaffTable(TIH_STAFF_ROWS.map(r => (r[5] === em('totruong1') ? [r[0], r[1], r[2], r[3], 'GVCN 1B0', r[5]] : r)));
    store.clearLog();
    await sync();
    assert.ok(!(await accOf(store, 'totruong1')).scopes.includes('T_tih_to-1'));
    assert.equal(await store.get(scopePath('T_tih_to-1')), null);
    assert.ok(commitIndex(store, o => o.path === accessPath(em('totruong1'))) < commitIndex(store, o => o.type === 'delete' && o.path === scopePath('T_tih_to-1')));
  });

  test('force → ghi lại toàn bộ dù không đổi', async () => {
    const { sync } = setup();
    const r1 = await sync();
    const r = await sync({ force: true });
    assert.deepEqual([r.scopesWritten, r.accessWritten], [r1.scopes, r1.accessCount]);
  });

  test('mất trạng thái (v2_config/state) → liệt kê tài liệu hiện có, xóa phạm vi/khối thừa', async () => {
    const { store, sync } = setup();
    await sync();
    await store.commitBatch([
      { type: 'delete', path: PATHS.state },
      { type: 'set', path: scopePath('P_cu'), data: { kind: 'person', chunkIds: ['c000'] } },
      { type: 'set', path: chunkPath('P_cu', 'c000'), data: { data: '[]' } },
      { type: 'set', path: chunkPath('L_tih', 'c009'), data: { data: '[]' } },
      { type: 'set', path: accessPath('cu@x.vn'), data: { scopes: ['P_cu'] } },
    ]);
    store.clearLog();
    const r = await sync();
    assert.equal(await store.get(scopePath('P_cu')), null);
    assert.equal(await store.get(chunkPath('P_cu', 'c000')), null);
    assert.equal(await store.get(chunkPath('L_tih', 'c009')), null);
    assert.equal(await store.get(accessPath('cu@x.vn')), null);
    assert.equal(r.scopesWritten, r.scopes, 'không tin trạng thái → ghi lại toàn bộ');
  });
});

/* =====================================================================
 * runSync – lỗi & chốt chặn an toàn
 * ===================================================================== */
describe('runSync v2 – lỗi Sheet và chốt chặn', () => {
  test('một cấp lỗi → cấp đó giữ dữ liệu cũ (stale), cấp khác vẫn cập nhật', async () => {
    const { store, src, sync, t } = setup();
    await sync();
    const before = await scopeRecords(store, 'L_thcs');
    t.now += 3_600_000;
    src.fail[`${SHEET_THCS}/${FORM_TAB}`] = Object.assign(new Error('Không có quyền đọc Google Sheet (tab “Câu trả lời biểu mẫu 1”).'), { expose: true });
    src.tables[SHEET_TIH][FORM_TAB].rows.push(tihDefaultRow(12));
    store.clearLog();
    const r = await sync();
    assert.equal(r.ok, true);
    assert.deepEqual([r.levels.tih.count, r.levels.thcs.count, r.levels.thcs.stale], [13, 6, true]);
    assert.ok(r.warnings.some(w => /THCS: không cập nhật được phiếu.*Không có quyền đọc.*giữ nguyên/.test(w)));
    assert.deepEqual(await scopeRecords(store, 'L_thcs'), before);
    assert.ok(!under(store, 'v2_scopes/L_thcs').length);
    const meta = await store.get(PATHS.meta);
    assert.deepEqual([meta.levels[1].stale, meta.levels[1].syncedAtMs, meta.levels[0].syncedAtMs], [true, T0, t.now]);
    assert.ok((await scopeRecords(store, await pIdOf(store, 'gv.anh'))).length, 'phạm vi cá nhân THCS vẫn còn phiếu');
  });

  test('cấp trả về 0 phiếu khi trước đó có dữ liệu → giữ dữ liệu cũ; force → chấp nhận', async () => {
    const { store, src, sync } = setup();
    await sync();
    src.tables[SHEET_THCS][FORM_TAB].rows = [];
    const r = await sync();
    assert.deepEqual([r.levels.thcs.count, r.levels.thcs.stale], [6, true]);
    assert.ok(r.warnings.some(w => /0 phiếu/.test(w)));
    const rf = await sync({ force: true });
    assert.deepEqual([rf.levels.thcs.count, rf.levels.thcs.stale], [0, false]);
    assert.equal((await store.get(scopePath('L_thcs'))).count, 0);
  });

  test('mọi cấp đều lỗi → ném lỗi, không ghi gì, nhả khóa', async () => {
    const { store, src, sync } = setup();
    await sync();
    src.fail[SHEET_TIH] = new Error('mạng lỗi');
    src.fail[SHEET_THCS] = new Error('mạng lỗi');
    store.clearLog();
    await assert.rejects(sync(), /mạng lỗi/);
    assert.deepEqual(paths(store), []);
    assert.equal((await store.get(PATHS.lock)).until, 0);
  });

  test('biểu mẫu sai cấu trúc ở một cấp → cấp đó giữ dữ liệu cũ, cảnh báo nêu nguyên nhân', async () => {
    const { src, sync } = setup();
    await sync();
    src.tables[SHEET_TIH][FORM_TAB].cols[0].label = 'Cột lạ';
    const r = await sync();
    assert.equal(r.levels.tih.stale, true);
    assert.ok(r.warnings.some(w => /Tiểu học.*cấu trúc cột/.test(w)));
    src.tables[SHEET_THCS][FORM_TAB].cols[0].label = 'Cột lạ';
    await assert.rejects(sync(), e => e.expose === true && /cấu trúc cột/.test(e.message));
  });

  test('sai tên tab DS Nhân sự (gviz trả tab đầu tiên) → dùng bản lưu, quyền không đổi', async () => {
    const { store, sync, env } = setup();
    await sync();
    const before = await store.dump('v2_access/');
    store.clearLog();
    const r = await sync({ env: { ...env, SHEET_STAFF_TAB_TIH: 'DS Nhân sự (cũ)' } });
    assert.ok(r.warnings.some(w => /Tiểu học: không đọc được “DS Nhân sự”.*bản lưu/.test(w)));
    assert.equal(r.accessWritten + r.accessDeleted, 0);
    assert.deepEqual(await store.dump('v2_access/'), before);
  });

  test('lỗi DS Nhân sự ngay lần đầu → cảnh báo, cấp đó chưa có quyền tự động; lần sau bổ sung', async () => {
    const { store, src, sync } = setup();
    src.fail[`${SHEET_TIH}/${STAFF_TAB}`] = new Error('x');
    const r = await sync();
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => /chưa có bản lưu/.test(w)));
    assert.equal(await accOf(store, 'gv.hai'), null);
    assert.ok(await accOf(store, 'gv.anh'), 'THCS vẫn có quyền');
    delete src.fail[`${SHEET_TIH}/${STAFF_TAB}`];
    await sync();
    assert.ok(await accOf(store, 'gv.hai'));
  });

  test('tab Phân quyền lỗi lần đầu → dừng (không cấp nhầm quyền); sau đó lỗi → dùng bản lưu', async () => {
    const { store, src, sync } = setup({ roles: [[em('gv.hai'), 'Không truy cập', '', '', '']] });
    src.fail[`${SHEET_ROLES}/${ROLES_TAB}`] = new Error('x');
    await assert.rejects(sync(), e => e.code === 'ROLES_SHEET' && e.expose);
    assert.equal(await store.get(PATHS.meta), null, 'không ghi gì');
    delete src.fail[`${SHEET_ROLES}/${ROLES_TAB}`];
    await sync();
    assert.equal(await accOf(store, 'gv.hai'), null);
    src.fail[`${SHEET_ROLES}/${ROLES_TAB}`] = new Error('x');
    const r = await sync();
    assert.ok(r.warnings.some(w => /tab Phân quyền.*bản lưu/.test(w)));
    assert.equal(await accOf(store, 'gv.hai'), null, 'thu hồi vẫn giữ nhờ bản lưu');
  });

  test('ROLES_TAB sai tên (gviz trả tab đầu tiên) → không nhận bảng', async () => {
    const { sync, env } = setup({ roles: [] });
    await assert.rejects(sync({ env: { ...env, ROLES_TAB: 'Phan quyen cu' } }), e => e.code === 'ROLES_SHEET' && /Email và Vai trò/.test(e.message));
  });

  test('không tính được quyền cho ai trong khi đang có người được cấp → dừng', async () => {
    const { src, sync } = setup();
    await sync();
    src.tables[SHEET_TIH][STAFF_TAB].rows = [];
    src.tables[SHEET_THCS][STAFF_TAB].rows = [];
    // cả hai DS rỗng (đọc được nhưng trống) → bản lưu được dùng → quyền vẫn còn
    const r = await sync();
    assert.ok(r.accessCount > 0);
    const { store: s2, sync: sync2 } = setup({ env: { ADMIN_EMAILS: 'boss@x.vn' } });
    await sync2();
    await s2.commitBatch([{ type: 'delete', path: staffCachePath('tih') }, { type: 'delete', path: staffCachePath('thcs') }]);
    const st = await s2.get(PATHS.state);
    await s2.commitBatch([{ type: 'set', path: PATHS.state, data: { ...st, staffHashes: {} } }]);
    await assert.rejects(sync2({ env: { ...BASE_ENV, SHEET_STAFF_TAB_TIH: 'none', SHEET_STAFF_TAB_THCS: 'none' } }), e => e.code === 'EMPTY_ACCESS');
  });

  test('Sheet công khai → cảnh báo, không đưa đường dẫn; Sheet riêng tư → đường dẫn trong phạm vi cấp', async () => {
    const { store, src, sync } = setup();
    src.publicBySheet[SHEET_TIH] = true;
    const r = await sync();
    assert.ok(r.warnings.some(w => /Tiểu học: Google Sheet đang ở chế độ “Bất kỳ ai có đường liên kết”/.test(w)));
    assert.equal((await store.get(scopePath('L_tih'))).sheetUrl, '');
    assert.equal((await store.get(scopePath('L_thcs'))).sheetUrl, `https://docs.google.com/spreadsheets/d/${SHEET_THCS}/edit`);
  });

  test('chưa cấu hình Sheet nào → lỗi hướng dẫn', async () => {
    const { sync } = setup();
    await assert.rejects(sync({ env: {} }), e => e.code === 'CONFIG_SHEET_ID' && /SHEET_ID_TIH/.test(e.message));
  });

  test('THPT bật nhưng chưa đọc được (chưa có dữ liệu cũ) → cấp đó trống + cảnh báo, cấp khác vẫn chạy', async () => {
    const { store, sync, env } = setup({ roles: [[em('gv.anh'), 'BGH cấp', 'THPT', '', '']] });
    const r = await sync({ env: { ...env, SHEET_ID_THPT: SHEET_THPT } });
    assert.deepEqual([r.levels.thpt.enabled, r.levels.thpt.count, r.levels.thpt.stale], [true, 0, true]);
    assert.ok(r.warnings.some(w => /THPT: không đọc được phiếu/.test(w)));
    const a = await accOf(store, 'gv.anh');
    assert.deepEqual(a.roles.bghCaps, ['thpt']);
    assert.ok(a.scopes.includes('L_thpt'));
    assert.equal((await store.get(scopePath('L_thpt'))).count, 0);
  });
});

/* =====================================================================
 * runSync – giới hạn tần suất và khóa (như v1, dưới v2_config)
 * ===================================================================== */
describe('runSync v2 – giới hạn tần suất và khóa', () => {
  test('người dùng bấm lại < 60 s → {ok:true, skipped:"recent"}, không ghi gì; cron/webhook không bị giới hạn', async () => {
    const { store, sync, t } = setup();
    await sync({ trigger: 'cron' });
    store.clearLog();
    t.now += 30_000;
    const r = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r.ok, r.skipped, r.count, r.retryAfterMs], [true, 'recent', 18, 30_000]);
    assert.deepEqual(paths(store), []);
    assert.equal((await sync({ trigger: 'cron' })).skipped, undefined);
    assert.equal((await sync({ trigger: 'webhook' })).skipped, undefined);
    t.now += 60_001;
    const r2 = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r2.ok, r2.skipped], [true, undefined]);
    assert.equal((await store.get(PATHS.meta)).trigger, 'user', 'meta (mọi người có quyền đều đọc) không chứa email người bấm đồng bộ');
    assert.equal((await store.get(PATHS.state)).lastTrigger, `user:gv@${DOMAIN}`, 'email chỉ nằm trong v2_config/state (máy chủ)');
  });

  test('đang bị khóa → {ok:false, skipped:"locked"}; hết hạn khóa (55 s) → chạy bình thường', async () => {
    const { store, sync, t } = setup({ initial: { [PATHS.lock]: { until: T0 + 30_000, token: 'khac' } } });
    const r = await sync();
    assert.deepEqual([r.ok, r.skipped], [false, 'locked']);
    assert.deepEqual(paths(store), []);
    t.now += 30_001;
    assert.equal((await sync()).ok, true);
    assert.equal(LOCK_TTL_MS, 55_000);
  });

  test('lượt chen ngang bị từ chối và lượt đang chạy chạy lại một lần', async () => {
    const { store, src, sync } = setup();
    let open;
    src.gate = new Promise(res => { open = res; });
    const first = sync({ trigger: 'cron' });
    await new Promise(res => setImmediate(res));
    assert.equal((await store.get(PATHS.lock)).until, T0 + LOCK_TTL_MS);
    src.tables[SHEET_TIH][FORM_TAB].rows.push(tihDefaultRow(12));
    assert.equal((await sync({ trigger: 'webhook' })).skipped, 'locked');
    src.gate = null;
    open();
    const r = await first;
    assert.deepEqual([r.ok, r.runs, r.levels.tih.count], [true, 2, 13]);
    assert.equal((await store.get(PATHS.lock)).until, 0);
  });

  test('lượt trước thất bại < 60 s → người dùng nhận {ok:false, skipped:"recent", error}; sau 60 s thử lại được', async () => {
    const { store, src, sync, t } = setup();
    await sync({ trigger: 'cron' });
    t.now += 120_000;
    src.fail[SHEET_TIH] = new Error('Sheet lỗi'); src.fail[SHEET_THCS] = new Error('Sheet lỗi');
    await assert.rejects(sync({ trigger: `user:gv@${DOMAIN}` }), /Sheet lỗi/);
    store.clearLog();
    t.now += 5_000;
    const r = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r.ok, r.skipped, r.retryAfterMs], [false, 'recent', 55_000]);
    assert.match(r.error, /chưa thành công/);
    assert.deepEqual(paths(store), []);
    await assert.rejects(sync({ trigger: 'cron' }), /Sheet lỗi/, 'cron không bị giới hạn');
    src.fail = {};
    t.now += 60_001;
    assert.deepEqual([(await sync({ trigger: `user:gv@${DOMAIN}` })).ok], [true]);
  });

  test('đang có lượt chạy → người dùng nhận locked, yêu cầu chờ chỉ ghi nhận một lần', async () => {
    const { store, sync, t } = setup({ initial: { [PATHS.lock]: { until: T0 + 30_000, token: 'khac', acquiredAt: T0 - 1_000, pendingAt: 0 } } });
    assert.deepEqual([(await sync({ trigger: `user:gv@${DOMAIN}` })).skipped], ['locked']);
    assert.equal((await store.get(PATHS.lock)).pendingAt, T0);
    t.now += 1_000;
    await sync({ trigger: 'webhook' });
    assert.equal((await store.get(PATHS.lock)).pendingAt, T0);
  });
});

describe('readSyncConfig / packGroups', () => {
  test('biến môi trường v2', () => {
    const c = readSyncConfig({
      SHEET_ID_TIH: ' a ', SHEET_ID_THCS: 'b', SHEET_FORM_TAB_THCS: 'Form 2', SHEET_STAFF_TAB_TIH: 'none',
      ROLES_SHEET_ID: 'r', ADMIN_EMAILS: 'IT@X.vn, sai', ALLOWED_DOMAINS: 'none',
    });
    assert.deepEqual(c.levels.map(l => [l.cap, l.sheetId, l.enabled, l.formTab, l.staffTab]), [
      ['tih', 'a', true, DEFAULT_FORM_TAB, ''], ['thcs', 'b', true, 'Form 2', DEFAULT_STAFF_TAB], ['thpt', '', false, DEFAULT_FORM_TAB, DEFAULT_STAFF_TAB],
    ]);
    assert.deepEqual([c.rolesSheetId, c.rolesTab, c.adminEmails, c.envDomains], ['r', 'Phân quyền', ['it@x.vn'], []]);
    assert.equal(readSyncConfig({ SHEET_ID: 'v1' }).levels[0].sheetId, 'v1');
    assert.equal(readSyncConfig({ SHEET_ID: 'v1', SHEET_ID_TIH: 'v2' }).levels[0].sheetId, 'v2');
    assert.equal(readSyncConfig({ SHEET_ID_THCS: 'x', SHEET_ID: 'v1' }).levels[1].sheetId, 'x');
    assert.equal(readSyncConfig({ SHEET_STAFF_TAB_TIH: '' }).levels[0].staffTab, DEFAULT_STAFF_TAB);
    assert.deepEqual(readSyncConfig({}).envDomains, [DOMAIN]);
  });
  test('packGroups: không tách nhóm, lô ≤ max', () => {
    const g = n => Array.from({ length: n }, (_, i) => i);
    assert.deepEqual(packGroups([g(3), g(3), g(3)], 7).map(b => b.length), [6, 3]);
    assert.deepEqual(packGroups([g(9)], 4).map(b => b.length), [4, 4, 1]);
    assert.deepEqual(packGroups([[], g(2)], 4).map(b => b.length), [2]);
  });
  test('packGroups: giới hạn theo dung lượng; nhóm quá lớn → khối ở các lô trước, (xóa khối thừa + tài liệu phạm vi) ở lô cuối', () => {
    const big = i => ({ type: 'set', path: `v2_scopes/L_tih/chunks/c00${i}`, data: { data: 'x'.repeat(400_000) } });
    const grp = [big(0), big(1), big(2), { type: 'delete', path: 'v2_scopes/L_tih/chunks/c009' }, { type: 'set', path: 'v2_scopes/L_tih', data: { chunkIds: ['c000', 'c001', 'c002'] } }];
    const b = packGroups([grp], 400, 900_000);
    assert.deepEqual(b.map(x => x.map(o => o.path.split('/').pop())), [['c000', 'c001'], ['c002'], ['c009', 'L_tih']]);
    assert.ok(b.every(x => x.reduce((n, o) => n + opBytes(o), 0) <= 900_000));
    const small = packGroups([[big(0)], [big(1)], [big(2)]], 400, 900_000);
    assert.deepEqual(small.map(x => x.length), [2, 1], 'nhóm nhỏ: không tách, gộp đến khi đầy theo dung lượng');
    assert.equal(MAX_BATCH_BYTES, 6 * 1024 * 1024);
  });
});

/* =====================================================================
 * authorize() – ai được kích hoạt đồng bộ
 * ===================================================================== */
describe('authorize – ma trận quyền (v2)', () => {
  const ms = (email, extra = {}) => ({ email, email_verified: false, firebase: { sign_in_provider: 'microsoft.com' }, ...extra });
  const TOKENS = {
    'ms-school': ms(`gv@${DOMAIN}`),
    'ms-upper': ms('GiaoVien@HoangMaiStarSchool.EDU.VN'),
    'ms-other': ms('someone@gmail.com'),
    'ms-granted': ms('Partner@Other.vn'),
    'ms-admin': ms('Boss@X.vn'),
    'ms-lookalike': ms(`x@${DOMAIN}.evil.com`),
    'ms-subdomain': ms(`x@sub.${DOMAIN}`),
    'ms-double-at': ms(`a@evil.com@${DOMAIN}`),
    'ms-slash': ms(`a/b@${DOMAIN}`),
    'ms-noemail': { firebase: { sign_in_provider: 'microsoft.com' } },
    'ms-blank': ms('   '),
    'google-school': { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'google.com' } },
    'password-school': { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'password' } },
    'noprovider-school': { email: `gv@${DOMAIN}` },
  };
  const calls = { verify: 0, access: [] };
  const verifyIdToken = async tok => {
    calls.verify++;
    if (TOKENS[tok]) return TOKENS[tok];
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  };
  const granted = new Set(['partner@other.vn']);
  const auth = (authorization, env = {}) =>
    authorize({ authorization, env, verifyIdToken, hasAccess: async e => { calls.access.push(e); return granted.has(e); } });

  test('microsoft.com + tên miền trường → được phép; viewer = đã có v2_access (để quyết định mức chi tiết của kết quả)', async () => {
    calls.access = [];
    assert.deepEqual(await auth('Bearer ms-school'), { ok: true, trigger: `user:gv@${DOMAIN}`, email: `gv@${DOMAIN}`, admin: false, viewer: false });
    assert.deepEqual(calls.access, [`gv@${DOMAIN}`]);
    assert.equal((await auth('Bearer ms-upper')).trigger, `user:giaovien@${DOMAIN}`);
  });
  test('tên miền khác: có v2_access → được phép; không có → 403', async () => {
    const r = await auth('Bearer ms-granted');
    assert.deepEqual([r.ok, r.email, r.admin], [true, 'partner@other.vn', false]);
    const d = await auth('Bearer ms-other');
    assert.deepEqual([d.ok, d.status], [false, 403]);
    assert.match(d.error, /chưa được cấp quyền/);
  });
  test('ADMIN_EMAILS → được phép (cờ admin), kể cả khi ALLOWED_DOMAINS=none', async () => {
    const r = await auth('Bearer ms-admin', { ADMIN_EMAILS: 'boss@x.vn', ALLOWED_DOMAINS: 'none' });
    assert.deepEqual([r.ok, r.admin], [true, true]);
    assert.equal((await auth('Bearer ms-school', { ALLOWED_DOMAINS: 'none' })).status, 403);
  });
  test('tên miền giả dạng / tên miền con / nhiều @ / có “/” → 403', async () => {
    for (const tok of ['ms-lookalike', 'ms-subdomain', 'ms-double-at', 'ms-slash']) assert.equal((await auth(`Bearer ${tok}`)).status, 403, tok);
    assert.equal(isEmailAllowed(`a@evil.com@${DOMAIN}`, { emails: [], domains: [DOMAIN] }), false);
  });
  test('nhà cung cấp khác microsoft.com → 403; thiếu email → 403', async () => {
    for (const tok of ['google-school', 'password-school', 'noprovider-school']) {
      const r = await auth(`Bearer ${tok}`);
      assert.deepEqual([r.ok, r.status], [false, 403], tok);
      assert.match(r.error, /Microsoft 365/);
    }
    assert.equal((await auth('Bearer ms-noemail')).status, 403);
    assert.equal((await auth('Bearer ms-blank')).status, 403);
  });
  test('CRON_SECRET → cron, SYNC_SECRET → webhook (không xác minh token); bí mật rỗng không khớp', async () => {
    calls.verify = 0;
    const env = { CRON_SECRET: 'cron-secret-123', SYNC_SECRET: 'sync-secret-456' };
    assert.deepEqual(await auth('Bearer cron-secret-123', env), { ok: true, trigger: 'cron' });
    assert.deepEqual(await auth('bearer   sync-secret-456  ', env), { ok: true, trigger: 'webhook' });
    assert.equal(calls.verify, 0);
    assert.equal((await auth('Bearer cron-secret-12', env)).status, 401);
    const empty = { CRON_SECRET: '', SYNC_SECRET: '   ' };
    for (const h of [undefined, '', 'Bearer ', 'Bearer    ']) assert.equal((await auth(h, empty)).status, 401);
    assert.equal(secretEquals('', ''), false);
    assert.equal(secretEquals('a', '  '), false);
    assert.equal(secretEquals('abc', 'abc'), true);
  });
  test('token sai → 401; lỗi cấu hình khi xác minh → ném ra (500)', async () => {
    assert.equal((await auth('Bearer token-sai')).status, 401);
    assert.equal((await auth('Basic abc')).status, 401);
    assert.equal((await authorize({ authorization: 'Bearer x', env: {} })).status, 401);
    const boom = Object.assign(new Error('Chưa cấu hình service account'), { expose: true });
    await assert.rejects(authorize({ authorization: 'Bearer x', env: {}, verifyIdToken: async () => { throw boom; } }), boom);
  });
  test('tiện ích', () => {
    assert.equal(bearerToken(['Bearer a', 'Bearer b']), 'a');
    assert.equal(bearerToken('Bearer a b'), '');
    assert.deepEqual(splitEmails('a@b.vn, x, C@D.VN'), ['a@b.vn', 'c@d.vn']);
    assert.deepEqual(splitDomains('@A.vn none localhost'), ['a.vn']);
    assert.deepEqual(envDomains({ ALLOWED_DOMAINS: ' NONE ' }), []);
    assert.deepEqual(envDomains({ ALLOWED_DOMAINS: '  @Truong.EDU.vn, other.vn ;bad other.vn' }), ['other.vn', 'truong.edu.vn']);
    assert.deepEqual(envAdmins({ ADMIN_EMAILS: 'B@x.vn a@x.vn,b@x.vn' }), ['a@x.vn', 'b@x.vn']);
  });
});

/* =====================================================================
 * Handler /api/sync
 * ===================================================================== */
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = b => { res.body = b ?? ''; res.ended = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}
const call = async (handler, { method = 'POST', url = '/api/sync', authorization } = {}) => {
  const res = mockRes();
  await handler({ method, url, headers: authorization ? { authorization } : {} }, res);
  return res;
};

describe('api/sync handler', () => {
  test('handler mặc định: thiếu xác thực → 401 mà không khởi tạo firebase-admin', async () => {
    const res = await call(defaultHandler, { method: 'GET' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-type'], /application\/json/);
    assert.match(res.json().error, /Microsoft 365/);
    assert.equal(getApps().length, 0);
  });
  test('phương thức khác GET/POST → 405', async () => {
    const res = await call(defaultHandler, { method: 'PUT' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, POST');
  });
  test('nạp được handler khi KHÔNG bật require(ESM) (như Vercel): node --no-experimental-require-module', () => {
    const out = execFileSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e',
      "const m = await import('./api/sync.js'); const s = await import('./server/sync.js'); console.log(typeof m.default, typeof s.runSync);"], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.trim(), 'function function');
  });

  const make = (over = {}) => {
    const t = { now: T0 };
    const store = memoryStore({ clock: () => t.now });
    const src = makeSource({ roles: [['partner@other.vn', 'BGH liên cấp', '', '', ''], ['bad', 'x', '', '', '']] });
    const logs = [];
    const env = { ...BASE_ENV, ROLES_SHEET_ID: SHEET_ROLES, CRON_SECRET: 'cron-xyz', SYNC_SECRET: 'sync-xyz', ADMIN_EMAILS: 'boss@x.vn', ...over.env };
    const users = { 'ms-ok': `gv@${DOMAIN}`, 'ms-hai': em('gv.hai'), 'ms-partner': 'partner@other.vn', 'ms-stranger': 'stranger@other.vn', 'ms-admin': 'boss@x.vn', 'ms-slash': `a/b@${DOMAIN}` };
    const handler = createHandler({
      env,
      getStore: () => store,
      makeFetchTable: () => src.fetchTable,
      verifyIdToken: async tok => {
        if (users[tok]) return { email: users[tok], firebase: { sign_in_provider: 'microsoft.com' } };
        if (tok === 'google-ok') return { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'google.com' } };
        throw new Error('bad token');
      },
      now: () => t.now,
      log: { error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
      ...over.deps,
    });
    return { t, store, src, handler, logs, env };
  };

  test('cron (GET) → 200 với các trường v2 và cảnh báo; không có debug/_internal', async () => {
    const { handler } = make();
    const res = await call(handler, { method: 'GET', authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    for (const k of ['ok', 'count', 'levels', 'scopes', 'scopesWritten', 'chunksWritten', 'accessCount', 'accessWritten', 'durationMs', 'syncedAtMs', 'trigger', 'warnings']) assert.ok(k in b, `thiếu ${k}`);
    assert.deepEqual([b.ok, b.count, b.trigger], [true, 18, 'cron']);
    assert.ok(b.syncedAtMs >= T0 && b.syncedAtMs < T0 + 10_000);
    assert.ok(b.warnings.some(w => /dòng 3/.test(w)));
    assert.ok(!('debug' in b) && !('_internal' in b));
  });
  test('người dùng có quyền → 200 + số liệu nhưng chỉ số cảnh báo; tài khoản chưa có quyền → kết quả tối thiểu; admin nhận đủ cảnh báo', async () => {
    const { handler, t, store } = make();
    const m = (await call(handler, { authorization: 'Bearer ms-ok' })).json();
    assert.deepEqual(Object.keys(m).sort(), ['durationMs', 'ok', 'syncedAtMs'], 'cùng tên miền nhưng chưa có v2_access: không có số phiếu / số tài khoản / cảnh báo');
    assert.equal((await store.get(PATHS.meta)).trigger, 'user');
    t.now += 61_000;
    const b = (await call(handler, { authorization: 'Bearer ms-hai' })).json();
    assert.deepEqual([b.ok, b.trigger, 'warnings' in b, b.warningCount > 0, b.count, b.added], [true, `user:${em('gv.hai')}`, false, true, 18, 0]);
    t.now += 61_000;
    const a = (await call(handler, { authorization: 'Bearer ms-admin' })).json();
    assert.ok(Array.isArray(a.warnings));
  });
  test('tên miền khác: có v2_access (sau đồng bộ) → 200; không có → 403; email có “/” → 403', async () => {
    const { handler, t } = make();
    assert.equal((await call(handler, { authorization: 'Bearer ms-partner' })).statusCode, 403, 'chưa đồng bộ lần nào → chưa có v2_access');
    await call(handler, { method: 'GET', authorization: 'Bearer cron-xyz' });
    t.now += 61_000;
    assert.equal((await call(handler, { authorization: 'Bearer ms-partner' })).statusCode, 200);
    assert.equal((await call(handler, { authorization: 'Bearer ms-stranger' })).statusCode, 403);
    assert.equal((await call(handler, { authorization: 'Bearer ms-slash' })).statusCode, 403);
  });
  test('bấm lại ngay → skipped recent; ?force=1 chỉ có tác dụng với cron', async () => {
    const { handler, t } = make();
    await call(handler, { authorization: 'Bearer ms-hai' });
    t.now += 10_000;
    const r2 = await call(handler, { authorization: 'Bearer ms-hai' });
    assert.deepEqual([r2.statusCode, r2.json().skipped], [200, 'recent']);
    t.now += 61_000;
    assert.equal((await call(handler, { url: '/api/sync?force=1', authorization: 'Bearer ms-hai' })).json().scopesWritten, 0);
    assert.equal((await call(handler, { url: '/api/sync?force=1', authorization: 'Bearer sync-xyz' })).json().scopesWritten, 0);
    const r5 = (await call(handler, { method: 'GET', url: '/api/sync?force=1', authorization: 'Bearer cron-xyz' })).json();
    assert.equal(r5.scopesWritten, r5.scopes);
  });
  test('gọi lại < 60 s sau lượt thất bại → 429 kèm Retry-After', async () => {
    const { handler, src, t } = make();
    src.fail[SHEET_TIH] = src.fail[SHEET_THCS] = Object.assign(new Error('Không có quyền đọc Google Sheet.'), { expose: true });
    assert.equal((await call(handler, { authorization: 'Bearer ms-ok' })).statusCode, 500);
    t.now += 10_000;
    const res = await call(handler, { authorization: 'Bearer ms-ok' });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '50');
    assert.match(res.json().error, /thử lại sau 50 giây/);
  });
  test('google.com → 403; token sai → 401; đang bị khóa → 409', async () => {
    const { handler, store, t } = make();
    assert.equal((await call(handler, { authorization: 'Bearer google-ok' })).statusCode, 403);
    assert.equal((await call(handler, { authorization: 'Bearer sai' })).statusCode, 401);
    store.docs.set(PATHS.lock, { until: t.now + 20_000, token: 'khac' });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /đồng bộ khác/);
  });
  test('lỗi bất ngờ → 500 không lộ bí mật/chi tiết nội bộ (kể cả trong cảnh báo)', async () => {
    const { handler, src, logs } = make();
    src.fail[SHEET_TIH] = src.fail[SHEET_THCS] = new Error('connect ECONNREFUSED secret=cron-xyz private_key=...');
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.ok(!/cron-xyz|private_key|ECONNREFUSED/.test(res.body));
    assert.ok(logs.length > 0);
    // chỉ một cấp lỗi lạ → đồng bộ thành công, cảnh báo không chép thông điệp lỗi lạ
    const m2 = make();
    await call(m2.handler, { method: 'GET', authorization: 'Bearer cron-xyz' });
    m2.src.fail[SHEET_THCS] = new Error('connect ECONNREFUSED secret=cron-xyz');
    const ok = await call(m2.handler, { method: 'GET', authorization: 'Bearer cron-xyz' });
    assert.equal(ok.statusCode, 200);
    assert.ok(!/ECONNREFUSED|cron-xyz/.test(ok.body));
    assert.ok(m2.logs.some(a => String(a[1]?.message || '').includes('ECONNREFUSED')), 'chi tiết chỉ ở log máy chủ');
  });
  test('không nạp được module máy chủ → 500 JSON nêu nguyên nhân; lần sau thử nạp lại', async () => {
    let calls = 0;
    const handler = createHandler({
      env: { ...BASE_ENV, CRON_SECRET: 'cron-xyz' },
      loadModules: async () => { calls++; throw Object.assign(new Error("Cannot find package 'firebase-admin'"), { code: 'ERR_MODULE_NOT_FOUND', moduleLoad: true }); },
      log: silentLog,
    });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /không nạp được thư viện.*ERR_MODULE_NOT_FOUND/);
    await call(handler, {});
    assert.equal(calls, 2);
  });
  test('chưa cấu hình Sheet nào → 500 hướng dẫn; thiếu service account → 500 rõ ràng', async () => {
    const { handler } = make({ env: { SHEET_ID_TIH: '', SHEET_ID_THCS: '' } });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /SHEET_ID_TIH/);
    const { handler: h2 } = make({ deps: { verifyIdToken: async () => { throw Object.assign(new Error('Chưa cấu hình service account Firebase'), { expose: true }); } } });
    const r2 = await call(h2, { authorization: 'Bearer ms-ok' });
    assert.equal(r2.statusCode, 500);
    assert.match(r2.json().error, /service account/);
  });
});

/* =====================================================================
 * server/sheet.js
 * ===================================================================== */
describe('sheet.js – gviz', () => {
  const wrap = obj => `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(obj)});`;
  const okBody = wrap({ version: '0.6', status: 'ok', table: { cols: [{ id: 'A', label: 'x', type: 'string' }], rows: [{ c: [{ v: 'a);b' }] }] } });
  const resp = (body, status = 200, type = 'application/javascript; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });
  const isApi = url => String(url).startsWith('https://sheets.googleapis.com/');
  const apiDisabled = () => new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Sheets API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }), { status: 403, headers: { 'content-type': 'application/json' } });

  test('đọc tab theo TÊN (sheet=…) hoặc gid', async () => {
    assert.match(gvizUrl('SID', { sheet: 'DS Nhân sự' }), /\/d\/SID\/gviz\/tq\?sheet=DS%20Nh%C3%A2n%20s%E1%BB%B1&headers=1&tqx=out:json$/);
    assert.match(gvizUrl('SID', { gid: '12' }), /\?gid=12&headers=1/);
    assert.match(gvizUrl('SID', '123'), /\?gid=123&headers=1/);
    assert.match(gvizUrl('SID', { sheet: 'A' }, 'limit 0'), /&tqx=out:json&tq=limit%200$/);
    const seen = [];
    const t = await fetchGvizTable('SID', { sheet: FORM_TAB }, { fetchImpl: async (url, init) => { seen.push([url, init.headers]); return resp(okBody); } });
    assert.equal(t.rows[0].c[0].v, 'a);b');
    assert.equal(seen[0][0], gvizUrl('SID', { sheet: FORM_TAB }));
    assert.equal(seen[0][1].Authorization, undefined);
  });
  test('lỗi: status error, trang đăng nhập, 404, lỗi mạng – thông báo nêu tên tab', async () => {
    const err = wrap({ status: 'error', errors: [{ detailed_message: 'Invalid query' }] });
    await assert.rejects(fetchGvizTable('SID', { sheet: 'X' }, { fetchImpl: async () => resp(err) }), e => e.expose && /tab “X”.*Invalid query/.test(e.message));
    await assert.rejects(fetchGvizTable('SID', { sheet: 'X' }, { fetchImpl: async () => resp('<html>Sign in</html>', 200, 'text/html') }), e => e.code === 'SHEET_NOT_SHARED' && /tab “X”/.test(e.message));
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => resp('', 404, 'text/html') }), e => e.code === 'SHEET_NOT_FOUND');
    await assert.rejects(fetchGvizTable('', '1', { fetchImpl: async () => resp(okBody) }), e => e.code === 'CONFIG_SHEET_ID');
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), e => e.code === 'SHEET_NETWORK');
    assert.throws(() => parseGvizBody('<!doctype html>'), e => e.code === 'SHEET_NOT_SHARED');
  });
  test('service account: Bearer token; lỗi token → đọc công khai và ghi nhớ', async () => {
    const sa = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k' };
    const auths = [];
    const fetchImpl = async (url, init) => { if (isApi(url)) return apiDisabled(); auths.push(init.headers.Authorization); return resp(okBody); };
    const f1 = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl, getToken: async () => 'tok123' });
    await f1({ sheet: 'A' });
    assert.deepEqual(auths, ['Bearer tok123'], 'Sheets API chưa bật → gviz bằng token');
    assert.ok([...f1.warnings].some(w => /Sheets API chưa được bật/.test(w) && /BỘ LỌC/.test(w)));
    auths.length = 0;
    const f2 = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl, getToken: async () => { throw new Error('no token'); } });
    await f2({ sheet: 'A' });
    await f2({ sheet: 'B' });
    assert.deepEqual(auths, [undefined, undefined]);
  });
  test('makeMultiSheetFetcher: một token dùng chung nhiều Sheet; mỗi Sheet nhớ cách đọc riêng; isPublic theo Sheet', async () => {
    const sa = { client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' };
    let tokens = 0;
    const seen = [];
    let apiCalls = 0;
    const fetchImpl = async (url, init) => {
      if (isApi(url)) { apiCalls++; return apiDisabled(); }
      seen.push([url.match(/\/d\/([^/]+)\//)[1], init.headers.Authorization || '-']);
      if (url.includes('/d/PRIV/') && !init.headers.Authorization) return resp('<html>login</html>', 200, 'text/html');
      if (url.includes('/d/PUB/') && init.headers.Authorization) return resp('<html>login</html>', 200, 'text/html'); // Sheet chưa chia sẻ cho SA nhưng công khai
      return resp(okBody);
    };
    const f = makeMultiSheetFetcher({ serviceAccount: sa, fetchImpl, getToken: async () => { tokens++; return 'tok'; } });
    await f('PRIV', { sheet: 'A' });
    await f('PUB', { sheet: 'A' });
    await f('PRIV', { sheet: 'B' });
    await f('PUB', { sheet: 'B' });
    assert.equal(tokens, 1, 'token lấy một lần');
    assert.equal(apiCalls, 2, 'Sheets API chưa bật là thiết lập chung của dự án → chỉ thử MỘT lần (2 yêu cầu song song: giá trị gốc + hiển thị) cho mọi Sheet');
    assert.deepEqual(seen.filter(([s]) => s === 'PUB').map(x => x[1]), ['Bearer tok', '-', '-'], 'Sheet PUB chuyển sang đọc công khai và ghi nhớ');
    assert.equal(await f.isPublic('PRIV', { sheet: 'A' }), false);
    assert.equal(await f.isPublic('PUB', { sheet: 'A' }), true);
    assert.equal(await makeMultiSheetFetcher({ fetchImpl: async () => { throw new Error('không gọi'); } }).isPublic('X', { sheet: 'A' }), true, 'không có service account → coi như công khai');
  });
  test('Sheet riêng tư mà service account chưa được chia sẻ → lỗi nêu email service account', async () => {
    const sa = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k' };
    const f = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl: async () => resp('<html>login</html>', 200, 'text/html'), getToken: async () => 'tok' });
    await assert.rejects(f({ sheet: 'A' }), e => e.code === 'SHEET_NOT_SHARED' && e.message.includes(sa.client_email));
  });
});

/* =====================================================================
 * server/firebase.js – đọc service account
 * ===================================================================== */
describe('firebase.js – getServiceAccount', () => {
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----\n';
  const json = { type: 'service_account', project_id: 'dugiotih', client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: KEY };
  test('chưa cấu hình → null', () => assert.equal(getServiceAccount({}), null));
  test('JSON thô và base64', () => {
    const a = getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(json) });
    assert.deepEqual(a, { project_id: 'dugiotih', client_email: json.client_email, private_key: KEY.trim() });
    assert.deepEqual(getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(json)).toString('base64') }), a);
  });
  test('ba biến rời, private key có \\n dạng chữ và dấu ngoặc kép', () => {
    const a = getServiceAccount({ FIREBASE_PROJECT_ID: 'dugiotih', FIREBASE_CLIENT_EMAIL: json.client_email, FIREBASE_PRIVATE_KEY: `"${KEY.replace(/\n/g, '\\n')}"` });
    assert.equal(a.private_key, KEY);
  });
  test('JSON sai / thiếu trường / key sai định dạng → lỗi expose', () => {
    assert.throws(() => getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: 'không-phải-json' }), e => e.expose && e.code === 'CONFIG_FIREBASE');
    assert.throws(() => getServiceAccount({ FIREBASE_CLIENT_EMAIL: 'a@b.c' }), e => e.expose && /thiếu/.test(e.message));
    assert.throws(() => getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...json, private_key: 'abc' }) }), e => e.expose && /PEM/.test(e.message));
  });
});

describe('memoryStore', () => {
  test('lô > 500 bị từ chối; serverTimestamp; undefined → lỗi, lô không áp dụng một phần; đường dẫn lồng nhau', async () => {
    const s = memoryStore({ clock: () => 1000 });
    await assert.rejects(s.commitBatch(Array.from({ length: 501 }, (_, i) => ({ type: 'set', path: `a/${i}`, data: {} }))), /500/);
    await s.commitBatch([{ type: 'set', path: 'a/b', data: { t: s.serverTimestamp(), n: null } }, { type: 'set', path: 'a/b/chunks/c000', data: { x: 1 } }]);
    assert.deepEqual(await s.get('a/b'), { t: new Date(1000), n: null });
    assert.deepEqual(await s.listIds('a'), ['b']);
    assert.deepEqual(await s.listIds('a/b/chunks'), ['c000']);
    await assert.rejects(s.commitBatch([{ type: 'set', path: 'a/c', data: { x: 1 } }, { type: 'set', path: 'a/d', data: { y: { z: undefined } } }]), /undefined.*y\.z/);
    assert.deepEqual(await s.listIds('a'), ['b']);
  });
  test('khóa ở lockPath (mặc định v2_config/lock)', async () => {
    const s = memoryStore();
    assert.ok(await s.acquireLock(1, 10));
    assert.equal((await s.get('v2_config/lock')).until, 11);
    const s2 = memoryStore({ lockPath: 'x/lock' });
    await s2.acquireLock(1, 10);
    assert.ok(await s2.get('x/lock'));
  });
});

/* =====================================================================
 * firestoreStore() với một Firestore giả lập (cùng API firebase-admin dùng tới)
 * ===================================================================== */
function fakeFirestore() {
  const docs = new Map();
  const commits = [];
  const write = (p, data, opts) => { docs.set(p, opts?.merge && docs.has(p) ? { ...docs.get(p), ...data } : data); };
  const doc = p => ({
    path: p, id: p.split('/').pop(),
    async get() { const d = docs.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }) }; },
  });
  return {
    docs, commits, doc,
    collection: name => ({
      async listDocuments() {
        const depth = name.split('/').length + 1;
        return [...docs.keys()].filter(p => p.startsWith(name + '/') && p.split('/').length === depth).map(doc);
      },
    }),
    batch() {
      const ops = [];
      return {
        set: (ref, data, opts) => { ops.push(() => write(ref.path, data, opts)); },
        delete: ref => { ops.push(() => docs.delete(ref.path)); },
        async commit() {
          if (ops.length > 500) throw new Error('INVALID_ARGUMENT: maximum 500 writes allowed per request');
          ops.forEach(f => f());
          commits.push(ops.length);
        },
      };
    },
    async runTransaction(fn) {
      const ops = [];
      const tx = { get: ref => ref.get(), set: (ref, data, opts) => { ops.push(() => write(ref.path, data, opts)); } };
      const out = await fn(tx);
      ops.forEach(f => f());
      return out;
    },
  };
}

describe('firestoreStore (Firestore giả lập)', () => {
  test('đồng bộ đầy đủ, lũy đẳng, khóa bằng transaction ở v2_config/lock', async () => {
    const db = fakeFirestore();
    const store = firestoreStore(db);
    const src = makeSource({ tihN: 450 });
    let now = T0;
    const run = (trigger = 'cron') => runSync({ store, fetchTable: src.fetchTable, env: BASE_ENV, trigger, nowMs: () => now, log: silentLog });
    const r1 = await run();
    assert.deepEqual([r1.ok, r1.levels.tih.count], [true, 450]);
    assert.ok(db.docs.get('v2_meta/global').version === 2);
    assert.deepEqual(db.docs.get('v2_scopes/L_tih').chunkIds, ['c000']);
    assert.ok(db.docs.get('v2_scopes/L_tih/chunks/c000').data.length > 1000);
    assert.ok(db.commits.every(n => n <= WRITE_BATCH));
    assert.equal(db.docs.get('v2_config/lock').until, 0);
    assert.ok(![...db.docs.keys()].some(p => !p.startsWith('v2_')));

    db.commits.length = 0;
    now += 1000;
    const r2 = await run();
    assert.deepEqual([r2.scopesWritten, r2.chunksWritten, r2.accessWritten], [0, 0, 0]);
    assert.deepEqual(db.commits, [1, 1], 'chỉ meta + trạng thái');

    db.docs.set('v2_config/lock', { until: now + 10_000, token: 'khac', acquiredAt: now, pendingAt: 0 });
    assert.deepEqual([(await run('webhook')).skipped], ['locked']);
    assert.equal(db.docs.get('v2_config/lock').pendingAt, now);
    now += 20_000;
    db.docs.set('v2_config/lock', { until: 0, token: null });
    assert.equal((await run(`user:gv@${DOMAIN}`)).skipped, 'recent');
    assert.ok(typeof FieldValue.serverTimestamp === 'function');
    // listIds cho collection con
    assert.deepEqual(await store.listIds('v2_scopes/L_tih/chunks'), ['c000']);
  });
});
