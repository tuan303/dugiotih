// Kiểm thử offline: đọc Google Sheet bằng Sheets API v4 (đủ mọi dòng kể cả khi Sheet đang lọc) và chặn giảm phiếu bất thường.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormTable, parseStaffTable } from '../lib/shared.js';
import { valuesToTable, serialToGvizDate, fetchSheetsApiTable, makeSheetFetcher, makeMultiSheetFetcher, sheetsValuesUrl } from '../server/sheet.js';
import { runSync, PATHS } from '../server/sync.js';
import { memoryStore } from '../server/memory-store.js';
import {
  T0, FORM_TAB, STAFF_TAB, SHEET_TIH, BASE_ENV, silentLog, makeSource,
  TIH_FORM_COLS, THCS_FORM_COLS, tihRow, thcsRow, tihStaffTable, thcsStaffTable,
} from './fixtures.mjs';

/* ---------- Bảng gviz → kết quả Sheets API (UNFORMATTED + FORMATTED), như Google trả về ---------- */
const EPOCH = Date.UTC(1899, 11, 30);
function gvizToValues(table) {
  const U = [table.cols.map(c => c.label)], F = [table.cols.map(c => c.label)];
  for (const row of table.rows) {
    const u = [], f = [];
    table.cols.forEach((col, i) => {
      const c = row.c?.[i];
      if (!c || c.v == null || c.v === '') { u.push(''); f.push(''); return; }
      const m = typeof c.v === 'string' && c.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
      if (m) { u.push((Date.UTC(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - EPOCH) / 864e5); f.push(c.f); return; }
      u.push(c.v); f.push(c.f ?? String(c.v));
    });
    while (u.length && u[u.length - 1] === '') { u.pop(); f.pop(); } // API bỏ các ô trống cuối dòng
    U.push(u); F.push(f);
  }
  return { U, F };
}
const strip = recs => recs.map(({ id, ...r }) => r); // id phụ thuộc thứ tự cột gốc → so sánh nội dung
const tihTable = n => ({ cols: structuredClone(TIH_FORM_COLS), rows: Array.from({ length: n }, (_, i) => tihRow(i, { tm: 100000 + (i % 9), om: i % 4 ? 101000 + i : null, oe: i % 3 ? `gv${i}@x.vn` : '', obsCol: ['to1', 'ta', 'bgh', 'cot'][i % 4], teachCol: ['to1', 'ta', 'tg'][i % 3], sc: [1 + (i % 5), i % 7 ? 4 : null, 5] })), parsedNumHeaders: 1 });
const thcsTable = n => ({ cols: structuredClone(THCS_FORM_COLS), rows: Array.from({ length: n }, (_, i) => thcsRow(i, { tm: 101600 + i })), parsedNumHeaders: 1 });

describe('valuesToTable – Sheets API cho kết quả phân tích giống hệt gviz', () => {
  test('biểu mẫu Tiểu học (ngày giờ, ô trống, cột không tên, điểm thiếu)', () => {
    const g = tihTable(60);
    const { U, F } = gvizToValues(g);
    const a = parseFormTable(g, { cap: 'tih' }), b = parseFormTable(valuesToTable(U, F), { cap: 'tih' });
    assert.equal(b.records.length, 60);
    assert.deepEqual(b.crit, a.crit);
    assert.deepEqual(b.records, a.records);
  });
  test('biểu mẫu THCS (cột tổ KHXH nằm sau cột nhận xét)', () => {
    const g = thcsTable(25);
    const { U, F } = gvizToValues(g);
    assert.deepEqual(parseFormTable(valuesToTable(U, F), { cap: 'thcs' }), parseFormTable(g, { cap: 'thcs' }));
  });
  test('DS Nhân sự', () => {
    for (const [t, cap] of [[tihStaffTable(), 'tih'], [thcsStaffTable(), 'thcs']]) {
      const { U, F } = gvizToValues(t);
      assert.deepEqual(parseStaffTable(valuesToTable(U, F), { cap }), parseStaffTable(t, { cap }));
    }
  });
  test('suy kiểu cột: datetime / date / number / string; số trong cột chữ giữ dạng hiển thị', () => {
    const U = [['Dấu thời gian', 'Ngày dạy', 'Điểm', 'Mã', 'Tên'], [46174.3142129630, 46173, 4, 101215, 'An'], [46174.5, 46174, 5, 'myvh@x.vn', 'Bình']];
    const F = [['Dấu thời gian', 'Ngày dạy', 'Điểm', 'Mã', 'Tên'], ['01/06/2026 7:32:28', '31/05/2026', '4', '101215', 'An'], ['01/06/2026 12:00:00', '01/06/2026', '5', 'myvh@x.vn', 'Bình']];
    const t = valuesToTable(U, F);
    assert.deepEqual(t.cols.map(c => c.type), ['datetime', 'date', 'number', 'string', 'string']);
    assert.deepEqual(t.rows[0].c[0], { v: 'Date(2026,5,1,7,32,28)', f: '01/06/2026 7:32:28' });
    assert.deepEqual(t.rows[0].c[1], { v: 'Date(2026,4,31,0,0,0)', f: '31/05/2026' });
    assert.deepEqual(t.rows[0].c[3], { v: '101215' });
    assert.equal(t.rows[1].c[3].v, 'myvh@x.vn');
  });
  test('serialToGvizDate làm tròn tới giây, không lệch múi giờ', () => {
    assert.equal(serialToGvizDate(0), 'Date(1899,11,30,0,0,0)');
    assert.equal(serialToGvizDate(46174.31421296296), 'Date(2026,5,1,7,32,28)');
    assert.equal(serialToGvizDate(46174.99999999), 'Date(2026,5,2,0,0,0)');
  });
});

/* ---------- Gọi API ---------- */
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const apiErr = (status, message, reason) => json({ error: { code: status, message, details: reason ? [{ reason }] : [] } }, status);
const gvizOk = '/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"ok","table":{"cols":[{"label":"x","type":"string"}],"rows":[]}});';
const SA = { client_email: 'sa@dugiotih.iam.gserviceaccount.com', private_key: 'k', project_id: 'dugiotih' };

function apiServer(book, { calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = new URL(url);
    if (u.host === 'docs.google.com') return new Response(gvizOk, { status: 200, headers: { 'content-type': 'application/javascript' } });
    const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+))?$/);
    if (!m) return apiErr(404, 'not found');
    const sheet = book[decodeURIComponent(m[1])];
    if (!sheet) return apiErr(404, 'Requested entity was not found.');
    if (!m[2]) return json({ sheets: Object.keys(sheet).map((title, i) => ({ properties: { sheetId: i * 111, title } })) });
    const title = decodeURIComponent(m[2]).replace(/^'|'$/g, '').replace(/''/g, "'");
    if (!sheet[title]) return apiErr(400, `Unable to parse range: '${title}'`);
    const { U, F } = sheet[title];
    return json({ range: m[2], majorDimension: 'ROWS', values: u.searchParams.get('valueRenderOption') === 'FORMATTED_VALUE' ? F : U });
  };
}

