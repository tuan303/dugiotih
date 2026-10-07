// Vercel Function: /api/sync – đồng bộ Google Sheet của các cấp (+ tab Phân quyền) → Firestore (bố cục v2).
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>)
//   POST – Apps Script (Bearer <SYNC_SECRET>) hoặc người dùng bấm “Đồng bộ ngay”
//          (Bearer <Firebase ID token> của tài khoản Microsoft 365 – nhà cung cấp 'microsoft.com'; email thuộc
//          ALLOWED_DOMAINS, có trong ADMIN_EMAILS, hoặc đã có v2_access/{email}). Tài khoản cùng tên miền nhưng chưa có
//          v2_access chỉ nhận { ok, skipped, syncedAtMs, … } (không có số phiếu / số tài khoản).
//   ?force=1 (CHỈ với CRON_SECRET): ghi lại toàn bộ, bỏ qua so sánh hash. Không nhận với SYNC_SECRET (bí mật này nằm
//            trong Script Properties – mọi người có quyền sửa Sheet đều đọc được) để tránh bị lạm dụng ghi hàng loạt.
// Trả về JSON { ok, skipped?, count, added, updated, removed, levels, scopes, scopesWritten, scopesDeleted, chunksWritten, chunksDeleted,
//               accessCount, accessWritten, accessDeleted, durationMs, syncedAtMs, trigger, warnings?, … };
//               401/403 khi không được phép, 409 khi đang có lượt khác, 429 khi người dùng gọi lại < 60 s sau một lượt
//               đồng bộ thất bại, 500 khi lỗi. `warnings` (có thể nêu email/tên trong DS Nhân sự, tab Phân quyền) chỉ trả cho
//               cron, Apps Script và ADMIN_EMAILS; người dùng khác nhận `warningCount`.
// firebase-admin chỉ được khởi tạo khi cần (sau khi đã có token), nên các nhánh 401 chạy được cả khi chưa có service account.
// Các thư viện nặng (firebase-admin, google-auth-library) được nạp động bên trong handler: nếu nạp lỗi trên Vercel,
// hàm trả JSON 500 nêu rõ nguyên nhân thay vì sập (FUNCTION_INVOCATION_FAILED).
// Điều kiện bảo mật của đăng nhập Microsoft (App registration SINGLE-TENANT): xem server/auth.js.
import { authorize } from '../server/auth.js';

// Nạp các module máy chủ một lần cho mỗi instance; lỗi nạp không được cache để lần sau thử lại.
let modsPromise = null;
export function loadServerModules() {
  modsPromise ||= Promise.all([
    import('../server/sync.js'),
    import('../server/sheet.js'),
    import('../server/firebase.js'),
  ]).then(([sync, sheet, firebase]) => ({ ...sync, ...sheet, ...firebase }))
    .catch(e => { modsPromise = null; throw Object.assign(e, { moduleLoad: true }); });
  return modsPromise;
}

// Mô tả lỗi ngắn gọn để chẩn đoán (không kèm stack, che mọi khóa PEM).
function errorDetail(e) {
  const first = String(e?.message || e || '').split('\n')[0].replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[đã ẩn]');
  return [e?.code, first].filter(Boolean).join(': ').slice(0, 240);
}

const PUBLIC_FIELDS = [
  'ok', 'skipped', 'count', 'added', 'updated', 'removed', 'levels', 'scopes', 'scopesWritten', 'scopesDeleted', 'chunksWritten', 'chunksDeleted',
  'accessCount', 'accessWritten', 'accessDeleted', 'durationMs', 'syncedAtMs', 'trigger', 'runs', 'retryAfterMs',
  'partial', 'pending', // lượt đồng bộ lớn đã ghi một phần (trạng thái đã lưu) – trình duyệt gọi tiếp để ghi phần còn lại
];
// Tài khoản cùng tên miền nhưng CHƯA được cấp quyền xem (không có v2_access): chỉ biết lượt đồng bộ chạy hay chưa.
const MINIMAL_FIELDS = ['ok', 'skipped', 'durationMs', 'syncedAtMs', 'retryAfterMs', 'partial'];
const pick = (r, fields = PUBLIC_FIELDS) => Object.fromEntries(fields.filter(k => r[k] !== undefined).map(k => [k, r[k]]));

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
  if (e?.moduleLoad) return `Máy chủ không nạp được thư viện (${errorDetail(e)}). Hãy Redeploy trên Vercel; nếu vẫn lỗi, gửi thông báo này cho quản trị.`;
  return 'Lỗi máy chủ khi đồng bộ dữ liệu. Xem log của hàm /api/sync trên Vercel để biết chi tiết.';
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}


