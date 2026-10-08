// Module dùng chung cho máy chủ (Vercel /api/sync) và trình duyệt (index.html).
// Không phụ thuộc thư viện nào. Định nghĩa cấu trúc dữ liệu lưu trong Firestore.
//
// Bản ghi gọn (compact record) – lưu trong v2_scopes/{scopeId}/chunks/{cNNN}.data (chuỗi JSON):
// {
//   id:      string   mã ổn định của phiếu (băm nội dung dòng; có cấp → khác nhau giữa các cấp)
//   cap:     string   'tih' | 'thcs' | 'thpt' – cấp của Sheet chứa phiếu (v2; bản ghi v1 không có)
//   ts:      string   'YYYY-MM-DD HH:mm:ss' – giờ gửi phiếu theo giờ của Sheet (Asia/Ho_Chi_Minh)
//   day:     string   'YYYY-MM-DD' – ngày dạy (nếu hợp lệ), ngược lại là ngày gửi phiếu
//   og, on:  string   tổ (đã chuẩn hóa theo cấp) và họ tên người dự giờ
//   tg, tn:  string   tổ (đã chuẩn hóa theo cấp) và họ tên giáo viên dạy
//   lesson, period, subject, cls: string   tên bài, tiết, môn, lớp
//   sc:      (number|null)[]   điểm từng tiêu chí, cùng thứ tự với crit của cấp
//   pros, cons: string  ưu điểm, cần khắc phục
//   oe:      string   email người gửi phiếu (cột “Địa chỉ email”, viết thường) – v2
//   om, tm:  string   mã nhân viên người dự giờ / giáo viên dạy (đã chuẩn hóa) – v2
//   tp, op:  string   CHỈ trong phạm vi cấp/tổ: khóa (mờ) của nhân sự mà máy chủ đã ghép làm GV dạy / người dự ('' = chưa ghép) –
//                     để hai người TRÙNG HỌ TÊN không bị gộp làm một trên dashboard; trùng với `k` trong danh sách nhân sự (staff)
//   rel:     string   CHỈ trong phạm vi cá nhân: 't' = tiết tôi dạy, 'o' = phiếu tôi đi dự, 'to' = cả hai
// }
// oe/om/tm chỉ dùng để ghép phiếu với nhân sự. Phạm vi cá nhân (P_*) chỉ giữ các giá trị này khi chúng là của chính người đó
// và không có tp/op.

export const SCHEMA_VERSION = 1;    // bố cục v1 (dashboard/*, phieu/*) – giữ cho tương thích
export const SCHEMA_VERSION_V2 = 2; // bố cục v2 (v2_meta, v2_access, v2_scopes)
export const TZ_OFFSET = '+07:00';

// Xếp loại theo điểm trung bình / tiêu chí (thang 5) – thang của nhà trường:
// Tốt 4,2 – 5 (cảnh báo xanh) · Đạt 3,4 – dưới 4,2 (vàng) · Chưa đạt 2,6 – dưới 3,4 (cam) · Nguy hiểm dưới 2,6 (đỏ).
export const LEVELS = [
  { key: 'tot', name: 'Tốt', min: 4.2 },
  { key: 'dat', name: 'Đạt', min: 3.4 },
  { key: 'chua', name: 'Chưa đạt', min: 2.6 },
  { key: 'nguy', name: 'Nguy hiểm', min: -Infinity },
];
// Dấu nhận diện thang xếp loại: đổi thang → số liệu đối sánh đã chốt (v2_config/state.bench) được tính lại ngay.
export const LEVELS_SIG = LEVELS.map(l => l.key + (Number.isFinite(l.min) ? l.min : '')).join(',');
export const LOW_SCORE = 2; // tiêu chí ≤ mức này bị gắn cờ "cần lưu ý"
export const SCHOOL_YEAR_START_MONTH = 8; // năm học bắt đầu từ 01/08
// So trên điểm làm tròn 2 chữ số – đúng con số đang hiển thị (TB 4,1999 hiện “4,20” → Tốt).
export const levelOf = avg => { const a = Math.round(avg * 100) / 100; return LEVELS.find(l => a >= l.min - 1e-9).key; };
export const levelName = key => (LEVELS.find(l => l.key === key) || {}).name || '';

