// Kiểm thử offline (node:test) cho đồng bộ Sheet → kho, xác thực /api/sync, đọc gviz và cấu hình Firebase.
// Dùng dữ liệu gviz tổng hợp + kho trong bộ nhớ – không cần mạng, Firebase hay Firestore emulator.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getApps } from 'firebase-admin/app';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { SCHEMA_VERSION, hash53, tsToInstant, parseStaffTable, LEVELS, hydrate, gradeOf as sharedGradeOf } from '../lib/shared.js';
import { runSync, firestoreStore, readSyncConfig, buildAccess, gradeOf, PATHS, CHUNK_OPTS, LOCK_TTL_MS } from '../server/sync.js';
import {
  authorize, secretEquals, bearerToken, envDomains, accessFromSheetMode, isEmailAllowed, splitEmails, splitDomains,
} from '../server/auth.js';
import { memoryStore } from '../server/memory-store.js';
import { parseGvizBody, fetchGvizTable, makeSheetFetcher, gvizUrl } from '../server/sheet.js';
import { getServiceAccount } from '../server/firebase.js';
import defaultHandler, { createHandler } from '../api/sync.js';

/* =====================================================================
 * Dữ liệu gviz tổng hợp
 * ===================================================================== */
const FORM_GID = '948197065';
const STAFF_GID = '979319376';
const SHEET_ID = 'TEST_SHEET_ID';
const DOMAIN = 'hoangmaistarschool.edu.vn';
const T0 = Date.UTC(2026, 9, 6, 1, 0, 0); // 06/10/2026 08:00 (+07)

const FORM_COLS = [
  ['A', 'Dấu thời gian', 'datetime'],
  ['B', 'Người dự giờ thuộc tổ', 'string'],
  ['C', 'Họ và tên người dự giờ', 'string'],
  ['D', 'Giáo viên dạy thuộc tổ', 'string'],
  ['E', 'Họ và tên giáo viên dạy', 'string'],
  ['F', 'Ngày dạy', 'date'],
  ['G', 'Tên bài dạy', 'string'],
  ['H', 'Tiết dạy', 'string'],
  ['I', 'Môn dạy', 'string'],
  ['J', 'Lớp dạy', 'string'],
  ['K', '1.1. Xác định rõ ràng mục tiêu bài học', 'number'],
  ['L', '2.1. Nội dung chính xác, logic', 'number'],
  ['M', '5.1. Học sinh đạt yêu cầu bài học', 'number'],
  ['N', 'Ưu điểm', 'string'],
  ['O', 'Tồn tại cần khắc phục', 'string'],
].map(([id, label, type]) => ({ id, label, type, pattern: '' }));
const p2 = n => String(n).padStart(2, '0');

// Dòng thứ i: thời điểm gửi tăng dần theo phút (sắp xếp ổn định), nội dung đủ khác nhau.
function formRow(i, over = {}) {
  const d = new Date(Date.UTC(2026, 8, 1, 7, 0, 0) + i * 60_000); // giờ “treo tường” của Sheet
  const [y, m, dd, h, mi] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
  const ts = { v: `Date(${y},${m},${dd},${h},${mi},0)`, f: `${p2(dd)}/${p2(m + 1)}/${y} ${p2(h)}:${p2(mi)}:00` };
  const day = { v: `Date(${y},${m},${dd})`, f: `${p2(dd)}/${p2(m + 1)}/${y}` };
  const sc = over.sc || [1 + (i % 5), 4, 5];
  const v = {
    og: i % 5 === 0 ? 'Ban Giám hiệu' : `Tổ ${1 + (i % 5)}`, on: `Người dự ${i % 7}`,
    tg: `Tổ ${1 + (i % 4)}`, tn: `Giáo viên ${i % 37}`, lesson: `Bài ${i}`, period: String(1 + (i % 6)),
    subject: i % 2 ? 'Toán' : 'Tiếng Việt', cls: `${1 + (i % 5)}A${i % 3}`, pros: `Ưu điểm ${i}`, cons: `Cần khắc phục ${i}`,
    ...over,
  };
  const s = x => ({ v: x });
  const n = x => (x == null ? null : { v: x, f: String(x) });
  return { c: [ts, s(v.og), s(v.on), s(v.tg), s(v.tn), day, s(v.lesson), s(v.period), s(v.subject), s(v.cls), n(sc[0]), n(sc[1]), n(sc[2]), s(v.pros), s(v.cons)] };
}
const formTable = n => ({ cols: structuredClone(FORM_COLS), rows: Array.from({ length: n }, (_, i) => formRow(i)), parsedNumHeaders: 1 });

const STAFF_COLS = [
  ['A', 'Mã nhân sự', 'number'], ['B', 'Họ và tên Nhân sự', 'string'], ['C', 'Cấp', 'string'], ['D', 'Tổ/Bộ phận', 'string'],
  ['E', 'Chức danh', 'string'], ['F', 'Email', 'string'], ['G', 'Ghi chú', 'string'],
].map(([id, label, type]) => ({ id, label, type, pattern: '' }));
const STAFF_ROWS = [
  [1, 'Nguyễn Văn An', 'Tiểu học', 'Ban Lãnh đạo', 'Hiệu trưởng', `HieuTruong@HoangMaiStarSchool.edu.vn`, null],
  [2, 'Trần Thị Bình', 'Tiểu học', 'Ban Giám hiệu Tiểu học', 'Phó Hiệu trưởng', `pht@${DOMAIN}`, null],
  [3, 'Lê Văn Cường', 'THCS', 'Ban Giám hiệu THCS', 'Phó Hiệu trưởng', ` PHT@${DOMAIN} `, null], // trùng email
  [4, 'Phạm Thị Dung', 'Tiểu học', 'Ban Giám hiệu', 'Phó Hiệu trưởng (cũ)', `old@${DOMAIN}`, 'Nghỉ việc từ 6/9/2025'],
  [5, 'Hoàng Văn Em', 'Tiểu học', 'Tổ 1', 'GVCN 1A1', `gv.em@${DOMAIN}`, null],
  [6, 'Đỗ Thị Phương', 'Tiểu học', 'Tổ 2', 'Giáo viên', `GV.Phuong@${DOMAIN}`, null],
  [7, 'Vũ Văn Giang', 'Tiểu học', 'Tổ 3', 'Giáo viên', '', null],
  [8, 'Bùi Thị Hà', 'Tiểu học', 'Ban Giám hiệu', 'Phó Hiệu trưởng', '', null], // BGH chưa có email
].map(r => ({ c: r.map((x, i) => (x == null ? null : i === 0 ? { v: x, f: String(x) } : { v: x })) }));
const staffTable = () => ({ cols: structuredClone(STAFF_COLS), rows: structuredClone(STAFF_ROWS), parsedNumHeaders: 1 });
const BGH_EMAILS = [`hieutruong@${DOMAIN}`, `pht@${DOMAIN}`];
const ALL_EMAILS = [`gv.em@${DOMAIN}`, `gv.phuong@${DOMAIN}`, `hieutruong@${DOMAIN}`, `pht@${DOMAIN}`];

// Nguồn Sheet giả lập: chỉnh src.form / src.staff giữa các lượt để mô phỏng thay đổi trên Sheet.
function makeSource(n = 12) {
  const src = { form: formTable(n), staff: staffTable(), calls: [], failStaff: false, failForm: null, gate: null };
  src.fetchTable = async gid => {
    gid = String(gid);
    src.calls.push(gid);
    if (gid === FORM_GID) {
      if (src.gate) await src.gate;
      if (src.failForm) throw src.failForm;
      return structuredClone(src.form);
    }
    if (gid === STAFF_GID) {
      if (src.failStaff) throw new Error('Không kết nối được');
      return structuredClone(src.staff);
    }
    throw new Error(`gid lạ ${gid}`);
  };
  return src;
}