/**
 * Tạo handler với các phụ thuộc có thể thay thế (phục vụ kiểm thử).
 * @param {object} [deps]
 * @param {object} [deps.env]                       mặc định process.env
 * @param {() => object} [deps.getStore]            mặc định firestoreStore(getDb())
 * @param {(token:string)=>Promise<object>} [deps.verifyIdToken]
 * @param {(p:{env:object}, mods:object)=>Function} [deps.makeFetchTable]  trả về fetchTable(sheetId, tab)
 * @param {() => number} [deps.now]
 * @param {Console} [deps.log]
 */
export function createHandler(deps = {}) {
  const {
    env = process.env,
    loadModules = loadServerModules,
    now = Date.now,
    log = console,
  } = deps;
  // Phụ thuộc mặc định dùng các module nạp động (m); kiểm thử có thể thay thế từng cái.
  const getStore = deps.getStore || (m => m.firestoreStore(m.getDb()));
  const verifyIdTokenWith = deps.verifyIdToken ? (() => deps.verifyIdToken) : (m => token => m.getAdminAuth().verifyIdToken(token));
  const makeFetchTable = deps.makeFetchTable || ((p, m) => {
    let serviceAccount = null;
    try { serviceAccount = m.getServiceAccount(); } catch { /* chưa cấu hình → đọc Sheet công khai */ }
    return m.makeMultiSheetFetcher({ serviceAccount });
  });

  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { ok: false, error: 'Phương thức không được hỗ trợ (chỉ GET hoặc POST).' });
    }

    let mods;
    try {
      mods = await loadModules();
    } catch (e) {
      log.error('[sync] không nạp được module máy chủ:', e);
      return send(res, 500, { ok: false, error: friendlyError(e) });
    }

    let store = null;
    const lazyStore = () => (store ||= getStore(mods));

    let auth;
    try {
      auth = await authorize({
        authorization: req.headers?.authorization,
        env,
        verifyIdToken: verifyIdTokenWith(mods),
        hasAccess: async email => !!(await lazyStore().get(mods.accessPath(email))),
      });
    } catch (e) {
      log.error('[sync] lỗi khi xác thực:', e);
      return send(res, 500, { ok: false, error: friendlyError(e) });
    }
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });

    const cfg = mods.readSyncConfig(env);
    if (!cfg.levels.some(l => l.enabled)) return send(res, 500, { ok: false, error: 'Chưa cấu hình Google Sheet nào: đặt SHEET_ID_TIH / SHEET_ID_THCS / SHEET_ID_THPT trên Vercel.', trigger: auth.trigger });

    let force = false;
    try {
      const q = new URL(req.url || '/', 'http://localhost').searchParams.get('force') || '';
      force = auth.trigger === 'cron' && /^(1|true|yes)$/i.test(q);
    } catch { /* bỏ qua URL lỗi */ }

    try {
      const result = await mods.runSync({
        store: lazyStore(),
        fetchTable: makeFetchTable({ env }, mods),
        env,
        trigger: auth.trigger,
        nowMs: now(),
        force,
        log,
      });
      if (result.warnings?.length) log.warn('[sync] cảnh báo:', result.warnings.join(' | '));
      const status = result.skipped === 'locked' ? 409 : (result.ok === false && result.skipped === 'recent') ? 429 : 200;
      const minimal = !!auth.email && !auth.admin && !auth.viewer;
      const body = pick(result, minimal ? MINIMAL_FIELDS : PUBLIC_FIELDS);
      if (Array.isArray(result.warnings) && !minimal) {
        if (!auth.email || auth.admin) body.warnings = result.warnings;
        else body.warningCount = result.warnings.length;
      }
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
