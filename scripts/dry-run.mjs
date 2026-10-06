#!/usr/bin/env node
// Chạy thử đồng bộ Google Sheet → kho dữ liệu TRONG BỘ NHỚ (không ghi Firestore).
//   • Sheet riêng tư (chế độ khuyên dùng): cần FIREBASE_SERVICE_ACCOUNT (hoặc 3 biến FIREBASE_*) của service account
//     đã được chia sẻ quyền Xem Sheet – chỉ dùng để lấy token đọc Sheet. Sheet công khai: không cần service account.
//   • In tóm tắt (số phiếu, tiêu chí, khối dữ liệu, nhân sự, quyền truy cập, cảnh báo).
//   • Ghi ./dev-data.json { meta, staff, chunks:[{id,i,n,data}] } để xem trước dashboard cục bộ
//     (mở index.html qua http://localhost…/?local). Tệp này chứa dữ liệu thật → đã nằm trong .gitignore.
//
// Cách dùng:
//   SHEET_ID=<mã sheet> npm run dry-run
//   npm run dry-run -- --sheet <mã sheet> [--out dev-data.json] [--no-write]
// Các biến SHEET_GID_FORM, SHEET_GID_STAFF, ALLOWED_EMAILS, ALLOWED_DOMAINS, ACCESS_FROM_SHEET được dùng như trên Vercel.
// Nếu có tệp .env ở thư mục dự án, các biến chưa đặt sẽ được đọc từ đó.
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSync, readSyncConfig, PATHS } from '../server/sync.js';
import { makeSheetFetcher } from '../server/sheet.js';
import { memoryStore } from '../server/memory-store.js';
import { getServiceAccount } from '../server/firebase.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { sheet: '', out: path.join(ROOT, 'dev-data.json'), write: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const [, v] = a.split(/=(.*)/s); return v !== undefined ? v : argv[++i] ?? ''; };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--no-write') out.write = false;
    else if (a === '--sheet' || a.startsWith('--sheet=')) out.sheet = val().trim();
    else if (a === '--out' || a.startsWith('--out=')) out.out = path.resolve(process.cwd(), val().trim());
    else { console.error(`Tham số không hợp lệ: ${a}`); process.exit(2); }
  }
  return out;
}

