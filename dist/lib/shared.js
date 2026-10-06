// Module dùng chung cho máy chủ (Vercel /api/sync) và trình duyệt (index.html).
// Không phụ thuộc thư viện nào. Định nghĩa cấu trúc dữ liệu lưu trong Firestore.
//
// Bản ghi gọn (compact record) – lưu trong dashboard_chunks/{cNNN}.data (chuỗi JSON):
// {
//   id:      string   mã ổn định của phiếu (băm nội dung dòng)
//   ts:      string   'YYYY-MM-DD HH:mm:ss' – giờ gửi phiếu theo giờ của Sheet (Asia/Ho_Chi_Minh)
//   day:     string   'YYYY-MM-DD' – ngày dạy (nếu hợp lệ), ngược lại là ngày gửi phiếu
//   og, on:  string   tổ (đã chuẩn hóa) và họ tên người dự giờ
//   tg, tn:  string   tổ (đã chuẩn hóa) và họ tên giáo viên dạy
//   lesson, period, subject, cls: string   tên bài, tiết, môn, lớp
//   sc:      (number|null)[]   điểm từng tiêu chí, cùng thứ tự với meta.crit
//   pros, cons: string  ưu điểm, cần khắc phục
// }

export const SCHEMA_VERSION = 1;
export const TZ_OFFSET = '+07:00';

// Xếp loại theo điểm trung bình / tiêu chí (thang 5)
export const LEVELS = [
  { key: 'tot', name: 'Tốt', min: 4.5 },
  { key: 'kha', name: 'Khá', min: 3.5 },
  { key: 'dat', name: 'Đạt', min: 2.5 },
  { key: 'chua', name: 'Chưa đạt', min: -Infinity },
];
export const LOW_SCORE = 2; // tiêu chí ≤ mức này bị gắn cờ "cần lưu ý"
export const levelOf = avg => LEVELS.find(l => avg >= l.min - 1e-9).key;
export const levelName = key => (LEVELS.find(l => l.key === key) || {}).name || '';

export const DOMAINS = { 1: 'Chuẩn bị bài dạy', 2: 'Nội dung dạy học', 3: 'Phương pháp dạy học', 4: 'Tổ chức hoạt động học tập', 5: 'Hiệu quả đối với học sinh' };
export const CRIT_SHORT = {
  '1.1': 'Mục tiêu bài học rõ ràng, lượng hóa được', '1.2': 'Giáo án chu đáo, chi tiết, đúng quy định', '1.3': 'Phương tiện, học liệu, CNTT phù hợp',
  '2.1': 'Chính xác, logic, làm rõ trọng tâm', '2.2': 'Mức độ phân hóa phù hợp học sinh', '2.3': 'Tích hợp nội dung giáo dục', '2.4': 'Liên hệ thực tế, trải nghiệm',
  '3.1': 'PPDH phù hợp nội dung & đối tượng', '3.2': 'Vận dụng PPDH tích cực', '3.3': 'Câu hỏi, bài tập phân hóa, kích thích tư duy', '3.4': 'Thu thập phản hồi về mức độ đạt mục tiêu', '3.5': 'Đa dạng phong cách học, khuyến khích tự học', '3.6': 'Ôn tập, củng cố hiệu quả',
  '4.1': 'Có “tiêu chí thành công” suốt giờ học', '4.2': 'Hoạt động học phù hợp mục tiêu', '4.3': 'Phân bố thời gian hợp lý', '4.4': 'Môi trường thân thiện, xử lý tình huống linh hoạt', '4.5': 'Tối đa hóa sự tham gia của HS', '4.6': 'HS được nhận xét, sửa lỗi kịp thời', '4.7': 'HS tự đánh giá, hỗ trợ bạn', '4.8': 'HS hiểu rõ nhiệm vụ học tập',
  '5.1': 'HS đạt yêu cầu bài học', '5.2': 'HS vận dụng kiến thức vào thực tế', '5.3': 'HS tự tin, chủ động, tích cực tương tác',
};

/* ---------------- Chuỗi ---------------- */
export const clean = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
export const fold = s => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