export const DOMAINS = { 1: 'Chuẩn bị bài dạy', 2: 'Nội dung dạy học', 3: 'Phương pháp dạy học', 4: 'Tổ chức hoạt động học tập', 5: 'Hiệu quả đối với học sinh' };
export const CRIT_SHORT = {
  '1.1': 'Mục tiêu bài học rõ ràng, lượng hóa được', '1.2': 'Giáo án chu đáo, chi tiết, đúng quy định', '1.3': 'Phương tiện, học liệu, CNTT phù hợp',
  '2.1': 'Chính xác, logic, làm rõ trọng tâm', '2.2': 'Mức độ phân hóa phù hợp học sinh', '2.3': 'Tích hợp nội dung giáo dục', '2.4': 'Liên hệ thực tế, trải nghiệm',
  '3.1': 'PPDH phù hợp nội dung & đối tượng', '3.2': 'Vận dụng PPDH tích cực', '3.3': 'Câu hỏi, bài tập phân hóa, kích thích tư duy', '3.4': 'Thu thập phản hồi về mức độ đạt mục tiêu', '3.5': 'Đa dạng phong cách học, khuyến khích tự học', '3.6': 'Ôn tập, củng cố hiệu quả',
  '4.1': 'Có “tiêu chí thành công” suốt giờ học', '4.2': 'Hoạt động học phù hợp mục tiêu', '4.3': 'Phân bố thời gian hợp lý', '4.4': 'Môi trường thân thiện, xử lý tình huống linh hoạt', '4.5': 'Tối đa hóa sự tham gia của HS', '4.6': 'HS được nhận xét, sửa lỗi kịp thời', '4.7': 'HS tự đánh giá, hỗ trợ bạn', '4.8': 'HS hiểu rõ nhiệm vụ học tập',
  '5.1': 'HS đạt yêu cầu bài học', '5.2': 'HS vận dụng kiến thức vào thực tế', '5.3': 'HS tự tin, chủ động, tích cực tương tác',
};

/* ---------------- Cấp học ---------------- */
export const CAPS = Object.freeze(['tih', 'thcs', 'thpt']);
// color: màu nhận diện của cấp (do BGH quy định). Chữ trên nền sáng KHÔNG dùng trực tiếp màu này (vd. #ffad00 chỉ ~1,9:1 trên nền trắng).
export const CAP_INFO = Object.freeze({
  tih: Object.freeze({ cap: 'tih', label: 'Tiểu học', short: 'TiH', color: '#ffad00' }),
  thcs: Object.freeze({ cap: 'thcs', label: 'THCS', short: 'THCS', color: '#2da037' }),
  thpt: Object.freeze({ cap: 'thpt', label: 'THPT', short: 'THPT', color: '#23328C' }),
});
export const capLabel = cap => CAP_INFO[cap]?.label || '';

/* ---------------- Chuỗi ---------------- */
export const clean = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
export const fold = s => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
// Khóa họ tên GIỮ dấu thanh (Thúy ≠ Thùy ≠ Thủy) nhưng không phụ thuộc vị trí đặt dấu (“hoà” = “hòa”, “Thuý” = “Thúy”):
// mỗi từ = phần chữ (giữ dấu mũ/móc/trăng, đ) + số của thanh điệu (1 sắc, 2 huyền, 3 hỏi, 4 ngã, 5 nặng).
const TONE_RE = /[\u0300\u0301\u0303\u0309\u0323]/g;
const TONE_NUM = { '\u0301': '1', '\u0300': '2', '\u0309': '3', '\u0303': '4', '\u0323': '5' };
export const nameKey = s => clean(s).toLowerCase().split(' ').filter(Boolean).map(w => {
  const d = w.normalize('NFD');
  const t = (d.match(TONE_RE) || []).map(c => TONE_NUM[c]).join('');
  return d.replace(TONE_RE, '').normalize('NFC') + t;
}).join(' ');
// 'Tổ Toán' → 'to-toan' (dùng trong mã phạm vi T_<cấp>_<slug>)
export const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'khac';

