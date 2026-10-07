// Dữ liệu gviz TỔNG HỢP (không phải dữ liệu thật) mô phỏng cấu trúc hai Sheet thật:
//  • Tiểu học: nhóm “Họ và tên … dự giờ” + một cột không tên (“Cột 8”) trước mã GV dạy; cột “Họ và tên giáo viên thỉnh giảng dạy”;
//    ngày dạy nằm ở cột không tên kiểu date (“Cột 14”).
//  • THCS: mã GV dạy ghi “… dạy (được dự giờ)”; cột KHXH (“Họ và tên giáo viên tổ KHXH dự giờ”, “… dạy thuộc tổ KHXH”)
//    nằm SAU các cột nhận xét; cột trống “Cột 24” ở cuối; DS Nhân sự có dòng “Liên cấp”, dòng “THPT”, dòng trống,
//    “nghỉ việc” ở cột Thâm niên; hai người trùng họ tên; một người hai email; email trùng giữa hai cấp.
// Dùng chung cho các tệp *.test.mjs (tệp này không phải tệp kiểm thử).
export const DOMAIN = 'hoangmaistarschool.edu.vn';
export const SHEET_TIH = 'SHEET_TIH_TEST';
export const SHEET_THCS = 'SHEET_THCS_TEST';
export const SHEET_THPT = 'SHEET_THPT_TEST';
export const SHEET_ROLES = 'SHEET_ROLES_TEST';
export const FORM_TAB = 'Câu trả lời biểu mẫu 1';
export const STAFF_TAB = 'DS Nhân sự';
export const ROLES_TAB = 'Phân quyền';
export const T0 = Date.UTC(2026, 9, 6, 1, 0, 0); // 06/10/2026 08:00 (+07)
export const em = local => `${local}@${DOMAIN}`;

