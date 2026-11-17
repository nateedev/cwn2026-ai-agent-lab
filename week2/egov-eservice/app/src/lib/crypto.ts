import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const dataKey = () => createHash('sha256').update(process.env.DATA_KEY ?? 'egov-test-data-key-do-not-use-in-prod').digest();
const signKey = () => process.env.SIGN_KEY ?? 'egov-test-sign-key-do-not-use-in-prod';

/** AES-256-GCM → base64(iv|tag|ciphertext) · ใช้กับเลขบัตรและเบอร์ (NFR-04) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', dataKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
/** ดัชนีค้นหา (HMAC) ไม่ย้อนกลับเป็นเลขบัตร */
export function blindIndex(value: string): string {
  return createHmac('sha256', dataKey()).update(value).digest('hex');
}
/** ลายเซ็นจำลอง HMAC-SHA256 (A-22) */
export function hmacSign(message: string): string {
  return createHmac('sha256', signKey()).update(message).digest('hex');
}
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const e = Buffer.from(hashHex, 'hex');
  return h.length === e.length && timingSafeEqual(h, e);
}
export const newToken = (): string => randomBytes(24).toString('hex');