const kb = n => `${(n / 1024).toFixed(1)} KB`;
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Cách dùng: SHEET_ID=<mã> npm run dry-run   |   npm run dry-run -- --sheet <mã> [--out tệp.json] [--no-write]');
    return;
  }
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envFile); } catch (e) { console.warn(`Không đọc được .env: ${e.message}`); }
  }
  const env = { ...process.env };
  if (args.sheet) env.SHEET_ID = args.sheet;
  const cfg = readSyncConfig(env);
  if (!cfg.sheetId) {
    console.error('Thiếu mã Google Sheet. Đặt biến SHEET_ID hoặc dùng --sheet <mã>.');
    process.exit(1);
  }

  // Service account (nếu có) để đọc Sheet riêng tư; không có → chỉ đọc được Sheet công khai. Đo thời gian từng tab.
  let serviceAccount = null;
  try { serviceAccount = getServiceAccount(env); } catch (e) { console.warn(`Bỏ qua service account: ${e.message}`); }
  console.log(serviceAccount ? `Đọc Sheet bằng service account ${serviceAccount.client_email}.` : 'Không có service account → đọc Sheet ở chế độ công khai.');
  const fetchSheet = makeSheetFetcher({ sheetId: cfg.sheetId, serviceAccount });
  const timings = {};
  const fetchTable = async gid => {
    const t0 = performance.now();
    try { return await fetchSheet(gid); } finally { timings[gid] = Math.round(performance.now() - t0); }
  };
  fetchTable.isPublic = fetchSheet.isPublic;

  const store = memoryStore();
  console.log(`Đang đọc Sheet (gid form ${cfg.formGid}${cfg.staffGid ? `, gid nhân sự ${cfg.staffGid}` : ', DS Nhân sự: tắt'}) …`);
  const r = await runSync({ store, fetchTable, env, trigger: 'dry-run' });

  // Lần 2 với cùng dữ liệu: phải không ghi gì ngoài meta + syncState (kiểm tra tính lũy đẳng).
  store.clearLog();
  const r2 = await runSync({ store, fetchTable: fetchSheet, env, trigger: 'dry-run' });
  const writes2 = store.writtenPaths();

  const meta = await store.get(PATHS.meta);
  const staff = await store.get(PATHS.staff);
  const access = await store.get(PATHS.access);
  const chunkIds = await store.listIds(PATHS.chunks);
  const chunks = [];
  for (const id of chunkIds) {
    const c = await store.get(`${PATHS.chunks}/${id}`);
    chunks.push({ id, i: c.i, n: c.n, data: c.data });
  }
  const phieuIds = await store.listIds(PATHS.phieu);
  const levels = {};
  for (const id of phieuIds) { const p = await store.get(`${PATHS.phieu}/${id}`); levels[p.xepLoai] = (levels[p.xepLoai] || 0) + 1; }

  console.log('\n=== KẾT QUẢ ĐỒNG BỘ (bộ nhớ) ===');
  console.log(`Phiếu hợp lệ      : ${r.count}  (thêm ${r.added}, sửa ${r.updated}, xóa ${r.removed})`);
  console.log(`Tiêu chí          : ${meta.crit.length}  [${meta.crit.map(k => k.code).join(', ')}]`);
  console.log(`Xếp loại          : ${Object.entries(levels).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`Khối dữ liệu      : ${chunks.length}`);
  for (const c of chunks) console.log(`   ${pad(c.id, 5)} ${pad(c.n + ' phiếu', 11)} ${pad(kb(c.data.length) + ' ký tự', 16)} ${kb(Buffer.byteLength(c.data, 'utf8'))} UTF-8`);
  console.log(`Nhân sự           : ${staff.teach.length} giáo viên/nhân viên, ${staff.bgh.length} BGH (staffCount ${meta.staffCount})`);
  console.log(`Quyền truy cập    : chế độ DS Nhân sự = ${cfg.accessFromSheet}; ${access.emails.length} email; tên miền = [${access.domains.join(', ') || 'không'}]`);
  console.log(`Tài liệu phieu/*  : ${phieuIds.length}`);
  const pub = r.debug?.sheetPublic;
  console.log(`Chế độ chia sẻ    : ${pub === true ? 'CÔNG KHAI (ai có link đều đọc được) → meta.sheetUrl để trống' : pub === false ? 'riêng tư → meta.sheetUrl có đường dẫn Sheet' : 'không rõ → meta.sheetUrl để trống'}`);
  console.log(`Thời gian tải     : ${Object.entries(timings).map(([g, ms]) => `gid ${g}: ${ms} ms`).join(', ')}`);
  console.log(`Thời gian lượt 1  : ${r.durationMs} ms (ghi ${r.debug?.phieuOps ?? '?'} phiếu, ${r.debug?.dashOps ?? '?'} thao tác dashboard trong 1 lô)`);
  console.log(`Lượt 2 (không đổi): thêm ${r2.added}, sửa ${r2.updated}, xóa ${r2.removed}, khối ghi ${r2.chunksWritten} → ghi: ${writes2.join(', ')}`);
  const warns = [...new Set([...(r.warnings || []), ...(r2.warnings || [])])];
  if (warns.length) { console.log('Cảnh báo:'); for (const w of warns) console.log('  • ' + w); }

  if (args.write) {
    const devMeta = { ...meta, syncedAt: meta.syncedAt instanceof Date ? meta.syncedAt.toISOString() : meta.syncedAt };
    const out = { meta: devMeta, staff, chunks };
    await writeFile(args.out, JSON.stringify(out));
    console.log(`\nĐã ghi ${path.relative(process.cwd(), args.out) || args.out} (${kb(Buffer.byteLength(JSON.stringify(out)))}) – chứa dữ liệu thật, KHÔNG commit.`);
  }
}

main().catch(e => {
  console.error(`\nLỗi: ${e?.message || e}`);
  process.exit(1);
});
