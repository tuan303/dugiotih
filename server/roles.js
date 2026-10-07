// Phân quyền v2 – THUẦN (không I/O) để kiểm thử offline.
//
// Nguồn quyền:
//  1) TỰ ĐỘNG từ “DS Nhân sự” của từng cấp (chỉ dòng đang làm việc – Ghi chú/Thâm niên không có “nghỉ”):
//     • Tổ/Bộ phận ~ “Ban lãnh đạo” hoặc Chức danh ~ “Tổng hiệu trưởng”                 → BGH liên cấp (xem cả 3 cấp)
//     • Tổ/Bộ phận ~ “Ban giám hiệu” hoặc Chức danh ~ “hiệu trưởng / BGH / TV BGH”      → BGH cấp của Sheet đó
//     • Chức danh ~ “Tổ trưởng” (không tính tổ phó, nhóm trưởng, tổ trưởng khối, tổ trưởng công đoàn, “nguyên …”)
//                                                                                       → Tổ trưởng của tổ đó (trong cấp đó)
//     • Mọi dòng có email                                                               → giáo viên (xem dữ liệu của chính mình)
//     Vai trò lãnh đạo chỉ được cấp khi cột Cấp của dòng trống, “Liên cấp” hoặc có cấp của Sheet (dòng ghi “THPT” trong Sheet
//     THCS không tự nhận quyền THCS/THPT – dùng tab Phân quyền nếu cần).
//     Một email chỉ thuộc về MỘT người: email ghi cho 2 người khác nhau (khác cả mã lẫn họ tên) → giữ cho người có họ tên khớp
//     mẫu email (vd. nguyettt ↔ Trịnh Thị Nguyệt), dòng còn lại không được gắn email đó + cảnh báo.
//  2) GHI ĐÈ từ tab “Phân quyền” (ROLES_SHEET_ID, tab ROLES_TAB): Email | Vai trò | Cấp | Tổ | Ghi chú
//     Vai trò: “BGH liên cấp”, “BGH cấp”, “Tổ trưởng”, “Giáo viên”, “Không truy cập”. Cấp: “Tiểu học” | “THCS” | “THPT”
//     (nhiều cấp cách nhau dấu phẩy; “Liên cấp” = cả ba). Tổ: tên tổ như trên dashboard (nhiều tổ cách nhau dấu phẩy).
//     Các dòng được CỘNG DỒN với quyền tự động; “Không truy cập” THU HỒI mọi quyền của email đó (kể cả ADMIN_EMAILS).
//     Vai trò ghi sai / không nhận ra → THU HỒI quyền của email đó (an toàn) + cảnh báo nêu số dòng.
//  3) ADMIN_EMAILS (biến môi trường, danh sách email) = BGH liên cấp bổ sung (vd. cán bộ CNTT).
// Một người có thể giữ nhiều vai trò (BGH cấp + Tổ trưởng + giáo viên) → hợp các phạm vi.
//
// Ghép phiếu: dùng MỌI dòng DS Nhân sự (kể cả dòng đã nghỉ, không email, bị thu hồi quyền) gom thành “nhân thân” (scopes.js)
// để phiếu của người không còn quyền KHÔNG bị đưa cho đồng nghiệp trùng họ tên.
import { CAPS, CAP_INFO, TO_BGH, TO_OTHER, fold, nameKey, clean, cellStr, hash53, normTo, parseCaps, emailsIn } from '../lib/shared.js';
import { matchRecords, effectiveTo, scopeIdLevel, scopeIdTo, scopeIdPerson, toLabel } from './scopes.js';
import { envAdmins } from './auth.js';

export const DEFAULT_ROLES_TAB = 'Phân quyền';
export const ROLE_NAMES = Object.freeze({
  bghAll: 'BGH liên cấp', bghCap: 'BGH cấp', toTruong: 'Tổ trưởng', giaoVien: 'Giáo viên', none: 'Không truy cập',
});

// 'BGH liên cấp' → 'bghAll' … ; không nhận ra → ''
export function parseRoleName(s) {
  const f = fold(s);
  if (!f) return '';
  if (/^(khong|ngung|cam|chan|khoa|thu hoi|tam dung|tam ngung|huy|bo quyen)\b|khong (duoc )?(truy cap|xem)/.test(f)) return 'none';
  if (/bgh|giam hieu|lanh dao|hieu truong|hieu pho/.test(f)) return /lien cap|toan truong|tat ca/.test(f) ? 'bghAll' : 'bghCap';
  if (/to truong/.test(f)) return 'toTruong';
  if (/giao vien|ca nhan|^gv\b/.test(f)) return 'giaoVien';
  return '';
}

