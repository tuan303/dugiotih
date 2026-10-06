// Kiểm thử offline cho server/verify-token.js (xác minh Firebase ID token bằng jose).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { verifyFirebaseIdToken } from '../server/verify-token.js';

const PROJECT = 'dugiotih';
const NOW = 1_791_270_000_000; // ms
const nowS = Math.floor(NOW / 1000);

const { privateKey, publicKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [jwk] });

const baseClaims = () => ({
  email: 'giaovien@hoangmaistarschool.edu.vn',
  firebase: { sign_in_provider: 'microsoft.com', identities: {} },
  auth_time: nowS - 60,
});
async function sign({ claims = baseClaims(), header = { alg: 'RS256', kid: 'k1' }, key = privateKey, iss = `https://securetoken.google.com/${PROJECT}`, aud = PROJECT, sub = 'uid-123', iat = nowS - 30, exp = nowS + 3000 } = {}) {
  let j = new SignJWT(claims).setProtectedHeader(header);
  if (iss) j = j.setIssuer(iss);
  if (aud) j = j.setAudience(aud);
  if (sub !== undefined) j = j.setSubject(sub);
  if (iat !== undefined) j = j.setIssuedAt(iat);
  if (exp !== undefined) j = j.setExpirationTime(exp);
  return j.sign(key);
}
const verify = (t, extra = {}) => verifyFirebaseIdToken(t, PROJECT, { keys, nowMs: NOW, ...extra });

describe('verifyFirebaseIdToken', () => {
  test('token hợp lệ → trả claims kèm uid', async () => {
    const p = await verify(await sign());
    assert.equal(p.uid, 'uid-123');
    assert.equal(p.email, 'giaovien@hoangmaistarschool.edu.vn');
    assert.equal(p.firebase.sign_in_provider, 'microsoft.com');
  });
  test('sai audience (dự án khác) → từ chối', async () => {
    await assert.rejects(verify(await sign({ aud: 'du-an-khac' })));
  });
  test('sai issuer → từ chối', async () => {
    await assert.rejects(verify(await sign({ iss: 'https://securetoken.google.com/du-an-khac' })));
  });
  test('hết hạn → từ chối', async () => {
    await assert.rejects(verify(await sign({ iat: nowS - 7200, exp: nowS - 3600 })));
  });
  test('iat ở tương lai → từ chối', async () => {
    await assert.rejects(verify(await sign({ iat: nowS + 600, exp: nowS + 4000 })));
  });
  test('auth_time ở tương lai → từ chối', async () => {
    await assert.rejects(verify(await sign({ claims: { ...baseClaims(), auth_time: nowS + 600 } })));
  });
  test('thiếu auth_time → từ chối', async () => {
    const { auth_time, ...c } = baseClaims();
    await assert.rejects(verify(await sign({ claims: c })));
  });
  test('sub rỗng → từ chối', async () => {
    await assert.rejects(verify(await sign({ sub: '' })));
  });
  test('ký bằng khóa khác (giả mạo) → từ chối', async () => {
    await assert.rejects(verify(await sign({ key: other.privateKey })));
  });
  test('kid không có trong bộ khóa → từ chối', async () => {
    await assert.rejects(verify(await sign({ header: { alg: 'RS256', kid: 'khong-co' } })));
  });
  test('thuật toán HS256 → từ chối', async () => {
    const secret = new TextEncoder().encode('x'.repeat(32));
    const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`).setAudience(PROJECT).setSubject('u').setIssuedAt(nowS - 10).setExpirationTime(nowS + 100).sign(secret);
    await assert.rejects(verify(t));
  });
  test('chuỗi không phải JWT → từ chối', async () => {
    await assert.rejects(verify('abc.def'), /JWT/);
  });
  test('thiếu projectId → lỗi cấu hình (expose)', async () => {
    await assert.rejects(verifyFirebaseIdToken(await sign(), '', { keys, nowMs: NOW }), e => e.expose === true);
  });
  test('không tải được bộ khóa (mạng) → lỗi máy chủ có thông điệp rõ ràng', async () => {
    const failingKeys = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(verify(await sign(), { keys: failingKeys }), e => e.expose === true && e.code === 'JWKS_UNAVAILABLE');
  });
});