describe('fetchSheetsApiTable / makeSheetFetcher', () => {
  const book = { SID: { [FORM_TAB]: gvizToValues(tihTable(647)), "Tab có 'nháy'": gvizToValues(tihTable(3)) } };

  test('đọc ĐỦ 647 dòng bằng token, tên tab được bọc nháy và mã hóa', async () => {
    const calls = [];
    const t = await fetchSheetsApiTable('SID', { sheet: FORM_TAB }, { accessToken: 'tok', fetchImpl: apiServer(book, { calls }) });
    assert.equal(parseFormTable(t, { cap: 'tih' }).records.length, 647);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.auth === 'Bearer tok'));
    assert.ok(calls.some(c => c.url.includes('valueRenderOption=UNFORMATTED_VALUE')) && calls.some(c => c.url.includes('valueRenderOption=FORMATTED_VALUE')));
    assert.ok(calls[0].url.includes(encodeURIComponent(`'${FORM_TAB}'`)));
    assert.equal(sheetsValuesUrl('S', "a'b", 'X').includes(encodeURIComponent("'a''b'")), true);
    const t2 = await fetchSheetsApiTable('SID', { sheet: "Tab có 'nháy'" }, { accessToken: 'tok', fetchImpl: apiServer(book) });
    assert.equal(t2.rows.length, 3);
  });
  test('tab theo gid → tra tên tab qua metadata', async () => {
    const t = await fetchSheetsApiTable('SID', { gid: '111' }, { accessToken: 'tok', fetchImpl: apiServer(book) });
    assert.equal(t.rows.length, 3);
    await assert.rejects(fetchSheetsApiTable('SID', { gid: '999' }, { accessToken: 'tok', fetchImpl: apiServer(book) }), e => e.code === 'SHEET_TAB_NOT_FOUND');
  });
  test('lỗi: chưa chia sẻ, sai mã Sheet, sai tên tab, API chưa bật', async () => {
    const f = res => async () => res();
    await assert.rejects(fetchSheetsApiTable('SID', { sheet: 'A' }, { accessToken: 't', fetchImpl: f(() => apiErr(403, 'The caller does not have permission')) }), e => e.code === 'SHEET_NOT_SHARED');
    await assert.rejects(fetchSheetsApiTable('NOPE', { sheet: 'A' }, { accessToken: 't', fetchImpl: apiServer(book) }), e => e.code === 'SHEET_NOT_FOUND');
    await assert.rejects(fetchSheetsApiTable('SID', { sheet: 'Không có' }, { accessToken: 't', fetchImpl: apiServer(book) }), e => e.code === 'SHEET_TAB_NOT_FOUND');
    await assert.rejects(fetchSheetsApiTable('SID', { sheet: 'A' }, { accessToken: 't', fetchImpl: f(() => apiErr(403, 'Google Sheets API has not been used in project 1 before or it is disabled.', 'SERVICE_DISABLED')) }), e => e.code === 'SHEETS_API_DISABLED');
    await assert.rejects(fetchSheetsApiTable('SID', { sheet: 'A' }, { accessToken: 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), e => e.code === 'SHEET_NETWORK');
  });
  test('có service account: dùng Sheets API, không gọi gviz, không cảnh báo', async () => {
    const calls = [];
    const f = makeSheetFetcher({ sheetId: 'SID', serviceAccount: SA, fetchImpl: apiServer(book, { calls }), getToken: async () => 'tok' });
    const t = await f({ sheet: FORM_TAB });
    assert.equal(t.rows.length, 647);
    assert.ok(calls.every(c => c.url.startsWith('https://sheets.googleapis.com/')));
    assert.equal(f.warnings.size, 0);
  });
  test('sai tên tab: báo lỗi ngay, KHÔNG thử đọc công khai (gviz sẽ trả nhầm tab đầu tiên)', async () => {
    const calls = [];
    const f = makeSheetFetcher({ sheetId: 'SID', serviceAccount: SA, fetchImpl: apiServer(book, { calls }), getToken: async () => 'tok' });
    await assert.rejects(f({ sheet: 'DS Nhân sư' }), e => e.code === 'SHEET_TAB_NOT_FOUND');
    assert.ok(!calls.some(c => c.url.includes('docs.google.com')));
  });
  test('Sheets API chưa bật: đọc tạm qua gviz bằng token + cảnh báo có link bật API của đúng dự án', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url));
      if (String(url).startsWith('https://sheets.googleapis.com/')) return apiErr(403, 'Google Sheets API has not been used in project 440214462806 before or it is disabled.', 'SERVICE_DISABLED');
      assert.equal(init.headers.Authorization, 'Bearer tok');
      return new Response(gvizOk, { status: 200, headers: { 'content-type': 'application/javascript' } });
    };
    const f = makeMultiSheetFetcher({ serviceAccount: SA, fetchImpl, getToken: async () => 'tok' });
    await f('A', { sheet: FORM_TAB });
    await f('B', { sheet: FORM_TAB });
    assert.equal(calls.filter(u => u.startsWith('https://sheets.googleapis.com/')).length, 2, 'chỉ thử API một lần cho cả dự án');
    const w = [...f.warnings];
    assert.equal(w.length, 1);
    assert.match(w[0], /BỘ LỌC/);
    assert.match(w[0], /sheets\.googleapis\.com\?project=dugiotih/);
  });
});

