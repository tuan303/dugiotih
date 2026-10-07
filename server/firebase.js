// Khởi tạo firebase-admin một lần (lazy – chỉ khi thật sự cần, KHÔNG khởi tạo lúc import) từ biến môi trường.
//   Cách 1: FIREBASE_SERVICE_ACCOUNT = nội dung file JSON của service account (nguyên văn hoặc base64)
//   Cách 2: FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (xuống dòng viết dạng \n)
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { initializeFirestore, getFirestore } from 'firebase-admin/firestore';
// KHÔNG import 'firebase-admin/auth': nó kéo jwks-rsa → require('jose') (ESM) gây ERR_REQUIRE_ESM trên Vercel.
// ID token được xác minh bằng server/verify-token.js (jose, import ESM).
import { verifyFirebaseIdToken } from './verify-token.js';

const APP_NAME = 'dugiotih-server';
const publicError = (message, code) => Object.assign(new Error(message), { expose: true, code });

const unquote = s => {
  const t = String(s ?? '').trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};
const fixKey = k => unquote(k).replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

function parseServiceAccountJson(raw) {
  const t = unquote(raw);
  if (!t) return null;
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let obj = t.startsWith('{') ? tryParse(t) : null;
  if (!obj) {
    const decoded = Buffer.from(t, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) obj = tryParse(decoded);
  }
  if (!obj || typeof obj !== 'object') {
    throw publicError('FIREBASE_SERVICE_ACCOUNT không phải JSON hợp lệ (dán nguyên nội dung file JSON của service account, hoặc bản mã hóa base64).', 'CONFIG_FIREBASE');
  }
  return obj;
}

/**
 * Đọc thông tin service account từ biến môi trường.
 * @returns {{project_id:string, client_email:string, private_key:string} | null}  null nếu chưa cấu hình
 */
export function getServiceAccount(env = process.env) {
  let sa = null;
  if (env.FIREBASE_SERVICE_ACCOUNT && String(env.FIREBASE_SERVICE_ACCOUNT).trim()) {
    const o = parseServiceAccountJson(env.FIREBASE_SERVICE_ACCOUNT);
    sa = { project_id: o.project_id || o.projectId || '', client_email: o.client_email || o.clientEmail || '', private_key: o.private_key || o.privateKey || '' };
  } else if (env.FIREBASE_CLIENT_EMAIL || env.FIREBASE_PRIVATE_KEY) {
    sa = { project_id: unquote(env.FIREBASE_PROJECT_ID), client_email: unquote(env.FIREBASE_CLIENT_EMAIL), private_key: env.FIREBASE_PRIVATE_KEY || '' };
  } else {
    return null;
  }
  sa.private_key = fixKey(sa.private_key);
  if (!sa.project_id && env.FIREBASE_PROJECT_ID) sa.project_id = unquote(env.FIREBASE_PROJECT_ID);
  const missing = ['project_id', 'client_email', 'private_key'].filter(k => !sa[k]);
  if (missing.length) throw publicError(`Thông tin service account Firebase thiếu: ${missing.join(', ')}.`, 'CONFIG_FIREBASE');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sa.private_key)) {
    throw publicError('Private key của service account không đúng định dạng PEM (“-----BEGIN PRIVATE KEY-----”).', 'CONFIG_FIREBASE');
  }
  return sa;
}

// Chỉ liệt kê TÊN biến cấu hình (không bao giờ giá trị) để chẩn đoán: thiếu biến, sai tên, sai môi trường, chưa Redeploy.
export function configNamesHint(env = process.env) {
  const names = Object.keys(env).filter(k => /firebase|sheet|secret|allowed|access_from|admin|roles/i.test(k)).sort();
  const where = env.VERCEL_ENV ? `môi trường Vercel: ${env.VERCEL_ENV}` : 'không chạy trên Vercel';
  return `${where}; biến cấu hình đang thấy: ${names.length ? names.join(', ') : '(không có)'}`;
}
function missingServiceAccountError(env = process.env) {
  return publicError(`Chưa cấu hình service account Firebase trên Vercel: đặt FIREBASE_SERVICE_ACCOUNT (nội dung file JSON) hoặc FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, rồi Redeploy. (${configNamesHint(env)})`, 'CONFIG_FIREBASE');
}

let app = null, db = null, auth = null;

function getAdminApp() {
  if (app) return app;
  const existing = getApps().find(a => a.name === APP_NAME);
  if (existing) return (app = existing);
  const sa = getServiceAccount();
  if (!sa) {
    throw missingServiceAccountError();
  }
  app = initializeApp({
    credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }),
    projectId: sa.project_id,
  }, APP_NAME);
  return app;
}

/** Firestore (REST – khởi động nhanh trên serverless).
 *  firebase-admin chỉ chuyển tiếp `preferRest`; giá trị undefined khi ghi sẽ gây lỗi (memory-store.js mô phỏng giống vậy). */
export function getDb() {
  if (db) return db;
  const a = getAdminApp();
  try {
    db = initializeFirestore(a, { preferRest: true });
  } catch {
    db = getFirestore(a); // đã được khởi tạo trước đó trên cùng app
  }
  return db;
}

/** Xác minh ID token của người dùng (cùng giao diện verifyIdToken như firebase-admin/auth). */
export function getAdminAuth() {
  if (auth) return auth;
  const sa = getServiceAccount();
  const projectId = sa?.project_id || String(process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!sa || !projectId) {
    throw missingServiceAccountError();
  }
  auth = { verifyIdToken: token => verifyFirebaseIdToken(token, projectId) };
  return auth;
}