const p2 = n => String(n).padStart(2, '0');
const cols = list => list.map(([label, type], i) => ({ id: colId(i), label, type, pattern: '' }));
function colId(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const S = v => (v == null || v === '' ? null : { v });
const N = v => (v == null || v === '' ? null : { v, f: String(v) });
function tsCell(i) {
  const d = new Date(Date.UTC(2026, 8, 1, 7, 0, 0) + i * 60_000);
  const [y, m, dd, h, mi] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
  return { v: `Date(${y},${m},${dd},${h},${mi},0)`, f: `${p2(dd)}/${p2(m + 1)}/${y} ${p2(h)}:${p2(mi)}:00` };
}
function dayCell(i, back = 0) {
  const d = new Date(Date.UTC(2026, 8, 1) + i * 60_000 - back * 864e5);
  return { v: `Date(${d.getUTCFullYear()},${d.getUTCMonth()},${d.getUTCDate()})`, f: `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}` };
}
export const CRIT_COLS = [
  ['1.1. Xác định rõ ràng, đầy đủ, mục tiêu của bài học', 'number'],
  ['2.1. Đảm bảo tính chính xác, logic, khoa học', 'number'],
  ['5.1. Học sinh đạt được yêu cầu của giờ học/bài học', 'number'],
];

/* ---------------- Tiểu học – biểu mẫu ---------------- */
export const TIH_FORM_COLS = cols([
  ['Dấu thời gian', 'datetime'],                         // 0
  ['Địa chỉ email', 'string'],                           // 1
  ['Mã nhân viên của thầy cô đi dự giờ', 'number'],      // 2
  ['Giáo viên dự giờ thuộc Tổ/bộ phận', 'string'],       // 3
  ['Họ và tên BGH dự giờ', 'string'],                    // 4
  ['Họ và tên giáo viên Tổ 1 dự giờ', 'string'],         // 5
  ['Họ và tên giáo viên Tổ Tiếng Anh dự giờ', 'string'], // 6
  ['Cột 8', 'string'],                                   // 7  (không tên – vẫn là người dự)
  ['Mã nhân viên của thầy cô dạy', 'number'],            // 8
  ['Giáo viên dạy thuộc Tổ/ bộ phận ', 'string'],        // 9
  ['Họ và tên giáo viên dạy Tổ 1', 'string'],            // 10
  ['Họ và tên giáo viên dạy Tổ Tiếng Anh', 'string'],    // 11
  ['Họ và tên giáo viên thỉnh giảng dạy', 'string'],     // 12
  ['Cột 14', 'date'],                                    // 13 (ngày dạy, không tên)
  ['Tên bài dạy', 'string'], ['Tiết dạy', 'string'], ['Môn dạy', 'string'], ['Lớp dạy', 'string'], // 14–17
  ...CRIT_COLS,                                          // 18–20
  ['VI. Ưu điểm của tiết học:', 'string'], ['VII. Những điểm cần khắc phục:', 'string'], // 21–22
]);
const TIH_OBS_COL = { bgh: 4, to1: 5, ta: 6, cot: 7 };
const TIH_TEACH_COL = { to1: 10, ta: 11, tg: 12 };
/**
 * Một dòng biểu mẫu Tiểu học.
 * @param {number} i  thứ tự (thời điểm gửi = 01/09/2026 07:00 + i phút)
 * @param {object} o  { oe, om, og, obsCol, on, tm, tg, teachCol, tn, lesson, period, subject, cls, sc, pros, cons, dayBack }
 */
export function tihRow(i, o = {}) {
  const c = Array(TIH_FORM_COLS.length).fill(null);
  c[0] = tsCell(i); c[1] = S(o.oe); c[2] = N(o.om); c[3] = S(o.og ?? 'Tổ 1');
  c[TIH_OBS_COL[o.obsCol || 'to1']] = S(o.on ?? `Người dự ${i % 7}`);
  c[8] = N(o.tm); c[9] = S(o.tg ?? 'Tổ 1');
  c[TIH_TEACH_COL[o.teachCol || 'to1']] = S(o.tn ?? `Giáo viên ${i % 37}`);
  c[13] = dayCell(i, o.dayBack ?? 1);
  c[14] = S(o.lesson ?? `Bài ${i}`); c[15] = S(o.period ?? `Tiết ${1 + (i % 6)}`); c[16] = S(o.subject ?? (i % 2 ? 'Toán' : 'Tiếng Việt')); c[17] = S(o.cls ?? `${1 + (i % 5)}A${i % 3}`);
  const sc = o.sc || [1 + (i % 5), 4, 5];
  c[18] = N(sc[0]); c[19] = N(sc[1]); c[20] = N(sc[2]);
  c[21] = S(o.pros ?? `Ưu điểm ${i}`); c[22] = S(o.cons ?? `Cần khắc phục ${i}`);
  return { c };
}

/* ---------------- THCS – biểu mẫu (cột KHXH nằm sau nhận xét) ---------------- */
export const THCS_FORM_COLS = cols([
  ['Dấu thời gian', 'datetime'],                                // 0
  ['Địa chỉ email', 'string'],                                  // 1
  ['Mã nhân viên của thầy cô đi dự giờ', 'number'],             // 2
  ['Giáo viên dự giờ thuộc Tổ/bộ phận', 'string'],              // 3
  ['Họ và tên BGH dự giờ', 'string'],                           // 4
  ['Họ và tên giáo viên Tổ Toán dự giờ', 'string'],             // 5
  ['Họ và tên giáo viên tổ Ngữ văn dự giờ', 'string'],          // 6
  ['Họ và tên giáo viên Tổ Thể thao dự giờ?', 'string'],        // 7
  ['Mã nhân viên của thầy cô dạy (được dự giờ)', 'number'],     // 8
  ['Giáo viên dạy thuộc Tổ/ bộ phận ', 'string'],               // 9
  ['Họ và tên giáo viên dạy thuộc tổ Toán', 'string'],          // 10
  ['Họ và tên giáo viên dạy thuộc tổ Ngữ văn', 'string'],       // 11
  ['Họ và tên giáo viên dạy thuộc tổ KHCN', 'string'],          // 12
  ['Ngày dạy', 'date'],                                         // 13
  ['Tên bài dạy', 'string'], ['Tiết dạy', 'string'], ['Môn dạy', 'string'], ['Lớp dạy', 'string'], // 14–17
  ...CRIT_COLS,                                                 // 18–20
  ['VI. Ưu điểm của tiết học:', 'string'], ['VII. Những điểm cần khắc phục:', 'string'], // 21–22
  ['Họ và tên giáo viên tổ KHXH dự giờ', 'string'],             // 23 (sau nhận xét!)
  ['Họ và tên giáo viên dạy thuộc tổ KHXH', 'string'],          // 24 (sau nhận xét!)
  ['Cột 26', 'string'],                                         // 25 (trống)
]);
const THCS_OBS_COL = { bgh: 4, toan: 5, van: 6, tt: 7, khxh: 23 };
const THCS_TEACH_COL = { toan: 10, van: 11, khcn: 12, khxh: 24 };
export function thcsRow(i, o = {}) {
  const c = Array(THCS_FORM_COLS.length).fill(null);
  c[0] = tsCell(i); c[1] = S(o.oe); c[2] = N(o.om); c[3] = S(o.og ?? 'Tổ Toán');
  c[THCS_OBS_COL[o.obsCol || 'toan']] = S(o.on ?? `Người dự THCS ${i % 5}`);
  c[8] = N(o.tm); c[9] = S(o.tg ?? 'Tổ Toán');
  c[THCS_TEACH_COL[o.teachCol || 'toan']] = S(o.tn ?? `GV THCS ${i % 11}`);
  c[13] = dayCell(i, o.dayBack ?? 2);
  c[14] = S(o.lesson ?? `Bài THCS ${i}`); c[15] = S(o.period ?? 'Tiết 3'); c[16] = S(o.subject ?? 'Toán'); c[17] = S(o.cls ?? `${6 + (i % 4)}B0${i % 3}`);
  const sc = o.sc || [3 + (i % 3), 4, 5];
  c[18] = N(sc[0]); c[19] = N(sc[1]); c[20] = N(sc[2]);
  c[21] = S(o.pros ?? `Ưu điểm THCS ${i}`); c[22] = S(o.cons ?? `Khắc phục THCS ${i}`);
  return { c };
}

/* ---------------- DS Nhân sự ---------------- */
const STAFF_COLS_TIH = cols([['Mã nhân sự', 'number'], ['Họ và tên Nhân sự', 'string'], ['Cấp', 'string'], ['Tổ/Bộ phận', 'string'], ['Chức danh', 'string'], ['Email', 'string'], ['Thâm niên', 'string'], ['Ghi chú', 'string'], ['ID', 'string']]);
const STAFF_COLS_THCS = cols([['Mã nhân sự', 'number'], ['Họ và tên Nhân sự', 'string'], ['Cấp', 'string'], ['Tổ/Bộ phận', 'string'], ['Chức danh', 'string'], ['Email', 'string'], ['Thâm niên', 'string'], ['', 'string'], ['ID', 'string'], ['', 'number'], ['', 'string']]);
const staffRow = (arr, width) => ({ c: Array.from({ length: width }, (_, i) => (i === 0 ? N(arr[0]) : S(arr[i]))) });

// [mã, họ tên, cấp, tổ, chức danh, email, thâm niên, ghi chú]
export const TIH_STAFF_ROWS = [
  [100003, 'Nguyễn Văn Tổng', 'Tiểu học', 'Ban Lãnh đạo', 'Tổng Hiệu trưởng', em('tonght')],
  [100191, 'Trần Thị Phó', 'Tiểu học', 'Ban Giám hiệu Tiểu học', 'Phó Hiệu trưởng thường trực', em('pho.tih')],
  [100935, 'Võ Thị Thành', 'Tiểu học', 'Ban Giám hiệu Tiểu học', 'Thành viên BGH', em('tvbgh.tih')],
  [101177, 'Lê Đã Nghỉ', 'Tiểu học', 'Ban Giám hiệu Tiểu học', 'Phó Hiệu Trưởng TiH', em('danghi'), '', 'Nghỉ việc từ ngày 6/9/2025'],
  [100130, 'Nguyễn Thị Một', 'Tiểu học', 'Tổ 1', 'Tổ trưởng - GVCN 1B0', em('totruong1')],
  [100131, 'Phạm Văn Hai', 'Tiểu học', 'Tổ 1', 'GVCN 1A1', em('gv.hai')],
  [100132, 'Đỗ Thị Ba', 'Tiểu học', 'Tổ 1', 'Tổ phó - GVCN 1A6', em('gv.ba')],
  [100136, 'Lý Văn Sáu', 'Tiểu học', 'Tổ 1', 'GVCN 1A2', em('gv.sau')],
  [100133, 'Hoàng Văn Bốn', 'Tiểu học', 'Tổ Ngoại ngữ Tiểu học', 'Nhóm trưởng khối 2 - GV Tiếng Anh 2A3', em('gv.bon')],
  [100463, 'Lê Thị Khoa', 'Tiểu học', 'Tổ KHCN Tiểu học', 'Tổ trưởng Tổ KHCN TiH - GV Toán - Tiếng Anh', em('totruong.khcn')],
  [100893, 'Ngô Văn Năm', 'Tiểu học', 'Tổ Toán - Tiếng Anh', 'Giáo viên', em('gv.nam')],
  [100084, 'Mai Thị Liên', 'Tiểu học', 'Tổ Thể thao', 'Giáo viên thể thao', em('lien.cap')],
  [100617, 'Nguyễn Mạnh Thể', 'Tiểu học', 'Tổ Thể thao', 'Tổ trưởng', em('the.thao')],
  [100555, 'Trùng Tên Văn', 'Tiểu học', 'Tổ 2', 'GVCN 2A1', em('trung.ten.tih')],
  [101392, 'Nguyễn Hai Mail', 'Tiểu học', 'Năng khiếu', 'GV Âm nhạc', em('hann')],
  [100777, 'Bùi Không Email', 'Tiểu học', 'Tổ 2', 'GVCN 2A2', ''],
  [100778, 'Đào Đề Nghị', 'Tiểu học', 'Tổ 2', 'GVCN 2A3', em('denghi'), '', 'Đề nghị chuyển lớp'],
  [100779, 'Hà Thỉnh Giảng', 'Tiểu học', 'Thỉnh giảng', 'GV Văn Hóa đọc', em('thinh.giang')],
];
export const THCS_STAFF_ROWS = [
  [100193, 'Đỗ Thị Thường Trực', 'THCS', 'Ban Giám hiệu THCS', 'Phó Hiệu trưởng thường trực', em('pht.thcs')],
  [100575, 'Nguyễn Thị Kiều', 'THCS', 'Ban Giám hiệu THCS', 'TV BGH - Tổ trưởng tổ KHCN THCS', em('tv.bgh')],
  [101183, 'Nguyễn Chuyên Gia', 'Liên cấp', 'Ban Giám hiệu THCS', 'Chuyên gia', em('chuyen.gia')],
  [100617, 'Nguyễn Mạnh Thể', 'Liên cấp', 'Tổ Thể thao', 'Tổ trưởng', em('the.thao')],
  [100084, 'Mai Thị Liên', 'Liên cấp', 'Tổ Thể thao', 'GV Cầu lông', em('lien.cap')],
  [100261, 'Đinh Đã Nghỉ', 'THCS', 'Tổ Toán THCS', 'Tổ trưởng', em('nghi.thcs'), 'nghỉ việc'],
  [101608, 'Nguyễn Thị Toán', 'THCS', 'Tổ Toán THCS', 'Tổ trưởng Toán THCS', em('totruong.toan')],
  [100081, 'Đỗ Thị Ánh', 'THCS', 'Tổ Toán THCS', 'Giáo viên Toán', em('gv.anh')],
  [100082, 'Phạm Văn Toán Hai', 'THCS', 'Tổ Toán THCS', 'Giáo viên Toán', em('gv.toan2')],
  [100083, 'Vũ Thị Toán Ba', 'THCS', 'Tổ Toán THCS', 'Giáo viên Toán', em('gv.toan3')],
  [100655, 'Nguyễn Thị Khối', 'THCS', 'Tổ Xã hội THCS', 'Tổ trưởng Khối THCS, Giáo viên Văn', em('khoi')],
  [101601, 'Trần Thị Sử', 'THCS', 'Tổ Xã hội', 'Giáo viên Địa lý THCS', em('gv.su')],
  [101602, 'Lê Phương Địa', 'THCS', 'Tổ Xã hội', 'Giáo viên Lịch sử THCS', em('gv.dia')],
  [101611, 'Nguyễn Thị Văn', 'THCS', 'Tổ Ngữ văn THCS', 'Tổ trưởng Ngữ văn THCS', em('totruong.van')],
  [100657, 'Ninh Thị Lan Anh', 'THCS', 'Tổ KHCN THCS', 'Giáo viên Vật lý', em('lananh1')],
  [101210, 'Ninh Thị Lan Anh', 'THCS', 'Tổ KHCN THCS', 'Giáo viên Hóa học', em('lananh2')],
  [101506, 'Trần Hai Thư', 'THCS', 'Tổ KHCN THCS', 'Giáo viên Khoa học - Tiếng Anh', em('thu.a')],
  [101506, 'Trần Hai Thư', 'THCS', 'Tổ KHCN THCS', 'Giáo viên Khoa học - Tiếng Anh THCS', em('thu.b')],
  [200555, 'Trùng Tên Văn', 'THCS', 'Tổ Ngoại ngữ THCS', 'Giáo viên Tiếng Anh', em('trung.ten.thcs')],
  [101392, 'Nguyễn Hai Mail', 'THCS', 'Tổ Năng khiếu', 'GV Âm nhạc', em('hanh')],
  [100348, 'Trịnh Cấp Ba', 'THPT', 'Tổ Xã hội', '', em('capba')],
  [101465, 'Trần Hai Dòng', 'THCS', 'Tổ Xã hội THCS', 'Giáo viên Văn', ''],
  [101465, 'Trần Hai Dòng', 'THCS', 'Tổ Ngữ văn THCS', 'Giáo viên Ngữ văn THCS', em('haidong')],
  [101700, 'Lê Trợ Lý', 'THCS', 'Văn phòng', 'Trợ lý Hiệu trưởng', em('troly')],
  [101701, 'Phan Phó Tổ', 'THCS', 'Tổ Ngữ văn THCS', 'Phó tổ trưởng', em('photo')],
];
export const tihStaffTable = (rows = TIH_STAFF_ROWS) => ({ cols: structuredClone(STAFF_COLS_TIH), rows: rows.map(r => staffRow([r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], `TiH${r[0]}`], STAFF_COLS_TIH.length)), parsedNumHeaders: 1 });
export const thcsStaffTable = (rows = THCS_STAFF_ROWS) => ({
  cols: structuredClone(STAFF_COLS_THCS),
  rows: [
    ...rows.map(r => staffRow([r[0], r[1], r[2], r[3], r[4], r[5], r[6], '', `THCS${r[0]}`, null, 'Đ'], STAFF_COLS_THCS.length)),
    ...Array.from({ length: 3 }, () => staffRow([null, '', '', '', '', '', '', '', '', null, 'SAI'], STAFF_COLS_THCS.length)), // dòng trống cuối bảng
  ],
  parsedNumHeaders: 1,
});

