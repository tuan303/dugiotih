// Đọc Google Sheet → đối tượng `table` dạng gviz (cols/rows) cho lib/shared.js.
// Có service account: ưu tiên Google Sheets API (đọc ĐỦ mọi dòng kể cả khi Sheet đang bật bộ lọc); nếu API chưa được bật
// thì đọc qua gviz bằng token (chỉ các dòng đang hiển thị). Không có service account: gviz công khai (chỉ dùng khi thử nghiệm).
import { GoogleAuth } from 'google-auth-library';

export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];
const DEFAULT_TIMEOUT_MS = 25_000;

const publicError = (message, code) => Object.assign(new Error(message), { expose: true, code });

// tab: { sheet: 'Tên tab' } (khuyên dùng – v2) | { gid: '123' } | '123' (gid – như v1).
// ⚠ Với sheet=<tên>, nếu tab KHÔNG tồn tại Google trả về TAB ĐẦU TIÊN (không báo lỗi) → nơi gọi phải kiểm tra cấu trúc bảng.
const tabParam = tab => (tab && typeof tab === 'object'
  ? (tab.sheet != null ? `sheet=${encodeURIComponent(tab.sheet)}` : `gid=${encodeURIComponent(tab.gid ?? '')}`)
  : `gid=${encodeURIComponent(tab ?? '')}`);
export const tabLabel = tab => (tab && typeof tab === 'object' && tab.sheet != null ? `tab “${tab.sheet}”` : `gid ${tab && typeof tab === 'object' ? tab.gid : tab}`);
export const gvizUrl = (sheetId, tab, tq = '') =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?${tabParam(tab)}&headers=1&tqx=out:json${tq ? `&tq=${encodeURIComponent(tq)}` : ''}`;
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
 * Tải một tab của Sheet và trả về `table` của gviz.
 * @param {string} sheetId
 * @param {{sheet:string}|{gid:string}|string|number} tab  tên tab (v2) hoặc gid
 * @param {{accessToken?:string, fetchImpl?:typeof fetch, timeoutMs?:number, tq?:string}} [opts]  tq: câu truy vấn gviz (vd. 'limit 0')
 */
export async function fetchGvizTable(sheetId, tab, { accessToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, tq = '' } = {}) {
  if (!sheetId) throw publicError('Chưa cấu hình mã Google Sheet (SHEET_ID_…).', 'CONFIG_SHEET_ID');
  const where = tabLabel(tab);
  const headers = { Accept: 'application/json, text/javascript, */*' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let res, body;
  try {
    res = await fetchImpl(gvizUrl(sheetId, tab, tq), { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    body = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw publicError(timeout ? `Quá thời gian chờ khi tải Google Sheet (${where}).` : `Không kết nối được tới Google Sheet (${where}).`, 'SHEET_NETWORK');
  }
  const ctype = String(res.headers?.get?.('content-type') || '');
  if (res.status === 404) throw publicError('Không tìm thấy Google Sheet – kiểm tra lại mã Sheet (SHEET_ID_…).', 'SHEET_NOT_FOUND');
  if (res.status === 401 || res.status === 403 || (/text\/html/i.test(ctype) && !/setResponse\(/.test(body))) {
    throw publicError(`Không có quyền đọc Google Sheet (${where}). ${SHARE_HINT}`, 'SHEET_NOT_SHARED');
  }
  if (!res.ok) throw publicError(`Google Sheet trả về lỗi HTTP ${res.status} (${where}).`, 'SHEET_HTTP');

  const json = parseGvizBody(body);
  if (json.status === 'error') {
    const e0 = (json.errors || [])[0] || {};
    const detail = e0.detailed_message || e0.message || e0.reason || 'không rõ';
    throw publicError(`Google Sheet báo lỗi (${where}): ${detail}`, 'SHEET_QUERY_ERROR');
  }
  if (!json.table || !Array.isArray(json.table.cols) || !Array.isArray(json.table.rows)) {
    throw publicError(`Phản hồi Google Sheet (${where}) không có bảng dữ liệu.`, 'SHEET_BAD_RESPONSE');
  }
  return json.table;
}

/* ---------------- Google Sheets API v4 (luôn đọc ĐỦ dữ liệu) ----------------
 * gviz chỉ trả các dòng ĐANG HIỂN THỊ: khi ai đó bật bộ lọc trên Sheet, các dòng bị lọc ẩn sẽ biến mất khỏi kết quả.
 * Sheets API trả toàn bộ giá trị bất kể bộ lọc → dùng khi có service account. Cần bật "Google Sheets API" cho dự án
 * Google Cloud của Firebase (https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=<project_id>).
 * Kết quả được chuyển về đúng định dạng `table` của gviz để bộ phân tích (lib/shared.js) dùng chung. */
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const a1Sheet = title => `'${String(title).replace(/'/g, "''")}'`;
export const sheetsValuesUrl = (sheetId, title, render) =>
  `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(a1Sheet(title))}?majorDimension=ROWS&valueRenderOption=${render}&dateTimeRenderOption=SERIAL_NUMBER`;