// Môi trường kiểm thử: đồng hồ điều khiển được + kho bộ nhớ + nguồn Sheet.
function setup({ n = 12, env = {}, initial } = {}) {
  const t = { now: T0 };
  const clock = () => t.now;
  const store = memoryStore({ clock, initial });
  const src = makeSource(n);
  const baseEnv = { SHEET_ID, ...env };
  const sync = (opts = {}) => runSync({ store, fetchTable: src.fetchTable, env: opts.env || baseEnv, trigger: opts.trigger || 'cron', nowMs: clock, force: !!opts.force });
  return { t, clock, store, src, env: baseEnv, sync };
}
const paths = store => store.writtenPaths();
const pathsUnder = (store, prefix) => paths(store).filter(p => p.split(':')[1].startsWith(prefix));
async function chunkRecords(store) {
  const meta = await store.get(PATHS.meta);
  const out = [];
  for (const id of meta.chunkIds) out.push(...JSON.parse((await store.get(`${PATHS.chunks}/${id}`)).data));
  return out;
}

/* =====================================================================
 * runSync
 * ===================================================================== */
describe('runSync – lần đồng bộ đầu tiên', () => {
  test('ghi meta, staff, chunk, phieu, access, syncState đúng cấu trúc', async () => {
    const { store, sync, t } = setup({ n: 12 });
    const r = await sync();
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
    assert.deepEqual([r.count, r.added, r.updated, r.removed, r.chunksWritten], [12, 12, 0, 0, 1]);
    assert.equal(r.staffChanged, true);
    assert.equal(r.accessChanged, true);
    assert.equal(r.trigger, 'cron');
    assert.equal(r.syncedAtMs, t.now);
    assert.equal(typeof r.durationMs, 'number');

    const meta = await store.get(PATHS.meta);
    assert.equal(meta.version, SCHEMA_VERSION);
    assert.ok(meta.syncedAt instanceof Date, 'syncedAt là serverTimestamp');
    assert.equal(meta.syncedAtMs, t.now);
    assert.equal(meta.count, 12);
    assert.deepEqual(meta.chunkIds, ['c000']);
    assert.deepEqual(meta.crit.map(k => [k.code, k.d]), [['1.1', 1], ['2.1', 2], ['5.1', 5]]);
    assert.equal(meta.crit[0].full, 'Xác định rõ ràng mục tiêu bài học');
    assert.equal(meta.staffCount, 3 + 4); // 3 giáo viên + 4 BGH đang làm việc
    assert.equal(meta.trigger, 'cron');
    assert.equal(meta.sheetUrl, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${FORM_GID}`);
    assert.equal(typeof meta.durationMs, 'number');

    const staff = await store.get(PATHS.staff);
    assert.deepEqual(Object.keys(staff).sort(), ['bgh', 'teach']);
    assert.ok(!JSON.stringify(staff).includes('@'), 'dashboard/staff không được chứa email');
    assert.deepEqual(staff.teach[0], { name: 'Hoàng Văn Em', group: 'Tổ 1', role: 'GVCN 1A1' });
    assert.deepEqual(staff.bgh.map(b => Object.keys(b).sort()), Array(4).fill(['name', 'role']));
    assert.ok(!staff.bgh.some(b => b.name === 'Phạm Thị Dung'), 'nhân sự đã nghỉ việc bị loại');

    const c = await store.get(`${PATHS.chunks}/c000`);
    assert.deepEqual(Object.keys(c).sort(), ['data', 'hash', 'i', 'n']);
    assert.equal(c.i, 0);
    assert.equal(c.n, 12);
    assert.equal(c.hash, hash53(c.data));
    const recs = JSON.parse(c.data);
    assert.equal(recs.length, 12);
    assert.deepEqual(recs.map(x => x.ts), [...recs.map(x => x.ts)].sort(), 'bản ghi sắp theo thời gian gửi');

    const access = await store.get(PATHS.access);
    assert.deepEqual(access.emails, BGH_EMAILS);
    assert.deepEqual(access.domains, [DOMAIN]);
    assert.ok(access.updatedAt instanceof Date);

    const st = await store.get(PATHS.state);
    assert.equal(typeof st.phieuHashes, 'string');
    assert.equal(Object.keys(JSON.parse(st.phieuHashes)).length, 12);
    assert.deepEqual(Object.keys(JSON.parse(st.chunkHashes)), ['c000']);
    assert.ok(st.staffHash && st.accessHash);
    assert.equal(st.lastRunMs, t.now);
    assert.equal(st.lastTrigger, 'cron');
    assert.equal(st.lastResult.count, 12);

    const lock = await store.get(PATHS.lock);
    assert.equal(lock.until, 0, 'khóa được nhả sau khi xong');
  });

  test('tài liệu phieu/{id} đúng các trường hợp đồng', async () => {
    const { store, sync } = setup({ n: 3 });
    await sync();
    const recs = await chunkRecords(store);
    const r = recs[1]; // dòng i = 1
    const p = await store.get(`${PATHS.phieu}/${r.id}`);
    assert.deepEqual(Object.keys(p).sort(), [
      'canKhacPhuc', 'capNhatLuc', 'diem', 'diemTB', 'diemToiDa', 'giaoVien', 'khoi', 'lop', 'mon', 'ngayDay', 'ngayGui',
      'nguoiDu', 'tenBai', 'thoiGianGui', 'tiet', 'toGiaoVien', 'toNguoiDu', 'tongDiem', 'uuDiem', 'xepLoai',
    ]);
    assert.ok(p.thoiGianGui instanceof Date);
    assert.equal(p.thoiGianGui.getTime(), tsToInstant(r.ts).getTime());
    assert.equal(p.thoiGianGui.toISOString(), '2026-09-01T00:01:00.000Z'); // 07:01 giờ VN
    assert.equal(p.ngayGui, '2026-09-01 07:01:00');
    assert.equal(p.ngayDay, '2026-09-01');
    assert.deepEqual([p.toNguoiDu, p.nguoiDu, p.toGiaoVien, p.giaoVien], ['Tổ 2', 'Người dự 1', 'Tổ 2', 'Giáo viên 1']);
    assert.deepEqual([p.tenBai, p.tiet, p.mon, p.lop, p.khoi], ['Bài 1', '2', 'Toán', '2A1', 'Khối 2']);
    assert.deepEqual(p.diem, { '1.1': 2, '2.1': 4, '5.1': 5 });
    assert.equal(p.tongDiem, 11);
    assert.equal(p.diemToiDa, 15);
    assert.equal(p.diemTB, 3.67);
    assert.equal(p.xepLoai, 'Khá');
    assert.ok(LEVELS.some(l => l.name === p.xepLoai));
    assert.deepEqual([p.uuDiem, p.canKhacPhuc], ['Ưu điểm 1', 'Cần khắc phục 1']);
    assert.ok(p.capNhatLuc instanceof Date);
    // Ban Giám hiệu được chuẩn hóa tên tổ
    assert.equal((await store.get(`${PATHS.phieu}/${recs[0].id}`)).toNguoiDu, 'Ban Giám Hiệu');
  });

  test('dashboard/* + dashboard_chunks/* trong MỘT lô nguyên tử; phieu theo lô ≤ 400', async () => {
    const { store, sync } = setup({ n: 1001 });
    const r = await sync();
    assert.equal(r.count, 1001);
    const meta = await store.get(PATHS.meta);
    assert.deepEqual(meta.chunkIds, ['c000', 'c001', 'c002']);
    const dashCommits = store.log.filter(e => e.ops.some(o => /^dashboard(\/|_chunks\/)/.test(o.path)));
    assert.equal(dashCommits.length, 1, 'mọi thao tác dashboard nằm trong 1 lô');
    assert.equal(dashCommits[0].kind, 'batch');
    assert.deepEqual(dashCommits[0].ops.map(o => o.path).sort(), [
      'config/access', 'dashboard/meta', 'dashboard/staff', 'dashboard_chunks/c000', 'dashboard_chunks/c001', 'dashboard_chunks/c002',
    ]);
    const phieuCommits = store.log.filter(e => e.ops.some(o => o.path.startsWith('phieu/')));
    assert.deepEqual(phieuCommits.map(e => e.ops.length), [400, 400, 201]);
    assert.ok(phieuCommits.every(e => e.ops.every(o => o.path.startsWith('phieu/'))));
    // Mỗi khối ≤ 500 phiếu và đủ nhỏ cho giới hạn 1 MiB của Firestore
    for (const id of meta.chunkIds) {
      const c = await store.get(`${PATHS.chunks}/${id}`);
      assert.ok(c.n <= CHUNK_OPTS.maxRecords);
      assert.ok(Buffer.byteLength(c.data, 'utf8') < 1_000_000);
    }
  });
});

describe('runSync – đồng bộ tăng dần', () => {
  test('không có thay đổi → chỉ ghi lại meta và syncState', async () => {
    const { store, sync, t } = setup({ n: 12 });
    await sync();
    store.clearLog();
    t.now += 5_000;
    const r = await sync();
    assert.deepEqual([r.count, r.added, r.updated, r.removed, r.chunksWritten], [12, 0, 0, 0, 0]);
    assert.equal(r.staffChanged, false);
    assert.equal(r.accessChanged, false);
    assert.deepEqual(paths(store), ['set:dashboard/meta', 'set:config/syncState']);
    assert.equal((await store.get(PATHS.meta)).syncedAtMs, t.now);
  });

  test('sửa ưu điểm của một phiếu → cập nhật đúng phiếu đó và khối chứa nó', async () => {
    const { store, src, sync } = setup({ n: 12 });
    await sync();
    const before = await chunkRecords(store);
    src.form.rows[3].c[13] = { v: 'Ưu điểm đã sửa' };
    store.clearLog();
    const r = await sync();
    assert.deepEqual([r.count, r.added, r.updated, r.removed, r.chunksWritten], [12, 0, 1, 0, 1]);
    const id = before[3].id;
    assert.equal((await store.get(`${PATHS.phieu}/${id}`)).uuDiem, 'Ưu điểm đã sửa');
    assert.deepEqual(pathsUnder(store, 'phieu/'), [`set:phieu/${id}`]);
    assert.ok(paths(store).includes('set:dashboard_chunks/c000'));
    assert.equal((await chunkRecords(store))[3].pros, 'Ưu điểm đã sửa');
  });

  test('sửa điểm → mã phiếu đổi: xóa phiếu cũ, thêm phiếu mới', async () => {
    const { store, src, sync } = setup({ n: 12 });
    await sync();
    const oldId = (await chunkRecords(store))[4].id;
    src.form.rows[4].c[10] = { v: 2, f: '2' }; // trước đó là 5
    const r = await sync();
    assert.deepEqual([r.count, r.added, r.updated, r.removed], [12, 1, 0, 1]);
    assert.equal(await store.get(`${PATHS.phieu}/${oldId}`), null);
    const newRec = (await chunkRecords(store))[4];
    assert.notEqual(newRec.id, oldId);
    assert.equal((await store.get(`${PATHS.phieu}/${newRec.id}`)).diem['1.1'], 2);
  });

  test('xóa dòng trên Sheet → xóa phieu/{id} tương ứng', async () => {
    const { store, src, sync } = setup({ n: 12 });
    await sync();
    const gone = (await chunkRecords(store))[5].id;
    src.form.rows.splice(5, 1);
    store.clearLog();
    const r = await sync();
    assert.deepEqual([r.count, r.added, r.updated, r.removed, r.chunksWritten], [11, 0, 0, 1, 1]);
    assert.equal(await store.get(`${PATHS.phieu}/${gone}`), null);
    assert.deepEqual(pathsUnder(store, 'phieu/'), [`delete:phieu/${gone}`]);
    assert.equal((await store.listIds(PATHS.phieu)).length, 11);
    assert.equal((await store.get(PATHS.meta)).count, 11);
  });

  test('thêm dòng cuối → chỉ ghi lại khối cuối cùng', async () => {
    const { store, src, sync } = setup({ n: 600 });
    await sync();
    assert.deepEqual((await store.get(PATHS.meta)).chunkIds, ['c000', 'c001']);
    src.form.rows.push(formRow(600));
    store.clearLog();
    const r = await sync();
    assert.deepEqual([r.count, r.added, r.updated, r.removed, r.chunksWritten], [601, 1, 0, 0, 1]);
    const dash = pathsUnder(store, 'dashboard');
    assert.deepEqual(dash.sort(), ['set:dashboard/meta', 'set:dashboard_chunks/c001']);
    assert.equal((await store.get(`${PATHS.chunks}/c001`)).n, 101);
    assert.equal(pathsUnder(store, 'phieu/').length, 1);
  });

  test('số khối giảm → xóa khối thừa', async () => {
    const { store, src, sync } = setup({ n: 600 });
    await sync();
    src.form.rows.length = 450;
    const r = await sync();
    assert.equal(r.removed, 150);
    assert.equal(r.chunksDeleted, 1);
    assert.deepEqual(await store.listIds(PATHS.chunks), ['c000']);
    assert.deepEqual((await store.get(PATHS.meta)).chunkIds, ['c000']);
  });

  test('dòng trùng lặp → mã phiếu riêng (…-2) và được lưu đủ', async () => {
    const { store, src, sync } = setup({ n: 12 });
    src.form.rows.splice(3, 0, structuredClone(src.form.rows[2]));
    const r = await sync();
    assert.equal(r.count, 13);
    const recs = await chunkRecords(store);
    const ids = recs.map(x => x.id);
    assert.equal(new Set(ids).size, 13, 'mã phiếu không trùng');
    const dupBase = recs.find(x => x.lesson === 'Bài 2').id.replace(/-2$/, '');
    assert.ok(ids.includes(dupBase) && ids.includes(`${dupBase}-2`));
    assert.ok(await store.get(`${PATHS.phieu}/${dupBase}-2`));
    // Bỏ bản trùng → chỉ xóa “…-2”
    src.form.rows.splice(3, 1);
    const r2 = await sync();
    assert.deepEqual([r2.count, r2.added, r2.removed], [12, 0, 1]);
    assert.equal(await store.get(`${PATHS.phieu}/${dupBase}-2`), null);
    assert.ok(await store.get(`${PATHS.phieu}/${dupBase}`));
  });

  test('force → ghi lại toàn bộ dù không đổi', async () => {
    const { sync } = setup({ n: 12 });
    await sync();
    const r = await sync({ force: true });
    assert.deepEqual([r.added, r.updated, r.removed, r.chunksWritten], [0, 12, 0, 1]);
    assert.equal(r.staffChanged, true);
    assert.equal(r.accessChanged, true);
  });

  test('Sheet trả về 0 phiếu khi đã có dữ liệu → dừng, không xóa gì', async () => {
    const { store, src, sync } = setup({ n: 12 });
    await sync();
    src.form.rows = [];
    store.clearLog();
    await assert.rejects(sync(), e => e.code === 'EMPTY_SHEET' && e.expose === true);
    assert.deepEqual(paths(store), []);
    assert.equal((await store.listIds(PATHS.phieu)).length, 12);
    assert.equal((await store.get(PATHS.lock)).until, 0, 'khóa được nhả khi lỗi');
  });

  test('Sheet sai cấu trúc → lỗi tiếng Việt hiển thị được', async () => {
    const { src, sync } = setup({ n: 2 });
    src.form.cols[0].label = 'Cột lạ';
    await assert.rejects(sync(), e => e.expose === true && /cấu trúc cột/.test(e.message));
  });

  test('meta.sheetUrl chỉ có khi Sheet riêng tư; Sheet công khai → ẩn link + cảnh báo', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${FORM_GID}`;
    for (const [pub, expectUrl, warn] of [[false, url, false], [true, '', true], [null, '', false], ['throw', '', false]]) {
      const { store, src, sync } = setup({ n: 3 });
      const probed = [];
      src.fetchTable.isPublic = async gid => { probed.push(gid); if (pub === 'throw') throw new Error('x'); return pub; };
      const r = await sync();
      assert.equal(r.ok, true, String(pub));
      assert.deepEqual(probed, [FORM_GID]);
      assert.equal((await store.get(PATHS.meta)).sheetUrl, expectUrl, `isPublic=${pub}`);
      assert.equal(r.debug.sheetPublic, pub === 'throw' ? null : pub);
      assert.equal(r.warnings.some(w => /Bất kỳ ai có đường liên kết/.test(w)), warn, `cảnh báo khi isPublic=${pub}`);
    }
  });
});

describe('runSync – danh sách quyền (config/access)', () => {
  const accessWith = async env => {
    const { store, sync } = setup({ n: 3, env });
    const r = await sync();
    return { r, access: await store.get(PATHS.access) };
  };

  test('mặc định: tên miền trường + email BGH (viết thường, lọc trùng, sắp xếp, bỏ người đã nghỉ)', async () => {
    const { access, r } = await accessWith({});
    assert.deepEqual(access.domains, [DOMAIN]);
    assert.deepEqual(access.emails, BGH_EMAILS);
    assert.ok(r.warnings.some(w => /1 thành viên BGH/.test(w)), 'cảnh báo BGH chưa có email');
  });

  test('ALLOWED_DOMAINS=none → không cấp theo tên miền', async () => {
    const { access } = await accessWith({ ALLOWED_DOMAINS: 'none' });
    assert.deepEqual(access.domains, []);
    assert.deepEqual(access.emails, BGH_EMAILS);
    assert.deepEqual((await accessWith({ ALLOWED_DOMAINS: ' NONE ' })).access.domains, []);
  });

  test('ALLOWED_DOMAINS tùy chỉnh → viết thường, bỏ @, bỏ giá trị sai, sắp xếp', async () => {
    const { access } = await accessWith({ ALLOWED_DOMAINS: '  @Truong.EDU.vn, other.vn ;bad other.vn' });
    assert.deepEqual(access.domains, ['other.vn', 'truong.edu.vn']);
  });

  test('ALLOWED_DOMAINS rỗng/khoảng trắng → coi như chưa đặt (mặc định)', async () => {
    assert.deepEqual((await accessWith({ ALLOWED_DOMAINS: '' })).access.domains, [DOMAIN]);
    assert.deepEqual((await accessWith({ ALLOWED_DOMAINS: '   ' })).access.domains, [DOMAIN]);
  });

  test('ACCESS_FROM_SHEET=all → email mọi nhân sự đang làm việc', async () => {
    const { access } = await accessWith({ ACCESS_FROM_SHEET: 'all', ALLOWED_DOMAINS: 'none' });
    assert.deepEqual(access.emails, ALL_EMAILS);
    assert.deepEqual(access.domains, []);
  });

  test('ACCESS_FROM_SHEET=0 → chỉ ALLOWED_EMAILS (viết thường, lọc trùng)', async () => {
    const { access } = await accessWith({ ACCESS_FROM_SHEET: '0', ALLOWED_EMAILS: 'Admin@X.vn, admin@x.vn;  b@y.vn\nkhông-phải-email' });
    assert.deepEqual(access.emails, ['admin@x.vn', 'b@y.vn']);
  });

  test('ALLOWED_EMAILS gộp với email BGH, không trùng', async () => {
    const { access } = await accessWith({ ALLOWED_EMAILS: `PHT@${DOMAIN}, it@${DOMAIN}` });
    assert.deepEqual(access.emails, [`hieutruong@${DOMAIN}`, `it@${DOMAIN}`, `pht@${DOMAIN}`]);
  });

  test('đổi biến môi trường → accessChanged; giữ nguyên → không ghi lại', async () => {
    const { store, sync, env } = setup({ n: 3 });
    await sync();
    const r1 = await sync({ env: { ...env, ALLOWED_DOMAINS: 'none', ACCESS_FROM_SHEET: 'all' } });
    assert.equal(r1.accessChanged, true);
    assert.deepEqual((await store.get(PATHS.access)).emails, ALL_EMAILS);
    store.clearLog();
    const r2 = await sync({ env: { ...env, ALLOWED_DOMAINS: 'none', ACCESS_FROM_SHEET: 'all' } });
    assert.equal(r2.accessChanged, false);
    assert.ok(!paths(store).includes('set:config/access'));
  });

  test('email mới trong DS Nhân sự → access cập nhật, staff không đổi nếu tên/chức danh giữ nguyên', async () => {
    const { store, src, sync } = setup({ n: 3 });
    await sync();
    src.staff.rows[7].c[5] = { v: `ha@${DOMAIN}` };
    const r = await sync();
    assert.equal(r.accessChanged, true);
    assert.equal(r.staffChanged, false);
    assert.ok((await store.get(PATHS.access)).emails.includes(`ha@${DOMAIN}`));
  });

  test('accessFromSheetMode / envDomains / readSyncConfig', () => {
    assert.equal(accessFromSheetMode({}), 'bgh');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: 'BGH' }), 'bgh');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: '1' }), 'bgh');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: 'All' }), 'all');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: '0' }), '0');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: 'false' }), '0');
    assert.equal(accessFromSheetMode({ ACCESS_FROM_SHEET: 'lạ' }), 'bgh');
    assert.deepEqual(envDomains({}), [DOMAIN]);
    assert.deepEqual(envDomains({ ALLOWED_DOMAINS: 'none' }), []);
    const cfg = readSyncConfig({ SHEET_ID: ' abc ' });
    assert.deepEqual([cfg.sheetId, cfg.formGid, cfg.staffGid, cfg.accessFromSheet], ['abc', FORM_GID, STAFF_GID, 'bgh']);
    assert.equal(readSyncConfig({ SHEET_GID_STAFF: '' }).staffGid, '');
    assert.equal(readSyncConfig({ SHEET_GID_STAFF: 'off' }).staffGid, '');
    assert.equal(readSyncConfig({ SHEET_GID_STAFF: '123' }).staffGid, '123');
    assert.equal(readSyncConfig({ SHEET_GID_FORM: '' }).formGid, FORM_GID);
    // buildAccess vẫn hoạt động khi parseStaffTable (cũ) không có allEmails
    const b = buildAccess({ accessFromSheet: 'all', envEmails: [], envDomains: [] }, { bgh: [{ email: 'A@x.vn' }], teach: [{ email: 'b@x.vn' }] });
    assert.deepEqual(b.emails, ['a@x.vn', 'b@x.vn']);
  });

  test('parseStaffTable: allEmails gồm mọi nhân sự đang làm việc (bổ sung, tương thích ngược)', () => {
    const s = parseStaffTable(staffTable());
    assert.deepEqual(Object.keys(s).sort(), ['allEmails', 'bgh', 'teach']);
    assert.ok(!s.allEmails.includes(`old@${DOMAIN}`));
    assert.ok(s.allEmails.includes(`gv.phuong@${DOMAIN}`));
    assert.ok(s.teach.every(x => !('email' in x)));
    assert.deepEqual(parseStaffTable({ cols: [{ label: 'X' }], rows: [] }), { teach: [], bgh: [], allEmails: [] });
  });
});