export function normGroup(g) {
  g = clean(g); const f = fold(g);
  if (/giam hieu|lanh dao/.test(f)) return 'Ban Giám Hiệu';
  if (/thinh giang/.test(f)) return 'Giáo viên thỉnh giảng';
  if (/ngoai ngu|tieng anh/.test(f)) return 'Tổ Tiếng Anh';
  if (/khcn/.test(f)) return 'Tổ KHCN';
  if (/the thao/.test(f)) return 'Tổ Thể thao';
  if (/nang khieu/.test(f)) return 'Tổ Năng khiếu';
  if (/bo mon/.test(f)) return 'Tổ Bộ môn';
  const m = f.match(/^(?:to\s*)?(\d)\b/);
  if (m) return 'Tổ ' + m[1];
  return g || 'Khác';
}

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

// table: đối tượng `table` của phản hồi gviz (cols, rows). Trả về { records, crit }.
export function parseFormTable(t) {
  const L = t.cols.map(c => clean(c.label));
  const T = t.cols.map(c => c.type);
  const idx = re => L.findIndex(l => re.test(l));
  const iTs = idx(/^dấu thời gian/i), iOG = idx(/dự giờ thuộc tổ/i), iTI = idx(/^mã nhân viên.*dạy$/i), iTG = idx(/giáo viên dạy thuộc tổ/i),
    iLs = idx(/^tên bài/i), iPe = idx(/^tiết dạy/i), iSu = idx(/^môn dạy/i), iCl = idx(/^lớp dạy/i), iPr = idx(/ưu điểm/i), iCo = idx(/khắc phục/i);
  if (iTs < 0 || iOG < 0 || iTG < 0 || iLs < 0) throw new Error('Không nhận diện được cấu trúc cột của sheet “Câu trả lời biểu mẫu”.');
  const crit = [];
  L.forEach((l, i) => {
    const m = l.match(/^(\d)\.(\d{1,2})\.?\s+(.+)$/);
    if (m && T[i] === 'number') crit.push({ i, code: `${m[1]}.${m[2]}`, d: +m[1], full: m[3].trim() });
  });
  if (!crit.length) throw new Error('Không tìm thấy các cột điểm tiêu chí (1.1, 1.2, …).');
  const obsEnd = iTI > iOG ? iTI : iTG;
  const obsCols = []; for (let i = iOG + 1; i < obsEnd; i++) if (T[i] === 'string') obsCols.push(i);
  const teachCols = [], dateCols = [];
  for (let i = Math.max(iTG, iTI) + 1; i < iLs; i++) { if (T[i] === 'string') teachCols.push(i); else if (T[i] === 'date' || T[i] === 'datetime') dateCols.push(i); }
  const first = (c, cols) => { for (const i of cols) { const v = cellStr(c[i]); if (v) return v; } return ''; };
  const raw = (c, i) => (i >= 0 ? String(c[i]?.v ?? '').trim() : '');

  const records = [], seen = new Map();
  for (const row of t.rows) {
    const c = row.c || [];
    const tw = wallFromCell(c[iTs]); if (!tw) continue;
    const sc = crit.map(k => { const x = c[k.i]; const v = x ? (typeof x.v === 'number' ? x.v : parseFloat(x.v)) : NaN; return Number.isFinite(v) ? v : null; });
    if (!sc.some(v => v != null)) continue;
    let dw = tw;
    for (const i of dateCols) { const lw = wallFromCell(c[i]); if (lw) { const diff = dayNum(tw) - dayNum(lw); if (diff >= -1 && diff <= 120) dw = lw; break; } }
    const r = {
      id: '', ts: wallTsStr(tw), day: wallDayStr(dw),
      og: normGroup(cellStr(c[iOG])), on: first(c, obsCols) || 'Không rõ',
      tg: normGroup(cellStr(c[iTG])), tn: first(c, teachCols) || 'Không rõ',
      lesson: cellStr(c[iLs]), period: iPe >= 0 ? cellStr(c[iPe]) : '', subject: iSu >= 0 ? cellStr(c[iSu]) : '',
      cls: iCl >= 0 ? cellStr(c[iCl]).toUpperCase() : '',
      sc, pros: raw(c, iPr), cons: raw(c, iCo),
    };
    const base = hash53([r.ts, fold(r.tn), fold(r.on), r.cls, r.period, r.subject, r.lesson, sc.join(',')].join('|'));
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    r.id = n === 1 ? base : `${base}-${n}`;
    records.push(r);
  }
  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return { records, crit: crit.map(({ code, d, full }) => ({ code, d, full })) };
}

