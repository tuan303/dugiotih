// Xác thực lời gọi /api/sync và các tiện ích email/tên miền.
// Thuần (không phụ thuộc firebase-admin) để kiểm thử offline: verifyIdToken/hasAccess được truyền vào.
//
// v2: quyền XEM dữ liệu do v2_access/{email} + firestore.rules quyết định. Ở đây chỉ quyết định ai được KÍCH HOẠT đồng bộ:
// cron (CRON_SECRET), Apps Script (SYNC_SECRET), hoặc người dùng Microsoft 365 có tên miền trong ALLOWED_DOMAINS,
// có trong ADMIN_EMAILS, hoặc đã có tài liệu v2_access (lượt đồng bộ của người dùng bị giới hạn tần suất).
//
// ĐĂNG NHẬP BẰNG MICROSOFT 365 (Entra ID) qua Firebase Auth – nhà cung cấp 'microsoft.com'.
// Firebase luôn báo email_verified = false với tài khoản microsoft.com, nên KHÔNG dùng email_verified.
// Thay vào đó yêu cầu: token.firebase.sign_in_provider == 'microsoft.com' + có email + email/tên miền được phép.
//
// ⚠ ĐIỀU KIỆN BẢO MẬT BẮT BUỘC: ứng dụng (App registration) trên Azure/Entra mà Firebase dùng cho nhà cung cấp
// Microsoft PHẢI là SINGLE-TENANT (“Accounts in this organizational directory only”), redirect URI
// https://dugiotih.firebaseapp.com/__/auth/handler. Nếu để multi-tenant, người dùng của tenant KHÁC có thể tự đặt
// thuộc tính email (không được xác minh) thành …@hoangmaistarschool.edu.vn và vượt qua kiểm tra tên miền
// (kiểu tấn công “nOAuth”). Tham số `tenant` phía trình duyệt KHÔNG thay thế được cấu hình này.
import { createHash, timingSafeEqual } from 'node:crypto';
import { emailsIn } from '../lib/shared.js';

export const REQUIRED_PROVIDER = 'microsoft.com';
export const DEFAULT_ALLOWED_DOMAINS = 'hoangmaistarschool.edu.vn';

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// "a@x.vn, B@y.vn; c@z.vn\n d@w.vn" → ['a@x.vn','b@y.vn',...] (chữ thường, hợp lệ; chưa sắp xếp/lọc trùng)
export const splitEmails = emailsIn;
// "@School.edu.vn, other.vn" → ['school.edu.vn','other.vn']
export function splitDomains(s) {
  return String(s ?? '').split(/[\s,;]+/).map(x => x.trim().toLowerCase().replace(/^@+/, '')).filter(x => DOMAIN_RE.test(x));
}
export const uniqSorted = arr => [...new Set(arr)].sort();

/**
 * Tên miền được phép KÍCH HOẠT đồng bộ theo biến môi trường ALLOWED_DOMAINS.
 *  – chưa đặt (undefined) hoặc chỉ có khoảng trắng → mặc định 'hoangmaistarschool.edu.vn'
 *  – 'none' → không cho phép theo tên miền (chỉ ADMIN_EMAILS và người đã có v2_access)
 *  – còn lại → danh sách tên miền (phân tách bằng dấu phẩy/khoảng trắng), viết thường
 */
export function envDomains(env = {}) {
  const raw = env.ALLOWED_DOMAINS;
  if (raw == null || !String(raw).trim()) return splitDomains(DEFAULT_ALLOWED_DOMAINS);
  if (/^\s*none\s*$/i.test(String(raw))) return [];
  return uniqSorted(splitDomains(raw));
}
// ADMIN_EMAILS: BGH liên cấp bổ sung (vd. cán bộ CNTT) – luôn được kích hoạt đồng bộ.
export const envAdmins = (env = {}) => uniqSorted(splitEmails(env.ADMIN_EMAILS));

// Email hợp lệ cho việc phân quyền: có ĐÚNG MỘT dấu '@', hai phía khác rỗng (vd. chặn “a@evil.com@truong.edu.vn”).
export const hasSingleAt = email => {
  const parts = String(email || '').split('@');
  return parts.length === 2 && !!parts[0] && !!parts[1];
};
export const emailDomain = email => {
  const e = String(email || '').trim().toLowerCase();
  return hasSingleAt(e) ? e.slice(e.indexOf('@') + 1) : '';
};