describe('runSync – DS Nhân sự tắt hoặc lỗi', () => {
  test('SHEET_GID_STAFF rỗng → không đọc tab nhân sự, staff rỗng, access chỉ từ biến môi trường', async () => {
    const { store, src, sync } = setup({ n: 3, env: { SHEET_GID_STAFF: '', ALLOWED_EMAILS: `it@${DOMAIN}` } });
    const r = await sync();
    assert.deepEqual(src.calls, [FORM_GID]);
    assert.deepEqual(await store.get(PATHS.staff), { teach: [], bgh: [] });
    assert.equal((await store.get(PATHS.meta)).staffCount, 0);
    const access = await store.get(PATHS.access);
    assert.deepEqual(access.emails, [`it@${DOMAIN}`]);
    assert.deepEqual(access.domains, [DOMAIN]);
    assert.ok(r.warnings.some(w => /SHEET_GID_STAFF/.test(w)));
  });

  test('lỗi đọc DS Nhân sự → giữ nguyên staff và access cũ, có cảnh báo', async () => {
    const { store, src, sync } = setup({ n: 3 });
    await sync();
    const staffBefore = await store.get(PATHS.staff);
    const accessBefore = await store.get(PATHS.access);
    src.failStaff = true;
    store.clearLog();
    const r = await sync();
    assert.equal(r.ok, true);
    assert.equal(r.staffChanged, false);
    assert.equal(r.accessChanged, false);
    assert.ok(r.warnings.some(w => /Không đọc được danh sách nhân sự/.test(w)));
    assert.deepEqual(await store.get(PATHS.staff), staffBefore);
    assert.deepEqual(await store.get(PATHS.access), accessBefore);
    assert.equal((await store.get(PATHS.meta)).staffCount, 7);
    // Đọc lại được → không ghi lại vì không đổi
    src.failStaff = false;
    const r2 = await sync();
    assert.equal(r2.staffChanged, false);
    assert.equal(r2.accessChanged, false);
  });

  test('lỗi đọc DS Nhân sự ngay lần đầu → staff rỗng, access từ biến môi trường; lần sau bổ sung', async () => {
    const { store, src, sync } = setup({ n: 3 });
    src.failStaff = true;
    const r = await sync();
    assert.equal(r.ok, true);
    assert.deepEqual(await store.get(PATHS.staff), { teach: [], bgh: [] });
    assert.deepEqual((await store.get(PATHS.access)).emails, []);
    assert.deepEqual((await store.get(PATHS.access)).domains, [DOMAIN]);
    src.failStaff = false;
    const r2 = await sync();
    assert.equal(r2.staffChanged, true);
    assert.equal(r2.accessChanged, true);
    assert.deepEqual((await store.get(PATHS.access)).emails, BGH_EMAILS);
  });
});

