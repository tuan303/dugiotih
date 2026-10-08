// Ghép phiếu ↔ nhân sự và dựng các “phạm vi dữ liệu” (scope) của v2. THUẦN (không I/O) để kiểm thử offline.
//
// Phạm vi (v2_scopes/{scopeId}, phiếu trong v2_scopes/{scopeId}/chunks/{cNNN}):
//   L_<cap>              – toàn bộ phiếu của một cấp (BGH liên cấp, BGH cấp)
//   T_<cap>_<slug(tổ)>   – phiếu có giáo viên dạy thuộc tổ đó (Tổ trưởng)
//   P_<personKey>        – phiếu của MỘT người: tiết người đó dạy (rel 't') + phiếu người đó đi dự (rel 'o'), 'to' = cả hai.
//                          personKey = hash53(email) (không đoán ngược được email).
// Quyền riêng tư:
//  • phạm vi cấp/tổ giữ đủ trường (BGH/tổ trưởng cần email/mã) + khóa nhân sự đã ghép (tp/op);
//  • phạm vi cá nhân XÓA email/mã của người khác (oe chỉ giữ khi là email của chính người đó; om/tm chỉ giữ khi là mã của
//    người đó) và không có tp/op;
//  • số liệu đối sánh (điểm TB tổ/cấp) là số gộp, làm tròn, chỉ tính các tuần ĐÃ KẾT THÚC và chỉ được công bố lại khi nhóm có
//    thêm ≥ BENCH_RULES.minNewRecords phiếu của ≥ BENCH_RULES.minNewTeachers giáo viên (xem publishBenchmarks) – để không ai
//    lấy hiệu hai lần công bố liên tiếp mà suy ra điểm của MỘT tiết dạy; nhóm có < 3 giáo viên được dự thì không công bố.
import { CAPS, CAP_INFO, TO_BGH, TO_OTHER, fold, nameKey, hash53, slug, LEVELS, LEVELS_SIG, levelOf, chunkRecords, SCHOOL_YEAR_START_MONTH } from '../lib/shared.js';

// chunkRecords đo độ dài theo đơn vị UTF-16; mỗi đơn vị ≤ 3 byte UTF-8 → 340 000 × 3 < 1 MiB (giới hạn tài liệu Firestore).
export const CHUNK_OPTS = Object.freeze({ maxBytes: 340_000, maxRecords: 500 });
// Quy tắc công bố số liệu đối sánh ẩn danh.
export const BENCH_RULES = Object.freeze({
  minTeachers: 3,      // nhóm có ít hơn ngần này GV được dự → không công bố điểm
  minRecords: 5,       // … hoặc ít hơn ngần này phiếu
  minNewRecords: 5,    // chỉ công bố lại khi có thêm ≥ ngần này phiếu mới (đã chốt) kể từ lần công bố trước …
  minNewTeachers: 3,   // … của ≥ ngần này giáo viên khác nhau
  decimals: 1,         // điểm TB làm tròn 0,1
  pctStep: 5,          // tỷ lệ xếp loại làm tròn 5 %
});
export const MIN_BENCH_TEACHERS = BENCH_RULES.minTeachers;

export const scopeIdLevel = cap => `L_${cap}`;
export const scopeIdTo = (cap, to) => `T_${cap}_${slug(to)}`;
export const scopeIdPerson = key => `P_${key}`;
export const toLabel = (cap, to) => `${to} – ${CAP_INFO[cap]?.label || cap}`;

