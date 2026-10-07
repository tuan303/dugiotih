#!/usr/bin/env node
// Chạy thử đồng bộ v2 (Dashboard toàn trường) → kho dữ liệu TRONG BỘ NHỚ (không ghi Firestore).
//   • Sheet riêng tư: cần FIREBASE_SERVICE_ACCOUNT (hoặc 3 biến FIREBASE_*) của service account đã được chia sẻ quyền Xem
//     (chỉ dùng để lấy token đọc Sheet). Sheet công khai: không cần service account.
//   • In: số phiếu từng cấp, danh sách TỔ đã chuẩn hóa (số phiếu theo biểu mẫu và số nhân sự theo DS – để thấy tổ lệch tên),
//     vai trò (BGH liên cấp, BGH cấp, tổ trưởng), tỉ lệ ghép phiếu ↔ nhân sự, kích thước phạm vi, cảnh báo.
//   • Ghi ./dev-data-v2.json { meta, users:{<bí danh>:{email, access}}, scopes:{<scopeId>:{doc, chunks:[{id,i,n,data}]}} }
//     để xem trước dashboard cục bộ: http://127.0.0.1:<cổng>/index.html?local&as=<bí danh>
//     Bí danh: admin, bgh_tih, bgh_thcs, to_tih, to_thcs, gv_tih, gv_thcs (chọn người thật có phiếu).
//     Tệp này chứa dữ liệu thật → đã nằm trong .gitignore, KHÔNG commit.
//
// Cách dùng:
//   SHEET_ID_TIH=<mã> SHEET_ID_THCS=<mã> [SHEET_ID_THPT=<mã>] [ROLES_SHEET_ID=<mã>] npm run dry-run
//   npm run dry-run -- --tih <mã> --thcs <mã> [--thpt <mã>] [--roles <mã>] [--admin <email>] [--out tệp.json] [--no-write]
//   npm run dry-run -- --tables <tệp.json>   (đọc bảng gviz đã lưu thay vì Google Sheet – khi không có mạng / Sheet đã riêng tư
//                                            mà máy không có service account; tệp: { tih: { form, staff }, thcs: {…}, thpt?: {…},
//                                            roles?: <bảng tab Phân quyền> } – CHỨA DỮ LIỆU THẬT, để ngoài thư mục dự án)
// Các biến SHEET_FORM_TAB_<CẤP>, SHEET_STAFF_TAB_<CẤP>, ROLES_TAB, ADMIN_EMAILS dùng như trên Vercel.
// ADMIN_EMAILS trống → dùng email giả admin.demo@hoangmaistarschool.edu.vn cho bí danh “admin”.
// Nếu có tệp .env ở thư mục dự án, các biến chưa đặt sẽ được đọc từ đó.
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSync, readSyncConfig, PATHS, scopePath, chunkPath, accessPath } from '../server/sync.js';
import { makeMultiSheetFetcher } from '../server/sheet.js';
import { memoryStore } from '../server/memory-store.js';
import { getServiceAccount } from '../server/firebase.js';
import { adminEmails } from '../server/roles.js';
import { scopeIdTo } from '../server/scopes.js';
import { readFile } from 'node:fs/promises';
import { CAPS, CAP_INFO, TO_BGH, fold } from '../lib/shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_ADMIN = 'admin.demo@hoangmaistarschool.edu.vn';

function parseArgs(argv) {
  const out = { tih: '', thcs: '', thpt: '', roles: '', admin: '', tables: '', out: path.join(ROOT, 'dev-data-v2.json'), write: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const [, v] = a.split(/=(.*)/s); return (v !== undefined ? v : argv[++i] ?? '').trim(); };
    const key = a.replace(/^--/, '').split('=')[0];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--no-write') out.write = false;
    else if (['tih', 'thcs', 'thpt', 'roles', 'admin'].includes(key) && a.startsWith('--')) out[key] = val();
    else if (key === 'out' && a.startsWith('--')) out.out = path.resolve(process.cwd(), val());
    else if (key === 'tables' && a.startsWith('--')) out.tables = path.resolve(process.cwd(), val());
    else { console.error(`Tham số không hợp lệ: ${a}`); process.exit(2); }
  }
  return out;
}