// Sheet “DS Nhân sự”. Trả về { teach: [{name, group, role}], bgh: [{name, group, role, email}], allEmails: string[] }
// allEmails: email (viết thường, có thể rỗng/lặp – nơi dùng tự lọc) của MỌI dòng nhân sự đang làm việc (gồm cả BGH).
export function parseStaffTable(t) {
  const L = t.cols.map(c => clean(c.label));
  const iN = L.findIndex(l => /họ và tên/i.test(l)), iG = L.findIndex(l => /tổ|bộ phận/i.test(l)), iR = L.findIndex(l => /chức danh/i.test(l)),
    iNote = L.findIndex(l => /ghi chú/i.test(l)), iE = L.findIndex(l => /email/i.test(l));
  if (iN < 0 || iG < 0) return { teach: [], bgh: [], allEmails: [] };
  const all = t.rows.map(r => {
    const c = r.c || [];
    return { name: cellStr(c[iN]), group: normGroup(cellStr(c[iG])), role: iR >= 0 ? cellStr(c[iR]) : '', note: iNote >= 0 ? cellStr(c[iNote]) : '', email: iE >= 0 ? cellStr(c[iE]).toLowerCase() : '' };
  }).filter(s => s.name && !/nghỉ|nghi viec/i.test(s.note));
  return {
    teach: all.filter(s => s.group !== 'Ban Giám Hiệu').map(({ name, group, role }) => ({ name, group, role })),
    bgh: all.filter(s => s.group === 'Ban Giám Hiệu').map(({ name, group, role, email }) => ({ name, group, role, email })),
    allEmails: all.map(s => s.email).filter(Boolean),
  };
}

// Khối lớp từ tên lớp: '3A5' → 'Khối 3', '10A1' → 'Khối 10' (1–12), còn lại → 'Khác'.
// Dùng chung cho dashboard (hydrate) và máy chủ (phieu/{id}.khoi) để hai nơi luôn khớp nhau.
export function gradeOf(cls) {
  const m = String(cls || '').match(/^(\d{1,2})(?!\d)/);
  return m && +m[1] >= 1 && +m[1] <= 12 ? 'Khối ' + +m[1] : 'Khác';
}

/* ---------------- Dùng ở trình duyệt: bản ghi gọn → bản ghi đầy đủ cho dashboard ---------------- */
export function hydrate(r, crit) {
  const ts = tsToLocal(r.ts), day = tsToLocal(r.day);
  const sc = r.sc || [];
  const valid = sc.filter(v => v != null);
  const total = valid.reduce((a, b) => a + b, 0), avg = valid.length ? total / valid.length : 0;
  const dom = {};
  for (let d = 1; d <= 5; d++) { const v = crit.map((k, j) => (k.d === d ? sc[j] : null)).filter(v => v != null); dom[d] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
  const out = {
    id: r.id, ts, day,
    og: r.og, on: r.on, ok: r.og + '|' + fold(r.on), isBGH: r.og === 'Ban Giám Hiệu',
    tg: r.tg, tn: r.tn, tk: r.tg + '|' + fold(r.tn),
    lesson: r.lesson || '', period: r.period || '', subject: r.subject || '', cls: r.cls || '',
    grade: gradeOf(r.cls),
    scores: sc, total, max: valid.length * 5, avg, level: levelOf(avg), dom,
    lowCodes: crit.filter((k, j) => sc[j] != null && sc[j] <= LOW_SCORE).map(k => k.code),
    pros: r.pros || '', cons: r.cons || '',
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