/* ---------------- Tab Phân quyền ---------------- */
const ROLES_COLS = cols([['Email', 'string'], ['Vai trò', 'string'], ['Cấp', 'string'], ['Tổ', 'string'], ['Ghi chú', 'string']]);
export const rolesTable = rows => ({ cols: structuredClone(ROLES_COLS), rows: rows.map(r => ({ c: r.map(S) })), parsedNumHeaders: 1 });

/* ---------------- Biểu mẫu mặc định cho kiểm thử đồng bộ ---------------- */
// Tiểu học: n dòng, xoay vòng giữa vài giáo viên có trong DS (ghép được) và người dự có trong DS.
export const TIH_TEACHERS = [
  { tm: 100131, tn: 'Phạm Văn Hai', tg: 'Tổ 1', teachCol: 'to1' },
  { tm: 100132, tn: 'Đỗ Thị Ba', tg: 'Tổ 1', teachCol: 'to1' },
  { tm: 100136, tn: 'Lý Văn Sáu', tg: 'Tổ 1', teachCol: 'to1' },
  { tm: 100133, tn: 'Hoàng Văn Bốn', tg: 'Tổ Tiếng Anh', teachCol: 'ta' },
  { tm: 100893, tn: 'Ngô Văn Năm', tg: 'Tổ Tiếng Anh', teachCol: 'ta' },
];
export const TIH_OBSERVERS = [
  { oe: em('totruong1'), om: 100130, og: 'Tổ 1', obsCol: 'to1', on: 'Nguyễn Thị Một' },
  { oe: em('pho.tih'), om: 100191, og: 'Ban Giám hiệu', obsCol: 'bgh', on: 'Trần Thị Phó' },
  { oe: em('gv.bon'), om: 100133, og: 'Tổ Tiếng Anh', obsCol: 'ta', on: 'Hoàng Văn Bốn' },
];
export const tihDefaultRow = i => tihRow(i, { ...TIH_TEACHERS[i % TIH_TEACHERS.length], ...TIH_OBSERVERS[i % TIH_OBSERVERS.length] });
export const tihFormTable = (n = 12, rowFn = tihDefaultRow) => ({ cols: structuredClone(TIH_FORM_COLS), rows: Array.from({ length: n }, (_, i) => rowFn(i)), parsedNumHeaders: 1 });