export const adminEmails = envAdmins;

/**
 * Tab “Phân quyền”. gviz trả về TAB ĐẦU TIÊN khi tên tab không tồn tại → bảng phải có cột Email và Vai trò.
 * @returns {{ rows: {line, emails, roleRaw, role, capRaw, caps, lienCap, tos, note}[], recognized: boolean }}
 */
export function parseRolesTable(t) {
  const F = (t?.cols || []).map(c => fold(c.label));
  const find = re => F.findIndex(l => re.test(l));
  const iE = find(/email/), iR = find(/vai tro|quyen/), iC = find(/^cap\b/), iT = find(/^to\b/), iN = find(/ghi chu/);
  if (iE < 0 || iR < 0 || F.some(l => /^dau thoi gian/.test(l))) return { rows: [], recognized: false };
  const rows = [];
  (t.rows || []).forEach((r, k) => {
    const c = r.c || [];
    const emailRaw = cellStr(c[iE]), roleRaw = cellStr(c[iR]);
    if (!emailRaw && !roleRaw) return;
    const capRaw = iC >= 0 ? cellStr(c[iC]) : '';
    rows.push({
      line: k + 2, // dòng 1 là tiêu đề
      emails: emailsIn(emailRaw), emailRaw, roleRaw, role: parseRoleName(roleRaw), capRaw, ...parseCaps(capRaw),
      tos: (iT >= 0 ? cellStr(c[iT]) : '').split(/[,;\n]/).map(clean).filter(Boolean),
      note: iN >= 0 ? cellStr(c[iN]) : '',
    });
  });
  return { rows, recognized: true };
}

/* ---------------- Email ↔ người ---------------- */
const rowEmails = row => row.emails || (row.email ? [row.email] : []);
// Mẫu email của trường: <tên gọi><chữ cái đầu họ + đệm>[số] – vd. nguyettt ↔ Trịnh Thị Nguyệt, tranglt2 ↔ Lương Thu Trang.
export function emailFitsName(email, name) {
  const w = fold(name).replace(/[^a-z ]/g, '').split(' ').filter(Boolean);
  if (!w.length) return false;
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const stem = w[w.length - 1] + w.slice(0, -1).map(x => x[0]).join('');
  return local === stem || (local.startsWith(stem) && local.length <= stem.length + 2);
}
const sameIdentity = (a, b) => (!!a.ma && a.ma === b.ma) || fold(a.name) === fold(b.name);
const describeRow = x => `${x.row.name}${x.row.ma ? ` – mã ${x.row.ma}` : ''}, DS ${CAP_INFO[x.cap]?.label || x.cap}`;

/**
 * Email nào thuộc dòng nào. Các dòng cùng email được gom theo danh tính (cùng mã HOẶC cùng họ tên); nếu một email ứng với ≥ 2
 * danh tính khác nhau → chỉ một danh tính giữ email (khớp mẫu email; không xác định được thì danh tính xuất hiện trước).
 * @returns {{ owned: Map<object, string[]>, warnings: string[] }}  owned: dòng → các email của dòng đó
 */
function assignEmails(rows) {
  const byEmail = new Map();
  for (const x of rows) for (const e of rowEmails(x.row)) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(x); }
  const owned = new Map(rows.map(x => [x.row, []]));
  const warnings = [];
  for (const [email, xs] of byEmail) {
    const groups = [];
    for (const x of xs) {
      const hit = groups.filter(g => g.some(y => sameIdentity(x.row, y.row)));
      if (!hit.length) groups.push([x]);
      else { hit[0].push(x); for (const g of hit.slice(1)) { hit[0].push(...g); groups.splice(groups.indexOf(g), 1); } }
    }
    let keep = groups[0];
    if (groups.length > 1) {
      const fits = groups.filter(g => g.some(y => emailFitsName(email, y.row.name)));
      if (fits.length === 1) keep = fits[0];
      warnings.push(`Email ${email} được ghi cho ${groups.length} người khác nhau trong DS Nhân sự (${groups.map(g => describeRow(g[0])).join(' / ')}): chỉ ${keep[0].row.name} dùng email này; người còn lại chưa có tài khoản xem dashboard và phiếu của họ không được hiển thị cho ai – kiểm tra lại DS Nhân sự.`);
    }
    for (const x of keep) owned.get(x.row).push(email);
  }
  return { owned, warnings };
}

