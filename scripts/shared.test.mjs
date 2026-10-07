// Kiểm thử offline cho lib/shared.js: đọc biểu mẫu theo NHÃN cột, chuẩn hóa tổ theo cấp, DS Nhân sự + cờ vai trò, tiện ích.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormTable, parseStaffTable, normTo, toRule, normGroup, parseCaps, normMa, emailsIn, normEmail, isLeaveNote,
  staffRoleFlags, hydrate, hash53, fold, nameKey, slug, CAPS, CAP_INFO, TO_BGH, TO_TG, chunkRecords,
} from '../lib/shared.js';
import {
  TIH_FORM_COLS, THCS_FORM_COLS, tihRow, thcsRow, tihStaffTable, thcsStaffTable, em, DOMAIN,
} from './fixtures.mjs';

const table = (cols, rows) => ({ cols: structuredClone(cols), rows, parsedNumHeaders: 1 });

describe('parseFormTable – Tiểu học (nhận diện cột theo nhãn)', () => {
  const t = table(TIH_FORM_COLS, [
    tihRow(0, { oe: ' PHO.TIH@HoangMaiStarSchool.edu.vn ', om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó', tm: 100131, tg: 'Tổ 1', teachCol: 'to1', tn: 'Phạm Văn Hai' }),
    tihRow(1, { oe: 'gmail.sai@gmail.com', om: '0100133', og: 'Tổ Ngoại ngữ', obsCol: 'cot', on: 'Người Cột Tám', tm: null, tg: 'Giáo viên thỉnh giảng', teachCol: 'tg', tn: 'Hà Thỉnh Giảng' }),
    tihRow(2, { og: 'Tổ 1', on: 'X', tg: 'Tổ Tiếng Anh', teachCol: 'ta', tn: 'Hoàng Văn Bốn', sc: [null, null, null] }), // không có điểm → bỏ
  ]);
  const { records, crit } = parseFormTable(t, { cap: 'tih' });

  test('đọc đủ trường, cấp, email người gửi, mã người dự / người dạy', () => {
    assert.equal(records.length, 2);
    assert.deepEqual(crit.map(k => k.code), ['1.1', '2.1', '5.1']);
    const [a, b] = records;
    assert.equal(a.cap, 'tih');
    assert.deepEqual([a.og, a.on, a.tg, a.tn], [TO_BGH, 'Trần Thị Phó', 'Tổ 1', 'Phạm Văn Hai']);
    assert.equal(a.oe, em('pho.tih'), 'email viết thường, bỏ khoảng trắng');
    assert.deepEqual([a.om, a.tm], ['100191', '100131']);
    assert.equal(a.day, '2026-08-31', 'ngày dạy lấy từ cột date không tên (“Cột 14”)');
    assert.equal(a.ts, '2026-09-01 07:00:00');
    assert.deepEqual([b.og, b.on, b.tg, b.tn], ['Tổ Tiếng Anh', 'Người Cột Tám', TO_TG, 'Hà Thỉnh Giảng'], 'cột không tên giữa nhóm người dự và mã GV dạy = người dự; cột thỉnh giảng = GV dạy');
    assert.equal(b.om, '100133', 'mã bỏ số 0 ở đầu');
    assert.equal(b.tm, '');
    assert.equal(b.oe, 'gmail.sai@gmail.com');
  });

  test('mã phiếu khác nhau giữa các cấp; không có cap → giống công thức v1', () => {
    const v1 = parseFormTable(t).records[0];
    const r = records[0];
    assert.ok(!('cap' in v1));
    assert.equal(v1.id, hash53([v1.ts, fold(v1.tn), fold(v1.on), v1.cls, v1.period, v1.subject, v1.lesson, v1.sc.join(',')].join('|')));
    assert.notEqual(r.id, v1.id);
    assert.equal(parseFormTable(t, { cap: 'thcs' }).records[0].id === r.id, false);
  });

  test('thiếu cột bắt buộc → lỗi tiếng Việt', () => {
    const bad = table(TIH_FORM_COLS, []);
    bad.cols[0].label = 'Cột lạ';
    assert.throws(() => parseFormTable(bad), /cấu trúc cột/);
  });
});

describe('parseFormTable – THCS (cột KHXH nằm SAU cột nhận xét)', () => {
  const t = table(THCS_FORM_COLS, [
    thcsRow(0, { oe: em('gv.su'), om: 101601, og: 'Tổ KHXH', obsCol: 'khxh', on: 'Trần Thị Sử', tm: 101602, tg: 'Tổ KHXH', teachCol: 'khxh', tn: 'Lê Phương Địa' }),
    thcsRow(1, { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán', tm: 100081, tg: 'Tổ Toán', teachCol: 'toan', tn: 'Đỗ Thị Ánh' }),
    thcsRow(2, { og: 'Tổ Ngoại ngữ', obsCol: 'bgh', on: 'Đỗ Thị Thường Trực', tg: 'Tổ Tiếng Anh THCS', teachCol: 'van', tn: 'Ai Đó' }),
  ]);
  const { records } = parseFormTable(t, { cap: 'thcs' });

  test('đọc được họ tên người dự / GV dạy ở cột KHXH cuối bảng (lỗi của bản đọc theo vị trí)', () => {
    const r = records[0];
    assert.deepEqual([r.og, r.on, r.tg, r.tn], ['Tổ KHXH', 'Trần Thị Sử', 'Tổ KHXH', 'Lê Phương Địa']);
    assert.notEqual(r.on, 'Không rõ');
    assert.notEqual(r.tn, 'Không rõ');
  });
  test('“Mã nhân viên … dạy (được dự giờ)” là mã GV dạy, không phải mã người dự', () => {
    assert.deepEqual([records[0].om, records[0].tm], ['101601', '101602']);
    assert.deepEqual([records[1].om, records[1].tm], ['101608', '100081']);
  });
  test('tổ THCS: “Tổ Tiếng Anh THCS” → “Tổ Ngoại ngữ”; ngày dạy từ cột “Ngày dạy”; cột trống cuối bị bỏ qua', () => {
    assert.equal(records[2].tg, 'Tổ Ngoại ngữ');
    assert.equal(records[2].og, 'Tổ Ngoại ngữ');
    assert.equal(records[0].day, '2026-08-30');
    assert.ok(records.every(r => r.cap === 'thcs'));
  });
  test('các cột nhận xét không bị nhầm thành họ tên', () => {
    assert.ok(records.every(r => !/Ưu điểm|Khắc phục/.test(r.on + r.tn)));
    assert.equal(records[1].pros, 'Ưu điểm THCS 1');
  });
});

describe('Chuẩn hóa tổ theo cấp (dữ liệu hai Sheet thật)', () => {
  // Các giá trị tổ xuất hiện trong hai Sheet thật (DS Nhân sự và biểu mẫu) – chỉ là tên tổ, không phải dữ liệu cá nhân.
  const TIH_STAFF = ['Ban Lãnh đạo', 'Ban Giám hiệu Tiểu học', 'Tổ 1', 'Tổ 2', 'Tổ 3', 'Tổ 4', 'Tổ 5', 'Tổ Ngoại ngữ Tiểu học', 'Tiếng Anh', 'Tổ Toán - Tiếng Anh', 'Tổ KHCN Tiểu học', 'Tổ KHCN', 'Tổ Thể thao', 'Thể thao', 'Tổ Năng khiếu', 'Năng khiếu', 'Thỉnh giảng'];
  const TIH_FORM = ['Tổ 1', 'Tổ 2', 'Tổ 3', 'Tổ 4', 'Tổ 5', 'Tổ Tiếng Anh', 'Tổ KHCN', 'Tổ Năng khiếu', 'Tổ Thể thao', 'Tổ Bộ môn', 'Giáo viên thỉnh giảng', 'Ban Giám Hiệu'];
  const THCS_STAFF = ['Ban Giám hiệu THCS', 'Tổ Ngoại ngữ THCS', 'Tổ Ngoại ngữ', 'Tổ Toán THCS', 'Tổ Toán THPT', 'Tổ KHCN THCS', 'Tổ Xã hội THCS', 'Tổ Xã hội', 'Tổ Ngữ văn THCS', 'Tổ Thể thao', 'Tổ Năng khiếu', 'Tổ Công nghệ'];
  const THCS_FORM = ['Tổ KHCN', 'Tổ Ngữ văn', 'Tổ Năng khiếu', 'Tổ KHXH', 'Tổ Toán', 'Tổ Ngoại ngữ', 'Tổ Tiếng Anh THCS', 'Ban Giám Hiệu'];

  test('Tiểu học giữ tên tổ của v1', () => {
    const want = {
      'Ban Lãnh đạo': TO_BGH, 'Ban Giám hiệu Tiểu học': TO_BGH, 'Tổ Ngoại ngữ Tiểu học': 'Tổ Tiếng Anh', 'Tiếng Anh': 'Tổ Tiếng Anh',
      'Tổ Toán - Tiếng Anh': 'Tổ Tiếng Anh', 'Tổ KHCN Tiểu học': 'Tổ KHCN', 'Thể thao': 'Tổ Thể thao', 'Năng khiếu': 'Tổ Năng khiếu',
      'Thỉnh giảng': TO_TG, 'tổ 3': 'Tổ 3', 'Tổ Bộ môn': 'Tổ Bộ môn', '': 'Khác',
    };
    for (const [k, v] of Object.entries(want)) assert.equal(normTo('tih', k), v, k);
    assert.equal(normGroup('Tổ Ngoại ngữ'), 'Tổ Tiếng Anh', 'normGroup (v1) = quy tắc Tiểu học');
  });
  test('THCS/THPT dùng tên tổ riêng', () => {
    const want = {
      'Tổ Ngoại ngữ THCS': 'Tổ Ngoại ngữ', 'Tổ Tiếng Anh THCS': 'Tổ Ngoại ngữ', 'Tổ Toán THCS': 'Tổ Toán', 'Tổ Toán THPT': 'Tổ Toán',
      'Tổ Xã hội THCS': 'Tổ KHXH', 'Tổ Xã hội': 'Tổ KHXH', 'Tổ KHCN THCS': 'Tổ KHCN', 'Tổ Ngữ văn THCS': 'Tổ Ngữ văn',
      'Ban Giám hiệu THCS': TO_BGH, 'Tổ Công nghệ': 'Tổ Công nghệ', 'Tổ Thể thao': 'Tổ Thể thao',
    };
    for (const [k, v] of Object.entries(want)) assert.equal(normTo('thcs', k), v, k);
    assert.equal(normTo('thpt', 'Tổ Toán THPT'), 'Tổ Toán');
  });
  test('mọi tổ trong DS Nhân sự đều khớp một tổ của biểu mẫu cùng cấp (trừ tổ chưa có phiếu)', () => {
    for (const [cap, staff, form, noRecords] of [['tih', TIH_STAFF, TIH_FORM, []], ['thcs', THCS_STAFF, THCS_FORM, ['Tổ Thể thao', 'Tổ Công nghệ']]]) {
      const formSet = new Set(form.map(g => normTo(cap, g)));
      for (const g of staff) {
        const n = normTo(cap, g);
        assert.ok(formSet.has(n) || noRecords.includes(n), `${cap}: “${g}” → “${n}” không khớp tổ nào của biểu mẫu`);
      }
      // không có hậu tố cấp trong tên đã chuẩn hóa
      for (const g of [...staff, ...form]) assert.ok(!/THCS|THPT|Tiểu học|TiH/.test(normTo(cap, g)), g);
    }
  });
  test('tổ lạ: bỏ hậu tố cấp, giữ tên; known = false', () => {
    assert.deepEqual(toRule('thpt', 'Tổ Hóa học THPT'), { to: 'Tổ Hóa học', known: false });
    assert.deepEqual(toRule('tih', 'tổ Văn phòng (Tiểu học)'), { to: 'Tổ Văn phòng', known: false });
    assert.equal(toRule('thcs', 'Tổ Toán').known, true);
  });
  test('slug cho mã phạm vi', () => {
    assert.equal(slug('Tổ Toán'), 'to-toan');
    assert.equal(slug('Tổ 1'), 'to-1');
    assert.equal(slug('Giáo viên thỉnh giảng'), 'giao-vien-thinh-giang');
    assert.equal(slug(''), 'khac');
  });
});

describe('parseStaffTable – DS Nhân sự + cờ vai trò tự động', () => {
  const tih = parseStaffTable(tihStaffTable(), { cap: 'tih' });
  const thcs = parseStaffTable(thcsStaffTable(), { cap: 'thcs' });
  const row = (s, email) => s.rows.find(r => r.email === em(email));

  test('cột mã, email, cấp, chức danh; dòng trống bị bỏ', () => {
    assert.equal(tih.recognized, true);
    const r = row(tih, 'gv.hai');
    assert.deepEqual([r.ma, r.name, r.to, r.role, r.capCell, r.caps, r.lienCap, r.active], ['100131', 'Phạm Văn Hai', 'Tổ 1', 'GVCN 1A1', 'Tiểu học', ['tih'], false, true]);
    assert.equal(thcs.rows.length, 25, 'ba dòng trống cuối bảng bị bỏ');
    assert.ok(!thcs.rows.some(r => !r.name));
  });
  test('“nghỉ” ở Ghi chú (TiH) hoặc Thâm niên (THCS) → không còn làm việc; “Đề nghị …” vẫn làm việc', () => {
    assert.equal(row(tih, 'danghi').active, false);
    assert.equal(row(thcs, 'nghi.thcs').active, false);
    assert.equal(row(tih, 'denghi').active, true);
    assert.equal(isLeaveNote('Nghỉ sinh từ tháng 9/2026'), true);
    assert.equal(isLeaveNote('GV đang nghỉ thai sản'), true);
    assert.equal(isLeaveNote('Hội nghị'), false);
  });
  test('cấp của dòng: Liên cấp, THPT trong Sheet THCS', () => {
    assert.deepEqual([row(thcs, 'lien.cap').lienCap, row(thcs, 'lien.cap').caps], [true, []]);
    assert.deepEqual(row(thcs, 'capba').caps, ['thpt']);
  });
  test('BGH liên cấp / BGH cấp', () => {
    const t = row(tih, 'tonght');
    assert.deepEqual([t.bghAll, t.bghCap, t.to], [true, true, TO_BGH]);
    assert.deepEqual([row(tih, 'pho.tih').bghAll, row(tih, 'pho.tih').bghCap], [false, true]);
    assert.equal(row(tih, 'tvbgh.tih').bghCap, true, 'Thành viên BGH');
    assert.equal(row(thcs, 'tv.bgh').bghCap, true, 'TV BGH');
    assert.equal(row(thcs, 'chuyen.gia').bghCap, true, 'dòng thuộc “Ban Giám hiệu THCS” (kể cả Liên cấp) → BGH cấp của Sheet');
    assert.equal(row(thcs, 'troly').bghCap, false, 'Trợ lý Hiệu trưởng không phải BGH');
    assert.equal(row(tih, 'gv.hai').bghCap, false);
  });
  test('Tổ trưởng: tổ trong chức danh hoặc cột Tổ; không tính tổ phó / nhóm trưởng / tổ trưởng khối / phó tổ trưởng', () => {
    assert.equal(row(tih, 'totruong1').toTruong, 'Tổ 1');
    assert.equal(row(tih, 'totruong.khcn').toTruong, 'Tổ KHCN', '“Tổ trưởng Tổ KHCN TiH - GV Toán - Tiếng Anh” → KHCN (không phải Tiếng Anh)');
    assert.equal(row(tih, 'the.thao').toTruong, 'Tổ Thể thao');
    assert.equal(row(thcs, 'tv.bgh').toTruong, 'Tổ KHCN', '“TV BGH - Tổ trưởng tổ KHCN THCS” (cột Tổ là BGH)');
    assert.equal(row(thcs, 'totruong.toan').toTruong, 'Tổ Toán');
    assert.equal(row(thcs, 'totruong.van').toTruong, 'Tổ Ngữ văn');
    for (const e of ['gv.ba', 'gv.bon']) assert.equal(row(tih, e).toTruong, '', e);
    for (const e of ['khoi', 'photo', 'gv.anh']) assert.equal(row(thcs, e).toTruong, '', e);
    assert.deepEqual(staffRoleFlags({ toRaw: 'Ban Giám hiệu', role: 'Tổ trưởng' }, 'tih'), { bghAll: false, bghCap: true, toTruong: '' }, 'tổ trưởng của “Ban Giám Hiệu” không phải tổ');
  });
  test('tương thích v1: teach/bgh/allEmails', () => {
    assert.ok(tih.teach.some(t => t.name === 'Phạm Văn Hai' && t.group === 'Tổ 1'));
    assert.ok(tih.teach.every(t => !('email' in t)));
    assert.deepEqual(tih.bgh.map(b => b.name), ['Nguyễn Văn Tổng', 'Trần Thị Phó', 'Võ Thị Thành']);
    assert.ok(!tih.allEmails.includes(em('danghi')));
  });
  test('bảng không phải DS Nhân sự (gviz trả tab đầu tiên khi sai tên tab) → recognized:false', () => {
    const r = parseStaffTable({ cols: structuredClone(TIH_FORM_COLS), rows: [] });
    assert.deepEqual([r.recognized, r.rows.length], [false, 0]);
    assert.equal(parseStaffTable({ cols: [{ label: 'X' }], rows: [] }).recognized, false);
  });
});

describe('Tiện ích', () => {
  test('parseCaps', () => {
    assert.deepEqual(parseCaps('Tiểu học'), { caps: ['tih'], lienCap: false });
    assert.deepEqual(parseCaps('THCS, THPT'), { caps: ['thcs', 'thpt'], lienCap: false });
    assert.deepEqual(parseCaps('TiH; thcs'), { caps: ['tih', 'thcs'], lienCap: false });
    assert.deepEqual(parseCaps('Liên cấp'), { caps: [], lienCap: true });
    assert.deepEqual(parseCaps(''), { caps: [], lienCap: false });
  });
  test('normMa / emailsIn / normEmail', () => {
    assert.equal(normMa(101506), '101506');
    assert.equal(normMa('0101506 '), '101506');
    assert.equal(normMa('gv-001'), 'GV001');
    assert.equal(normMa(''), '');
    assert.deepEqual(emailsIn(`A@${DOMAIN}; b@x.vn, sai, a@b@c.vn, x/y@z.vn`), [`a@${DOMAIN}`, 'b@x.vn']);
    assert.equal(normEmail('  '), '');
  });
  test('CAP_INFO: nhãn và màu nhận diện', () => {
    assert.deepEqual(CAPS, ['tih', 'thcs', 'thpt']);
    assert.deepEqual(CAPS.map(c => CAP_INFO[c].color), ['#ffad00', '#2da037', '#23328C']);
    assert.deepEqual(CAPS.map(c => CAP_INFO[c].label), ['Tiểu học', 'THCS', 'THPT']);
  });
  test('hydrate: trường v2 (cap, rel, oe/om/tm), khóa giáo viên có tiền tố cấp; bản ghi v1 giữ khóa cũ', () => {
    const crit = [{ code: '1.1', d: 1 }, { code: '5.1', d: 5 }];
    const base = { id: 'x', ts: '2026-10-01 08:00:00', day: '2026-10-01', og: TO_BGH, on: 'A', tg: 'Tổ Toán', tn: 'Bé Bê', cls: '6B01', sc: [4, 2] };
    const h = hydrate({ ...base, cap: 'thcs', rel: 't', tm: '123' }, crit);
    assert.deepEqual([h.cap, h.rel, h.tm, h.oe, h.grade, h.isBGH], ['thcs', 't', '123', '', 'Khối 6', true]);
    assert.equal(h.tk, 'thcs:Tổ Toán|be be');
    assert.deepEqual(h.lowCodes, ['5.1']);
    assert.equal(hydrate(base, crit).tk, 'Tổ Toán|be be');
    const k = hydrate({ ...base, cap: 'thcs', tp: 'h1', op: 'h2' }, crit);
    assert.deepEqual([k.tk, k.ok, k.tp, k.op], ['thcs:Tổ Toán|#h1', 'thcs:Ban Giám Hiệu|#h2', 'h1', 'h2'], 'khóa nhân thân (phạm vi cấp/tổ) thay cho họ tên');
  });
  test('nameKey: giữ dấu thanh, không phụ thuộc vị trí đặt dấu', () => {
    assert.notEqual(nameKey('Vương Thị Thúy'), nameKey('Vương Thị Thùy'));
    assert.notEqual(nameKey('Vương Thị Thúy'), nameKey('Vương Thị Thủy'));
    assert.equal(nameKey('Vương Thị Thuý'), nameKey('Vương Thị Thúy'));
    assert.equal(nameKey('Lê Thị Hoà'), nameKey('lê  thị hòa '));
    assert.equal(fold('Vương Thị Thúy'), fold('Vương Thị Thùy'), 'fold() bỏ dấu → chỉ dùng khi cách viết bỏ dấu là duy nhất');
    assert.notEqual(nameKey('Đỗ Văn A'), nameKey('Do Van A'));
  });
  test('staffRoleFlags: công đoàn, “nguyên …”, chức danh hành chính → không có quyền lãnh đạo', () => {
    const f = (toRaw, role, cap = 'thcs') => staffRoleFlags({ toRaw, role, to: normTo(cap, toRaw) }, cap);
    const none = { bghAll: false, bghCap: false, toTruong: '' };
    assert.deepEqual(f('Tổ Toán THCS', 'Tổ trưởng công đoàn - GV Toán'), none);
    assert.deepEqual(f('Tổ 3', 'GVCN 3A2, Tổ trưởng Công đoàn', 'tih'), none);
    assert.deepEqual(f('Tổ 3', 'Nguyên Tổ trưởng Tổ 3', 'tih'), none);
    assert.deepEqual(f('Văn phòng', 'Nguyên Hiệu trưởng'), none);
    assert.deepEqual(f('Văn phòng', 'Văn thư BGH'), none);
    assert.deepEqual(f('Ban Giám hiệu THCS', 'Văn thư'), none, 'thuộc bộ phận BGH nhưng là văn thư');
    assert.deepEqual(f('Ban Lãnh đạo', 'Thư ký Tổng hiệu trưởng', 'tih'), none);
    assert.deepEqual(f('Tổ 3', 'Tổ trưởng công đoàn, Tổ trưởng Tổ 3', 'tih'), { ...none, toTruong: 'Tổ 3' });
    assert.deepEqual(f('Tổ 3', 'Nguyên Tổ trưởng Tổ 2, Tổ trưởng Tổ 3', 'tih'), { ...none, toTruong: 'Tổ 3' });
    assert.deepEqual(f('Ban Giám hiệu THCS', 'Chuyên gia'), { ...none, bghCap: true });
    assert.deepEqual(f('Ban Giám hiệu THCS', 'TV BGH - Tổ trưởng tổ KHCN THCS'), { ...none, bghCap: true, toTruong: 'Tổ KHCN' });
  });
  test('chunkRecords: giới hạn kích thước & số bản ghi', () => {
    const recs = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), x: 'y'.repeat(100) }));
    const ch = chunkRecords(recs, { maxBytes: 340_000, maxRecords: 500 });
    assert.deepEqual(ch.map(c => c.n), [500, 500, 200]);
    assert.deepEqual(ch.map(c => c.id), ['c000', 'c001', 'c002']);
    assert.equal(ch[0].hash, hash53(ch[0].data));
  });
});