/* ---------------- Ghép phiếu ↔ người ---------------- */
const push = (m, k, v) => { if (!k) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
const uniq = arr => [...new Set(arr)];
const unknownName = f => !f || f === 'khong ro';

/**
 * “Nhân thân” (human): một người thật = cụm các dòng DS Nhân sự (mọi Sheet, CẢ dòng đã nghỉ / không email / bị thu hồi) cùng
 * email hoặc cùng (mã + họ tên). Phiếu được ghép với nhân thân; nhân thân chỉ chuyển phiếu cho các tài khoản ĐƯỢC PHÉP của mình
 * (persons). Nhờ vậy người đã nghỉ / bị thu hồi quyền vẫn “giữ” phiếu của mình: phiếu đó KHÔNG rơi sang đồng nghiệp trùng họ tên.
 * @typedef {{ hid:string, emails:Set<string>, mas:Set<string>, names:{f:string,k:string}[], folds:Set<string>, caps:Set<string>,
 *   anyLevel:boolean, rows:{row:object, cap:string}[], persons:object[] }} Human
 */

/**
 * Tạo bộ ghép dùng chung cho mọi phiếu.
 * Họ tên so khớp theo khóa GIỮ dấu thanh (nameKey: Thúy ≠ Thùy); chỉ so khớp kiểu bỏ dấu (fold) khi cách viết bỏ dấu đó ứng với
 * DUY NHẤT một cách viết có dấu trong toàn bộ DS Nhân sự (vd. phiếu gõ “Nguyen Thi Hoa” không dấu).
 * @param {Human[]} humans
 */
export function makeMatcher(humans) {
  const byEmail = new Map(), byMa = new Map(), byKey = new Map(), byFold = new Map(), spell = new Map();
  for (const h of humans) {
    for (const e of h.emails) push(byEmail, e, h);
    for (const ma of h.mas) push(byMa, ma, h);
    for (const { f, k } of h.names) {
      push(byKey, k, h); push(byFold, f, h);
      if (!spell.has(f)) spell.set(f, new Set());
      spell.get(f).add(k);
    }
  }
  for (const m of [byEmail, byMa, byKey, byFold]) for (const [k, v] of m) m.set(k, uniq(v));
  const byName = name => {
    const hit = byKey.get(nameKey(name));
    if (hit) return hit;
    const f = fold(name);
    return spell.get(f)?.size === 1 ? byFold.get(f) || [] : [];
  };
  const inCap = cap => h => h.caps.has(cap) || h.anyLevel;
  /**
   * Nhân thân khớp với (mã, họ tên) trong cấp `cap`:
   *  1) mã khớp VÀ họ tên khớp → người đó (chắc chắn);
   *  2) họ tên khớp DUY NHẤT một nhân thân trong cấp đó (hoặc “Liên cấp”) → người đó, kể cả khi mã ghi sai (họ tên chọn từ danh
   *     sách thả xuống của biểu mẫu nên tin cậy hơn mã gõ tay); ≥ 2 nhân thân trùng họ tên → không ghép (“ambiguous”);
   *  3) họ tên không khớp ai trong cấp, mã thuộc DUY NHẤT một nhân thân có cùng TÊN GỌI (từ cuối) → người đó (họ tên gõ sai);
   *  còn lại → không ghép (thà thiếu còn hơn đưa phiếu cho nhầm người).
   * @returns {{ hs: Human[], how: 'ma+name'|'name'|'ma'|'ambiguous'|'none' }}
   */
  function resolve(cap, ma, name) {
    const fn = fold(name);
    const maH = ma ? byMa.get(ma) || [] : [];
    const nameH = unknownName(fn) ? [] : byName(name);
    const agree = maH.filter(h => nameH.includes(h));
    if (agree.length) return { hs: agree, how: 'ma+name' };
    const nameC = nameH.filter(inCap(cap));
    if (nameC.length === 1) return { hs: nameC, how: 'name' };
    if (nameC.length > 1) return { hs: [], how: 'ambiguous' };
    if (maH.length === 1 && !unknownName(fn)) {
      const given = fn.split(' ').pop();
      if ([...maH[0].folds].some(n => n.split(' ').pop() === given)) return { hs: maH, how: 'ma' };
    }
    return { hs: [], how: 'none' };
  }
  // Mã thuộc DUY NHẤT một nhân thân → nhân thân đó.
  const byMaOnly = ma => { const hs = ma ? byMa.get(ma) || [] : []; return hs.length === 1 ? hs : []; };
  // Nhân thân có dòng DS ở cấp `cap` thuộc tổ `tg` (đối chiếu khi chỉ dựa vào mã).
  const inTo = (h, cap, tg) => !!tg && h.rows.some(x => (x.cap === cap || x.row.lienCap) && x.row.to === tg);

  /**
   * Ghép một phiếu: người dạy (T) và người dự (O).
   *  • Người dự: email người gửi phiếu (mạnh nhất) – cộng thêm người được nêu khi mã + họ tên người dự cùng chỉ một người;
   *    không khớp email → theo mã/họ tên người dự (resolve).
   *  • Họ tên người dạy TRÙNG họ tên người dự (điền nhầm một ô): KHÔNG dùng họ tên đó cho cả hai vai trò. Người dự theo
   *    email/mã người dự; người dạy theo mã GV dạy (phải là mã của chính người mang họ tên đó, hoặc người có tổ trong DS khớp
   *    tổ GV dạy trên phiếu). Nếu người dự (theo email/mã) là người khác → họ tên đó là của GV dạy, và ngược lại.
   */
  function matchOne(cap, r) {
    const em = r.oe ? byEmail.get(r.oe) || [] : [];
    const fn = fold(r.tn);
    if (unknownName(fn) || fn !== fold(r.on)) {
      const T = resolve(cap, r.tm, r.tn);
      const o = resolve(cap, r.om, r.on);
      const O = em.length ? uniq([...em, ...(o.how === 'ma+name' ? o.hs : [])]) : o.hs;
      return { T, O };
    }
    const N = byName(r.tn);
    const tMa = byMaOnly(r.tm);
    const obs = em.length ? em : byMaOnly(r.om);
    const obsIsN = obs.some(h => N.includes(h));
    let T;
    if (tMa.length && (N.includes(tMa[0]) || inTo(tMa[0], cap, r.tg))) T = { hs: tMa, how: N.includes(tMa[0]) ? 'ma+name' : 'ma' };
    else if (!tMa.length && obs.length && !obsIsN) T = resolve(cap, '', r.tn);
    else T = { hs: [], how: 'shared-name' };
    let O = obs;
    if (!O.length && T.hs.length && !T.hs.some(h => N.includes(h))) O = resolve(cap, '', r.on).hs;
    return { T, O };
  }
  return { byEmail, byMa, byName, resolve, matchOne };
}

/**
 * Ghép từng phiếu với nhân thân người dạy / người dự, rồi chuyển cho các tài khoản được phép của nhân thân đó.
 * @param {Human[]} humans
 * @param {Record<string,{records:object[]}>} levels
 * @returns {{ byPerson: Map<string, {rec:object, rel:'t'|'o'|'to'}[]>, recKeys: Map<object,{tp:string, op:string}>, stats: object }}
 */
export function matchRecords(humans, levels) {
  const { matchOne } = makeMatcher(humans);
  const byPerson = new Map();
  for (const h of humans) for (const p of h.persons) byPerson.set(p.key, []);
  const recKeys = new Map();
  const stats = {};
  for (const cap of CAPS) {
    const recs = levels[cap]?.records || [];
    const st = stats[cap] = { records: recs.length, taught: 0, observed: 0, both: 0, taughtHow: {}, unmatchedTeachers: {}, unmatchedObservers: {}, heldBack: 0 };
    for (const r of recs) {
      const { T, O } = matchOne(cap, r);
      st.taughtHow[T.how] = (st.taughtHow[T.how] || 0) + 1;
      recKeys.set(r, { tp: T.hs.length === 1 ? T.hs[0].hid : '', op: O.length ? O[0].hid : '' });
      const rel = new Map();
      for (const h of T.hs) for (const p of h.persons) rel.set(p.key, 't');
      for (const h of O) for (const p of h.persons) rel.set(p.key, rel.get(p.key) === 't' ? 'to' : 'o');
      if (T.hs.length) st.taught++; else st.unmatchedTeachers[r.tn] = (st.unmatchedTeachers[r.tn] || 0) + 1;
      if (O.length) st.observed++; else st.unmatchedObservers[r.on] = (st.unmatchedObservers[r.on] || 0) + 1;
      if (T.hs.length && O.length) st.both++;
      if ([...T.hs, ...O].some(h => !h.persons.length)) st.heldBack++; // ghép được người nhưng người đó không có tài khoản được phép
      for (const [key, rl] of rel) byPerson.get(key)?.push({ rec: r, rel: rl });
    }
  }
  return { byPerson, recKeys, stats };
}

/* ---------------- Tổ “thực tế” của một người trong một cấp ---------------- */
// DS Nhân sự có thể lạc hậu (vd. GV Văn THCS còn ghi “Tổ Xã hội” trong khi biểu mẫu ghi “Tổ Ngữ văn”). Quy tắc:
//  • nếu biểu mẫu từng ghi người đó (khi DẠY; nếu chưa được dự thì khi ĐI DỰ) thuộc một tổ có trong DS → giữ tổ của DS;
//  • nếu biểu mẫu CHƯA BAO GIỜ ghi tổ của DS → dùng tổ biểu mẫu ghi nhiều nhất;
//  • chưa có phiếu → tổ trong DS.
export function effectiveTo(matches, cap, staffTos = []) {
  const valid = g => g && g !== TO_BGH && g !== TO_OTHER;
  const tally = list => {
    const m = new Map();
    for (const g of list) if (valid(g)) m.set(g, (m.get(g) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
  };
  const own = (Array.isArray(staffTos) ? staffTos : [staffTos]).filter(valid);
  const inCap = (matches || []).filter(x => x.rec.cap === cap);
  const taught = tally(inCap.filter(x => x.rel !== 'o').map(x => x.rec.tg));
  const seen = taught.length ? taught : tally(inCap.filter(x => x.rel !== 't').map(x => x.rec.og));
  const inStaff = seen.find(([g]) => own.includes(g));
  return (inStaff || seen[0] || [own[0] || ''])[0];
}

/* ---------------- Số liệu đối sánh ẩn danh ---------------- */
const r3 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// Khóa giáo viên của phiếu: nhân thân đã ghép (tp) nếu có, ngược lại họ tên bỏ dấu.
const teacherKeyOf = r => (r.tp ? '#' + r.tp : fold(r.tn));

/**
 * Điểm TB gộp (CHÍNH XÁC) của một nhóm phiếu (cùng một cấp → cùng crit). Dùng nội bộ; số công bố đi qua coarseBench().
 * @returns {{n, teachers, avg, dom:{1..5}, crit:number[], dist:{tot,dat,chua,nguy}} | {n, teachers, suppressed:true}}  (dist: khóa theo LEVELS)
 */
export function benchmark(records, crit, minTeachers = BENCH_RULES.minTeachers, keyOf = teacherKeyOf) {
  const recs = records.filter(r => (r.sc || []).some(v => v != null));
  const teachers = new Set(recs.map(keyOf)).size;
  if (teachers < minTeachers) return { n: recs.length, teachers, suppressed: true };
  const recAvg = r => mean(r.sc.filter(v => v != null));
  const dom = {};
  for (let d = 1; d <= 5; d++) {
    const cols = crit.map((k, j) => (k.d === d ? j : -1)).filter(j => j >= 0);
    dom[d] = r3(mean(recs.map(r => mean(cols.map(j => r.sc[j]).filter(v => v != null))).filter(v => v != null)));
  }
  const dist = Object.fromEntries(LEVELS.map(l => [l.key, 0]));
  const avgs = recs.map(recAvg);
  for (const a of avgs) dist[levelOf(a)]++;
  return {
    n: recs.length, teachers,
    avg: r3(mean(avgs)),
    dom,
    crit: crit.map((k, j) => r3(mean(recs.map(r => r.sc[j]).filter(v => v != null)))),
    dist,
  };
}

/**
 * Số liệu đối sánh ĐỂ CÔNG BỐ: điểm làm tròn 0,1; tỷ lệ xếp loại (%) làm tròn 5 %; không có số đếm từng loại.
 * Nhóm có < minTeachers GV hoặc < minRecords phiếu → { n, teachers, suppressed: true }.
 */
export function coarseBench(b, rules = BENCH_RULES) {
  if (!b || b.suppressed || b.n < rules.minRecords) return { n: b?.n || 0, teachers: b?.teachers || 0, suppressed: true };
  const f = 10 ** rules.decimals;
  const rd = x => (x == null ? null : Math.round(x * f) / f);
  const pc = k => Math.round((100 * b.dist[k]) / b.n / rules.pctStep) * rules.pctStep;
  const dom = {};
  for (const [d, v] of Object.entries(b.dom)) dom[d] = rd(v);
  return { n: b.n, teachers: b.teachers, avg: rd(b.avg), dom, crit: b.crit.map(rd), pct: Object.fromEntries(LEVELS.map(l => [l.key, pc(l.key)])) };
}

/**
 * Mốc chốt số liệu đối sánh: 00:00 thứ Hai của tuần hiện tại (giờ Việt Nam) – chỉ phiếu GỬI trước mốc này được tính; năm học
 * (từ ngày 01/08) chứa ngày trước mốc → chỉ phiếu có ngày dạy trong năm học đó.
 * @returns {{ at: string, sy: number, syStart: string }}  at: 'YYYY-MM-DD 00:00:00' (giờ treo tường)
 */
export function benchCutoff(nowMs) {
  const d = new Date(nowMs + 7 * 3600e3); // giờ Việt Nam đọc bằng các hàm UTC
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  const last = new Date(monday.getTime() - 864e5); // ngày cuối cùng đã chốt (Chủ nhật)
  const sy = last.getUTCMonth() + 1 >= SCHOOL_YEAR_START_MONTH ? last.getUTCFullYear() : last.getUTCFullYear() - 1;
  const p2 = n => String(n).padStart(2, '0');
  return { at: `${monday.getUTCFullYear()}-${p2(monday.getUTCMonth() + 1)}-${p2(monday.getUTCDate())} 00:00:00`, sy, syStart: `${sy}-${p2(SCHOOL_YEAR_START_MONTH)}-01` };
}
// Mốc “mọi phiếu” (khi không có đồng hồ – vd. kiểm thử trực tiếp buildScopes).
export const ALL_TIME = Object.freeze({ at: '9999-12-31 00:00:00', sy: 0, syStart: '' });
export const benchGroupId = (cap, to = '') => (to ? `T|${cap}|${to}` : `L|${cap}`);

/**
 * Công bố số liệu đối sánh cho các nhóm (cấp, tổ) – có “giữ” để không lộ điểm của từng tiết:
 *  • chỉ tính phiếu của năm học hiện tại, gửi trước mốc chốt (tuần đã kết thúc);
 *  • nhóm đã công bố → GIỮ NGUYÊN số cũ cho đến khi có thêm ≥ minNewRecords phiếu đã chốt của ≥ minNewTeachers GV
 *    (chênh lệch giữa hai lần công bố luôn gộp nhiều tiết của nhiều người); sửa/xóa phiếu cũ chỉ thể hiện ở lần công bố sau;
 *  • nhóm chưa đủ điều kiện (bị ẩn) → tính lại mỗi tuần; năm học mới / bộ tiêu chí đổi → tính lại từ đầu.
 * @param {object} p
 * @param {{id:string, records:object[], crit:object[]}[]} p.groups
 * @param {Record<string, {at:string, sy:number, nc:number, lv:string, b:object}>} [p.prev]  trạng thái lần trước (v2_config/state.bench);
 *   lv = LEVELS_SIG lúc chốt – khác thang hiện tại → tính lại
 * @param {{at:string, sy:number, syStart:string}} p.cutoff
 * @returns {{ bench: Record<string, object>, state: Record<string, object> }}  bench[id] = coarseBench(…) + { asOf, sy }
 */
export function publishBenchmarks({ groups, prev = {}, cutoff = ALL_TIME, rules = BENCH_RULES }) {
  const bench = {}, state = {};
  for (const g of groups) {
    const closed = g.records.filter(r => r.ts < cutoff.at && (!cutoff.syStart || r.day >= cutoff.syStart));
    const p = prev[g.id];
    // lv: thang xếp loại lúc chốt – thang đổi thì tỷ lệ xếp loại cũ không còn đúng → tính lại.
    const usable = p && p.b && !p.b.suppressed && p.sy === cutoff.sy && p.nc === g.crit.length && p.lv === LEVELS_SIG && p.at <= cutoff.at;
    let rec = null;
    if (usable && p.at === cutoff.at) rec = p;
    else if (usable) {
      const fresh = closed.filter(r => r.ts >= p.at && (r.sc || []).some(v => v != null));
      const enough = fresh.length >= rules.minNewRecords && new Set(fresh.map(teacherKeyOf)).size >= rules.minNewTeachers;
      rec = enough ? null : p;
    }
    if (!rec) rec = { at: cutoff.at, sy: cutoff.sy, nc: g.crit.length, lv: LEVELS_SIG, b: coarseBench(benchmark(closed, g.crit, rules.minTeachers), rules) };
    state[g.id] = rec;
    bench[g.id] = { ...rec.b, asOf: rec.at === ALL_TIME.at ? '' : rec.at.slice(0, 10), sy: rec.sy || null };
  }
  return { bench, state };
}

/* ---------------- Danh sách nhân sự cho “độ phủ” ---------------- */
const staffKey = r => `${r.ma || ''}|${fold(r.name)}`;
// Dòng nhân sự thuộc cấp: ô Cấp trống, đúng cấp, hoặc “Liên cấp” (dòng ghi cấp khác – vd. THPT trong Sheet THCS – không tính).
export const rowInCap = (r, cap) => !r.caps?.length || r.caps.includes(cap) || r.lienCap;

/**
 * @param {object[]} rows  parseStaffTable().rows của Sheet cấp `cap`
 * @param {string} cap
 * @param {(row)=>string} [groupOf]  tổ hiển thị (mặc định row.to)
 * @param {(row)=>string} [keyOf]    khóa nhân thân (k) – trùng với tp/op của phiếu
 * @returns {{ staff: {name, group, role, k?}[], bgh: {name, role, k?}[] }}
 */
export function levelStaff(rows, cap, groupOf = r => r.to, keyOf = () => '') {
  const pick = new Map();
  for (const r of rows || []) {
    if (!r.active || !rowInCap(r, cap)) continue;
    const k = staffKey(r);
    const cur = pick.get(k);
    if (!cur || r.email || !cur.email) pick.set(k, r); // ưu tiên dòng có email, rồi dòng sau
  }
  const staff = [], bgh = [], seenBgh = new Set();
  for (const r of pick.values()) {
    const k = keyOf(r) || '';
    if (r.to === TO_BGH || r.bghAll) {
      if (!seenBgh.has(fold(r.name))) { seenBgh.add(fold(r.name)); bgh.push({ name: r.name, role: r.role, ...(k ? { k } : {}) }); }
    } else {
      staff.push({ name: r.name, group: groupOf(r) || r.to, role: r.role, ...(k ? { k } : {}) });
    }
  }
  return { staff, bgh };
}

/* ---------------- Dựng phạm vi ---------------- */
// Phạm vi cá nhân: chỉ giữ email/mã của CHÍNH người đó; bỏ khóa nhân thân (tp/op).
export function personRecord(rec, rel, person) {
  const { tp, op, ...r } = rec; // eslint-disable-line no-unused-vars
  return {
    ...r,
    oe: rec.oe && rec.oe === person.email ? rec.oe : '',
    om: rec.om && person.mas.has(rec.om) ? rec.om : '',
    tm: rec.tm && person.mas.has(rec.tm) ? rec.tm : '',
    rel,
  };
}
const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Các nhóm cần số liệu đối sánh: mỗi cấp đang bật + mỗi tổ (GV dạy) của cấp đó.
 * @returns {{id, cap, to, records, crit}[]}
 */
export function benchGroups(levels, keyed = r => r) {
  const out = [];
  for (const cap of CAPS) {
    const L = levels[cap];
    if (!L?.enabled) continue;
    const recs = (L.records || []).map(keyed);
    out.push({ id: benchGroupId(cap), cap, to: '', records: recs, crit: L.crit || [] });
    for (const to of uniq(recs.map(r => r.tg)).filter(t => t && t !== TO_OTHER).sort()) {
      out.push({ id: benchGroupId(cap, to), cap, to, records: recs.filter(r => r.tg === to), crit: L.crit || [] });
    }
  }
  return out;
}

/**
 * Dựng toàn bộ phạm vi. Trả về [{ id, doc, chunks }] – doc chưa có syncedAtMs (máy chủ gán khi ghi), có hash nội dung.
 * @param {object} p
 * @param {Record<string, {cap, enabled, records, crit, staffRows, sheetUrl?}>} p.levels
 * @param {object[]} p.people   resolveAccess().people (có matches, tos)
 * @param {{cap:string, to:string}[]} p.tos  các tổ cần phạm vi T_ (tổ trưởng ở cấp đang bật)
 * @param {Map<object,{tp,op}>} [p.recKeys]  khóa nhân thân của từng phiếu (resolveAccess().recKeys)
 * @param {(row)=>string} [p.rowKey]          khóa nhân thân của một dòng DS Nhân sự (resolveAccess().rowKey)
 * @param {Record<string, object>} [p.bench]  số liệu đối sánh đã công bố (publishBenchmarks().bench); thiếu → tính trên mọi phiếu
 */
export function buildScopes({ levels, people = [], tos = [], recKeys = null, rowKey = () => '', bench = null }) {
  const out = [];
  const enabled = CAPS.filter(c => levels[c]?.enabled);
  const keyed = r => { const k = recKeys?.get(r); return k ? { ...r, tp: k.tp, op: k.op } : r; };
  const B = bench || publishBenchmarks({ groups: benchGroups(levels, keyed) }).bench;
  const benchOf = (cap, to = '') => B[benchGroupId(cap, to)] || { n: 0, teachers: 0, suppressed: true };
  const groupByRow = new Map(); // cap → Map(staffKey → tổ thực tế)
  for (const cap of enabled) groupByRow.set(cap, new Map());
  for (const p of people) {
    for (const cap of enabled) {
      for (const row of p.rowsByCap?.[cap] || []) groupByRow.get(cap).set(staffKey(row), p.tos?.[cap]?.[0] || row.to);
    }
  }
  const staffOf = {}, keyedRecs = {};
  for (const cap of enabled) {
    const L = levels[cap];
    const map = groupByRow.get(cap);
    const { staff, bgh } = levelStaff(L.staffRows, cap, r => map.get(staffKey(r)) || r.to, rowKey);
    staffOf[cap] = staff;
    keyedRecs[cap] = L.records.map(keyed);
    out.push(finalize(scopeIdLevel(cap), {
      kind: 'level', cap, label: CAP_INFO[cap].label, color: CAP_INFO[cap].color,
      crit: L.crit, staff, bgh, sheetUrl: L.sheetUrl || '',
    }, keyedRecs[cap]));
  }
  const seenT = new Set();
  for (const { cap, to } of tos) {
    const id = scopeIdTo(cap, to);
    if (!levels[cap]?.enabled || seenT.has(id)) continue;
    seenT.add(id);
    const L = levels[cap];
    const recs = keyedRecs[cap].filter(r => r.tg === to);
    out.push(finalize(id, {
      kind: 'to', cap, to, label: toLabel(cap, to), color: CAP_INFO[cap].color,
      crit: L.crit,
      staff: staffOf[cap].filter(s => s.group === to),
      benchmarks: { levels: { [cap]: benchOf(cap) }, tos: { [cap]: { [to]: benchOf(cap, to) } } },
    }, recs));
  }
  for (const p of people) {
    const recs = (p.matches || []).map(({ rec, rel }) => personRecord(rec, rel, p)).sort(byTs);
    const caps = enabled.filter(c => p.caps.has(c) || recs.some(r => r.cap === c));
    const crit = {}, levelsB = {}, tosB = {}, tosOf = {};
    for (const cap of caps) {
      crit[cap] = levels[cap].crit;
      levelsB[cap] = benchOf(cap);
      const myTos = (p.tos?.[cap] || []).filter(t => t && t !== TO_BGH && t !== TO_OTHER);
      tosOf[cap] = myTos;
      tosB[cap] = Object.fromEntries(myTos.map(t => [t, benchOf(cap, t)]));
    }
    out.push(finalize(scopeIdPerson(p.key), {
      kind: 'person', label: p.name || p.email, caps, tos: tosOf, crit,
      benchmarks: { levels: levelsB, tos: tosB },
    }, recs));
  }
  return out;
}

function finalize(id, fields, records) {
  const chunks = chunkRecords(records, CHUNK_OPTS);
  const doc = { ...fields, count: records.length, chunkIds: chunks.map(c => c.id) };
  doc.hash = hash53(JSON.stringify({ doc, chunks: chunks.map(c => c.hash) }));
  return { id, doc, chunks };
}