export const THCS_TEACHERS = [
  { tm: 100081, tn: 'Đỗ Thị Ánh', tg: 'Tổ Toán', teachCol: 'toan' },
  { tm: 101602, tn: 'Lê Phương Địa', tg: 'Tổ KHXH', teachCol: 'khxh' },
  { tm: 101465, tn: 'Trần Hai Dòng', tg: 'Tổ Ngữ văn', teachCol: 'van' },
];
export const THCS_OBSERVERS = [
  { oe: em('totruong.toan'), om: 101608, og: 'Tổ Toán', obsCol: 'toan', on: 'Nguyễn Thị Toán' },
  { oe: em('gv.su'), om: 101601, og: 'Tổ KHXH', obsCol: 'khxh', on: 'Trần Thị Sử' },
];
export const thcsDefaultRow = i => thcsRow(i, { ...THCS_TEACHERS[i % THCS_TEACHERS.length], ...THCS_OBSERVERS[i % THCS_OBSERVERS.length] });
export const thcsFormTable = (n = 6, rowFn = thcsDefaultRow) => ({ cols: structuredClone(THCS_FORM_COLS), rows: Array.from({ length: n }, (_, i) => rowFn(i + 1000)), parsedNumHeaders: 1 });

/**
 * Nguồn Sheet giả lập cho runSync: fetchTable(sheetId, tab) trả bản sao của bảng tương ứng.
 * src.tables[sheetId][tabName] có thể sửa giữa các lượt; src.fail[`${sheetId}/${tab}`] = Error để mô phỏng lỗi.
 * Tên tab không tồn tại → trả TAB ĐẦU TIÊN (giống gviz thật).
 */