describe('runSync – giới hạn tần suất và khóa', () => {
  test('người dùng bấm lại < 60 s → {ok:true, skipped:"recent"}, không ghi gì; cron không bị giới hạn', async () => {
    const { store, sync, t } = setup({ n: 3 });
    await sync({ trigger: 'cron' });
    store.clearLog();
    t.now += 30_000;
    const r = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'recent');
    assert.equal(r.count, 3);
    assert.equal(r.retryAfterMs, 30_000);
    assert.deepEqual(paths(store), []);
    const rc = await sync({ trigger: 'cron' });
    assert.equal(rc.skipped, undefined);
    const rw = await sync({ trigger: 'webhook' });
    assert.equal(rw.skipped, undefined);
    t.now += 60_001;
    const r2 = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.equal(r2.ok, true);
    assert.equal(r2.skipped, undefined);
    assert.equal((await store.get(PATHS.meta)).trigger, `user:gv@${DOMAIN}`);
  });

  test('đang bị khóa → {ok:false, skipped:"locked"}; hết hạn khóa (55 s) → chạy bình thường', async () => {
    const { store, sync, t } = setup({ n: 3, initial: { 'config/syncLock': { until: T0 + 30_000, token: 'khac' } } });
    const r = await sync();
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'locked');
    assert.deepEqual(paths(store), []);
    t.now += 30_001;
    const r2 = await sync();
    assert.equal(r2.ok, true);
    assert.equal(r2.count, 3);
    assert.equal(LOCK_TTL_MS, 55_000);
  });

  test('khóa được đặt trong lúc chạy; lượt chen ngang bị từ chối và lượt đang chạy chạy lại một lần', async () => {
    const { store, src, sync } = setup({ n: 3 });
    let open;
    src.gate = new Promise(res => { open = res; });
    const first = sync({ trigger: 'cron' });
    await new Promise(res => setImmediate(res));
    const lock = await store.get(PATHS.lock);
    assert.equal(lock.until, T0 + LOCK_TTL_MS);
    src.form.rows.push(formRow(3)); // dòng mới đến trong lúc đang đồng bộ
    const second = await sync({ trigger: 'webhook' });
    assert.equal(second.skipped, 'locked');
    src.gate = null;
    open();
    const r = await first;
    assert.equal(r.ok, true);
    assert.equal(r.runs, 2, 'chạy lại để lấy dữ liệu của yêu cầu bị chặn');
    assert.equal(r.count, 4);
    assert.equal((await store.get(PATHS.lock)).until, 0);
  });

  test('lỗi khi đọc Sheet → khóa được nhả, lỗi được ném ra', async () => {
    const { store, src, sync } = setup({ n: 3 });
    src.failForm = new Error('mạng lỗi');
    await assert.rejects(sync(), /mạng lỗi/);
    assert.equal((await store.get(PATHS.lock)).until, 0);
  });

  test('lượt trước thất bại < 60 s → người dùng nhận {ok:false, skipped:"recent", error}; cron vẫn chạy; sau 60 s thử lại được', async () => {
    const { store, src, sync, t } = setup({ n: 3 });
    await sync({ trigger: 'cron' });
    t.now += 120_000;
    src.failForm = new Error('Sheet lỗi');
    await assert.rejects(sync({ trigger: `user:gv@${DOMAIN}` }), /Sheet lỗi/);
    store.clearLog();
    t.now += 5_000;
    const r = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r.ok, r.skipped], [false, 'recent']);
    assert.equal(r.retryAfterMs, 55_000);
    assert.match(r.error, /chưa thành công/);
    assert.deepEqual(paths(store), [], 'không ghi gì, không giữ khóa');
    assert.equal(src.calls.filter(g => g === FORM_GID).length, 2, 'không đọc Sheet thêm lần nào');
    await assert.rejects(sync({ trigger: 'cron' }), /Sheet lỗi/, 'cron không bị giới hạn');
    src.failForm = null;
    t.now += 60_001;
    const r2 = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r2.ok, r2.skipped], [true, undefined]);
    t.now += 1_000;
    assert.deepEqual([(await sync({ trigger: `user:gv@${DOMAIN}` })).ok, (await sync({ trigger: `user:gv@${DOMAIN}` })).skipped], [true, 'recent']);
  });

  test('đang có lượt chạy (khóa còn hạn) → người dùng nhận locked, không phải recent', async () => {
    const { store, sync, t } = setup({ n: 3, initial: { 'config/syncLock': { until: T0 + 30_000, token: 'khac', acquiredAt: T0 - 1_000, pendingAt: 0 } } });
    const r = await sync({ trigger: `user:gv@${DOMAIN}` });
    assert.deepEqual([r.ok, r.skipped], [false, 'locked']);
    assert.equal((await store.get(PATHS.lock)).pendingAt, T0);
    t.now += 1_000;
    await sync({ trigger: 'webhook' });
    assert.equal((await store.get(PATHS.lock)).pendingAt, T0, 'yêu cầu chờ chỉ được ghi nhận một lần');
  });
});

