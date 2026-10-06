// Đọc Google Sheet qua endpoint gviz (Google Visualization Query) – trả về đối tượng `table`.
// Sheet riêng tư (khuyên dùng, bắt buộc khi chạy thật): dùng access token của service account đã được chia sẻ quyền Xem.
// Sheet công khai (“Bất kỳ ai có đường liên kết”): đọc được không cần token – chỉ nên dùng khi thử nghiệm.
import { GoogleAuth } from 'google-auth-library';

export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];
const DEFAULT_TIMEOUT_MS = 25_000;

const publicError = (message, code) => Object.assign(new Error(message), { expose: true, code });

export const gvizUrl = (sheetId, gid, tq = '') =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?gid=${encodeURIComponent(gid)}&headers=1&tqx=out:json${tq ? `&tq=${encodeURIComponent(tq)}` : ''}`;
const SHARE_HINT = 'Hãy chia sẻ quyền Xem của Sheet cho email service account (FIREBASE_SERVICE_ACCOUNT → client_email) – xem README, bước 2.';

// "/*O_o*/\ngoogle.visualization.Query.setResponse({...});" → object
export function parseGvizBody(body) {
  const s = String(body ?? '');
  const start = s.indexOf('setResponse(');
  const end = s.lastIndexOf(')');
  if (start < 0 || end <= start) {
    if (/^\s*</.test(s)) {
      throw publicError(`Google trả về trang HTML (thường là trang đăng nhập) thay vì dữ liệu: Sheet chưa được chia sẻ cho máy chủ. ${SHARE_HINT}`, 'SHEET_NOT_SHARED');
    }
    throw publicError('Phản hồi từ Google Sheet không đúng định dạng gviz.', 'SHEET_BAD_RESPONSE');
  }
  let json;
  try { json = JSON.parse(s.slice(start + 'setResponse('.length, end)); } catch {
    throw publicError('Không đọc được JSON trong phản hồi của Google Sheet.', 'SHEET_BAD_RESPONSE');
  }
  return json;
}

/**
 * Tải một tab của Sheet (theo gid) và trả về `table` của gviz.
 * @param {string} sheetId
 * @param {string|number} gid
 * @param {{accessToken?:string, fetchImpl?:typeof fetch, timeoutMs?:number, tq?:string}} [opts]  tq: câu truy vấn gviz (vd. 'limit 0')
 */
export async function fetchGvizTable(sheetId, gid, { accessToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, tq = '' } = {}) {
  if (!sheetId) throw publicError('Chưa cấu hình SHEET_ID.', 'CONFIG_SHEET_ID');
  const headers = { Accept: 'application/json, text/javascript, */*' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let res, body;
  try {
    res = await fetchImpl(gvizUrl(sheetId, gid, tq), { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    body = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw publicError(timeout ? `Quá thời gian chờ khi tải Google Sheet (gid ${gid}).` : `Không kết nối được tới Google Sheet (gid ${gid}).`, 'SHEET_NETWORK');
  }
  const ctype = String(res.headers?.get?.('content-type') || '');
  if (res.status === 404) throw publicError('Không tìm thấy Google Sheet – kiểm tra lại SHEET_ID.', 'SHEET_NOT_FOUND');
  if (res.status === 401 || res.status === 403 || (/text\/html/i.test(ctype) && !/setResponse\(/.test(body))) {
    throw publicError(`Không có quyền đọc Google Sheet (gid ${gid}). ${SHARE_HINT}`, 'SHEET_NOT_SHARED');
  }
  if (!res.ok) throw publicError(`Google Sheet trả về lỗi HTTP ${res.status} (gid ${gid}).`, 'SHEET_HTTP');

  const json = parseGvizBody(body);
  if (json.status === 'error') {
    const e0 = (json.errors || [])[0] || {};
    const detail = e0.detailed_message || e0.message || e0.reason || 'không rõ';
    throw publicError(`Google Sheet báo lỗi (gid ${gid}): ${detail}`, 'SHEET_QUERY_ERROR');
  }
  if (!json.table || !Array.isArray(json.table.cols) || !Array.isArray(json.table.rows)) {
    throw publicError(`Phản hồi Google Sheet (gid ${gid}) không có bảng dữ liệu.`, 'SHEET_BAD_RESPONSE');
  }
  return json.table;
}

/* ---------------- Token service account ---------------- */
const authCache = new Map(); // client_email → GoogleAuth (thư viện tự lưu token tới khi hết hạn)

/**
 * @param {{client_email:string, private_key:string}} serviceAccount
 * @returns {Promise<string>} access token (scope spreadsheets.readonly + drive.readonly)
 */
export async function getSheetsAccessToken(serviceAccount) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error('Thiếu thông tin service account.');
  let auth = authCache.get(serviceAccount.client_email);
  if (!auth) {
    auth = new GoogleAuth({
      credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key },
      scopes: SHEETS_SCOPES,
    });
    authCache.set(serviceAccount.client_email, auth);
  }
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Không lấy được access token cho service account.');
  return token;
}

/**
 * Tạo hàm fetchTable(gid) cho runSync: thử bằng token service account trước (Sheet riêng tư),
 * nếu không được thì thử lại không token (Sheet công khai). Ghi nhớ cách đã thành công cho các tab sau.
 * fetchTable.isPublic(gid) → true (đọc được KHÔNG cần đăng nhập) | false (riêng tư) | null (không rõ):
 *   runSync dùng để chỉ đưa đường dẫn Sheet lên dashboard khi Sheet đã riêng tư, và cảnh báo khi Sheet còn công khai.
 * @param {{sheetId:string, serviceAccount?:{client_email:string, private_key:string}|null, fetchImpl?:typeof fetch, getToken?:Function}} p
 */
export function makeSheetFetcher({ sheetId, serviceAccount = null, fetchImpl = globalThis.fetch, getToken = getSheetsAccessToken } = {}) {
  let mode = null; // 'token' | 'anon'
  let tokenPromise = null;
  fetchTable.isPublic = async gid => {
    // Không có service account → máy chủ chỉ đọc được khi Sheet công khai (nếu không, fetchTable sẽ báo lỗi).
    if (!serviceAccount || mode === 'anon') return true;
    try {
      await fetchGvizTable(sheetId, gid, { fetchImpl, tq: 'limit 0', timeoutMs: 10_000 }); // chỉ lấy tiêu đề cột, không token
      return true;
    } catch (e) {
      return e?.code === 'SHEET_NOT_SHARED' ? false : null;
    }
  };
  return fetchTable;
  async function fetchTable(gid) {
    let tokenErr = null;
    if (serviceAccount && mode !== 'anon') {
      try {
        tokenPromise ||= getToken(serviceAccount);
        const accessToken = await tokenPromise;
        const table = await fetchGvizTable(sheetId, gid, { accessToken, fetchImpl });
        mode = 'token';
        return table;
      } catch (e) {
        tokenPromise = null;
        if (mode === 'token') throw e;
        tokenErr = e;
      }
    }
    try {
      const table = await fetchGvizTable(sheetId, gid, { fetchImpl });
      mode = 'anon';
      return table;
    } catch (e) {
      if (tokenErr && e.code === 'SHEET_NOT_SHARED') {
        const why = tokenErr.expose ? tokenErr.message : 'không lấy được token của service account';
        throw publicError(`Không đọc được Google Sheet: Sheet ở chế độ riêng tư và service account ${serviceAccount.client_email} chưa đọc được (${why}). Hãy chia sẻ quyền Xem của Sheet cho email này.`, 'SHEET_NOT_SHARED');
      }
      throw e;
    }
  }
}