export const sheetsMetaUrl = sheetId => `${SHEETS_API}/${encodeURIComponent(sheetId)}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`;
export const sheetsApiEnableUrl = projectId =>
  `https://console.cloud.google.com/apis/library/sheets.googleapis.com${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;

async function sheetsApiGet(url, { accessToken, fetchImpl, timeoutMs, where }) {
  let res, body;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    body = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw publicError(timeout ? `Quá thời gian chờ khi tải Google Sheet (${where}).` : `Không kết nối được tới Google Sheets API (${where}).`, 'SHEET_NETWORK');
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* không phải JSON */ }
  if (res.ok && json) return json;
  const err = json?.error || {};
  const msg = String(err.message || '');
  const reasons = [...(err.details || []).map(d => d?.reason), ...(err.errors || []).map(d => d?.reason)].filter(Boolean);
  if (res.status === 403 && (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /has not been used|is disabled|SERVICE_DISABLED/i.test(msg))) {
    throw publicError('Google Sheets API chưa được bật cho dự án Google Cloud của Firebase.', 'SHEETS_API_DISABLED');
  }
  if (res.status === 401 || res.status === 403) throw publicError(`Không có quyền đọc Google Sheet (${where}). ${SHARE_HINT}`, 'SHEET_NOT_SHARED');
  if (res.status === 404) throw publicError('Không tìm thấy Google Sheet – kiểm tra lại mã Sheet (SHEET_ID_…).', 'SHEET_NOT_FOUND');
  if (res.status === 400 && /unable to parse range/i.test(msg)) throw publicError(`Không tìm thấy ${where} trong Google Sheet – kiểm tra tên tab.`, 'SHEET_TAB_NOT_FOUND');
  throw publicError(`Google Sheets API trả về lỗi HTTP ${res.status} (${where}).`, 'SHEET_HTTP');
}

// Số ngày kiểu Google Sheets (gốc 30/12/1899, giờ "treo tường") → chuỗi gviz 'Date(y,m0,d,h,mi,s)'
export function serialToGvizDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000);
  return `Date(${d.getUTCFullYear()},${d.getUTCMonth()},${d.getUTCDate()},${d.getUTCHours()},${d.getUTCMinutes()},${d.getUTCSeconds()})`;
}
const DATE_TEXT = /^\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/;
const colId = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const isBlank = v => v === undefined || v === null || v === '';

/**
 * Chuyển kết quả values.get (2 lần: UNFORMATTED_VALUE + FORMATTED_VALUE, dòng 1 là tiêu đề) thành `table` dạng gviz:
 * cột có kiểu (number | date | datetime | string) suy theo đa số giá trị; ô ngày giờ có v = 'Date(…)' và f = chuỗi hiển thị.
 * @param {any[][]} U  giá trị gốc (số, số ngày, chuỗi, boolean)
 * @param {any[][]} F  giá trị hiển thị (chuỗi)
 */
export function valuesToTable(U = [], F = []) {
  const header = (F[0] || U[0] || []).map(v => (isBlank(v) ? '' : String(v)));
  const nRows = Math.max(U.length, F.length) - 1;
  let width = header.length;
  for (let r = 1; r <= nRows; r++) width = Math.max(width, U[r]?.length || 0, F[r]?.length || 0);
  const cols = [];
  for (let i = 0; i < width; i++) {
    let n = 0, num = 0, date = 0, time = 0, str = 0;
    for (let r = 1; r <= nRows; r++) {
      const u = U[r]?.[i]; if (isBlank(u)) continue;
      n++;
      const f = F[r]?.[i];
      if (typeof u === 'number') {
        if (typeof f === 'string' && DATE_TEXT.test(f)) { date++; if (/\d:\d/.test(f) || u % 1 !== 0) time++; } else num++;
      } else str++;
    }
    const type = !n ? 'string' : date * 2 >= n ? (time ? 'datetime' : 'date') : num > str ? 'number' : 'string';
    cols.push({ id: colId(i), label: header[i] || '', type });
  }
  const cell = (type, u, f) => {
    if (isBlank(u)) return null;
    if (type === 'date' || type === 'datetime') return typeof u === 'number' ? { v: serialToGvizDate(u), f: isBlank(f) ? '' : String(f) } : { v: String(u), f: String(isBlank(f) ? u : f) };
    if (type === 'number') return typeof u === 'number' ? { v: u, f: isBlank(f) ? String(u) : String(f) } : { v: String(u) };
    return { v: typeof u === 'string' ? u : (isBlank(f) ? String(u) : String(f)) };
  };
  const rows = [];
  for (let r = 1; r <= nRows; r++) rows.push({ c: cols.map((col, i) => cell(col.type, U[r]?.[i], F[r]?.[i])) });
  return { cols, rows, parsedNumHeaders: 1 };
}

/**
 * Đọc một tab bằng Google Sheets API (cần access token của service account đã được chia sẻ quyền Xem).
 * @param {string} sheetId
 * @param {{sheet:string}|{gid:string}|string|number} tab
 */
export async function fetchSheetsApiTable(sheetId, tab, { accessToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!sheetId) throw publicError('Chưa cấu hình mã Google Sheet (SHEET_ID_…).', 'CONFIG_SHEET_ID');
  const where = tabLabel(tab);
  const opts = { accessToken, fetchImpl, timeoutMs, where };
  let title = tab && typeof tab === 'object' && tab.sheet != null ? String(tab.sheet) : null;
  if (title == null) {
    const gid = String(tab && typeof tab === 'object' ? tab.gid : tab);
    const meta = await sheetsApiGet(sheetsMetaUrl(sheetId), opts);
    const s = (meta.sheets || []).find(x => String(x?.properties?.sheetId) === gid);
    if (!s) throw publicError(`Không tìm thấy ${where} trong Google Sheet.`, 'SHEET_TAB_NOT_FOUND');
    title = s.properties.title;
  }
  const [unf, fmt] = await Promise.all([
    sheetsApiGet(sheetsValuesUrl(sheetId, title, 'UNFORMATTED_VALUE'), opts),
    sheetsApiGet(sheetsValuesUrl(sheetId, title, 'FORMATTED_VALUE'), opts),
  ]);
  return valuesToTable(unf.values || [], fmt.values || []);
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
 * Tạo hàm fetchTable(tab) cho MỘT Sheet: thử bằng token service account trước (Sheet riêng tư),
 * nếu không được thì thử lại không token (Sheet công khai). Ghi nhớ cách đã thành công cho các tab sau.
 * fetchTable.isPublic(tab) → true (đọc được KHÔNG cần đăng nhập) | false (riêng tư) | null (không rõ):
 *   runSync dùng để chỉ đưa đường dẫn Sheet lên dashboard khi Sheet đã riêng tư, và cảnh báo khi Sheet còn công khai.
 * @param {{sheetId:string, serviceAccount?:{client_email:string, private_key:string}|null, fetchImpl?:typeof fetch, getToken?:Function}} p
 */
export function makeSheetFetcher({ sheetId, serviceAccount = null, fetchImpl = globalThis.fetch, getToken = getSheetsAccessToken, apiState = { disabled: false }, warnings = new Set() } = {}) {
  let mode = null; // 'token' | 'anon'
  let tokenPromise = null;
  const filterRisk = how => `Sheet ${sheetId.slice(0, 6)}…: đang đọc qua gviz (${how}) – nếu Sheet đang bật BỘ LỌC, các dòng bị ẩn sẽ KHÔNG được đồng bộ.`;
  fetchTable.warnings = warnings;
  fetchTable.isPublic = async tab => {
    // Không có service account → máy chủ chỉ đọc được khi Sheet công khai (nếu không, fetchTable sẽ báo lỗi).
    if (!serviceAccount || mode === 'anon') return true;
    try {
      await fetchGvizTable(sheetId, tab, { fetchImpl, tq: 'limit 0', timeoutMs: 10_000 }); // chỉ lấy tiêu đề cột, không token
      return true;
    } catch (e) {
      return e?.code === 'SHEET_NOT_SHARED' ? false : null;
    }
  };
  return fetchTable;
  async function fetchTable(tab) {
    let tokenErr = null;
    if (serviceAccount && mode !== 'anon') {
      try {
        tokenPromise ||= getToken(serviceAccount);
        const accessToken = await tokenPromise;
        // 1) Sheets API – đủ mọi dòng kể cả khi Sheet đang lọc.
        if (!apiState.disabled) {
          try {
            const table = await fetchSheetsApiTable(sheetId, tab, { accessToken, fetchImpl });
            mode = 'token';
            return table;
          } catch (e) {
            if (e?.code !== 'SHEETS_API_DISABLED') throw e;
            apiState.disabled = true;
            warnings.add(`Google Sheets API chưa được bật cho dự án Firebase – đang đọc tạm qua gviz: nếu Sheet đang bật BỘ LỌC, các dòng bị ẩn sẽ KHÔNG được đồng bộ. Bật tại ${sheetsApiEnableUrl(serviceAccount.project_id)} rồi bấm Đồng bộ lại.`);
          }
        }
        // 2) Sheets API chưa bật → gviz bằng token (chỉ thấy các dòng đang hiển thị).
        const table = await fetchGvizTable(sheetId, tab, { accessToken, fetchImpl });
        mode = 'token';
        return table;
      } catch (e) {
        tokenPromise = null;
        // Mã Sheet / tên tab sai: không thử đọc công khai (gviz sẽ lặng lẽ trả về tab đầu tiên).
        if (mode === 'token' || e?.code === 'SHEET_NOT_FOUND' || e?.code === 'SHEET_TAB_NOT_FOUND') throw e;
        tokenErr = e;
      }
    }
    try {
      const table = await fetchGvizTable(sheetId, tab, { fetchImpl });
      mode = 'anon';
      if (serviceAccount) warnings.add(filterRisk('Sheet công khai, service account chưa đọc được'));
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

/**
 * fetchTable(sheetId, tab) cho NHIỀU Sheet (v2: mỗi cấp một Sheet + Sheet phân quyền). Dùng chung một token service account;
 * mỗi Sheet tự nhớ cách đọc đã thành công (token hoặc công khai).
 * fetchTable.isPublic(sheetId, tab) → true | false | null (như makeSheetFetcher).
 * @param {{serviceAccount?:{client_email:string, private_key:string}|null, fetchImpl?:typeof fetch, getToken?:Function}} [p]
 */
export function makeMultiSheetFetcher({ serviceAccount = null, fetchImpl = globalThis.fetch, getToken = getSheetsAccessToken } = {}) {
  let tokenP = null;
  const sharedToken = sa => (tokenP ||= Promise.resolve().then(() => getToken(sa)).catch(e => { tokenP = null; throw e; }));
  const apiState = { disabled: false }; // Sheets API bật/tắt là thiết lập của cả dự án → dùng chung
  const warnings = new Set();
  const bySheet = new Map();
  const of = sheetId => {
    let f = bySheet.get(sheetId);
    if (!f) bySheet.set(sheetId, f = makeSheetFetcher({ sheetId, serviceAccount, fetchImpl, getToken: sharedToken, apiState, warnings }));
    return f;
  };
  const fetchTable = (sheetId, tab) => of(sheetId)(tab);
  fetchTable.isPublic = (sheetId, tab) => of(sheetId).isPublic(tab);
  fetchTable.warnings = warnings; // Set<string> – cảnh báo về cách đọc (Sheets API chưa bật, đọc công khai…)
  return fetchTable;
}