export function makeSource({ tihN = 12, thcsN = 6, roles = null } = {}) {
  const src = {
    tables: {
      [SHEET_TIH]: { [FORM_TAB]: tihFormTable(tihN), [STAFF_TAB]: tihStaffTable() },
      [SHEET_THCS]: { [FORM_TAB]: thcsFormTable(thcsN), [STAFF_TAB]: thcsStaffTable() },
      // tab đầu tiên của Sheet phân quyền là một tab khác (để kiểm thử “sai tên tab → gviz trả tab đầu tiên”)
      [SHEET_ROLES]: { 'Hướng dẫn': { cols: cols([['Ghi chú', 'string']]), rows: [] }, ...(roles ? { [ROLES_TAB]: rolesTable(roles) } : {}) },
    },
    fail: {}, calls: [], gate: null, publicBySheet: {},
  };
  src.fetchTable = async (sheetId, tab) => {
    const name = tab.sheet;
    src.calls.push(`${sheetId}/${name}`);
    if (src.gate && name === FORM_TAB) await src.gate;
    const f = src.fail[`${sheetId}/${name}`] || src.fail[sheetId];
    if (f) throw f;
    const book = src.tables[sheetId];
    if (!book) throw Object.assign(new Error('Không tìm thấy Google Sheet.'), { expose: true, code: 'SHEET_NOT_FOUND' });
    const t = book[name] ?? Object.values(book)[0];
    return structuredClone(t);
  };
  src.fetchTable.isPublic = async sheetId => (sheetId in src.publicBySheet ? src.publicBySheet[sheetId] : false);
  return src;
}
export const BASE_ENV = Object.freeze({ SHEET_ID_TIH: SHEET_TIH, SHEET_ID_THCS: SHEET_THCS });
export const silentLog = { warn() {}, error() {} };