// Email: đúng MỘT dấu '@', hai phía khác rỗng, có dấu chấm ở tên miền, không có '/' (email là mã tài liệu v2_access/{email}). Viết thường.
const EMAIL_RE = /^[^\s@,;/]+@[^\s@,;/]+\.[^\s@,;/]+$/;
export const emailsIn = s => String(s ?? '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => EMAIL_RE.test(x));
export const normEmail = s => emailsIn(s)[0] || '';

// Mã nhân sự: bỏ khoảng trắng/dấu câu, viết hoa; chuỗi toàn số bỏ số 0 ở đầu ('0101506' → '101506').
export function normMa(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : '';
  const s = String(v ?? '').normalize('NFC').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

// 'Tiểu học, THCS' → { caps: ['tih','thcs'], lienCap: false };  'Liên cấp' → { caps: [], lienCap: true }
export function parseCaps(s) {
  const set = new Set();
  let lienCap = false;
  for (const part of fold(s).split(/[,;/+&]|\bva\b/)) {
    const p = part.trim();
    if (!p) continue;
    if (/lien cap|toan truong|tat ca/.test(p)) lienCap = true;
    else if (/thcs|trung hoc co so/.test(p)) set.add('thcs');
    else if (/thpt|trung hoc pho thong/.test(p)) set.add('thpt');
    else if (/tieu hoc|\btih\b|^th$/.test(p)) set.add('tih');
  }
  return { caps: CAPS.filter(c => set.has(c)), lienCap };
}

/* ---------------- Chuẩn hóa tên tổ (theo từng cấp) ---------------- */
// Bảng quy tắc (dữ liệu): [biểu thức trên chuỗi đã fold(), tên tổ chuẩn]. Quy tắc đầu tiên khớp được dùng.
// Mục tiêu: tên tổ trong “DS Nhân sự” (vd. 'Tổ Toán THCS', 'Tổ Xã hội', 'Tổ Ngoại ngữ Tiểu học') khớp với giá trị
// cột “Giáo viên dạy thuộc Tổ” của biểu mẫu cùng cấp (vd. 'Tổ Toán', 'Tổ KHXH', 'Tổ Tiếng Anh').
export const TO_BGH = 'Ban Giám Hiệu';
export const TO_TG = 'Giáo viên thỉnh giảng';
export const TO_OTHER = 'Khác';
const HEAD_RULES = [
  [/giam hieu|lanh dao|^bgh$/, TO_BGH],
  [/thinh giang/, TO_TG],
];
const SECONDARY_RULES = [
  ...HEAD_RULES,
  [/ngoai ngu|tieng (anh|trung|nhat|han|phap|duc)/, 'Tổ Ngoại ngữ'],
  [/khcn|khoa hoc cong nghe|khoa hoc tu nhien|khtn/, 'Tổ KHCN'],
  [/ngu van|(^|\s)van$/, 'Tổ Ngữ văn'],
  [/khxh|xa hoi/, 'Tổ KHXH'],
  [/\btoan\b(?! truong)/, 'Tổ Toán'],
  [/the thao|the duc/, 'Tổ Thể thao'],
  [/nang khieu/, 'Tổ Năng khiếu'],
  [/cong nghe/, 'Tổ Công nghệ'],
  [/bo mon/, 'Tổ Bộ môn'],
];
export const TO_RULES = Object.freeze({
  tih: [
    ...HEAD_RULES,
    [/ngoai ngu|tieng anh/, 'Tổ Tiếng Anh'], // 'Tổ Ngoại ngữ Tiểu học', 'Tiếng Anh', 'Tổ Toán - Tiếng Anh' (như v1)
    [/khcn|khoa hoc cong nghe/, 'Tổ KHCN'],
    [/the thao|the duc/, 'Tổ Thể thao'],
    [/nang khieu/, 'Tổ Năng khiếu'],
    [/bo mon/, 'Tổ Bộ môn'],
    [/^(?:to\s*)?(\d)\b/, 'Tổ $1'],
  ],
  thcs: SECONDARY_RULES,
  thpt: SECONDARY_RULES,
});
// Bỏ hậu tố cấp ở cuối: 'Tổ Hóa THPT' → 'Tổ Hóa', 'Tổ X (Tiểu học)' → 'Tổ X'
const CAP_SUFFIX_RE = /(?:\s*[-–,(]?\s*(?:tiểu học|tih|thcs|thpt|liên cấp)\s*\)?)+\s*$/iu;

/** Chuẩn hóa tên tổ theo cấp. Trả về { to, known } – known = khớp một quy tắc trong TO_RULES. */
export function toRule(cap, g) {
  const s = clean(g);
  const f = fold(s);
  if (!f) return { to: TO_OTHER, known: false };
  for (const [re, name] of TO_RULES[cap] || TO_RULES.tih) {
    const m = f.match(re);
    if (m) return { to: name.replace(/\$(\d)/g, (_, k) => m[+k] || ''), known: true };
  }
  let out = s.replace(CAP_SUFFIX_RE, '').trim() || s;
  if (/^tổ\s/iu.test(out)) out = 'Tổ' + out.slice(2);
  return { to: out, known: false };
}
export const normTo = (cap, g) => toRule(cap, g).to;
// v1: tổ của Tiểu học
export const normGroup = g => normTo('tih', g);

// Băm 53-bit đồng bộ (cyrb53) → base36. Dùng cho mã phiếu và phát hiện thay đổi.
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* ---------------- Ngày giờ (giờ “treo tường”, không phụ thuộc múi giờ máy chủ) ---------------- */
const p2 = n => String(n).padStart(2, '0');
// Trả về {y,m,d,h,mi,s} (m: 1–12) hoặc null
export function wallFromCell(c) {
  if (!c || c.v == null) return null;
  if (typeof c.v === 'string') {
    const m = c.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
    if (m) return { y: +m[1], m: +m[2] + 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
    return wallFromDMY(c.v);
  }
  return c.f ? wallFromDMY(c.f) : null;
}
export function wallFromDMY(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? { y: +m[3], m: +m[2], d: +m[1], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) } : null;
}
export const wallDayStr = w => `${String(w.y).padStart(4, '0')}-${p2(w.m)}-${p2(w.d)}`;
export const wallTsStr = w => `${wallDayStr(w)} ${p2(w.h)}:${p2(w.mi)}:${p2(w.s)}`;
// Số ngày (theo lịch) giữa hai ngày treo tường
const dayNum = w => Date.UTC(w.y, w.m - 1, w.d) / 864e5;
// Chuỗi 'YYYY-MM-DD HH:mm:ss' → Date thực (dùng múi giờ của Sheet)
export const tsToInstant = ts => new Date(ts.replace(' ', 'T') + TZ_OFFSET);
// Chuỗi → Date theo giờ địa phương của trình duyệt (để hiển thị/so sánh ngày)
export function tsToLocal(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
}

/* ---------------- Đọc bảng Google Visualization ---------------- */
export function cellStr(c) {
  if (!c || c.v == null) return '';
  if (typeof c.v === 'number') return clean(c.f ?? String(c.v));
  return clean(c.v);
}
const maCell = c => (!c || c.v == null ? '' : normMa(typeof c.v === 'number' ? c.v : cellStr(c)));
// Cột không có tiêu đề: gviz đặt nhãn 'Cột 15' (hoặc rỗng)
const isUnnamed = f => /^(?:cot \d+)?$/.test(f);
// Cột họ tên người dự giờ: 'Họ và tên BGH dự giờ', 'Họ và tên giáo viên tổ KHXH dự giờ', 'Họ và tên người dự giờ'
const isObserverLabel = f => /^ho va ten\b/.test(f) && /\bdu gio\b/.test(f) && !/\bday\b/.test(f);
// Cột họ tên giáo viên dạy: 'Họ và tên giáo viên dạy Tổ 1', '… dạy thuộc tổ KHXH', '… thỉnh giảng dạy'
const isTeacherLabel = f => /^ho va ten\b/.test(f) && /\b(day|thinh giang)\b/.test(f) && !isObserverLabel(f);

/**
 * Tab “Câu trả lời biểu mẫu”. table: đối tượng `table` của phản hồi gviz (cols, rows).
 * Nhận diện cột theo NHÃN (không theo vị trí) nên các cột thêm sau (vd. “Họ và tên giáo viên tổ KHXH dự giờ”
 * nằm sau cột nhận xét ở Sheet THCS) vẫn được đọc. Cột không tên (“Cột N”) nằm giữa nhóm người dự giờ và
 * nhóm giáo viên dạy vẫn được tính như v1.
 * @param {object} t
 * @param {{cap?: string}} [opts]  cap: 'tih' | 'thcs' | 'thpt' – chuẩn hóa tổ theo cấp, gắn r.cap, mã phiếu riêng theo cấp
 * @returns {{records: object[], crit: {code:string, d:number, full:string}[]}}
 */
export function parseFormTable(t, { cap = '' } = {}) {
  const L = t.cols.map(c => clean(c.label));
  const F = L.map(fold);
  const T = t.cols.map(c => c.type);
  const idx = re => F.findIndex(l => re.test(l));
  const iTs = idx(/^dau thoi gian/), iEm = idx(/^dia chi email|^email/), iOG = idx(/du gio thuoc to/),
    iTG = F.findIndex(l => /day thuoc to/.test(l) && !/^ho va ten/.test(l)),
    iLs = idx(/^ten bai/), iPe = idx(/^tiet day/), iSu = idx(/^mon day/), iCl = idx(/^lop day/), iPr = idx(/uu diem/), iCo = idx(/khac phuc/),
    iDay = idx(/^ngay day/);
  if (iTs < 0 || iOG < 0 || iTG < 0 || iLs < 0) throw new Error('Không nhận diện được cấu trúc cột của sheet “Câu trả lời biểu mẫu”.');
  const maCols = F.map((l, i) => (/^ma (nhan vien|nhan su|nv|gv|giao vien)\b/.test(l) ? i : -1)).filter(i => i >= 0);
  const iTM = maCols.find(i => /\bday\b/.test(F[i])) ?? -1;
  const iOM = maCols.find(i => i !== iTM && /\bdu gio\b|\bdi du\b/.test(F[i])) ?? -1;

  const crit = [];
  L.forEach((l, i) => {
    const m = l.match(/^(\d)\.(\d{1,2})\.?\s+(.+)$/);
    if (m && T[i] === 'number') crit.push({ i, code: `${m[1]}.${m[2]}`, d: +m[1], full: m[3].trim() });
  });
  if (!crit.length) throw new Error('Không tìm thấy các cột điểm tiêu chí (1.1, 1.2, …).');

  const isStr = i => T[i] === 'string';
  const obsEnd = [iTM, iTG].filter(i => i > iOG).sort((a, b) => a - b)[0] ?? iLs;
  const teachStart = Math.max(iTG, iTM);
  const obsCols = [], teachCols = [], dateCols = [];
  F.forEach((f, i) => {
    if (!isStr(i)) return;
    if (isObserverLabel(f) || (isUnnamed(f) && i > iOG && i < obsEnd)) obsCols.push(i);
    else if (isTeacherLabel(f) || (isUnnamed(f) && i > teachStart && i < iLs)) teachCols.push(i);
  });
  if (iDay >= 0 && (T[iDay] === 'date' || T[iDay] === 'datetime')) dateCols.push(iDay);
  for (let i = teachStart + 1; i < iLs; i++) if ((T[i] === 'date' || T[i] === 'datetime') && i !== iDay) dateCols.push(i);

  const first = (c, cols) => { for (const i of cols) { const v = cellStr(c[i]); if (v) return v; } return ''; };
  const raw = (c, i) => (i >= 0 ? String(c[i]?.v ?? '').trim() : '');
  const capRules = cap || 'tih';

  const records = [], seen = new Map();
  for (const row of t.rows) {
    const c = row.c || [];
    const tw = wallFromCell(c[iTs]); if (!tw) continue;
    const sc = crit.map(k => { const x = c[k.i]; const v = x ? (typeof x.v === 'number' ? x.v : parseFloat(x.v)) : NaN; return Number.isFinite(v) ? v : null; });
    if (!sc.some(v => v != null)) continue;
    let dw = tw;
    for (const i of dateCols) { const lw = wallFromCell(c[i]); if (lw) { const diff = dayNum(tw) - dayNum(lw); if (diff >= -1 && diff <= 120) dw = lw; break; } }
    const r = {
      id: '', ...(cap ? { cap } : {}), ts: wallTsStr(tw), day: wallDayStr(dw),
      og: normTo(capRules, cellStr(c[iOG])), on: first(c, obsCols) || 'Không rõ',
      tg: normTo(capRules, cellStr(c[iTG])), tn: first(c, teachCols) || 'Không rõ',
      lesson: cellStr(c[iLs]), period: iPe >= 0 ? cellStr(c[iPe]) : '', subject: iSu >= 0 ? cellStr(c[iSu]) : '',
      cls: iCl >= 0 ? cellStr(c[iCl]).toUpperCase() : '',
      sc, pros: raw(c, iPr), cons: raw(c, iCo),
      oe: iEm >= 0 ? normEmail(cellStr(c[iEm])) : '',
      om: iOM >= 0 ? maCell(c[iOM]) : '',
      tm: iTM >= 0 ? maCell(c[iTM]) : '',
    };
    const base = hash53((cap ? cap + '|' : '') + [r.ts, fold(r.tn), fold(r.on), r.cls, r.period, r.subject, r.lesson, sc.join(',')].join('|'));
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    r.id = n === 1 ? base : `${base}-${n}`;
    records.push(r);
  }
  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return { records, crit: crit.map(({ code, d, full }) => ({ code, d, full })) };
}

/* ---------------- DS Nhân sự ---------------- */
// Ghi chú nghỉ việc/nghỉ sinh… (không bắt “đề nghị”, “hội nghị”)
export const isLeaveNote = note => /nghỉ/iu.test(clean(note)) || /\bnghi (viec|sinh|huu|thai san|om|phep|khong luong)\b/.test(fold(note));

/**
 * Cờ vai trò TỰ ĐỘNG của một dòng nhân sự (so sánh không dấu, không phân biệt hoa thường).
 *  • bghAll  – Tổ/Bộ phận ~ “Ban lãnh đạo” hoặc Chức danh ~ “Tổng hiệu trưởng”
 *  • bghCap  – Tổ/Bộ phận ~ “Ban giám hiệu” hoặc Chức danh ~ “hiệu trưởng”, “BGH”, “Thành viên BGH”, “TV BGH”
 *  • toTruong – tên tổ (đã chuẩn hóa) nếu Chức danh có “Tổ trưởng” (không tính “tổ phó”, “phó tổ trưởng”,
 *              “nhóm trưởng”, “tổ trưởng khối”, “tổ trưởng công đoàn”); tổ lấy từ tên ghi trong chức danh
 *              (vd. “TV BGH - Tổ trưởng tổ KHCN THCS”) nếu nhận ra được, ngược lại lấy cột Tổ/Bộ phận.
 *  Không cấp vai trò lãnh đạo cho: chức danh “nguyên …” (đã thôi giữ chức – vd. “Nguyên Tổ trưởng Tổ 3”, “Nguyên Hiệu trưởng”)
 *  và chức danh hành chính/phục vụ (văn thư, thư ký, trợ lý, nhân viên, kế toán, lái xe, bảo vệ… – kể cả khi thuộc bộ phận BGH).
 * @param {{toRaw:string, role:string, to:string}} row
 * @param {string} cap  cấp của Sheet
 * @param {Set<string>} [knownTos]  các tổ (đã fold) có trong Sheet – để nhận tên tổ ghi trong chức danh
 */
const FORMER_RE = /(^|[,;\-–(/]\s*)nguyen\s+(?:to truong|to pho|pho hieu truong|hieu truong|tong hieu truong|tv bgh|thanh vien bgh|pho tong)[^,;\-–(/]*/g;
const NON_LEAD_RE = /\b(?:tro ly|thu ky|giup viec|van thu|nhan vien|ke toan|thu quy|lai xe|bao ve|tap vu|y te)\b/;
export function staffRoleFlags({ toRaw = '', role = '', to = '' }, cap, knownTos = new Set()) {
  const g = fold(toRaw), r = fold(role).replace(FORMER_RE, '$1').trim();
  const clerical = NON_LEAD_RE.test(r);
  const bghAll = !clerical && (/lanh dao/.test(g) || /tong hieu truong/.test(r));
  const bghCap = !clerical && (/giam hieu/.test(g) || /hieu truong|\bbgh\b/.test(r));
  let toTruong = '';
  for (const m of r.matchAll(/(?<![a-z])(?<!pho )to truong\b/g)) {
    const rest = r.slice(m.index + m[0].length);
    if (/^\s*(?:khoi\b|(?:to\s+)?(?:cong doan|doan\b))/.test(rest)) continue; // tổ trưởng khối / công đoàn
    const named = rest.split(/\s[-–]\s|[-–,;(/]|\bgv\b|\bgiao vien\b|\bgvcn\b/)[0].trim();
    if (named) {
      const cand = toRule(cap, named);
      if (cand.known || knownTos.has(fold(cand.to))) toTruong = cand.to;
    }
    if (!toTruong) toTruong = to;
    if (toTruong === TO_BGH || toTruong === TO_OTHER) toTruong = '';
    break;
  }
  return { bghAll, bghCap, toTruong };
}

/**
 * Tab “DS Nhân sự” (Mã nhân sự | Họ và tên Nhân sự | Cấp | Tổ/Bộ phận | Chức danh | Email | Thâm niên | Ghi chú …).
 * @param {object} t  `table` của gviz
 * @param {{cap?: string}} [opts]  cap của Sheet – để chuẩn hóa tổ và gán vai trò BGH cấp
 * @returns {{
 *   teach: {name, group, role}[],                      // v1: giáo viên/nhân viên đang làm việc (không gồm BGH)
 *   bgh: {name, group, role, email}[],                 // v1: Ban Giám hiệu
 *   allEmails: string[],                               // v1: email mọi nhân sự đang làm việc
 *   rows: {ma, name, email, emails, capCell, caps, lienCap, to, toRaw, role, note, active, bghAll, bghCap, toTruong}[],
 *   recognized: boolean                                // false: bảng không phải DS Nhân sự (vd. gviz trả về tab đầu tiên vì sai tên tab)
 * }}
 */
export function parseStaffTable(t, { cap = '' } = {}) {
  const F = t.cols.map(c => fold(c.label));
  const find = re => F.findIndex(l => re.test(l));
  const iN = find(/^ho va ten/), iG = find(/^to\b|bo phan/), iR = find(/chuc danh|chuc vu/), iE = find(/email/),
    iMa = find(/^ma (nhan su|nhan vien|nv|gv|giao vien)\b|^ma$/), iCap = find(/^cap\b/);
  const noteCols = F.map((l, i) => (/ghi chu|tham nien|trang thai|tinh trang/.test(l) ? i : -1)).filter(i => i >= 0);
  const formLike = F.some(l => /^dau thoi gian/.test(l));
  if (iN < 0 || iG < 0 || formLike) return { teach: [], bgh: [], allEmails: [], rows: [], recognized: false };
  const capRules = cap || 'tih';

  const rows = [];
  for (const r of t.rows) {
    const c = r.c || [];
    const name = cellStr(c[iN]);
    if (!name) continue;
    const toRaw = cellStr(c[iG]);
    const note = noteCols.map(i => cellStr(c[i])).filter(Boolean).join(' · ');
    const emails = iE >= 0 ? emailsIn(cellStr(c[iE])) : [];
    const capCell = iCap >= 0 ? cellStr(c[iCap]) : '';
    const { caps, lienCap } = parseCaps(capCell);
    rows.push({
      ma: iMa >= 0 ? maCell(c[iMa]) : '', name, email: emails[0] || '', emails, capCell, caps, lienCap,
      to: normTo(capRules, toRaw), toRaw, role: iR >= 0 ? cellStr(c[iR]) : '', note, active: !isLeaveNote(note),
    });
  }
  const knownTos = new Set(rows.map(r => fold(r.to)));
  for (const r of rows) Object.assign(r, staffRoleFlags(r, capRules, knownTos));

  const act = rows.filter(r => r.active);
  return {
    teach: act.filter(s => s.to !== TO_BGH).map(s => ({ name: s.name, group: s.to, role: s.role })),
    bgh: act.filter(s => s.to === TO_BGH).map(s => ({ name: s.name, group: s.to, role: s.role, email: s.email })),
    allEmails: act.flatMap(s => s.emails),
    rows,
    recognized: true,
  };
}

// Khối lớp từ tên lớp: '3A5' → 'Khối 3', '10A1' → 'Khối 10' (1–12), còn lại → 'Khác'.
// Dùng chung cho dashboard (hydrate) và máy chủ để hai nơi luôn khớp nhau.
export function gradeOf(cls) {
  const m = String(cls || '').match(/^(\d{1,2})(?!\d)/);
  return m && +m[1] >= 1 && +m[1] <= 12 ? 'Khối ' + +m[1] : 'Khác';
}

/* ---------------- Dùng ở trình duyệt: bản ghi gọn → bản ghi đầy đủ cho dashboard ---------------- */
// crit: danh sách tiêu chí CỦA CẤP chứa bản ghi (phạm vi cá nhân: doc.crit[r.cap]).
// Khóa tk/ok có tiền tố cấp khi bản ghi có cap, để giáo viên trùng tên ở hai cấp không bị gộp; trong phạm vi cấp/tổ khóa dùng
// tp/op (nhân sự máy chủ đã ghép) thay cho họ tên, để hai giáo viên TRÙNG HỌ TÊN trong cùng tổ không bị gộp.
export function hydrate(r, crit) {
  const ts = tsToLocal(r.ts), day = tsToLocal(r.day);
  const sc = r.sc || [];
  const valid = sc.filter(v => v != null);
  const total = valid.reduce((a, b) => a + b, 0), avg = valid.length ? total / valid.length : 0;
  const dom = {};
  for (let d = 1; d <= 5; d++) { const v = crit.map((k, j) => (k.d === d ? sc[j] : null)).filter(v => v != null); dom[d] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
  const cap = r.cap || '';
  const pre = cap ? cap + ':' : '';
  const out = {
    id: r.id, cap, rel: r.rel || '', ts, day,
    og: r.og, on: r.on, ok: pre + r.og + '|' + (r.op ? '#' + r.op : fold(r.on)), isBGH: r.og === TO_BGH,
    tg: r.tg, tn: r.tn, tk: pre + r.tg + '|' + (r.tp ? '#' + r.tp : fold(r.tn)),
    lesson: r.lesson || '', period: r.period || '', subject: r.subject || '', cls: r.cls || '',
    grade: gradeOf(r.cls),
    scores: sc, total, max: valid.length * 5, avg, level: levelOf(avg), dom,
    lowCodes: crit.filter((k, j) => sc[j] != null && sc[j] <= LOW_SCORE).map(k => k.code),
    pros: r.pros || '', cons: r.cons || '',
    oe: r.oe || '', om: r.om || '', tm: r.tm || '', tp: r.tp || '', op: r.op || '',
  };
  out.search = fold([out.tn, out.on, out.lesson, out.cls, out.subject, out.tg].join(' '));
  return out;
}

// Chia bản ghi (đã sắp theo ts) thành các khối ≤ maxBytes (JSON) và ≤ maxRecords.
export function chunkRecords(records, { maxBytes = 600_000, maxRecords = 500 } = {}) {
  const chunks = []; let cur = [], size = 2;
  for (const r of records) {
    const len = JSON.stringify(r).length + 1;
    if (cur.length && (size + len > maxBytes || cur.length >= maxRecords)) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r); size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((recs, i) => { const data = JSON.stringify(recs); return { id: 'c' + String(i).padStart(3, '0'), i, n: recs.length, data, hash: hash53(data) }; });
}
