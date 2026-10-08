// Kiểm thử offline cho server/roles.js (phân quyền) và server/scopes.js (ghép phiếu ↔ người, dựng phạm vi).
// Trọng tâm: các kiểm thử PHỦ ĐỊNH về quyền riêng tư – giáo viên không thấy tiết dạy của người khác, tổ trưởng chỉ thấy tổ mình,
// BGH cấp chỉ thấy cấp mình, phạm vi cá nhân không lộ email/mã của người khác.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormTable, parseStaffTable, fold, nameKey, TO_BGH, LEVELS, LEVELS_SIG } from '../lib/shared.js';
import { resolveAccess, parseRolesTable, parseRoleName } from '../server/roles.js';
import {
  buildScopes, benchmark, makeMatcher, personRecord, MIN_BENCH_TEACHERS, levelStaff, scopeIdTo, effectiveTo,
  publishBenchmarks, coarseBench, benchCutoff, BENCH_RULES,
} from '../server/scopes.js';
import { hydrate } from '../lib/shared.js';
import {
  TIH_FORM_COLS, THCS_FORM_COLS, tihRow, thcsRow, tihStaffTable, thcsStaffTable, rolesTable, em, TIH_STAFF_ROWS, THCS_STAFF_ROWS,
} from './fixtures.mjs';

const formOf = (cols, rows, cap) => parseFormTable({ cols: structuredClone(cols), rows }, { cap });
// Nhân thân tối giản cho kiểm thử makeMatcher.
const human = (name, ma, { caps = ['tih'], hid = name, persons = [], emails = [], to = '' } = {}) => ({
  hid, emails: new Set(emails), mas: new Set(ma ? [String(ma)] : []), names: [{ f: fold(name), k: nameKey(name) }], folds: new Set([fold(name)]),
  caps: new Set(caps), anyLevel: false, rows: to ? [{ cap: caps[0], row: { to } }] : [], persons,
});