describe('gradeOf', () => {
  test('dashboard (hydrate) và phieu/{id}.khoi dùng cùng một quy tắc', () => {
    assert.equal(gradeOf, sharedGradeOf);
    const crit = [{ code: '1.1', d: 1 }];
    for (const [cls, g] of [['1A1', 'Khối 1'], ['10A1', 'Khối 10'], ['12A2', 'Khối 12'], ['6A1', 'Khối 6'], ['CLB', 'Khác']]) {
      assert.equal(hydrate({ id: 'x', ts: '2026-10-01 08:00:00', day: '2026-10-01', og: 'Tổ 1', on: 'A', tg: 'Tổ 1', tn: 'B', cls, sc: [4] }, crit).grade, g, cls);
    }
  });
  test('khối theo lớp', () => {
    assert.equal(gradeOf('1A0'), 'Khối 1');
    assert.equal(gradeOf('5B0'), 'Khối 5');
    assert.equal(gradeOf('10A1'), 'Khối 10');
    assert.equal(gradeOf('12C'), 'Khối 12');
    assert.equal(gradeOf('13A'), 'Khác');
    assert.equal(gradeOf(''), 'Khác');
    assert.equal(gradeOf('CLB'), 'Khác');
  });
});

/* =====================================================================
 * authorize()
 * ===================================================================== */