/* ---------------- Người (theo email) và nhân thân (cụm dòng nhân sự) ---------------- */
function newPerson(email) {
  return { key: hash53(email), email, name: '', mas: new Set(), names: new Set(), caps: new Set(), anyLevel: false, rowsByCap: {}, staffTos: {}, fromStaff: false, fromOverride: false, eligible: true };
}

/**
 * Gom mọi dòng DS Nhân sự (mọi cấp, kể cả dòng nghỉ / không email) + tài khoản “Giáo viên” ghi đè thành nhân thân.
 * Hai dòng thuộc cùng nhân thân khi cùng email (đã phân định ở assignEmails) hoặc cùng (mã + họ tên).
 */
function buildHumans(rows, owned, persons) {
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const add = k => { if (!parent.has(k)) parent.set(k, k); return k; };
  const union = (a, b) => { const ra = find(add(a)), rb = find(add(b)); if (ra !== rb) parent.set(rb, ra); };
  rows.forEach((x, i) => {
    const me = add(`r:${i}`);
    for (const e of owned.get(x.row) || []) union(me, `e:${e}`);
    if (x.row.ma) union(me, `m:${x.row.ma}|${fold(x.row.name)}`);
  });
  for (const p of persons) add(`e:${p.email}`);
  const groups = new Map();
  const groupOf = k => { const r = find(k); if (!groups.has(r)) groups.set(r, { rows: [], emails: new Set() }); return groups.get(r); };
  rows.forEach((x, i) => { const g = groupOf(`r:${i}`); g.rows.push(x); for (const e of owned.get(x.row) || []) g.emails.add(e); });
  for (const p of persons) groupOf(`e:${p.email}`).emails.add(p.email);
  const byEmail = new Map(persons.map(p => [p.email, p]));
  const humans = [];
  for (const g of groups.values()) {
    const h = { hid: '', emails: g.emails, mas: new Set(), names: [], folds: new Set(), caps: new Set(), anyLevel: false, rows: g.rows, persons: [] };
    const seen = new Set();
    for (const { row, cap } of g.rows) {
      if (row.ma) h.mas.add(row.ma);
      const f = fold(row.name), k = nameKey(row.name);
      if (f && !seen.has(k)) { seen.add(k); h.names.push({ f, k }); h.folds.add(f); }
      h.caps.add(cap);
      for (const c of row.caps || []) h.caps.add(c);
      if (row.lienCap) h.anyLevel = true;
    }
    for (const e of [...g.emails].sort()) {
      const p = byEmail.get(e);
      if (!p) continue;
      for (const c of p.caps) h.caps.add(c);
      if (p.anyLevel) h.anyLevel = true;
      if (p.eligible) h.persons.push(p);
    }
    const sig = [...g.rows.map(x => `${x.row.ma || ''}|${fold(x.row.name)}`), ...[...g.emails].map(e => `@${e}`)].sort();
    h.hid = hash53('h|' + sig.join(','));
    humans.push(h);
  }
  return humans;
}

/**
 * @param {object} p
 * @param {Record<string, {enabled?:boolean, staffRows?:object[], records?:object[]}>} p.levels  theo cấp
 * @param {object[]} [p.rolesRows]  parseRolesTable().rows
 * @param {object} [p.env]          ADMIN_EMAILS
 * @returns {{ access: Record<string, {email, name, roles, scopes}>, people: object[], tos: {cap,to}[], warnings: string[],
 *   stats: object, humans: object[], recKeys: Map<object,{tp,op}>, rowKey: (row)=>string }}
 */