// Bộ phiếu chuẩn cho các kiểm thử quyền.
function scenario({ tihRows, thcsRows, roles = [], env = {}, thpt = false, tihStaff = TIH_STAFF_ROWS, thcsStaff = THCS_STAFF_ROWS } = {}) {
  const tih = formOf(TIH_FORM_COLS, tihRows ?? [
    // 0: Tổ trưởng Tổ 1 dự Phạm Văn Hai (mã + tên khớp)
    tihRow(0, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
    // 1: Phó HT dự Đỗ Thị Ba – người dự gõ NHẦM mã của chính mình vào ô mã GV dạy (mã ↔ tên mâu thuẫn → tin họ tên)
    tihRow(1, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 100191, tg: 'Tổ 1', teachCol: 'to1', tn: 'Đỗ Thị Ba' }),
    // 2: Phạm Văn Hai dự Hoàng Văn Bốn (Tổ Tiếng Anh) – email gõ sai tên miền → ghép người dự theo mã + tên
    tihRow(2, { oe: 'gv.hai@hoangmaistartschool.edu.vn', om: 100131, og: 'Tổ 1', obsCol: 'to1', on: 'Phạm Văn Hai', tm: 100133, tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Hoàng Văn Bốn' }),
    // 3: GV TiH trùng họ tên với một GV THCS (khác người) – chỉ người TiH được nhận
    tihRow(3, { oe: em('gv.bon'), om: 100133, og: 'Tổ Tiếng Anh', obsCol: 'ta', on: 'Hoàng Văn Bốn', tm: null, tg: 'Tổ 2', teachCol: 'to1', tn: 'Trùng Tên Văn' }),
    // 4: Ngô Văn Năm (Tổ Toán - Tiếng Anh trong DS → Tổ Tiếng Anh)
    tihRow(4, { oe: em('gv.bon'), om: 100133, og: 'Tổ Tiếng Anh', obsCol: 'ta', on: 'Hoàng Văn Bốn', tm: 100893, tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Ngô Văn Năm' }),
    // 5: GV Liên cấp (chỉ có trong DS THCS dạng Liên cấp + DS TiH) – không mã → ghép theo tên
    tihRow(5, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: null, tg: 'Tổ 2', teachCol: 'to1', tn: 'Mai Thị Liên' }),
    // 6: GV không có trong DS (giáo viên mới) – không ghép ai
    tihRow(6, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 109999, tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Người Mới Toanh' }),
    // 7: Người hai email (hann@ ở TiH, hanh@ ở THCS) được dự
    tihRow(7, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 101392, tg: 'Tổ Năng khiếu', teachCol: 'to1', tn: 'Nguyễn Hai Mail' }),
    // 8: Lý Văn Sáu (Tổ 1) – thêm GV để benchmark Tổ 1 đủ 3 người
    tihRow(8, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100136, tg: 'Tổ 1', teachCol: 'to1', tn: 'Lý Văn Sáu' }),
    // 9–12: thêm phiếu để Tổ 1 và Tổ Tiếng Anh đủ 5 phiếu (ngưỡng công bố số liệu đối sánh)
    tihRow(9, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
    tihRow(10, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100132, tg: 'Tổ 1', teachCol: 'to1', tn: 'Đỗ Thị Ba' }),
    tihRow(11, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 100133, tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Hoàng Văn Bốn' }),
    tihRow(12, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 100893, tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Ngô Văn Năm' }),
  ], 'tih');
  const thcs = formOf(THCS_FORM_COLS, thcsRows ?? [
    // 0: Tổ trưởng Toán dự Đỗ Thị Ánh
    thcsRow(0, { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán', tm: 100081, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Đỗ Thị Ánh' }),
    // 1: KHXH (cột cuối bảng): Trần Thị Sử dự Lê Phương Địa – mã GV dạy gõ nhầm thành mã người dự (101601)
    thcsRow(1, { oe: em('gv.su'), om: 101601, og: 'Tổ KHXH', obsCol: 'khxh', on: 'Trần Thị Sử', tm: 101601, tg: 'Tổ KHXH', teachCol: 'khxh', tn: 'Lê Phương Địa' }),
    // 2: hai người trùng tên “Ninh Thị Lan Anh” – có mã → đúng người
    thcsRow(2, { oe: em('tv.bgh'), om: 100575, og: 'Ban Giám Hiệu', obsCol: 'bgh', on: 'Nguyễn Thị Kiều', tm: 101210, tg: 'Tổ KHCN', teachCol: 'khcn', tn: 'Ninh Thị Lan Anh' }),
    // 3: trùng tên, mã KHÔNG khớp ai → không ghép (không đoán)
    thcsRow(3, { oe: em('tv.bgh'), om: 100575, og: 'Ban Giám Hiệu', obsCol: 'bgh', on: 'Nguyễn Thị Kiều', tm: 555, tg: 'Tổ KHCN', teachCol: 'khcn', tn: 'Ninh Thị Lan Anh' }),
    // 4: GV THCS trùng tên với GV TiH – chỉ người THCS
    thcsRow(4, { oe: em('pht.thcs'), om: 100193, og: 'Ban Giám Hiệu', obsCol: 'bgh', on: 'Đỗ Thị Thường Trực', tm: null, tg: 'Tổ Ngoại ngữ', teachCol: 'van', tn: 'Trùng Tên Văn' }),
    // 5: một người hai email trong DS THCS (cùng mã) → cả hai email đều thấy
    thcsRow(5, { oe: em('pht.thcs'), om: 100193, og: 'Ban Giám Hiệu', obsCol: 'bgh', on: 'Đỗ Thị Thường Trực', tm: 101506, tg: 'Tổ KHCN', teachCol: 'khcn', tn: 'Trần Hai Thư' }),
    // 6: Ngữ văn – GV có dòng DS cũ “Tổ Xã hội THCS” (không email) và dòng mới “Tổ Ngữ văn THCS”
    thcsRow(6, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: 101465, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Trần Hai Dòng' }),
    // 7, 8: thêm GV Toán để benchmark Tổ Toán đủ 3 người
    thcsRow(7, { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán', tm: 100082, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Phạm Văn Toán Hai' }),
    thcsRow(8, { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán', tm: 100083, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Vũ Thị Toán Ba' }),
    // 9: “Không rõ” tên GV dạy, mã của một người → KHÔNG ghép (thiếu bằng chứng)
    thcsRow(9, { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán', tm: 100081, tg: 'Tổ Toán', teachCol: 'toan', tn: '' }),
  ], 'thcs');
  const levels = {
    tih: { cap: 'tih', enabled: true, ...tih, staffRows: parseStaffTable(tihStaffTable(tihStaff), { cap: 'tih' }).rows },
    thcs: { cap: 'thcs', enabled: true, ...thcs, staffRows: parseStaffTable(thcsStaffTable(thcsStaff), { cap: 'thcs' }).rows },
    thpt: thpt ? { cap: 'thpt', enabled: true, records: [], crit: tih.crit, staffRows: [] } : { cap: 'thpt', enabled: false, records: [], crit: [], staffRows: [] },
  };
  const rolesRows = parseRolesTable(rolesTable(roles)).rows;
  const res = resolveAccess({ levels, rolesRows, env });
  const scopes = buildScopes({ levels, people: res.people, tos: res.tos, recKeys: res.recKeys, rowKey: res.rowKey });
  const scope = id => scopes.find(s => s.id === id);
  const recsOf = id => scope(id).chunks.flatMap(c => JSON.parse(c.data));
  const acc = local => res.access[local.includes('@') ? local : em(local)];
  const pScope = local => scope(`P_${acc(local).roles.person.key}`);
  const pRecs = local => recsOf(`P_${acc(local).roles.person.key}`);
  // phiếu (theo id) mà một email nhận được, kèm quan hệ – [] khi không có quyền / không có phạm vi cá nhân
  const relOf = local => { const a = acc(local); return a?.roles.person ? pRecs(local).map(r => `${r.rel}:${r.id}`).sort() : []; };
  return { levels, res, scopes, scope, recsOf, acc, pScope, pRecs, relOf, tih, thcs };
}

describe('resolveAccess – vai trò TỰ ĐỘNG từ DS Nhân sự', () => {
  const S = scenario();
  test('BGH liên cấp → mọi cấp đang bật (không cần phạm vi tổ)', () => {
    const a = S.acc('tonght');
    assert.equal(a.roles.bghAll, true);
    assert.deepEqual(a.scopes.filter(s => s.startsWith('L_')), ['L_thcs', 'L_tih']);
    assert.ok(!a.scopes.some(s => s.startsWith('T_')));
  });
  test('BGH cấp → CHỈ phạm vi cấp mình (không thấy cấp khác)', () => {
    const t = S.acc('pho.tih');
    assert.deepEqual([t.roles.bghAll, t.roles.bghCaps], [false, ['tih']]);
    assert.ok(t.scopes.includes('L_tih'));
    assert.ok(!t.scopes.includes('L_thcs') && !t.scopes.includes('L_thpt'));
    const c = S.acc('pht.thcs');
    assert.deepEqual(c.roles.bghCaps, ['thcs']);
    assert.ok(c.scopes.includes('L_thcs') && !c.scopes.includes('L_tih'));
    assert.deepEqual(S.acc('chuyen.gia').roles.bghCaps, ['thcs'], 'Liên cấp ở “Ban Giám hiệu THCS” → BGH cấp THCS (không phải liên cấp)');
  });
  test('Tổ trưởng → phạm vi tổ của cấp đó', () => {
    const t = S.acc('totruong1');
    assert.deepEqual(t.roles.toTruong, [{ cap: 'tih', to: 'Tổ 1', label: 'Tổ 1 – Tiểu học' }]);
    assert.ok(t.scopes.includes('T_tih_to-1'));
    assert.ok(!t.scopes.some(s => s.startsWith('L_')));
    assert.deepEqual(S.acc('totruong.khcn').roles.toTruong.map(x => x.to), ['Tổ KHCN']);
    assert.deepEqual(S.acc('totruong.toan').scopes.filter(s => s.startsWith('T_')), ['T_thcs_to-toan']);
  });
  test('Liên cấp, cùng email ở hai DS → MỘT người, tổ trưởng ở cả hai cấp', () => {
    const t = S.acc('the.thao');
    assert.deepEqual(t.roles.toTruong.map(x => `${x.cap}:${x.to}`), ['tih:Tổ Thể thao', 'thcs:Tổ Thể thao']);
    assert.deepEqual(t.scopes.filter(s => s.startsWith('T_')).sort(), ['T_thcs_to-the-thao', 'T_tih_to-the-thao']);
    assert.deepEqual(S.acc('lien.cap').roles.person.caps, ['tih', 'thcs']);
    assert.equal(S.res.people.filter(p => p.email === em('lien.cap')).length, 1);
  });
  test('nhiều vai trò → hợp phạm vi; L_<cấp> đã bao trùm thì không thêm T_', () => {
    const k = S.acc('tv.bgh');
    assert.deepEqual(k.roles.bghCaps, ['thcs']);
    assert.deepEqual(k.roles.toTruong.map(x => x.to), ['Tổ KHCN']);
    assert.deepEqual(k.scopes, ['L_thcs', `P_${k.roles.person.key}`]);
  });
  test('mọi dòng đang làm việc có email → giáo viên (phạm vi cá nhân); không email / đã nghỉ → không có quyền', () => {
    const g = S.acc('gv.hai');
    assert.deepEqual([g.roles.bghAll, g.roles.bghCaps, g.roles.toTruong], [false, [], []]);
    assert.deepEqual(g.scopes, [`P_${g.roles.person.key}`]);
    assert.equal(S.acc('danghi'), undefined);
    assert.equal(S.acc('nghi.thcs'), undefined);
    assert.ok(!Object.values(S.res.access).some(a => a.name === 'Bùi Không Email'));
    assert.equal(S.acc('troly').roles.bghCaps.length, 0);
    assert.equal(S.acc('photo').roles.toTruong.length, 0);
    assert.equal(S.acc('khoi').roles.toTruong.length, 0, 'tổ trưởng khối không phải tổ trưởng');
  });
  test('personKey = hash email (không chứa email); access doc đúng cấu trúc', () => {
    const g = S.acc('gv.hai');
    assert.deepEqual(Object.keys(g).sort(), ['email', 'name', 'roles', 'scopes']);
    assert.ok(!g.roles.person.key.includes('@'));
    assert.match(g.roles.person.key, /^[0-9a-z]+$/);
  });
});

describe('resolveAccess – tab Phân quyền và ADMIN_EMAILS', () => {
  const roles = [
    ['IT@Truong.vn', 'BGH liên cấp', '', '', 'CNTT'],
    [em('gv.hai'), 'BGH cấp', 'THCS, THPT', '', ''],
    [em('gv.anh'), 'Tổ trưởng', 'THCS', 'Tổ Toán THCS', ''],
    ['moi@truong.vn', 'Giáo viên', 'Tiểu học', '', 'GV mới chưa có trong DS'],
    [em('tonght'), 'Không truy cập', '', '', 'thu hồi'],
    [em('admin.it'), 'Không truy cập', '', '', ''],
    ['khong-phai-email', 'BGH cấp', 'THCS', '', ''],
    [em('gv.ba'), 'Quản lý?', 'THCS', '', ''],
    [em('gv.ba'), 'Phó hiệu trưởng', '', '', ''],
    [em('gv.ba'), 'Tổ trưởng', 'THCS', '', ''],
  ];
  const S = scenario({ roles, env: { ADMIN_EMAILS: `Admin.IT@${'hoangmaistarschool.edu.vn'}, boss@x.vn` } });

  test('BGH liên cấp cho email ngoài DS', () => {
    const a = S.acc('it@truong.vn');
    assert.deepEqual([a.roles.bghAll, a.roles.person, a.name], [true, null, '']);
    assert.deepEqual(a.scopes, ['L_thcs', 'L_tih']);
  });
  test('BGH cấp nhiều cấp: cấp chưa kết nối (THPT) có trong roles nhưng không có phạm vi', () => {
    const a = S.acc('gv.hai');
    assert.deepEqual(a.roles.bghCaps, ['thcs', 'thpt']);
    assert.ok(a.scopes.includes('L_thcs'));
    assert.ok(!a.scopes.includes('L_thpt') && !a.scopes.includes('L_tih'));
    assert.ok(a.scopes.includes(`P_${a.roles.person.key}`), 'vẫn giữ phạm vi cá nhân (cộng dồn với quyền tự động)');
  });
  test('Tổ trưởng ghi đè: tên tổ được chuẩn hóa theo cấp', () => {
    const a = S.acc('gv.anh');
    assert.deepEqual(a.roles.toTruong, [{ cap: 'thcs', to: 'Tổ Toán', label: 'Tổ Toán – THCS' }]);
    assert.ok(a.scopes.includes('T_thcs_to-toan'));
  });
  test('Giáo viên ghi đè cho email chưa có trong DS → phạm vi cá nhân', () => {
    const a = S.acc('moi@truong.vn');
    assert.deepEqual(a.roles.person.caps, ['tih']);
    assert.equal(a.scopes.length, 1);
  });
  test('“Không truy cập” thu hồi MỌI quyền (kể cả tự động và ADMIN_EMAILS) – có cảnh báo', () => {
    assert.equal(S.acc('tonght'), undefined);
    assert.equal(S.acc('admin.it'), undefined);
    assert.ok(S.res.warnings.some(w => /ADMIN_EMAILS.*Không truy cập/.test(w)));
    assert.ok(!S.res.people.some(p => p.email === em('tonght')));
    assert.ok(S.recsOf('L_tih').length > 0, 'phiếu của người bị thu hồi quyền vẫn nằm trong dữ liệu cấp');
  });
  test('ADMIN_EMAILS → BGH liên cấp (email viết thường)', () => {
    assert.equal(S.acc('boss@x.vn').roles.bghAll, true);
  });
  test('dòng không hợp lệ → cảnh báo nêu số dòng; vai trò không nhận ra → TẠM THU HỒI quyền của email đó (an toàn)', () => {
    assert.ok(S.res.warnings.some(w => /dòng 8: email/.test(w)));
    assert.ok(S.res.warnings.some(w => /dòng 9: vai trò “Quản lý\?” không hợp lệ.*TẠM THU HỒI/.test(w)));
    assert.ok(S.res.warnings.some(w => /dòng 10: vai trò “BGH cấp” cần cột Cấp/.test(w)));
    assert.ok(S.res.warnings.some(w => /dòng 11: vai trò “Tổ trưởng” cần cột Cấp và cột Tổ/.test(w)));
    assert.equal(S.acc('gv.ba'), undefined, 'gv.ba có dòng vai trò không hợp lệ → không còn quyền nào');
    assert.ok(!S.res.people.some(p => p.email === em('gv.ba')));
  });
  test('parseRoleName / parseRolesTable', () => {
    assert.equal(parseRoleName('BGH liên cấp'), 'bghAll');
    assert.equal(parseRoleName('bgh cap'), 'bghCap');
    assert.equal(parseRoleName('Tổ trưởng'), 'toTruong');
    assert.equal(parseRoleName('Giáo viên'), 'giaoVien');
    assert.equal(parseRoleName('Không truy cập'), 'none');
    for (const w of ['Không được xem', 'Không cho xem', 'Ngừng truy cập', 'Khóa quyền', 'Thu hồi', 'Tạm dừng', 'Chặn']) assert.equal(parseRoleName(w), 'none', w);
    assert.equal(parseRoleName('Hiệu phó'), 'bghCap');
    assert.equal(parseRoleName('???'), '');
    const wrongTab = parseRolesTable({ cols: structuredClone(TIH_FORM_COLS), rows: [] });
    assert.equal(wrongTab.recognized, false, 'gviz trả tab đầu tiên (biểu mẫu) khi sai tên tab → không nhận');
  });
});

describe('Ghép phiếu ↔ người', () => {
  const S = scenario();
  const lessons = local => S.pRecs(local).map(r => `${r.rel}:${r.tn}`).sort();

  test('mã + họ tên khớp → GV dạy (rel t) và người dự (rel o)', () => {
    assert.ok(lessons('gv.hai').includes('t:Phạm Văn Hai'));
    assert.ok(lessons('totruong1').includes('o:Phạm Văn Hai'));
  });
  test('mã GV dạy gõ nhầm thành mã người dự → tin họ tên; người dự KHÔNG bị coi là GV dạy', () => {
    assert.ok(lessons('gv.ba').includes('t:Đỗ Thị Ba'));
    assert.deepEqual(S.pRecs('pho.tih').filter(r => r.tn === 'Đỗ Thị Ba').map(r => r.rel), ['o']);
    assert.deepEqual(S.pRecs('gv.dia').map(r => r.rel), ['t'], 'THCS: Lê Phương Địa (mã gõ nhầm 101601)');
    assert.deepEqual(S.pRecs('gv.su').map(r => r.rel), ['o']);
  });
  test('email người gửi gõ sai → ghép người dự theo mã + họ tên', () => {
    assert.ok(lessons('gv.hai').includes('o:Hoàng Văn Bốn'));
  });
  test('trùng họ tên khác cấp → chỉ người đúng cấp', () => {
    assert.deepEqual(lessons('trung.ten.tih'), ['t:Trùng Tên Văn']);
    assert.deepEqual(S.pRecs('trung.ten.tih').map(r => r.cap), ['tih']);
    assert.deepEqual(S.pRecs('trung.ten.thcs').map(r => r.cap), ['thcs']);
  });
  test('trùng họ tên cùng cấp: có mã → đúng người; mã không khớp → không ghép ai', () => {
    assert.equal(S.pRecs('lananh2').length, 1);
    assert.equal(S.pRecs('lananh1').length, 0);
    const amb = S.res.stats.match.thcs.taughtHow.ambiguous;
    assert.equal(amb, 1);
  });
  test('GV Liên cấp ghép theo tên ở cấp khác; một người hai email → cả hai đều thấy', () => {
    assert.ok(lessons('lien.cap').includes('t:Mai Thị Liên'));
    assert.deepEqual(S.pRecs('hann').map(r => r.tn), ['Nguyễn Hai Mail']);
    assert.deepEqual(S.pRecs('hanh').map(r => r.tn), ['Nguyễn Hai Mail']);
    assert.equal(S.pRecs('thu.a').length, 1);
    assert.equal(S.pRecs('thu.b').length, 1);
  });
  test('không có họ tên GV dạy → không ghép dù mã khớp; GV không có trong DS → không ghép', () => {
    assert.deepEqual(S.pRecs('gv.anh').map(r => r.tn), ['Đỗ Thị Ánh']);
    assert.ok(S.res.stats.match.tih.unmatchedTeachers['Người Mới Toanh'] === 1);
  });
  test('makeMatcher: mã khớp + tên gõ sai nhưng cùng tên gọi → ghép; khác tên gọi → không', () => {
    const { resolve } = makeMatcher([human('Lò Thị Hoa', '1')]);
    assert.equal(resolve('tih', '1', 'Lo Thi Hoa').how, 'ma+name', 'không dấu vẫn khớp (cách viết bỏ dấu là duy nhất)');
    assert.equal(resolve('tih', '1', 'Lò Thị Hoà').how, 'ma+name', 'vị trí dấu thanh khác (hoà/hòa) vẫn khớp');
    assert.equal(resolve('tih', '1', 'Lò T. Hoa').how, 'ma');
    assert.equal(resolve('tih', '1', 'Trần Văn Nam').how, 'none');
    assert.equal(resolve('thcs', '', 'Lò Thị Hoa').how, 'none', 'tên khớp nhưng khác cấp');
  });
});

describe('Phạm vi – nội dung và quyền riêng tư', () => {
  const S = scenario();
  test('L_<cấp>: đủ phiếu của cấp, đủ trường (email/mã) cho BGH; độ phủ bỏ BGH, người nghỉ, dòng trùng, dòng cấp khác', () => {
    const recs = S.recsOf('L_thcs');
    assert.equal(recs.length, S.thcs.records.length);
    assert.ok(recs.every(r => r.cap === 'thcs'));
    assert.ok(recs.some(r => r.oe && r.om && r.tm));
    const doc = S.scope('L_thcs').doc;
    assert.deepEqual([doc.kind, doc.cap, doc.label, doc.color], ['level', 'thcs', 'THCS', '#2da037']);
    const names = doc.staff.map(s => s.name);
    assert.ok(!names.includes('Đinh Đã Nghỉ') && !names.includes('Trịnh Cấp Ba') && !names.includes('Đỗ Thị Thường Trực'));
    assert.equal(names.filter(n => n === 'Trần Hai Dòng').length, 1, 'người có 2 dòng DS chỉ tính một lần');
    assert.equal(doc.staff.find(s => s.name === 'Trần Hai Dòng').group, 'Tổ Ngữ văn');
    assert.ok(doc.bgh.some(b => b.name === 'Đỗ Thị Thường Trực'));
    assert.deepEqual(Object.keys(doc).sort(), ['bgh', 'cap', 'chunkIds', 'color', 'count', 'crit', 'hash', 'kind', 'label', 'sheetUrl', 'staff']);
  });
  test('T_<cấp>_<tổ>: CHỈ phiếu của tổ đó, nhân sự của tổ đó', () => {
    for (const s of S.scopes.filter(x => x.doc.kind === 'to')) {
      const recs = S.recsOf(s.id);
      assert.ok(recs.every(r => r.tg === s.doc.to && r.cap === s.doc.cap), s.id);
      assert.ok(s.doc.staff.every(m => m.group === s.doc.to), s.id);
    }
    const t1 = S.recsOf('T_tih_to-1');
    assert.deepEqual([...new Set(t1.map(r => r.tn))].sort(), ['Lý Văn Sáu', 'Phạm Văn Hai', 'Đỗ Thị Ba'].sort());
    assert.ok(!t1.some(r => r.tg === 'Tổ Tiếng Anh'));
    assert.deepEqual(S.scope('T_tih_to-1').doc.label, 'Tổ 1 – Tiểu học');
  });
  test('P_: giáo viên KHÔNG thấy tiết dạy của giáo viên khác (trừ phiếu chính mình đi dự)', () => {
    for (const p of S.res.people) {
      const recs = S.recsOf(`P_${p.key}`);
      for (const r of recs) {
        const taughtByMe = p.names.has(fold(r.tn));
        const observedByMe = r.oe === p.email || p.names.has(fold(r.on));
        assert.ok(taughtByMe || observedByMe, `${p.email} thấy phiếu không liên quan: ${r.tn} / ${r.on}`);
        if (r.rel === 't') assert.ok(taughtByMe, `${p.email}: rel t nhưng không phải tiết của mình`);
        if (r.rel === 'o') assert.ok(observedByMe, `${p.email}: rel o nhưng không phải người dự`);
      }
    }
    assert.ok(!S.pRecs('gv.hai').some(r => r.tn === 'Đỗ Thị Ba'), 'cùng tổ nhưng không thấy tiết của đồng nghiệp');
  });
  test('P_: xóa email/mã của người khác, giữ của chính mình', () => {
    for (const p of S.res.people) {
      for (const r of S.recsOf(`P_${p.key}`)) {
        assert.ok(!r.oe || r.oe === p.email, `${p.email}: lộ email ${r.oe}`);
        assert.ok(!r.om || p.mas.has(r.om), `${p.email}: lộ mã người dự ${r.om}`);
        assert.ok(!r.tm || p.mas.has(r.tm), `${p.email}: lộ mã GV dạy ${r.tm}`);
      }
    }
    const t = S.pRecs('gv.hai').find(r => r.rel === 't');
    assert.deepEqual([t.oe, t.om, t.tm], ['', '', '100131']);
    const o = S.pRecs('totruong1').find(r => r.rel === 'o');
    assert.deepEqual([o.oe, o.om, o.tm], [em('totruong1'), '100130', '']);
    const ba = S.pRecs('gv.ba')[0];
    assert.equal(ba.tm, '', 'mã gõ nhầm (của người dự) không được đưa cho GV dạy');
  });
  test('P_: benchmark ẩn danh của cấp và tổ; tổ < 3 GV → không công bố điểm', () => {
    const d = S.pScope('gv.hai').doc;
    assert.deepEqual([d.kind, d.caps, d.tos], ['person', ['tih'], { tih: ['Tổ 1'] }]);
    assert.deepEqual(Object.keys(d.crit), ['tih']);
    const lb = d.benchmarks.levels.tih;
    assert.ok(lb.n >= 9 && lb.teachers >= 3 && typeof lb.avg === 'number' && lb.crit.length === 3);
    assert.equal(typeof d.benchmarks.tos.tih['Tổ 1'].avg, 'number');
    const kx = S.pScope('gv.dia').doc.benchmarks.tos.thcs['Tổ KHXH'];
    assert.deepEqual([kx.suppressed, 'avg' in kx, kx.teachers], [true, false, 1], 'Tổ KHXH (THCS) chỉ có 1 GV được dự → không lộ điểm của người đó');
    assert.equal(typeof S.pScope('gv.bon').doc.benchmarks.tos.tih['Tổ Tiếng Anh'].avg, 'number', 'Tổ Tiếng Anh có 3 GV được dự');
    assert.ok(!JSON.stringify(d.benchmarks).includes('@'));
  });
  test('BGH: phạm vi cá nhân không có tổ', () => {
    assert.deepEqual(S.pScope('pho.tih').doc.tos, { tih: [] });
  });
  test('benchmark(): trung bình theo phiếu, lĩnh vực, tiêu chí, phân loại', () => {
    const crit = [{ code: '1.1', d: 1 }, { code: '1.2', d: 1 }, { code: '5.1', d: 5 }];
    const recs = [{ tn: 'A', sc: [5, 5, 5] }, { tn: 'B', sc: [3, 3, null] }, { tn: 'C', sc: [4, null, 2] }];
    const b = benchmark(recs, crit);
    assert.deepEqual([b.n, b.teachers, b.avg], [3, 3, 3.667]);
    assert.deepEqual(b.dom, { 1: 4, 2: null, 3: null, 4: null, 5: 3.5 });
    assert.deepEqual(b.crit, [4, 4, 3.5]);
    assert.deepEqual(b.dist, { tot: 1, dat: 0, chua: 2, nguy: 0 }, 'TB 5 → Tốt; TB 3 → Chưa đạt (2,6 – dưới 3,4)');
    assert.deepEqual(benchmark(recs.slice(0, 2), crit), { n: 2, teachers: 2, suppressed: true });
    assert.equal(MIN_BENCH_TEACHERS, 3);
  });
  test('hash phạm vi ổn định; đổi nội dung → đổi hash', () => {
    const again = buildScopes({ levels: S.levels, people: S.res.people, tos: S.res.tos, recKeys: S.res.recKeys, rowKey: S.res.rowKey });
    assert.deepEqual(again.map(s => s.doc.hash), S.scopes.map(s => s.doc.hash));
    const lv = structuredClone(S.levels.thcs);
    lv.records[0].pros = 'đã sửa';
    const changed = buildScopes({ levels: { ...S.levels, thcs: lv }, people: S.res.people, tos: S.res.tos, recKeys: S.res.recKeys, rowKey: S.res.rowKey });
    assert.notEqual(changed.find(s => s.id === 'L_thcs').doc.hash, S.scope('L_thcs').doc.hash);
    assert.equal(changed.find(s => s.id === 'L_tih').doc.hash, S.scope('L_tih').doc.hash);
  });
  test('cấp chưa kết nối → không có phạm vi; personRecord / levelStaff', () => {
    assert.ok(!S.scopes.some(s => s.id === 'L_thpt'));
    const p = { email: 'a@x.vn', mas: new Set(['1']) };
    assert.deepEqual(personRecord({ id: 'r', oe: 'b@x.vn', om: '2', tm: '1' }, 't', p), { id: 'r', oe: '', om: '', tm: '1', rel: 't' });
    const { staff, bgh } = levelStaff([{ name: 'A', to: TO_BGH, active: true, caps: [] }, { name: 'B', to: 'Tổ 1', active: false, caps: [] }, { name: 'C', to: 'Tổ 2', active: true, caps: ['thcs'] }], 'tih');
    assert.deepEqual([staff, bgh.map(b => b.name)], [[], ['A']]);
    assert.equal(scopeIdTo('thcs', 'Tổ Ngữ văn'), 'T_thcs_to-ngu-van');
  });
});

describe('Tổ thực tế (DS Nhân sự lạc hậu so với biểu mẫu)', () => {
  const m = (cap, tg, og, rel) => ({ rec: { cap, tg, og }, rel });
  test('biểu mẫu từng ghi đúng tổ trong DS → giữ tổ của DS', () => {
    assert.equal(effectiveTo([m('thcs', 'Tổ Ngữ văn', '', 't'), m('thcs', 'Tổ Ngữ văn', '', 't'), m('thcs', 'Tổ KHXH', '', 't')], 'thcs', ['Tổ KHXH']), 'Tổ KHXH');
  });
  test('biểu mẫu CHƯA BAO GIỜ ghi tổ của DS → tổ ghi nhiều nhất trong biểu mẫu', () => {
    assert.equal(effectiveTo([m('thcs', 'Tổ Ngữ văn', '', 't'), m('thcs', 'Tổ Ngữ văn', '', 'to'), m('thcs', 'Tổ Toán', '', 't')], 'thcs', ['Tổ KHXH']), 'Tổ Ngữ văn');
  });
  test('chưa được dự → theo tổ khi đi dự; chưa có phiếu → tổ trong DS; bỏ BGH và cấp khác', () => {
    assert.equal(effectiveTo([m('thcs', 'Tổ Toán', 'Tổ Ngữ văn', 'o')], 'thcs', ['Tổ KHXH']), 'Tổ Ngữ văn');
    assert.equal(effectiveTo([m('tih', 'Tổ 1', '', 't')], 'thcs', ['Tổ KHXH']), 'Tổ KHXH');
    assert.equal(effectiveTo([m('thcs', 'Tổ Toán', TO_BGH, 'o')], 'thcs', []), '');
    assert.equal(effectiveTo([], 'thcs', 'Tổ Toán'), 'Tổ Toán');
  });
  test('độ phủ của phạm vi cấp dùng tổ thực tế', () => {
    const S = scenario({
      thcsRows: [thcsRow(0, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: 100655, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Nguyễn Thị Khối' })],
    });
    const staff = S.scope('L_thcs').doc.staff;
    assert.equal(staff.find(x => x.name === 'Nguyễn Thị Khối').group, 'Tổ Ngữ văn', 'DS ghi “Tổ Xã hội THCS”, biểu mẫu ghi “Tổ Ngữ văn”');
    assert.equal(staff.find(x => x.name === 'Lê Phương Địa').group, 'Tổ KHXH', 'chưa có phiếu → giữ tổ của DS');
    assert.ok(S.scope('T_thcs_to-ngu-van').doc.staff.some(x => x.name === 'Nguyễn Thị Khối'));
  });
});

/* =====================================================================
 * Hồi quy – các phát hiện của vòng rà soát bảo mật / tích hợp (mỗi phát hiện về quyền truy cập có ít nhất một kiểm thử)
 * ===================================================================== */
describe('Hồi quy – họ tên GV dạy TRÙNG họ tên người dự (điền nhầm một ô)', () => {
  const one = { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một' };
  const S = scenario({
    tihRows: [
      // 0: người dự Một (email + mã) chép tên mình vào ô GV dạy; mã GV dạy = Phạm Văn Hai → GV dạy = Hai, người dự = Một
      tihRow(0, { ...one, tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Nguyễn Thị Một' }),
      // 1: người dự (email pho.tih) chép tên GV dạy vào ô người dự; mã GV dạy = Hai → GV dạy = Hai, người dự = Phó HT
      tihRow(1, { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Phạm Văn Hai', tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
      // 2: như 0 nhưng không có mã GV dạy → không biết ai dạy (không đoán), người dự = Một
      tihRow(2, { ...one, tm: null, tg: 'Tổ 1', teachCol: 'to1', tn: 'Nguyễn Thị Một' }),
      // 3: mã GV dạy = Lý Văn Sáu (cùng tổ với tổ GV dạy trên phiếu) → Sáu; Hai (tên bị chép) không nhận gì
      tihRow(3, { ...one, on: 'Phạm Văn Hai', tm: 100136, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
      // 4: mã GV dạy thuộc người tổ khác (Hoàng Văn Bốn – Tổ Tiếng Anh) mà tổ GV dạy trên phiếu là Tổ 1 → không ghép GV dạy
      tihRow(4, { ...one, tm: 100133, tg: 'Tổ 1', teachCol: 'to1', tn: 'Nguyễn Thị Một' }),
    ],
  });
  const ids = S.tih.records.map(r => r.id); // đã sắp theo thời gian gửi = thứ tự dòng
  test('không bao giờ gán “to” (vừa dạy vừa dự) chỉ vì một họ tên bị chép sang ô kia', () => {
    for (const p of S.res.people) for (const r of S.recsOf(`P_${p.key}`)) assert.notEqual(r.rel, 'to', `${p.email}: ${r.tn}`);
  });
  test('GV dạy theo mã GV dạy, người dự theo email/mã người dự', () => {
    assert.deepEqual(S.relOf('gv.hai'), [`t:${ids[0]}`, `t:${ids[1]}`].sort());
    assert.deepEqual(S.relOf('totruong1'), [`o:${ids[0]}`, `o:${ids[2]}`, `o:${ids[3]}`, `o:${ids[4]}`].sort());
    assert.deepEqual(S.relOf('pho.tih'), [`o:${ids[1]}`]);
    assert.deepEqual(S.relOf('gv.sau'), [`t:${ids[3]}`]);
    assert.deepEqual(S.relOf('gv.bon'), [], 'mã của người tổ khác (không khớp tổ GV dạy) → không đưa phiếu cho người đó');
    assert.equal(S.res.stats.match.tih.taughtHow['shared-name'], 2);
  });
});

describe('Hồi quy – người không còn quyền vẫn “giữ” phiếu của mình (không rơi sang đồng nghiệp trùng họ tên)', () => {
  const TRANG2 = [100476, 'Lương Thu Trang', 'Tiểu học', 'Tổ 3', 'GVCN 3A1', em('tranglt2')];
  const TRANG5 = [101221, 'Lương Thu Trang', 'Tiểu học', 'Tổ 4', 'GVCN 4A1', em('tranglt5')];
  const rows = [
    // Trang (mã 100476) đi dự Hai và Sáu; được dự 1 tiết; một phiếu chỉ ghi họ tên (không mã, không email)
    tihRow(0, { oe: em('tranglt2'), om: 100476, og: 'Tổ 3', obsCol: 'to1', on: 'Lương Thu Trang', tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
    tihRow(1, { oe: em('tranglt2'), om: 100476, og: 'Tổ 3', obsCol: 'to1', on: 'Lương Thu Trang', tm: 100136, tg: 'Tổ 1', teachCol: 'to1', tn: 'Lý Văn Sáu' }),
    tihRow(2, { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100476, tg: 'Tổ 3', teachCol: 'to1', tn: 'Lương Thu Trang' }),
    tihRow(3, { oe: '', om: null, og: 'Tổ 3', obsCol: 'to1', on: 'Lương Thu Trang', tm: 100132, tg: 'Tổ 1', teachCol: 'to1', tn: 'Đỗ Thị Ba' }),
  ];
  const base = scenario({ tihRows: rows, tihStaff: [...TIH_STAFF_ROWS, TRANG2, TRANG5] });
  test('bình thường: mỗi người đúng phiếu của mình; phiếu chỉ có họ tên trùng → không ai nhận', () => {
    assert.equal(base.relOf('tranglt2').length, 3);
    assert.deepEqual(base.relOf('tranglt5'), []);
  });
  const variants = {
    'bị “Không truy cập” trong tab Phân quyền': scenario({ tihRows: rows, tihStaff: [...TIH_STAFF_ROWS, TRANG2, TRANG5], roles: [[em('tranglt2'), 'Không truy cập', '', '', '']] }),
    'ghi chú “Nghỉ việc”': scenario({ tihRows: rows, tihStaff: [...TIH_STAFF_ROWS, [...TRANG2, '', 'Nghỉ việc từ 10/2026'], TRANG5] }),
    'dòng DS không có email': scenario({ tihRows: rows, tihStaff: [...TIH_STAFF_ROWS, [...TRANG2.slice(0, 5), ''], TRANG5] }),
  };
  for (const [what, S] of Object.entries(variants)) {
    test(`người trùng tên ${what} → đồng nghiệp trùng tên KHÔNG nhận thêm phiếu nào`, () => {
      assert.equal(S.acc('tranglt2'), undefined);
      assert.deepEqual(S.relOf('tranglt5'), [], 'phạm vi cá nhân của tranglt5 không đổi');
      assert.ok(S.res.stats.match.tih.heldBack >= 3);
      assert.equal(S.recsOf('L_tih').length, rows.length, 'phiếu vẫn nằm trong dữ liệu cấp (BGH)');
    });
  }
});

describe('Hồi quy – họ tên chỉ khác dấu thanh (Thúy ≠ Thùy)', () => {
  const S = scenario({
    tihStaff: [...TIH_STAFF_ROWS,
      [101047, 'Vương Thị Thúy', 'Tiểu học', 'Tổ 2', 'GVCN 2A5', em('thuyvt'), '', 'Nghỉ sinh'],
      [101207, 'Vương Thị Thùy', 'Tiểu học', 'Tổ 2', 'GVCN 2A4', em('thuyvt5')]],
    tihRows: [
      tihRow(0, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: 101047, tg: 'Tổ 2', teachCol: 'to1', tn: 'Vương Thị Thúy' }),
      tihRow(1, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: null, tg: 'Tổ 2', teachCol: 'to1', tn: 'Vương Thị Thúy' }),
      tihRow(2, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: null, tg: 'Tổ 2', teachCol: 'to1', tn: 'Vuong Thi Thuy' }),
      tihRow(3, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: 101207, tg: 'Tổ 2', teachCol: 'to1', tn: 'Vương Thị Thùy' }),
      tihRow(4, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: null, tg: 'Tổ 2', teachCol: 'to1', tn: 'Vương Thị Thuỳ' }),
    ],
  });
  test('tiết của “Vương Thị Thúy” (đã nghỉ) không vào hồ sơ của “Vương Thị Thùy”; viết không dấu (mơ hồ) → không ghép', () => {
    const ids = S.tih.records.map(r => r.id);
    assert.deepEqual(S.relOf('thuyvt5'), [`t:${ids[3]}`, `t:${ids[4]}`].sort(), 'chỉ tiết ghi đúng “Thùy” (kể cả kiểu đặt dấu “Thuỳ”)');
  });
});

describe('Hồi quy – một email ghi cho hai người khác nhau trong DS Nhân sự', () => {
  const S = scenario({
    tihStaff: [
      [101348, 'Trịnh Thảo Nguyên', 'Tiểu học', 'Thỉnh giảng', 'GV Văn Hóa đọc', em('nguyettt')], // dòng sai email, đứng TRƯỚC
      ...TIH_STAFF_ROWS,
      [100085, 'Trịnh Thị Nguyệt', 'Tiểu học', 'Tổ Năng khiếu', 'Tổ trưởng', em('nguyettt')],
      [101349, 'Lê Văn Khác', 'Tiểu học', 'Tổ 5', 'Tổ trưởng', em('gv.hai')], // trùng email với Phạm Văn Hai, không khớp mẫu email
    ],
    tihRows: [
      tihRow(0, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: 101348, tg: 'Giáo viên thỉnh giảng', teachCol: 'tg', tn: 'Trịnh Thảo Nguyên' }),
      tihRow(1, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: 100085, tg: 'Tổ Năng khiếu', teachCol: 'to1', tn: 'Trịnh Thị Nguyệt' }),
      tihRow(2, { oe: em('totruong1'), om: 100130, on: 'Nguyễn Thị Một', tm: 101349, tg: 'Tổ 5', teachCol: 'to1', tn: 'Lê Văn Khác' }),
    ],
  });
  const ids = S.tih.records.map(r => r.id);
  test('email thuộc người có họ tên khớp mẫu email; người còn lại không được gắn email đó + cảnh báo', () => {
    const a = S.acc('nguyettt');
    assert.equal(a.name, 'Trịnh Thị Nguyệt');
    assert.deepEqual(a.roles.toTruong.map(t => t.to), ['Tổ Năng khiếu']);
    assert.deepEqual(S.relOf('nguyettt'), [`t:${ids[1]}`], 'tiết của Trịnh Thảo Nguyên KHÔNG vào hồ sơ của chủ email');
    assert.ok(!S.res.people.find(p => p.email === em('nguyettt')).mas.has('101348'));
    assert.ok(S.res.warnings.some(w => /nguyettt@.*2 người khác nhau.*Trịnh Thảo Nguyên/.test(w)));
  });
  test('vai trò của dòng mang email “mượn” không được cấp cho chủ email', () => {
    const a = S.acc('gv.hai');
    assert.equal(a.name, 'Phạm Văn Hai');
    assert.deepEqual(a.roles.toTruong, [], 'Lê Văn Khác là tổ trưởng nhưng email thuộc Phạm Văn Hai');
    assert.ok(!S.relOf('gv.hai').includes(`t:${ids[2]}`));
  });
});

describe('Hồi quy – hai người dùng chung MỘT mã nhân sự', () => {
  const S = scenario({
    thcsStaff: [...THCS_STAFF_ROWS,
      [101016, 'Tạ Trí Cao', 'THCS', 'Tổ Toán THCS', 'Giáo viên Toán', em('caott')],
      [101016, 'Kiều Tùng Lâm', 'THCS', 'Tổ KHCN THCS', 'Giáo viên Lý', em('lamkt')]],
    thcsRows: [
      thcsRow(0, { oe: em('totruong.toan'), om: 101608, on: 'Nguyễn Thị Toán', tm: 101016, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Tạ Chí Cao' }), // họ tên gõ sai
      thcsRow(1, { oe: em('totruong.toan'), om: 101608, on: 'Nguyễn Thị Toán', tm: 101016, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Tạ Trí Cao' }),
    ],
  });
  test('mã dùng chung + họ tên gõ sai → không ghép (không đưa cho cả hai); họ tên đúng → đúng một người', () => {
    const ids = S.thcs.records.map(r => r.id);
    assert.deepEqual(S.relOf('caott'), [`t:${ids[1]}`]);
    assert.deepEqual(S.relOf('lamkt'), []);
  });
});

describe('Hồi quy – vai trò theo cột Cấp của dòng, chức danh không phải lãnh đạo', () => {
  const S = scenario({
    thpt: true,
    thcsStaff: [...THCS_STAFF_ROWS,
      [100990, 'Phạm Phó Ba', 'THPT', 'Ban Giám hiệu THPT', 'Phó Hiệu trưởng', em('pht.thpt')],
      [100991, 'Lê Tổ Ba', 'THPT', 'Tổ Toán THPT', 'Tổ trưởng', em('tt.thpt')],
      [100992, 'Vũ Văn Thư', 'THCS', 'Ban Giám hiệu THCS', 'Văn thư', em('vanthu')],
      [100993, 'Hà Công Đoàn', 'THCS', 'Tổ Toán THCS', 'Tổ trưởng công đoàn - GV Toán', em('congdoan')],
      [100994, 'Trần Nguyên Tổ', 'THCS', 'Tổ Toán THCS', 'Nguyên Tổ trưởng, GV Toán', em('nguyento')]],
  });
  test('dòng ghi Cấp “THPT” trong Sheet THCS → không tự nhận quyền BGH/tổ trưởng của THCS hay THPT (cảnh báo)', () => {
    for (const e of ['pht.thpt', 'tt.thpt']) {
      const a = S.acc(e);
      assert.deepEqual([a.roles.bghAll, a.roles.bghCaps, a.roles.toTruong], [false, [], []], e);
      assert.ok(!a.scopes.some(x => x.startsWith('L_') || x.startsWith('T_')), e);
      assert.ok(a.roles.person, `${e} vẫn xem được dữ liệu của chính mình`);
    }
    assert.ok(S.res.warnings.some(w => /Phạm Phó Ba ghi Cấp “THPT”.*không tự cấp vai trò lãnh đạo/.test(w)));
  });
  test('văn thư thuộc BGH, tổ trưởng công đoàn, “nguyên tổ trưởng” → không có quyền lãnh đạo', () => {
    for (const e of ['vanthu', 'congdoan', 'nguyento']) {
      const a = S.acc(e);
      assert.deepEqual([a.roles.bghAll, a.roles.bghCaps, a.roles.toTruong], [false, [], []], e);
    }
  });
});

describe('Hồi quy – thu hồi viết khác chữ (không nhận ra vai trò) vẫn thu hồi', () => {
  const S = scenario({ roles: [[em('gv.hai'), 'Không được xem', '', '', ''], [em('gv.sau'), 'Ngừng truy cập', '', '', ''], [em('gv.ba'), 'Xoá?', '', '', ''], [em('totruong1'), 'Tạm dừng', '', '', '']] });
  test('mọi cách viết thu hồi / vai trò lạ → không còn quyền', () => {
    for (const e of ['gv.hai', 'gv.sau', 'gv.ba', 'totruong1']) assert.equal(S.acc(e), undefined, e);
    assert.ok(S.recsOf('L_tih').length > 0);
  });
});

describe('Hồi quy – người dự: email người gửi phiếu là chính', () => {
  const S = scenario({
    tihRows: [
      // email + mã người dự = Phạm Văn Hai, ô họ tên người dự ghi Lý Văn Sáu → chỉ Hai là người dự
      tihRow(0, { oe: em('gv.hai'), om: 100131, og: 'Tổ 1', obsCol: 'to1', on: 'Lý Văn Sáu', tm: 100132, tg: 'Tổ 1', teachCol: 'to1', tn: 'Đỗ Thị Ba' }),
      // email = Hai, mã + họ tên người dự cùng chỉ Nguyễn Thị Một (người gửi hộ) → cả hai
      tihRow(1, { oe: em('gv.hai'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một', tm: 100132, tg: 'Tổ 1', teachCol: 'to1', tn: 'Đỗ Thị Ba' }),
    ],
  });
  test('họ tên người dự mâu thuẫn với email + mã → không đưa phiếu cho người được nêu tên', () => {
    const ids = S.tih.records.map(r => r.id);
    assert.deepEqual(S.relOf('gv.sau'), []);
    assert.deepEqual(S.relOf('gv.hai'), [`o:${ids[0]}`, `o:${ids[1]}`].sort());
    assert.deepEqual(S.relOf('totruong1'), [`o:${ids[1]}`]);
  });
});

describe('Hồi quy – hai GV TRÙNG họ tên trong cùng tổ không bị gộp ở phạm vi cấp/tổ', () => {
  const S = scenario({
    thcsStaff: [...THCS_STAFF_ROWS,
      [101612, 'Mạc Thị Yến', 'THCS', 'Tổ Ngữ văn THCS', 'Giáo viên Ngữ văn', em('yenmt2')],
      [101228, 'Mạc Thị Yến', 'THCS', 'Tổ Ngữ văn THCS', 'Giáo viên Ngữ văn', em('yenmt3')]],
    thcsRows: [
      thcsRow(0, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: 101612, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Mạc Thị Yến' }),
      thcsRow(1, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: 101612, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Mạc Thị Yến' }),
      thcsRow(2, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: 101228, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Mạc Thị Yến' }),
      thcsRow(3, { oe: em('totruong.van'), om: 101611, og: 'Tổ Ngữ văn', obsCol: 'van', on: 'Nguyễn Thị Văn', tm: null, tg: 'Tổ Ngữ văn', teachCol: 'van', tn: 'Mạc Thị Yến' }),
    ],
  });
  test('phiếu trong L_/T_ mang khóa nhân thân (tp) khác nhau; danh sách nhân sự có khóa k tương ứng; phiếu mơ hồ không có khóa', () => {
    const recs = S.recsOf('L_thcs');
    const tp = recs.map(r => r.tp);
    assert.ok(tp[0] && tp[0] === tp[1] && tp[2] && tp[2] !== tp[0] && tp[3] === '');
    const crit = S.scope('L_thcs').doc.crit;
    const keys = new Set(recs.slice(0, 3).map(r => hydrate(r, crit).tk));
    assert.equal(keys.size, 2, 'dashboard (hydrate) tách thành 2 giáo viên');
    const yen = S.scope('L_thcs').doc.staff.filter(s => s.name === 'Mạc Thị Yến').map(s => s.k).sort();
    assert.deepEqual(yen, [tp[0], tp[2]].sort());
    assert.ok(S.recsOf('T_thcs_to-ngu-van').every(r => 'tp' in r), 'phạm vi tổ cũng có khóa');
  });
  test('phạm vi cá nhân không có tp/op; mỗi người đúng tiết của mình', () => {
    const ids = S.thcs.records.map(r => r.id);
    assert.deepEqual(S.relOf('yenmt2'), [`t:${ids[0]}`, `t:${ids[1]}`].sort());
    assert.deepEqual(S.relOf('yenmt3'), [`t:${ids[2]}`]);
    for (const p of S.res.people) for (const r of S.recsOf(`P_${p.key}`)) assert.ok(!('tp' in r) && !('op' in r));
  });
});

describe('Hồi quy – số liệu đối sánh không cho phép suy ra điểm của MỘT tiết dạy', () => {
  const crit = [{ code: '1.1', d: 1 }, { code: '2.1', d: 2 }, { code: '5.1', d: 5 }];
  let seq = 0;
  const rec = (ts, tn, sc) => ({ id: `r${seq++}`, ts, day: ts.slice(0, 10), tn, tg: 'Tổ 1', sc });
  const W1 = '2026-09-07 08:00:00', W2 = '2026-09-14 08:00:00', W3 = '2026-09-21 08:00:00';
  const base = [
    rec(W1, 'A', [4, 4, 5]), rec(W1, 'B', [3, 4, 4]), rec(W1, 'C', [5, 5, 5]), rec(W1, 'D', [2, 3, 3]), rec(W1, 'E', [4, 3, 4]), rec(W1, 'A', [4, 5, 4]),
  ];
  const cut = d => benchCutoff(Date.parse(d + 'T03:00:00Z')); // 10:00 giờ VN
  const pub = (records, prev, day) => publishBenchmarks({ groups: [{ id: 'g', records, crit }], prev, cutoff: cut(day) });
  test('mốc chốt = 00:00 thứ Hai tuần hiện tại (giờ VN); năm học từ 01/08', () => {
    assert.deepEqual(benchCutoff(Date.parse('2026-10-07T03:00:00Z')), { at: '2026-10-05 00:00:00', sy: 2026, syStart: '2026-08-01' });
    assert.deepEqual(benchCutoff(Date.parse('2026-10-04T18:30:00Z')), { at: '2026-10-05 00:00:00', sy: 2026, syStart: '2026-08-01' }, 'thứ Hai 01:30 giờ VN');
    assert.equal(benchCutoff(Date.parse('2026-08-02T03:00:00Z')).sy, 2025, 'tuần chốt cuối cùng còn thuộc năm học trước');
  });
  test('thêm MỘT phiếu (kể cả sang tuần mới) → số công bố GIỮ NGUYÊN, không suy ra được điểm phiếu đó', () => {
    const p1 = pub(base, {}, '2026-09-16');
    assert.equal(p1.bench.g.n, 6);
    const extra = rec(W2, 'B', [1, 1, 1]);
    const p2 = pub([...base, extra], p1.state, '2026-09-23');
    assert.deepEqual(p2.bench.g, p1.bench.g, 'số liệu không đổi');
    assert.deepEqual(p2.state.g, p1.state.g, 'trạng thái giữ mốc công bố cũ');
    // Kẻ tấn công lấy hiệu hai lần công bố:
    const guess = p2.bench.g.crit.map((a, j) => Math.round(a * 7 - p1.bench.g.crit[j] * 6));
    assert.notDeepEqual(guess, extra.sc);
  });
  test('đủ ≥ 5 phiếu mới của ≥ 3 GV → công bố lại; số liệu làm tròn 0,1, tỷ lệ làm tròn 5 %, không có số đếm từng loại', () => {
    const p1 = pub(base, {}, '2026-09-16');
    const more = [rec(W2, 'B', [5, 5, 5]), rec(W2, 'C', [4, 4, 4]), rec(W2, 'D', [3, 3, 3]), rec(W2, 'B', [5, 4, 5])];
    const p2 = pub([...base, ...more], p1.state, '2026-09-23');
    assert.deepEqual(p2.bench.g, p1.bench.g, '4 phiếu mới → chưa đủ');
    const p3 = pub([...base, ...more, rec(W3, 'E', [4, 4, 4])], p2.state, '2026-09-30');
    assert.notDeepEqual(p3.bench.g, p1.bench.g);
    assert.equal(p3.bench.g.n, 11);
    const b = p3.bench.g;
    for (const x of [b.avg, ...Object.values(b.dom).filter(v => v != null), ...b.crit]) assert.equal(Math.round(x * 10) / 10, x);
    for (const v of Object.values(b.pct)) assert.equal(v % 5, 0);
    assert.ok(!('dist' in b));
    assert.equal(b.asOf, '2026-09-28');
  });
  test('đổi thang xếp loại → số liệu đã chốt theo thang cũ được tính lại ngay (không chờ phiếu mới)', () => {
    const p1 = pub(base, {}, '2026-09-16');
    assert.equal(p1.state.g.lv, LEVELS_SIG);
    const old = { g: { ...p1.state.g, lv: undefined, b: { ...p1.state.g.b, pct: { tot: 100, kha: 0, dat: 0, chua: 0 } } } }; // trạng thái lưu từ bản cũ
    const p2 = pub(base, old, '2026-09-23');
    assert.equal(p2.state.g.lv, LEVELS_SIG);
    assert.deepEqual(Object.keys(p2.bench.g.pct), LEVELS.map(l => l.key));
    assert.equal(p2.bench.g.asOf, '2026-09-21', 'chốt lại ở mốc hiện tại');
    assert.deepEqual(pub(base, p2.state, '2026-09-30').bench.g, p2.bench.g, 'sau đó giữ nguyên như thường');
  });
  test('5 phiếu mới nhưng chỉ của 1–2 GV → chưa công bố lại', () => {
    const p1 = pub(base, {}, '2026-09-16');
    const same = [1, 2, 3, 4, 5].map(i => rec(W2, i % 2 ? 'B' : 'C', [i % 5 + 1, 3, 3]));
    assert.deepEqual(pub([...base, ...same], p1.state, '2026-09-23').bench.g, p1.bench.g);
  });
  test('phiếu của tuần hiện tại (chưa chốt) và của năm học trước không được tính', () => {
    const p = pub([...base, rec('2026-09-16 07:00:00', 'Z', [1, 1, 1]), rec('2026-05-05 07:00:00', 'Y', [1, 1, 1])], {}, '2026-09-16');
    assert.equal(p.bench.g.n, 6);
  });
  test('nhóm < 3 GV hoặc < 5 phiếu → không công bố điểm', () => {
    assert.deepEqual(coarseBench({ n: 4, teachers: 3, avg: 4, dom: {}, crit: [], dist: { tot: 0, dat: 4, chua: 0, nguy: 0 } }), { n: 4, teachers: 3, suppressed: true });
    const p = pub(base.slice(0, 2), {}, '2026-09-16');
    assert.equal(p.bench.g.suppressed, true);
    assert.equal(BENCH_RULES.minRecords, 5);
  });
  test('phạm vi cá nhân / tổ chỉ chứa số đã công bố (không có dist)', () => {
    const S = scenario();
    const d = S.pScope('gv.hai').doc;
    for (const B of [d.benchmarks.levels.tih, d.benchmarks.tos.tih['Tổ 1']]) {
      assert.ok(!('dist' in B) && 'pct' in B, JSON.stringify(B));
      for (const x of B.crit) assert.equal(Math.round(x * 10) / 10, x);
    }
  });
});