describe('authorize – ma trận quyền', () => {
  const ms = (email, extra = {}) => ({ email, email_verified: false, firebase: { sign_in_provider: 'microsoft.com' }, ...extra });
  const TOKENS = {
    'ms-school': ms(`gv@${DOMAIN}`),
    'ms-upper': ms(`GiaoVien@HoangMaiStarSchool.EDU.VN`),
    'ms-other': ms('someone@gmail.com'),
    'ms-lookalike': ms(`x@${DOMAIN}.evil.com`),
    'ms-subdomain': ms(`x@sub.${DOMAIN}`),
    'ms-double-at': ms(`a@evil.com@${DOMAIN}`),
    'ms-noemail': { firebase: { sign_in_provider: 'microsoft.com' } },
    'ms-blank': ms('   '),
    'ms-listed': ms('Partner@Other.vn'),
    'google-school': { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'google.com' } },
    'password-school': { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'password' } },
    'noprovider-school': { email: `gv@${DOMAIN}` },
  };
  const calls = { verify: 0, access: 0 };
  const verifyIdToken = async tok => {
    calls.verify++;
    if (TOKENS[tok]) return TOKENS[tok];
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  };
  const auth = (authorization, env = {}, access = { emails: [`partner@other.vn`], domains: [DOMAIN] }) =>
    authorize({ authorization, env, verifyIdToken, getAccess: async () => { calls.access++; return access; } });

  test('microsoft.com + tên miền trường → được phép (không cần email_verified)', async () => {
    calls.access = 0;
    const r = await auth('Bearer ms-school');
    assert.deepEqual(r, { ok: true, trigger: `user:gv@${DOMAIN}`, email: `gv@${DOMAIN}` });
    assert.equal(calls.access, 0, 'tên miền mặc định từ env → không cần đọc Firestore');
  });

  test('email viết hoa → được phép, trigger viết thường', async () => {
    const r = await auth('Bearer ms-upper');
    assert.equal(r.ok, true);
    assert.equal(r.trigger, `user:giaovien@${DOMAIN}`);
  });

  test('microsoft.com + tên miền khác → 403', async () => {
    const r = await auth('Bearer ms-other');
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.error, /không có quyền/);
  });

  test('tên miền giả dạng / tên miền con / nhiều dấu @ → 403 (khớp chính xác)', async () => {
    assert.equal((await auth('Bearer ms-lookalike')).status, 403);
    assert.equal((await auth('Bearer ms-subdomain')).status, 403);
    assert.equal((await auth('Bearer ms-double-at')).status, 403);
    assert.equal(isEmailAllowed(`a@evil.com@${DOMAIN}`, { emails: [], domains: [DOMAIN] }), false);
  });

  test('nhà cung cấp google.com / password / không rõ với email trường → 403', async () => {
    for (const tok of ['google-school', 'password-school', 'noprovider-school']) {
      const r = await auth(`Bearer ${tok}`);
      assert.equal(r.ok, false, tok);
      assert.equal(r.status, 403, tok);
      assert.match(r.error, /Microsoft 365/);
    }
  });

  test('thiếu email → 403', async () => {
    assert.equal((await auth('Bearer ms-noemail')).status, 403);
    assert.equal((await auth('Bearer ms-blank')).status, 403);
  });

  test('email có trong config/access.emails (không thuộc tên miền) → được phép', async () => {
    const r = await auth('Bearer ms-listed');
    assert.equal(r.ok, true);
    assert.equal(r.email, 'partner@other.vn');
  });

  test('ALLOWED_DOMAINS=none: chỉ theo danh sách email (env hoặc config/access)', async () => {
    const env = { ALLOWED_DOMAINS: 'none' };
    const onlyEmails = { emails: [`bgh@${DOMAIN}`], domains: [] };
    assert.equal((await auth('Bearer ms-school', env, onlyEmails)).status, 403);
    assert.equal((await auth('Bearer ms-school', { ...env, ALLOWED_EMAILS: `GV@${DOMAIN}` }, onlyEmails)).ok, true);
    assert.equal((await auth('Bearer ms-school', env, { emails: [`gv@${DOMAIN}`], domains: [] })).ok, true);
    assert.equal((await auth('Bearer ms-school', env, { emails: [], domains: [DOMAIN] })).ok, true, 'config/access.domains vẫn được tôn trọng');
    assert.equal((await auth('Bearer ms-school', env, null)).status, 403, 'thiếu config/access → từ chối');
  });

  test('CRON_SECRET → cron, SYNC_SECRET → webhook (không gọi verifyIdToken)', async () => {
    calls.verify = 0;
    const env = { CRON_SECRET: 'cron-secret-123', SYNC_SECRET: 'sync-secret-456' };
    assert.deepEqual(await auth('Bearer cron-secret-123', env), { ok: true, trigger: 'cron' });
    assert.deepEqual(await auth('bearer   sync-secret-456  ', env), { ok: true, trigger: 'webhook' });
    assert.equal(calls.verify, 0);
    assert.equal((await auth('Bearer cron-secret-12', env)).status, 401);
    assert.deepEqual(await auth('Bearer cron-secret-123', { CRON_SECRET: 'cron-secret-123\n' }), { ok: true, trigger: 'cron' }, 'bỏ khoảng trắng thừa của biến môi trường');
  });

  test('bí mật rỗng không bao giờ khớp', async () => {
    const env = { CRON_SECRET: '', SYNC_SECRET: '   ' };
    assert.equal((await auth(undefined, env)).status, 401);
    assert.equal((await auth('', env)).status, 401);
    assert.equal((await auth('Bearer ', env)).status, 401);
    assert.equal((await auth('Bearer    ', env)).status, 401);
    calls.verify = 0;
    const r = await auth('Bearer x', env);
    assert.equal(r.status, 401);
    assert.equal(calls.verify, 1, 'không khớp bí mật rỗng → chuyển sang xác minh ID token');
    assert.equal(secretEquals('', ''), false);
    assert.equal(secretEquals('a', undefined), false);
    assert.equal(secretEquals('a', ''), false);
    assert.equal(secretEquals('a', '  '), false);
    assert.equal(secretEquals(undefined, 'a'), false);
    assert.equal(secretEquals('abc', 'abc'), true);
  });

  test('token sai/hết hạn hoặc thiếu header → 401 tiếng Việt', async () => {
    const r = await auth('Bearer token-sai');
    assert.equal(r.status, 401);
    assert.match(r.error, /đăng nhập/);
    const r2 = await auth(undefined);
    assert.equal(r2.status, 401);
    assert.match(r2.error, /Microsoft 365/);
    assert.equal((await auth('Basic abc')).status, 401);
    assert.equal((await authorize({ authorization: 'Bearer x', env: {} })).status, 401, 'không có verifier');
  });

  test('lỗi cấu hình máy chủ khi xác minh token → ném ra (handler trả 500)', async () => {
    const boom = Object.assign(new Error('Chưa cấu hình service account'), { expose: true });
    await assert.rejects(authorize({ authorization: 'Bearer x', env: {}, verifyIdToken: async () => { throw boom; } }), boom);
  });

  test('tiện ích', () => {
    assert.equal(bearerToken(['Bearer a', 'Bearer b']), 'a');
    assert.equal(bearerToken('Bearer a b'), '');
    assert.equal(isEmailAllowed('A@B.VN', { emails: ['a@b.vn'], domains: [] }), true);
    assert.equal(isEmailAllowed('a@b.vn', { emails: [], domains: ['B.vn'] }), true);
    assert.equal(isEmailAllowed('', { emails: [''], domains: [''] }), false);
    assert.equal(isEmailAllowed('nodomain', { emails: [], domains: [''] }), false);
    assert.deepEqual(splitEmails('a@b.vn, x, C@D.VN'), ['a@b.vn', 'c@d.vn']);
    assert.deepEqual(splitDomains('@A.vn none localhost'), ['a.vn']);
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
    const body = res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /Microsoft 365/);
    assert.equal(getApps().length, 0, 'firebase-admin chưa được khởi tạo');
  });

  test('phương thức khác GET/POST → 405', async () => {
    const res = await call(defaultHandler, { method: 'PUT' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, POST');
  });

  const make = (over = {}) => {
    const t = { now: T0 };
    const store = memoryStore({ clock: () => t.now });
    const src = makeSource(5);
    const logs = [];
    const env = { SHEET_ID, CRON_SECRET: 'cron-xyz', SYNC_SECRET: 'sync-xyz', ...over.env };
    const handler = createHandler({
      env,
      getStore: () => store,
      makeFetchTable: () => src.fetchTable,
      verifyIdToken: async tok => {
        if (tok === 'ms-ok') return { email: `gv@${DOMAIN}`, firebase: { sign_in_provider: 'microsoft.com' } };
        if (tok === 'google-ok') return { email: `gv@${DOMAIN}`, email_verified: true, firebase: { sign_in_provider: 'google.com' } };
        throw new Error('bad token');
      },
      now: () => t.now,
      log: { error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
      ...over.deps,
    });
    return { t, store, src, handler, logs, env };
  };

  test('cron (GET) → 200 với các trường kết quả, không có debug', async () => {
    const { handler } = make();
    const res = await call(handler, { method: 'GET', authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const b = res.json();
    for (const k of ['ok', 'count', 'added', 'updated', 'removed', 'chunksWritten', 'staffChanged', 'accessChanged', 'durationMs', 'syncedAtMs', 'trigger']) {
      assert.ok(k in b, `thiếu trường ${k}`);
    }
    assert.equal(b.ok, true);
    assert.equal(b.count, 5);
    assert.equal(b.trigger, 'cron');
    assert.equal(b.syncedAtMs, T0);
    assert.ok(!('debug' in b));
  });

  test('người dùng Microsoft 365 (POST) → 200; bấm lại ngay → skipped recent; ?force=1 bị bỏ qua với người dùng', async () => {
    const { handler, t } = make();
    const r1 = (await call(handler, { authorization: 'Bearer ms-ok' })).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.trigger, `user:gv@${DOMAIN}`);
    t.now += 10_000;
    const res2 = await call(handler, { authorization: 'Bearer ms-ok' });
    assert.equal(res2.statusCode, 200);
    assert.deepEqual([res2.json().ok, res2.json().skipped], [true, 'recent']);
    t.now += 61_000;
    const r3 = (await call(handler, { url: '/api/sync?force=1', authorization: 'Bearer ms-ok' })).json();
    assert.equal(r3.updated, 0, 'force chỉ dành cho cron');
    const r4 = (await call(handler, { url: '/api/sync?force=1', authorization: 'Bearer sync-xyz' })).json();
    assert.equal(r4.trigger, 'webhook');
    assert.equal(r4.updated, 0, 'SYNC_SECRET (Apps Script) không được force');
    const r5 = (await call(handler, { method: 'GET', url: '/api/sync?force=1', authorization: 'Bearer cron-xyz' })).json();
    assert.equal(r5.trigger, 'cron');
    assert.equal(r5.updated, 5);
  });

  test('người dùng gọi lại < 60 s sau lượt thất bại → 429 kèm Retry-After và thông báo tiếng Việt', async () => {
    const { handler, src, t } = make();
    src.failForm = Object.assign(new Error('Không có quyền đọc Google Sheet.'), { expose: true });
    assert.equal((await call(handler, { authorization: 'Bearer ms-ok' })).statusCode, 500);
    t.now += 10_000;
    const res = await call(handler, { authorization: 'Bearer ms-ok' });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '50');
    const b = res.json();
    assert.deepEqual([b.ok, b.skipped], [false, 'recent']);
    assert.match(b.error, /thử lại sau 50 giây/);
  });

  test('google.com → 403; token sai → 401', async () => {
    const { handler } = make();
    const r403 = await call(handler, { authorization: 'Bearer google-ok' });
    assert.equal(r403.statusCode, 403);
    assert.equal(r403.json().ok, false);
    const r401 = await call(handler, { authorization: 'Bearer sai' });
    assert.equal(r401.statusCode, 401);
  });

  test('đang bị khóa → 409 {ok:false, skipped:"locked"}', async () => {
    const { handler, store, t } = make();
    store.docs.set('config/syncLock', { until: t.now + 20_000, token: 'khac' });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 409);
    const b = res.json();
    assert.deepEqual([b.ok, b.skipped], [false, 'locked']);
    assert.match(b.error, /đồng bộ khác/);
  });

  test('lỗi bất ngờ → 500 {ok:false, error} không lộ bí mật/chi tiết nội bộ', async () => {
    const { handler, src, logs } = make();
    src.failForm = new Error('connect ECONNREFUSED secret=cron-xyz private_key=...');
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    const b = res.json();
    assert.equal(b.ok, false);
    assert.ok(b.error && !/cron-xyz|private_key|ECONNREFUSED/.test(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(logs.length > 0, 'chi tiết lỗi chỉ ghi vào log máy chủ');
  });

  test('không nạp được module máy chủ → 500 JSON nêu nguyên nhân, không sập hàm', async () => {
    const logs = [];
    let calls = 0;
    const handler = createHandler({
      env: { SHEET_ID: 'x', CRON_SECRET: 'cron-xyz' },
      loadModules: async () => { calls++; throw Object.assign(new Error("Cannot find package 'firebase-admin' imported from /var/task/server/firebase.js"), { code: 'ERR_MODULE_NOT_FOUND', moduleLoad: true }); },
      log: { error: (...a) => logs.push(a), warn() {} },
    });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /không nạp được thư viện.*ERR_MODULE_NOT_FOUND.*firebase-admin/);
    assert.equal(res.headers['cache-control'], 'no-store');
    await call(handler, {});
    assert.equal(calls, 2, 'lần gọi sau thử nạp lại');
    assert.ok(logs.length >= 1);
  });

  test('lỗi có thông điệp công khai (expose) → trả nguyên thông điệp tiếng Việt', async () => {
    const { handler, src } = make();
    src.failForm = Object.assign(new Error('Không có quyền đọc Google Sheet (gid 948197065).'), { expose: true });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /Không có quyền đọc Google Sheet/);
  });

  test('thiếu SHEET_ID → 500 hướng dẫn cấu hình', async () => {
    const { handler } = make({ env: { SHEET_ID: '' } });
    const res = await call(handler, { authorization: 'Bearer cron-xyz' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /SHEET_ID/);
  });

  test('chưa cấu hình service account → 500 có thông báo rõ (không phải 401)', async () => {
    const { handler } = make({
      deps: { verifyIdToken: async () => { throw Object.assign(new Error('Chưa cấu hình service account Firebase trên Vercel'), { expose: true }); } },
    });
    const res = await call(handler, { authorization: 'Bearer ms-ok' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /service account/);
  });
});

/* =====================================================================
 * server/sheet.js
 * ===================================================================== */
describe('sheet.js – gviz', () => {
  const wrap = obj => `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(obj)});`;
  const okBody = wrap({ version: '0.6', status: 'ok', table: { cols: [{ id: 'A', label: 'x', type: 'string' }], rows: [{ c: [{ v: 'a);b' }] }] } });
  const resp = (body, status = 200, type = 'application/javascript; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });

  test('bỏ lớp bọc và đọc bảng', async () => {
    assert.equal(parseGvizBody(okBody).table.rows[0].c[0].v, 'a);b');
    const seen = [];
    const t = await fetchGvizTable('SID', '123', { fetchImpl: async (url, init) => { seen.push([url, init.headers]); return resp(okBody); } });
    assert.equal(t.cols[0].label, 'x');
    assert.equal(seen[0][0], gvizUrl('SID', '123'));
    assert.match(seen[0][0], /\/d\/SID\/gviz\/tq\?gid=123&headers=1&tqx=out:json$/);
    assert.equal(seen[0][1].Authorization, undefined);
  });

  test('status error → thông báo chi tiết từ Google', async () => {
    const body = wrap({ status: 'error', errors: [{ reason: 'invalid_query', detailed_message: 'Invalid gid' }] });
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => resp(body) }), e => e.expose && /Invalid gid/.test(e.message));
  });

  test('trang đăng nhập HTML → SHEET_NOT_SHARED', async () => {
    const html = '<!doctype html><html><body>Sign in</body></html>';
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => resp(html, 200, 'text/html; charset=utf-8') }), e => e.code === 'SHEET_NOT_SHARED');
    assert.throws(() => parseGvizBody(html), e => e.code === 'SHEET_NOT_SHARED');
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => resp('', 404, 'text/html') }), e => e.code === 'SHEET_NOT_FOUND');
    await assert.rejects(fetchGvizTable('', '1', { fetchImpl: async () => resp(okBody) }), e => e.code === 'CONFIG_SHEET_ID');
  });

  test('lỗi mạng → thông báo tiếng Việt', async () => {
    await assert.rejects(fetchGvizTable('SID', '1', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), e => e.code === 'SHEET_NETWORK' && /Không kết nối/.test(e.message));
  });

  test('service account: dùng Bearer token; lỗi token → thử lại không token (Sheet công khai)', async () => {
    const sa = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k' };
    const auths = [];
    const fetchImpl = async (url, init) => { auths.push(init.headers.Authorization); return resp(okBody); };
    const f1 = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl, getToken: async () => 'tok123' });
    await f1('1');
    assert.deepEqual(auths, ['Bearer tok123']);
    auths.length = 0;
    const f2 = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl, getToken: async () => { throw new Error('no token'); } });
    await f2('1');
    await f2('2');
    assert.deepEqual(auths, [undefined, undefined], 'chuyển sang đọc công khai và ghi nhớ');
  });

  test('gvizUrl với câu truy vấn tq', () => {
    assert.match(gvizUrl('SID', '1', 'limit 0'), /&tqx=out:json&tq=limit%200$/);
  });

  test('isPublic: không có service account → true; Sheet riêng tư → false; công khai → true; lỗi khác → null', async () => {
    const sa = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k' };
    const noSa = makeSheetFetcher({ sheetId: 'SID', fetchImpl: async () => { throw new Error('không được gọi'); } });
    assert.equal(await noSa.isPublic('1'), true);
    const seen = [];
    const priv = makeSheetFetcher({
      sheetId: 'SID', serviceAccount: sa, getToken: async () => 'tok',
      fetchImpl: async (url, init) => { seen.push([url, init.headers.Authorization]); return init.headers.Authorization ? resp(okBody) : resp('<html>login</html>', 200, 'text/html'); },
    });
    await priv('1');
    assert.equal(await priv.isPublic('1'), false);
    assert.deepEqual(seen[1], [gvizUrl('SID', '1', 'limit 0'), undefined], 'thăm dò không kèm token, chỉ lấy tiêu đề cột');
    const pub = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, getToken: async () => 'tok', fetchImpl: async () => resp(okBody) });
    assert.equal(await pub.isPublic('1'), true);
    const down = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, getToken: async () => 'tok', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(await down.isPublic('1'), null);
  });

  test('Sheet riêng tư mà service account chưa được chia sẻ → lỗi nêu email service account', async () => {
    const sa = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k' };
    const fetchImpl = async () => resp('<html>login</html>', 200, 'text/html');
    const f = makeSheetFetcher({ sheetId: 'SID', serviceAccount: sa, fetchImpl, getToken: async () => 'tok' });
    await assert.rejects(f('1'), e => e.code === 'SHEET_NOT_SHARED' && e.message.includes(sa.client_email));
  });
});