/* ---------- Chặn giảm phiếu bất thường ---------- */
describe('runSync – số phiếu giảm bất thường (vd. Sheet đang lọc) → giữ dữ liệu cũ', () => {
  function setup(tihN) {
    let now = T0;
    const store = memoryStore({ clock: () => now });
    const src = makeSource({ tihN, thcsN: 6 });
    const sync = (o = {}) => { now += 120_000; return runSync({ store, fetchTable: src.fetchTable, env: BASE_ENV, trigger: 'cron', nowMs: () => now, force: !!o.force, log: silentLog }); };
    return { store, src, sync };
  }
  const tihCount = async store => (await store.get(PATHS.meta)).levels.find(l => l.cap === 'tih');

  test('100 → 30 phiếu: giữ 100, đánh dấu stale, cảnh báo nêu khả năng Sheet đang lọc; ?force chấp nhận', async () => {
    const { store, src, sync } = setup(100);
    await sync();
    assert.equal((await tihCount(store)).count, 100);
    src.tables[SHEET_TIH][FORM_TAB].rows = src.tables[SHEET_TIH][FORM_TAB].rows.slice(0, 30);
    const r = await sync();
    const L = await tihCount(store);
    assert.equal(L.count, 100);
    assert.equal(L.stale, true);
    assert.ok(r.warnings.some(w => /giảm bất thường từ 100 xuống 30/.test(w) && /bộ lọc/.test(w)));
    await sync({ force: true });
    assert.equal((await tihCount(store)).count, 30);
  });
  test('giảm ít (100 → 60) hoặc tăng (28 → 647) vẫn cập nhật bình thường', async () => {
    const { store, src, sync } = setup(100);
    await sync();
    src.tables[SHEET_TIH][FORM_TAB].rows = src.tables[SHEET_TIH][FORM_TAB].rows.slice(0, 60);
    await sync();
    assert.equal((await tihCount(store)).count, 60);
    const s2 = setup(28);
    await s2.sync();
    s2.src.tables[SHEET_TIH][FORM_TAB] = makeSource({ tihN: 647 }).tables[SHEET_TIH][FORM_TAB];
    await s2.sync();
    assert.equal((await tihCount(s2.store)).count, 647);
  });
  test('cảnh báo cách đọc của bộ đọc Sheet được đưa vào kết quả đồng bộ', async () => {
    const { src, sync } = setup(10);
    src.fetchTable.warnings = new Set(['Google Sheets API chưa được bật … BỘ LỌC …']);
    const r = await sync();
    assert.ok(r.warnings.some(w => /Sheets API chưa được bật/.test(w)));
  });
});