export function resolveAccess({ levels = {}, rolesRows = [], env = {} } = {}) {
  const warnings = [];
  const enabled = CAPS.filter(c => levels[c]?.enabled);
  const rows = [];
  for (const cap of CAPS) for (const row of levels[cap]?.staffRows || []) if (row && clean(row.name)) rows.push({ row, cap });
  const { owned, warnings: emailWarnings } = assignEmails(rows);
  warnings.push(...emailWarnings);

  const people = new Map();      // email → người (có dòng nhân sự đang làm việc hoặc dòng “Giáo viên”)
  const grants = new Map();      // email → { bghAll, bghCaps:Set, toTruong: Map('cap|to' → {cap,to}) }
  const grant = email => {
    let g = grants.get(email);
    if (!g) grants.set(email, g = { bghAll: false, bghCaps: new Set(), toTruong: new Map() });
    return g;
  };
  const addTo = (email, cap, to) => {
    if (!to || to === TO_BGH || to === TO_OTHER) return;
    grant(email).toTruong.set(`${cap}|${to}`, { cap, to });
  };

  // 1) Tự động từ DS Nhân sự (dòng đang làm việc, email thuộc về dòng đó)
  for (const { row, cap } of rows) {
    if (!row.active) continue;
    const emails = owned.get(row) || [];
    const lead = row.bghAll || row.bghCap || row.toTruong;
    const ownCap = row.lienCap || !row.caps?.length || row.caps.includes(cap);
    if (lead && emails.length && !ownCap) {
      warnings.push(`DS Nhân sự ${CAP_INFO[cap].label}: ${row.name} ghi Cấp “${row.capCell || row.caps.join(', ')}” – không tự cấp vai trò lãnh đạo (“${row.role || row.toRaw}”) từ Sheet của cấp ${CAP_INFO[cap].label}; nếu cần, thêm dòng trong tab Phân quyền.`);
    }
    for (const email of emails) {
      let p = people.get(email);
      if (!p) people.set(email, p = newPerson(email));
      p.fromStaff = true;
      if (!p.name) p.name = row.name;
      if (row.ma) p.mas.add(row.ma);
      p.names.add(fold(row.name));
      p.caps.add(cap);
      for (const c of row.caps || []) p.caps.add(c);
      if (row.lienCap) p.anyLevel = true;
      (p.rowsByCap[cap] ||= []).push(row);
      if (row.to && row.to !== TO_BGH && row.to !== TO_OTHER) (p.staffTos[cap] ||= new Set()).add(row.to);
      if (!ownCap) continue;
      if (row.bghAll) grant(email).bghAll = true;
      if (row.bghCap) grant(email).bghCaps.add(cap);
      if (row.toTruong) addTo(email, cap, row.toTruong);
    }
  }

  // 2) Ghi đè từ tab “Phân quyền”
  const revoked = new Set();
  for (const r of rolesRows) {
    const where = `Phân quyền – dòng ${r.line}`;
    if (!r.emails.length) { warnings.push(`${where}: email “${r.emailRaw || ''}” không hợp lệ – bỏ qua.`); continue; }
    if (!r.role) {
      // Không nhận ra vai trò (có thể là ý định thu hồi gõ khác chữ) → thu hồi cho an toàn.
      r.emails.forEach(e => revoked.add(e));
      warnings.push(`${where}: vai trò “${r.roleRaw}” không hợp lệ (dùng: ${Object.values(ROLE_NAMES).join(', ')}) – đã TẠM THU HỒI mọi quyền của ${r.emails.join(', ')} cho tới khi sửa dòng này.`);
      continue;
    }
    const caps = r.lienCap ? [...CAPS] : r.caps;
    for (const email of r.emails) {
      if (r.role === 'none') { revoked.add(email); continue; }
      if (r.role === 'bghAll') { grant(email).bghAll = true; continue; }
      if (r.role === 'bghCap') {
        if (!caps.length) { warnings.push(`${where}: vai trò “BGH cấp” cần cột Cấp (Tiểu học / THCS / THPT) – bỏ qua.`); continue; }
        caps.forEach(c => grant(email).bghCaps.add(c));
        continue;
      }
      if (r.role === 'toTruong') {
        if (!caps.length || !r.tos.length) { warnings.push(`${where}: vai trò “Tổ trưởng” cần cột Cấp và cột Tổ – bỏ qua.`); continue; }
        for (const cap of caps) for (const t of r.tos) addTo(email, cap, normTo(cap, t));
        continue;
      }
      if (r.role === 'giaoVien') {
        let p = people.get(email);
        if (!p) people.set(email, p = newPerson(email));
        p.fromOverride = true;
        caps.forEach(c => p.caps.add(c));
        if (r.lienCap) p.anyLevel = true;
      }
    }
  }

  // 3) ADMIN_EMAILS
  const admins = adminEmails(env);
  for (const e of admins) grant(e).bghAll = true;

  // 4) Thu hồi: bỏ quyền; người đó vẫn tham gia ghép phiếu (không được phép) để phiếu của họ không rơi sang người trùng tên.
  for (const e of revoked) {
    if (admins.includes(e)) warnings.push(`${e} có trong ADMIN_EMAILS nhưng bị “Không truy cập” (hoặc ghi vai trò không hợp lệ) trong tab Phân quyền → đã thu hồi quyền.`);
    const p = people.get(e);
    if (p) p.eligible = false;
    grants.delete(e);
  }

  // 5) Nhân thân → ghép phiếu; tổ thực tế theo phiếu
  const allPersons = [...people.values()].sort((a, b) => (a.email < b.email ? -1 : 1));
  const humans = buildHumans(rows, owned, allPersons);
  const hidOfRow = new Map();
  for (const h of humans) {
    for (const { row } of h.rows) hidOfRow.set(row, h.hid);
    for (const p of h.persons) { // thông tin nhận diện của cả nhân thân (mọi dòng, mọi cấp) – dùng cho phạm vi cá nhân
      for (const ma of h.mas) p.mas.add(ma);
      for (const f of h.folds) p.names.add(f);
    }
  }
  const { byPerson, recKeys, stats: matchStats } = matchRecords(humans, levels);
  const plist = allPersons.filter(p => p.eligible);
  for (const p of plist) {
    p.matches = byPerson.get(p.key) || [];
    for (const m of p.matches) p.caps.add(m.rec.cap);
    p.tos = {};
    for (const cap of CAPS) {
      if (!p.caps.has(cap)) continue;
      const t = effectiveTo(p.matches, cap, [...(p.staffTos[cap] || [])]);
      if (t) p.tos[cap] = [t];
    }
  }

  // 6) Tài liệu quyền
  const access = {};
  const tosNeeded = new Map();
  const live = new Map(plist.map(p => [p.email, p]));
  const emails = [...new Set([...live.keys(), ...grants.keys()])].sort();
  for (const email of emails) {
    const p = live.get(email) || null;
    const g = grants.get(email) || { bghAll: false, bghCaps: new Set(), toTruong: new Map() };
    const bghCaps = CAPS.filter(c => g.bghCaps.has(c));
    const toTruong = [...g.toTruong.values()]
      .sort((a, b) => CAPS.indexOf(a.cap) - CAPS.indexOf(b.cap) || a.to.localeCompare(b.to, 'vi'))
      .map(({ cap, to }) => ({ cap, to, label: toLabel(cap, to) }));
    const scopes = new Set();
    for (const cap of enabled) if (g.bghAll || g.bghCaps.has(cap)) scopes.add(scopeIdLevel(cap));
    for (const { cap, to } of toTruong) {
      if (!enabled.includes(cap) || scopes.has(scopeIdLevel(cap))) continue; // L_<cap> đã bao gồm tổ
      scopes.add(scopeIdTo(cap, to));
      tosNeeded.set(scopeIdTo(cap, to), { cap, to });
    }
    if (p) scopes.add(scopeIdPerson(p.key));
    access[email] = {
      email,
      name: p?.name || '',
      roles: {
        bghAll: !!g.bghAll,
        bghCaps,
        toTruong,
        person: p ? { key: p.key, caps: CAPS.filter(c => p.caps.has(c)) } : null,
      },
      scopes: [...scopes].sort(),
    };
  }

  const stats = {
    emails: emails.length,
    bghAll: emails.filter(e => access[e].roles.bghAll).length,
    bghCaps: Object.fromEntries(CAPS.map(c => [c, emails.filter(e => access[e].roles.bghCaps.includes(c)).length])),
    toTruong: Object.fromEntries(CAPS.map(c => [c, emails.flatMap(e => access[e].roles.toTruong.filter(t => t.cap === c).map(t => ({ email: e, name: access[e].name, to: t.to })))])),
    persons: plist.length,
    personsWithRecords: plist.filter(p => p.matches.length).length,
    humans: humans.length,
    revoked: revoked.size,
    overrides: rolesRows.length,
    match: matchStats,
  };
  return { access, people: plist, tos: [...tosNeeded.values()], warnings, stats, humans, recKeys, rowKey: row => hidOfRow.get(row) || '' };
}