/* =====================================================================
 * server/firebase.js – đọc service account
 * ===================================================================== */
describe('firebase.js – getServiceAccount', () => {
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----\n';
  const json = { type: 'service_account', project_id: 'dugiotih', client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: KEY };

  test('chưa cấu hình → null', () => {
    assert.equal(getServiceAccount({}), null);
  });
  test('FIREBASE_SERVICE_ACCOUNT dạng JSON thô và base64', () => {
    const a = getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(json) });
    assert.deepEqual(a, { project_id: 'dugiotih', client_email: json.client_email, private_key: KEY.trim() });
    const b = getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(json)).toString('base64') });
    assert.deepEqual(b, a);
  });
  test('ba biến rời, private key có \\n dạng chữ và dấu ngoặc kép', () => {
    const a = getServiceAccount({
      FIREBASE_PROJECT_ID: 'dugiotih', FIREBASE_CLIENT_EMAIL: json.client_email,
      FIREBASE_PRIVATE_KEY: `"${KEY.replace(/\n/g, '\\n')}"`,
    });
    assert.equal(a.private_key, KEY);
    assert.equal(a.project_id, 'dugiotih');
  });
  test('JSON sai / thiếu trường / key sai định dạng → lỗi expose', () => {
    assert.throws(() => getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: 'không-phải-json' }), e => e.expose && e.code === 'CONFIG_FIREBASE');
    assert.throws(() => getServiceAccount({ FIREBASE_CLIENT_EMAIL: 'a@b.c' }), e => e.expose && /thiếu/.test(e.message));
    assert.throws(() => getServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...json, private_key: 'abc' }) }), e => e.expose && /PEM/.test(e.message));
  });
});