// access: { emails: string[], domains: string[] } | null
export function isEmailAllowed(email, access) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !hasSingleAt(e) || !access) return false;
  if (Array.isArray(access.emails) && access.emails.some(x => String(x).trim().toLowerCase() === e)) return true;
  const d = emailDomain(e);
  return !!d && Array.isArray(access.domains) && access.domains.some(x => String(x).trim().toLowerCase() === d);
}

// So sánh bí mật an toàn về thời gian (băm trước để độ dài luôn bằng nhau). Bí mật rỗng không bao giờ khớp.
export function secretEquals(given, expected) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  const exp = expected.trim();
  if (!exp || !given) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(exp, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header) {
  const h = Array.isArray(header) ? header[0] : header;
  const m = String(h || '').match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : '';
}

const deny = (status, error) => ({ ok: false, status, error });

/**
 * Quyết định ai được gọi /api/sync.
 *   Bearer = CRON_SECRET → 'cron';  Bearer = SYNC_SECRET → 'webhook' (chỉ khi biến môi trường khác rỗng)
 *   Ngược lại: Firebase ID token của tài khoản Microsoft 365 có email, và email thuộc ALLOWED_DOMAINS, có trong
 *   ADMIN_EMAILS, hoặc đã có tài liệu v2_access/{email} → 'user:<email>'.
 * @param {object} p
 * @param {string|string[]|undefined} p.authorization  giá trị header Authorization
 * @param {object} p.env  process.env (CRON_SECRET, SYNC_SECRET, ALLOWED_DOMAINS, ADMIN_EMAILS)
 * @param {(token:string)=>Promise<object>} p.verifyIdToken  xác minh Firebase ID token → claims
 * @param {(email:string)=>Promise<boolean>} [p.hasAccess]  email đã có tài liệu v2_access chưa
 * @returns {Promise<{ok:true, trigger:string, email?:string, admin?:boolean, viewer?:boolean} | {ok:false, status:number, error:string}>}
 *   viewer: người dùng đã có tài liệu v2_access (hoặc là ADMIN_EMAILS) – chỉ những người này nhận số liệu chi tiết của lượt đồng bộ
 *   (số phiếu từng cấp, số tài khoản…); tài khoản cùng tên miền nhưng chưa được cấp quyền chỉ nhận kết quả tối thiểu.
 *   Lỗi cấu hình máy chủ (vd. chưa có service account) được ném ra để handler trả 500.
 */
export async function authorize({ authorization, env = {}, verifyIdToken, hasAccess } = {}) {
  const token = bearerToken(authorization);
  if (!token) return deny(401, 'Thiếu thông tin xác thực. Vui lòng đăng nhập bằng tài khoản Microsoft 365 của trường.');

  if (secretEquals(token, env.CRON_SECRET)) return { ok: true, trigger: 'cron' };
  if (secretEquals(token, env.SYNC_SECRET)) return { ok: true, trigger: 'webhook' };

  if (typeof verifyIdToken !== 'function') return deny(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
  let claims;
  try {
    claims = await verifyIdToken(token);
  } catch (e) {
    if (e?.expose) throw e; // lỗi cấu hình máy chủ (thiếu service account…) → 500 với thông báo rõ ràng
    return deny(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
  }

  if (claims?.firebase?.sign_in_provider !== REQUIRED_PROVIDER) {
    return deny(403, 'Chỉ chấp nhận đăng nhập bằng tài khoản Microsoft 365 của trường (@hoangmaistarschool.edu.vn).');
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return deny(403, 'Tài khoản Microsoft 365 này không có địa chỉ email. Liên hệ quản trị CNTT của trường.');
  if (!hasSingleAt(email) || email.includes('/')) return deny(403, `Địa chỉ email “${email}” không hợp lệ.`);

  const admin = envAdmins(env).includes(email);
  if (admin) return { ok: true, trigger: `user:${email}`, email, admin: true, viewer: true };
  const viewer = typeof hasAccess === 'function' ? !!(await hasAccess(email)) : false; // lỗi Firestore → handler trả 500
  if (viewer || isEmailAllowed(email, { emails: [], domains: envDomains(env) })) return { ok: true, trigger: `user:${email}`, email, admin: false, viewer };

  return deny(403, `Tài khoản ${email} chưa được cấp quyền xem dashboard nên không thể yêu cầu đồng bộ. Liên hệ quản trị để được cấp quyền.`);
}
