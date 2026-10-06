// Vercel Function: /api/sync – đồng bộ Google Sheet → Firestore.
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>)
//   POST – Apps Script (Bearer <SYNC_SECRET>) hoặc người dùng bấm “Làm mới”
//          (Bearer <Firebase ID token> của tài khoản Microsoft 365 – nhà cung cấp 'microsoft.com').
//   ?force=1 (CHỈ với CRON_SECRET): ghi lại toàn bộ, bỏ qua so sánh hash. Không nhận với SYNC_SECRET (bí mật này nằm
//            trong Script Properties – mọi người có quyền sửa Sheet đều đọc được) để tránh bị lạm dụng ghi hàng loạt.
// Trả về JSON { ok, skipped?, count, added, updated, removed, chunksWritten, staffChanged, accessChanged,
//               durationMs, syncedAtMs, trigger, … }; 401/403 khi không được phép, 409 khi đang có lượt khác,
//               429 khi người dùng gọi lại < 60 s sau một lượt đồng bộ thất bại, 500 khi lỗi.
// firebase-admin chỉ được khởi tạo khi cần (sau khi đã có token), nên các nhánh 401 chạy được cả khi chưa có service account.
// Điều kiện bảo mật của đăng nhập Microsoft (App registration SINGLE-TENANT): xem server/auth.js.
import { authorize } from '../server/auth.js';
import { runSync, firestoreStore, readSyncConfig, PATHS } from '../server/sync.js';
import { makeSheetFetcher } from '../server/sheet.js';
import { getDb, getAdminAuth, getServiceAccount } from '../server/firebase.js';

const PUBLIC_FIELDS = [
  'ok', 'skipped', 'count', 'added', 'updated', 'removed', 'chunksWritten', 'chunksDeleted',
  'staffChanged', 'accessChanged', 'durationMs', 'syncedAtMs', 'trigger', 'runs', 'warnings', 'retryAfterMs',
];
const pick = r => Object.fromEntries(PUBLIC_FIELDS.filter(k => r[k] !== undefined).map(k => [k, r[k]]));

// Thông báo lỗi an toàn (không lộ bí mật/stack). Lỗi do ta tạo (expose) giữ nguyên nội dung.
export function friendlyError(e) {
  if (e?.expose) return e.message;
  const code = e?.code;
  const msg = String(e?.message || '');
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(msg)) return 'Cloud Firestore API chưa được bật cho dự án Firebase.';
  if (code === 5 || (/NOT_FOUND/.test(msg) && /database/i.test(msg))) return 'Chưa tạo cơ sở dữ liệu Firestore “(default)” cho dự án Firebase.';
  if (code === 7 || code === 'permission-denied' || /PERMISSION_DENIED/.test(msg)) return 'Service account không có quyền ghi Firestore (cần vai trò “Cloud Datastore User” hoặc “Firebase Admin SDK Administrator”).';
  if (code === 8 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return 'Đã vượt hạn mức Firestore. Vui lòng thử lại sau.';
  if (code === 16 || /UNAUTHENTICATED|invalid_grant|invalid_client/i.test(msg)) return 'Service account Firebase không hợp lệ hoặc khóa đã bị thu hồi.';
  return 'Lỗi máy chủ khi đồng bộ dữ liệu. Xem log của hàm /api/sync trên Vercel để biết chi tiết.';
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function serviceAccountOrNull() {
  try { return getServiceAccount(); } catch { return null; }
}

/**
 * Tạo handler với các phụ thuộc có thể thay thế (phục vụ kiểm thử).
 * @param {object} [deps]
 * @param {object} [deps.env]                       mặc định process.env
 * @param {() => object} [deps.getStore]            mặc định firestoreStore(getDb())
 * @param {(token:string)=>Promise<object>} [deps.verifyIdToken]
 * @param {(p:{sheetId:string, env:object})=>Function} [deps.makeFetchTable]
 * @param {() => number} [deps.now]
 * @param {Console} [deps.log]
 */
export function createHandler(deps = {}) {
  const {
    env = process.env,
    getStore = () => firestoreStore(getDb()),
    verifyIdToken = token => getAdminAuth().verifyIdToken(token),
    makeFetchTable = ({ sheetId }) => makeSheetFetcher({ sheetId, serviceAccount: serviceAccountOrNull() }),
    now = Date.now,
    log = console,
  } = deps;

  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { ok: false, error: 'Phương thức không được hỗ trợ (chỉ GET hoặc POST).' });
    }

    let store = null;
    const lazyStore = () => (store ||= getStore());

    let auth;
    try {
      auth = await authorize({
        authorization: req.headers?.authorization,
        env,
        verifyIdToken,
        getAccess: () => lazyStore().get(PATHS.access),
      });
    } catch (e) {
      log.error('[sync] lỗi khi xác thực:', e);
      return send(res, 500, { ok: false, error: friendlyError(e) });
    }
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });

    const cfg = readSyncConfig(env);
    if (!cfg.sheetId) return send(res, 500, { ok: false, error: 'Chưa cấu hình biến môi trường SHEET_ID trên Vercel.', trigger: auth.trigger });

    let force = false;
    try {
      const q = new URL(req.url || '/', 'http://localhost').searchParams.get('force') || '';
      force = auth.trigger === 'cron' && /^(1|true|yes)$/i.test(q);
    } catch { /* bỏ qua URL lỗi */ }

    try {
      const result = await runSync({
        store: lazyStore(),
        fetchTable: makeFetchTable({ sheetId: cfg.sheetId, env }),
        env,
        trigger: auth.trigger,
        nowMs: now(),
        force,
      });
      if (result.warnings?.length) log.warn('[sync] cảnh báo:', result.warnings.join(' | '));
      const status = result.skipped === 'locked' ? 409 : (result.ok === false && result.skipped === 'recent') ? 429 : 200;
      const body = pick(result);
      if (result.skipped === 'locked') body.error = 'Đang có một lượt đồng bộ khác chạy. Dữ liệu mới sẽ được cập nhật ngay sau lượt đó.';
      else if (status === 429) {
        body.error = result.error || 'Vui lòng thử lại sau ít phút.';
        if (result.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      }
      return send(res, status, body);
    } catch (e) {
      log.error('[sync] đồng bộ thất bại:', e);
      return send(res, 500, { ok: false, error: friendlyError(e), trigger: auth.trigger });
    }
  };
}

export default createHandler();