describe('memoryStore', () => {
  test('lô > 500 thao tác bị từ chối; serverTimestamp được thay bằng thời điểm ghi', async () => {
    const s = memoryStore({ clock: () => 1000 });
    await assert.rejects(s.commitBatch(Array.from({ length: 501 }, (_, i) => ({ type: 'set', path: `a/${i}`, data: {} }))), /500/);
    await s.commitBatch([{ type: 'set', path: 'a/b', data: { t: s.serverTimestamp(), n: null } }]);
    assert.deepEqual(await s.get('a/b'), { t: new Date(1000), n: null });
    assert.deepEqual(await s.listIds('a'), ['b']);
    // undefined → lỗi như Firestore thật, và lô ghi không được áp dụng một phần
    await assert.rejects(s.commitBatch([{ type: 'set', path: 'a/c', data: { x: 1 } }, { type: 'set', path: 'a/d', data: { y: { z: undefined } } }]), /undefined.*y\.z/);
    assert.deepEqual(await s.listIds('a'), ['b']);
  });
});

/* =====================================================================
 * firestoreStore() với một Firestore giả lập (cùng API firebase-admin dùng tới)
 * ===================================================================== */
function fakeFirestore() {
  const docs = new Map();
  const commits = [];
  const write = (path, data, opts) => {
    docs.set(path, opts?.merge && docs.has(path) ? { ...docs.get(path), ...data } : data);
  };
  const doc = path => ({
    path, id: path.split('/').pop(),
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }) }; },
  });
  return {
    docs, commits,
    doc,
    collection: name => ({
      async listDocuments() {
        return [...docs.keys()].filter(p => p.startsWith(name + '/') && p.split('/').length === 2).map(doc);
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
  test('đồng bộ đầy đủ, lũy đẳng, dùng FieldValue/Timestamp của firebase-admin, khóa bằng transaction', async () => {
    const db = fakeFirestore();
    const store = firestoreStore(db);
    const src = makeSource(450);
    let now = T0;
    const run = (trigger = 'cron') => runSync({ store, fetchTable: src.fetchTable, env: { SHEET_ID }, trigger, nowMs: () => now });

    const r1 = await run();
    assert.deepEqual([r1.ok, r1.count, r1.added, r1.chunksWritten], [true, 450, 450, 1]);
    const meta = db.docs.get('dashboard/meta');
    assert.ok(meta.syncedAt instanceof FieldValue && meta.syncedAt.isEqual(FieldValue.serverTimestamp()));
    assert.deepEqual(meta.chunkIds, ['c000']);
    const anyPhieu = [...db.docs.entries()].find(([p]) => p.startsWith('phieu/'))[1];
    assert.ok(anyPhieu.thoiGianGui instanceof Timestamp);
    assert.ok(anyPhieu.capNhatLuc instanceof FieldValue);
    assert.equal(anyPhieu.thoiGianGui.toDate().getTime(), tsToInstant(anyPhieu.ngayGui).getTime());
    // 1 lô dashboard (meta, staff, c000, access) + phieu 400 + 50 + 1 lô syncState
    assert.deepEqual(db.commits, [4, 400, 50, 1]);
    assert.equal(db.docs.get('config/syncLock').until, 0);
    assert.ok(Array.isArray(db.docs.get('config/access').emails));

    db.commits.length = 0;
    now += 1000;
    const r2 = await run();
    assert.deepEqual([r2.added, r2.updated, r2.removed, r2.chunksWritten], [0, 0, 0, 0]);
    assert.deepEqual(db.commits, [1, 1], 'chỉ meta + syncState');

    // Khóa còn hiệu lực → locked, và ghi nhận yêu cầu chờ (merge)
    db.docs.set('config/syncLock', { until: now + 10_000, token: 'khac', acquiredAt: now, pendingAt: 0 });
    const r3 = await run('webhook');
    assert.deepEqual([r3.ok, r3.skipped], [false, 'locked']);
    assert.equal(db.docs.get('config/syncLock').token, 'khac');
    assert.equal(db.docs.get('config/syncLock').pendingAt, now);
    const r3b = await runSync({ store, fetchTable: src.fetchTable, env: { SHEET_ID }, trigger: 'webhook', nowMs: () => now + 500 });
    assert.equal(r3b.skipped, 'locked');
    assert.equal(db.docs.get('config/syncLock').pendingAt, now, 'chỉ ghi nhận yêu cầu chờ một lần');

    // Người dùng bấm “Làm mới” ngay sau lượt trước → recent
    now += 20_000;
    db.docs.set('config/syncLock', { until: 0, token: null });
    const r4 = await run(`user:gv@${DOMAIN}`);
    assert.equal(r4.skipped, 'recent');
  });
});