const kb = n => `${(n / 1024).toFixed(1)} KB`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Cách dùng: SHEET_ID_TIH=<mã> SHEET_ID_THCS=<mã> npm run dry-run   |   npm run dry-run -- --tih <mã> --thcs <mã> [--thpt <mã>] [--roles <mã>] [--admin <email>] [--tables bảng.json] [--out tệp.json] [--no-write]');
    return;
  }
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envFile); } catch (e) { console.warn(`Không đọc được .env: ${e.message}`); }
  }
  const env = { ...process.env };
  if (args.tih) env.SHEET_ID_TIH = args.tih;
  if (args.thcs) env.SHEET_ID_THCS = args.thcs;
  if (args.thpt) env.SHEET_ID_THPT = args.thpt;
  if (args.roles) env.ROLES_SHEET_ID = args.roles;
  let saved = null;
  if (args.tables) {
    saved = JSON.parse(await readFile(args.tables, 'utf8'));
    for (const cap of CAPS) env[`SHEET_ID_${cap.toUpperCase()}`] = saved[cap] ? `tables:${cap}` : '';
    env.ROLES_SHEET_ID = saved.roles ? 'tables:roles' : '';
  }
  if (args.admin) env.ADMIN_EMAILS = [env.ADMIN_EMAILS, args.admin].filter(Boolean).join(',');
  let demoAdmin = false;
  if (!adminEmails(env).length) { env.ADMIN_EMAILS = DEMO_ADMIN; demoAdmin = true; }
  const cfg = readSyncConfig(env);
  if (!cfg.levels.some(l => l.enabled)) {
    console.error('Thiếu mã Google Sheet. Đặt SHEET_ID_TIH / SHEET_ID_THCS / SHEET_ID_THPT hoặc dùng --tih / --thcs / --thpt <mã>.');
    process.exit(1);
  }

  let fetchSheet;
  if (saved) {
    console.log(`Đọc bảng đã lưu: ${args.tables} (không truy cập Google Sheet).`);
    fetchSheet = async (sheetId, tab) => {
      const which = String(sheetId).replace(/^tables:/, '');
      if (which === 'roles') return structuredClone(saved.roles);
      return structuredClone(tab.sheet === (env[`SHEET_STAFF_TAB_${which.toUpperCase()}`] || 'DS Nhân sự') ? saved[which].staff : saved[which].form);
    };
    fetchSheet.isPublic = async () => null;
  } else {
    let serviceAccount = null;
    try { serviceAccount = getServiceAccount(env); } catch (e) { console.warn(`Bỏ qua service account: ${e.message}`); }
    console.log(serviceAccount ? `Đọc Sheet bằng service account ${serviceAccount.client_email}.` : 'Không có service account → đọc Sheet ở chế độ công khai.');
    fetchSheet = makeMultiSheetFetcher({ serviceAccount });
  }
  const timings = [];
  const label = id => cfg.levels.find(l => l.sheetId === id)?.label || (id === cfg.rolesSheetId ? 'Phân quyền' : '?');
  const fetchTable = async (sheetId, tab) => {
    const t0 = performance.now();
    try { return await fetchSheet(sheetId, tab); } finally { timings.push(`${label(sheetId)} / ${tab.sheet}: ${Math.round(performance.now() - t0)} ms`); }
  };
  fetchTable.isPublic = fetchSheet.isPublic;

  const store = memoryStore();
  console.log(`Cấp đang bật: ${cfg.levels.filter(l => l.enabled).map(l => l.label).join(', ')}${cfg.rolesSheetId ? ` · tab Phân quyền: “${cfg.rolesTab}”` : ' · không có ROLES_SHEET_ID'}${demoAdmin ? ` · ADMIN_EMAILS trống → dùng ${DEMO_ADMIN}` : ''}`);
  console.log('Đang đọc Sheet …');
  const r = await runSync({ store, fetchTable, env, trigger: 'dry-run' });
  const { levels, access, people, scopes } = r._internal;
  const st = r.debug.stats;

  // Lần 2 với cùng dữ liệu: chỉ được ghi meta + trạng thái (kiểm tra tính lũy đẳng).
  store.clearLog();
  const r2 = await runSync({ store, fetchTable: fetchSheet, env, trigger: 'dry-run' });
  const bigCommit = store.maxCommitBytes;
  const writes2 = store.writtenPaths();

  console.log('\n=== CẤP ===');
  for (const L of cfg.levels) {
    const lv = levels[L.cap];
    if (!L.enabled) { console.log(`${pad(L.label, 9)} chưa kết nối (SHEET_ID_${L.cap.toUpperCase()} trống)`); continue; }
    const rows = lv.staffRows || [];
    console.log(`${pad(L.label, 9)} ${lpad(lv.records.length, 5)} phiếu · ${lv.crit.length} tiêu chí · DS Nhân sự ${rows.length} dòng (${rows.filter(x => x.active).length} đang làm việc, ${rows.filter(x => x.active && x.email).length} có email)${lv.stale ? ' · ⚠ dùng dữ liệu cũ' : ''}`);
  }

  console.log('\n=== TỔ (đã chuẩn hóa) – phiếu theo biểu mẫu / nhân sự theo DS ===');
  for (const L of cfg.levels.filter(l => l.enabled)) {
    const lv = levels[L.cap];
    const map = new Map();
    const row = to => { if (!map.has(to)) map.set(to, { tg: 0, og: 0, staff: 0, eff: 0, raw: new Set() }); return map.get(to); };
    for (const rec of lv.records) { row(rec.tg).tg++; row(rec.og).og++; }
    const act = (lv.staffRows || []).filter(x => x.active);
    for (const s of act) { const x = row(s.to); x.staff++; x.raw.add(s.toRaw || '(trống)'); }
    const lscope = scopes.find(s => s.id === `L_${L.cap}`);
    for (const s of lscope?.doc.staff || []) row(s.group).eff++;
    for (const b of lscope?.doc.bgh || []) if (b) row(TO_BGH).eff++;
    console.log(`-- ${L.label}`);
    console.log(`   ${pad('Tổ', 24)} ${lpad('GV dạy', 7)} ${lpad('Ng.dự', 6)} ${lpad('DS', 4)} ${lpad('Độ phủ', 7)}  Tên trong DS Nhân sự`);
    for (const [to, x] of [...map].sort((a, b) => b[1].tg - a[1].tg || b[1].staff - a[1].staff)) {
      const flag = (x.tg || x.og) && !x.staff && to !== 'Giáo viên thỉnh giảng' ? ' ⚠ có phiếu nhưng DS không có tổ này' : !x.tg && !x.og && x.staff ? ' (chưa có phiếu)' : '';
      console.log(`   ${pad(to, 24)} ${lpad(x.tg, 7)} ${lpad(x.og, 6)} ${lpad(x.staff, 4)} ${lpad(x.eff, 7)}  ${[...x.raw].join(' | ')}${flag}`);
    }
    const rowsN = act.filter(s => s.to !== TO_BGH).length;
    console.log(`   (Độ phủ = danh sách GV dùng cho “Dự giờ & độ phủ”: bỏ dòng trùng, bỏ dòng ghi cấp khác, tổ theo biểu mẫu nếu biểu mẫu chưa từng ghi tổ trong DS; ${rowsN} dòng DS → ${(lscope?.doc.staff || []).length} GV)`);
  }

  console.log('\n=== VAI TRÒ ===');
  const nameOf = e => access[e]?.name || e;
  const emails = Object.keys(access);
  console.log(`Tài khoản có quyền  : ${emails.length} (người trong DS Nhân sự/Giáo viên: ${st.persons}, trong đó ${st.personsWithRecords} có phiếu)`);
  console.log(`BGH liên cấp        : ${st.bghAll} – ${emails.filter(e => access[e].roles.bghAll).map(nameOf).join(', ')}`);
  for (const cap of CAPS) {
    if (!st.bghCaps[cap] && !st.toTruong[cap].length) continue;
    console.log(`BGH cấp ${pad(CAP_INFO[cap].label, 11)} : ${st.bghCaps[cap]} – ${emails.filter(e => access[e].roles.bghCaps.includes(cap)).map(nameOf).join(', ')}`);
    console.log(`Tổ trưởng ${pad(CAP_INFO[cap].label, 9)} : ${st.toTruong[cap].length} – ${st.toTruong[cap].map(t => `${t.to}: ${t.name || t.email}`).join('; ')}`);
  }
  if (st.overrides) console.log(`Tab Phân quyền      : ${st.overrides} dòng, thu hồi ${st.revoked} email`);

  console.log('\n=== GHÉP PHIẾU ↔ NHÂN SỰ ===');
  const allStaff = new Map(); // tên (fold) → [{cap, active}]
  for (const cap of CAPS) for (const s of levels[cap]?.staffRows || []) { const k = fold(s.name); if (!allStaff.has(k)) allStaff.set(k, []); allStaff.get(k).push({ cap, active: s.active }); }
  const hint = (cap, name) => {
    const rows = allStaff.get(fold(name)) || [];
    if (rows.some(x => x.cap === cap && !x.active)) return 'có trong DS nhưng ghi chú “nghỉ”';
    if (rows.some(x => x.cap !== cap)) return `chỉ có trong DS ${[...new Set(rows.filter(x => x.cap !== cap).map(x => CAP_INFO[x.cap].label))].join(', ')} (khác cấp → không ghép theo tên)`;
    return 'không có trong DS Nhân sự';
  };
  for (const cap of CAPS) {
    const m = st.match[cap];
    if (!m?.records) continue;
    console.log(`-- ${CAP_INFO[cap].label}: ${m.records} phiếu`);
    console.log(`   Người dạy được ghép : ${m.taught}/${m.records} (${pct(m.taught, m.records)})  [${Object.entries(m.taughtHow).map(([k, v]) => `${k} ${v}`).join(', ')}]`);
    console.log(`   Người dự được ghép  : ${m.observed}/${m.records} (${pct(m.observed, m.records)})`);
    if (m.heldBack) console.log(`   Ghép được người nhưng người đó không có tài khoản được phép (nghỉ / bị thu hồi / email trùng): ${m.heldBack} phiếu – không hiển thị cho ai`);
    const same = (levels[cap]?.records || []).filter(x => fold(x.tn) && fold(x.tn) !== 'khong ro' && fold(x.tn) === fold(x.on));
    if (same.length) {
      console.log(`   ⚠ Phiếu ghi họ tên GV dạy TRÙNG họ tên người dự (${same.length}) – cần sửa trên Sheet; hệ thống xác định người dạy theo mã GV dạy, người dự theo email/mã người dự:`);
      for (const x of same.slice(0, 50)) console.log(`     ${x.day} · ${x.subject} · lớp ${x.cls} · “${x.tn}” · mã GV dạy ${x.tm || '–'} · mã người dự ${x.om || '–'}`);
      if (same.length > 50) console.log('     …');
    }
    const ut = Object.entries(m.unmatchedTeachers).sort((a, b) => b[1] - a[1]);
    if (ut.length) console.log(`   GV dạy chưa ghép (${ut.length} tên): ${ut.slice(0, 12).map(([n, k]) => `${n} ×${k} (${hint(cap, n)})`).join('; ')}${ut.length > 12 ? '; …' : ''}`);
    const uo = Object.entries(m.unmatchedObservers).sort((a, b) => b[1] - a[1]);
    if (uo.length) console.log(`   Người dự chưa ghép (${uo.length} tên): ${uo.slice(0, 12).map(([n, k]) => `${n} ×${k} (${hint(cap, n)})`).join('; ')}${uo.length > 12 ? '; …' : ''}`);
    const inCap = people.filter(p => (p.rowsByCap[cap] || []).length);
    const never = inCap.filter(p => !p.matches.some(x => x.rec.cap === cap));
    console.log(`   Nhân sự (có email) chưa có phiếu nào ở cấp này: ${never.length}/${inCap.length}`);
  }

  console.log('\n=== PHẠM VI (v2_scopes) ===');
  const sizes = r.debug.scopeSizes;
  for (const kind of ['level', 'to', 'person']) {
    const list = sizes.filter(s => s.kind === kind);
    const bytes = list.reduce((n, s) => n + s.bytes, 0);
    console.log(`${pad(kind === 'level' ? 'Cấp (L_)' : kind === 'to' ? 'Tổ (T_)' : 'Cá nhân (P_)', 14)} ${lpad(list.length, 4)} phạm vi · ${lpad(list.reduce((n, s) => n + s.chunks, 0), 4)} khối · ${kb(bytes)}${kind === 'person' ? ` · có phiếu: ${list.filter(s => s.count).length}, nhiều nhất ${Math.max(0, ...list.map(s => s.count))} phiếu` : ''}`);
    if (kind !== 'person') for (const s of list) console.log(`   ${pad(s.id, 26)} ${lpad(s.count, 5)} phiếu ${lpad(s.chunks, 2)} khối ${lpad(kb(s.bytes), 10)}`);
  }
  console.log(`Ghi lượt 1          : ${r.scopesWritten} phạm vi, ${r.chunksWritten} khối, ${r.accessWritten} tài liệu quyền (${r.debug.batches} lô) trong ${r.durationMs} ms`);
  console.log(`Lượt 2 (không đổi)  : phạm vi ${r2.scopesWritten}, khối ${r2.chunksWritten}, quyền ${r2.accessWritten} → ghi: ${writes2.join(', ')}`);
  console.log(`Lô ghi lớn nhất     : ${kb(bigCommit)} (giới hạn của Firestore 10 MiB)`);
  console.log(`Thời gian tải       : ${timings.join(' · ')}`);
  const warns = [...new Set([...(r.warnings || []), ...(r2.warnings || [])])];
  if (warns.length) { console.log('Cảnh báo:'); for (const w of warns) console.log('  • ' + w); }

  if (!args.write) return;

  // ---- dev-data-v2.json: chọn người thật có phiếu cho từng bí danh ----
  const scopeDoc = id => scopes.find(s => s.id === id)?.doc;
  const pCount = (e, cap, rels = ['t', 'to', 'o']) => {
    const key = access[e].roles.person?.key;
    const p = key && people.find(x => x.key === key);
    return p ? p.matches.filter(x => (!cap || x.rec.cap === cap) && rels.includes(x.rel)).length : 0;
  };
  const best = (list, score) => list.map(e => [e, score(e)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const plain = e => { const ro = access[e].roles; return !ro.bghAll && !ro.bghCaps.length && !ro.toTruong.length; };
  const pick = {};
  pick.admin = adminEmails(env).find(e => access[e]) || emails.find(e => access[e].roles.bghAll);
  for (const cap of ['tih', 'thcs']) {
    if (!levels[cap]?.enabled) continue;
    pick[`bgh_${cap}`] = best(emails.filter(e => !access[e].roles.bghAll && access[e].roles.bghCaps.includes(cap)), e => pCount(e, cap));
    pick[`to_${cap}`] = best(emails.filter(e => !access[e].roles.bghAll && !access[e].roles.bghCaps.includes(cap) && access[e].roles.toTruong.some(t => t.cap === cap)),
      e => Math.max(...access[e].roles.toTruong.filter(t => t.cap === cap).map(t => scopeDoc(scopeIdTo(cap, t.to))?.count || 0)) * 10 + pCount(e, cap));
    pick[`gv_${cap}`] = best(emails.filter(e => plain(e) && access[e].roles.person?.caps.includes(cap)),
      e => pCount(e, cap, ['t', 'to']) * 10 + Math.min(pCount(e, cap, ['o', 'to']), 9));
  }
  const users = {}, needed = new Set();
  for (const [alias, email] of Object.entries(pick)) {
    if (!email) { console.log(`(Không tìm được người phù hợp cho bí danh “${alias}”.)`); continue; }
    const acc = await store.get(accessPath(email));
    users[alias] = { email, access: acc };
    acc.scopes.forEach(s => needed.add(s));
  }
  const outScopes = {};
  for (const id of [...needed].sort()) {
    const doc = await store.get(scopePath(id));
    if (!doc) continue;
    const chunks = [];
    for (const cid of doc.chunkIds) { const c = await store.get(chunkPath(id, cid)); chunks.push({ id: cid, i: c.i, n: c.n, data: c.data }); }
    outScopes[id] = { doc, chunks };
  }
  const out = { meta: await store.get(PATHS.meta), users, scopes: outScopes };
  const json = JSON.stringify(out);
  await writeFile(args.out, json);
  console.log(`\nBí danh xem trước (?local&as=…): ${Object.entries(users).map(([a, u]) => `${a} → ${u.access.name || u.email} [${u.access.scopes.length} phạm vi]`).join(' · ')}`);
  console.log(`Đã ghi ${path.relative(process.cwd(), args.out) || args.out} (${kb(Buffer.byteLength(json))}) – chứa dữ liệu thật, KHÔNG commit.`);
}

main().catch(e => {
  console.error(`\nLỗi: ${e?.message || e}`);
  process.exit(1);
});
