// Xác minh Firebase ID token bằng thư viện `jose` (ES Module), không dùng firebase-admin/auth.
// Lý do: firebase-admin/auth → jwks-rsa → require('jose') (ESM-only) gây ERR_REQUIRE_ESM trên Vercel,
// nơi require() của ES Module không được bật.
// Quy trình theo hướng dẫn của Firebase cho thư viện JWT bên thứ ba:
//   https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
//   - alg RS256, chữ ký khớp một khóa công khai của securetoken@system.gserviceaccount.com (kid)
//   - aud = projectId, iss = https://securetoken.google.com/<projectId>
//   - exp ở tương lai, iat và auth_time ở quá khứ, sub là chuỗi khác rỗng (≤ 128 ký tự)
// Không kiểm tra thu hồi phiên (giống verifyIdToken(token) mặc định của firebase-admin).
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_S = 5;

let remoteJwks = null;
const defaultKeys = () => (remoteJwks ||= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL), {
  cacheMaxAge: 6 * 3600 * 1000, // Google xoay vòng khóa vài ngày một lần
  cooldownDuration: 30_000,
  timeoutDuration: 10_000,
}));

const authError = message => Object.assign(new Error(message), { code: 'auth/invalid-id-token' });

/**
 * @param {string} token   Firebase ID token (JWT)
 * @param {string} projectId
 * @param {{ keys?: Function, nowMs?: number }} [opts]  keys: bộ khóa jose (để kiểm thử)
 * @returns {Promise<object>} payload đã xác minh, kèm `uid`
 */
export async function verifyFirebaseIdToken(token, projectId, { keys = defaultKeys(), nowMs = Date.now() } = {}) {
  if (!projectId) throw Object.assign(new Error('Thiếu projectId để xác minh ID token.'), { expose: true, code: 'CONFIG_FIREBASE' });
  if (typeof token !== 'string' || token.split('.').length !== 3) throw authError('ID token không đúng định dạng JWT.');
  const nowS = Math.floor(nowMs / 1000);
  let payload, protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      clockTolerance: CLOCK_SKEW_S,
      currentDate: new Date(nowS * 1000),
    }));
  } catch (e) {
    // Không tải được khóa công khai của Google (mạng/timeout) → lỗi máy chủ (500), không phải token sai (401).
    if (e?.code === 'ERR_JWKS_TIMEOUT' || e instanceof TypeError) {
      throw Object.assign(new Error('Không tải được khóa xác minh đăng nhập của Google. Vui lòng thử lại sau ít phút.'), { expose: true, code: 'JWKS_UNAVAILABLE' });
    }
    throw e;
  }
  if (!protectedHeader.kid) throw authError('ID token thiếu "kid".');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw authError('ID token có "sub" không hợp lệ.');
  if (typeof payload.iat !== 'number' || payload.iat > nowS + CLOCK_SKEW_S) throw authError('ID token có "iat" ở tương lai.');
  if (typeof payload.auth_time !== 'number' || payload.auth_time > nowS + CLOCK_SKEW_S) throw authError('ID token có "auth_time" ở tương lai.');
  return { ...payload, uid: payload.sub };
}
