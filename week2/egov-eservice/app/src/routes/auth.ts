// B03 · ล็อกอิน ThaiD จำลอง + สมัคร + SSO เจ้าหน้าที่ + RBAC (CONTRACT §2.2 §2.3 §5 §6.1)
import { Router } from 'express';
import { blindIndex, decrypt, encrypt, verifyPassword } from '../lib/crypto.ts';
import { one, query, tx } from '../lib/db.ts';
import { fmtThai, now, toIso } from '../lib/clock.ts';
import { ah, apiError } from '../lib/http.ts';
import {
  SESSION_COOKIE, createSession, destroySession, landingFor, requireAuth, sessionMiddleware,
} from '../lib/rbac.ts';
import { audit } from './audit-admin.ts';

const router = Router();
router.use(sessionMiddleware); // auth.ts โหลดก่อน route อื่น (เรียงชื่อ) → req.user พร้อมให้ทุกบล็อก

const TEST_OTP = '123456';
const MAX_FAIL = 3;
const LOCK_MS = 15 * 60 * 1000;
const MSG = {
  invalidId: 'เลขบัตรประชาชนไม่ถูกต้อง',
  otp: 'รหัส OTP ไม่ถูกต้อง',
  locked: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  cred: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  mobile: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  consent: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
};

/** BR-01: 13 หลักตัวเลข + checksum */
export function validCitizenId(id: unknown): id is string {
  if (typeof id !== 'string' || !/^[0-9]{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}
const maskId = (id: string) => `X-XXXX-XXXXX-${id.slice(10, 12)}-${id[12]}`;
const fullId = (id: string) => `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}`;
void fullId; void decrypt;

function setCookie(res: import('express').Response, token: string) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/' });
}
const lockedBody = (until: Date) => ({ code: 'LOCKED', message: MSG.locked, lockedUntil: toIso(until), lockedUntilText: fmtThai(until) });

/** อ่านสถานะล็อกของเลขบัตร (ปลดล็อกเมื่อ now ≥ lockedUntil แล้วเริ่มนับ 0) */
async function activeLock(hash: string): Promise<Date | null> {
  const s = await one<{ locked_until: Date | null }>(`SELECT locked_until FROM otp_state WHERE id_hash = $1`, [hash]);
  if (s?.locked_until && s.locked_until.getTime() > now().getTime()) return s.locked_until;
  return null;
}

router.post('/api/auth/thaid/start', ah(async (req, res) => {
  const idNo = req.body?.idNo;
  if (!validCitizenId(idNo)) return apiError(res, 400, 'INVALID_ID', MSG.invalidId);
  const until = await activeLock(blindIndex(idNo));
  if (until) return res.status(423).json(lockedBody(until));
  res.json({ status: 'OTP_SENT' });
}));

router.post('/api/auth/thaid/verify', ah(async (req, res) => {
  const idNo = req.body?.idNo;
  const otp = req.body?.otp;
  if (!validCitizenId(idNo)) return apiError(res, 400, 'INVALID_ID', MSG.invalidId);
  const hash = blindIndex(idNo);

  // ตัวนับ/ล็อกต่อเลขบัตร ใน transaction เดียว (กัน race)
  const result = await tx(async (c) => {
    await c.query(`INSERT INTO otp_state(id_hash) VALUES ($1) ON CONFLICT DO NOTHING`, [hash]);
    const { rows } = await c.query(`SELECT fail_count, locked_until FROM otp_state WHERE id_hash = $1 FOR UPDATE`, [hash]);
    let fail = rows[0].fail_count as number;
    const lockedUntil = rows[0].locked_until as Date | null;
    const t = now();
    if (lockedUntil && lockedUntil.getTime() > t.getTime()) return { kind: 'locked' as const, until: lockedUntil };
    if (lockedUntil) { fail = 0; await c.query(`UPDATE otp_state SET fail_count = 0, locked_until = NULL WHERE id_hash = $1`, [hash]); }
    if (typeof otp === 'string' && otp === TEST_OTP) {
      await c.query(`UPDATE otp_state SET fail_count = 0, locked_until = NULL WHERE id_hash = $1`, [hash]);
      return { kind: 'ok' as const };
    }
    fail += 1;
    if (fail >= MAX_FAIL) {
      const until = new Date(t.getTime() + LOCK_MS);
      await c.query(`UPDATE otp_state SET fail_count = $2, locked_until = $3, last_fail_at = $4 WHERE id_hash = $1`, [hash, fail, toIso(until), toIso(t)]);
      return { kind: 'locked' as const, until };
    }
    await c.query(`UPDATE otp_state SET fail_count = $2, last_fail_at = $3 WHERE id_hash = $1`, [hash, fail, toIso(t)]);
    return { kind: 'wrong' as const, left: MAX_FAIL - fail };
  });

  if (result.kind === 'locked') return res.status(423).json(lockedBody(result.until));
  if (result.kind === 'wrong') return apiError(res, 401, 'OTP_INVALID', MSG.otp, { attemptsLeft: result.left });

  // OTP ถูก: หา/สร้างประชาชน (ThaiD จำลองคืนชื่อจาก seed; เลขใหม่ที่ checksum ผ่านสร้างเป็นยังไม่ลงทะเบียน)
  let cit = await one<{ id: number; registered: boolean }>(`SELECT id, registered FROM citizens WHERE id_hash = $1`, [hash]);
  if (!cit) {
    cit = await one(
      `INSERT INTO citizens(id_hash,id_enc,id_masked,name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id_hash) DO UPDATE SET id_hash = EXCLUDED.id_hash RETURNING id, registered`,
      [hash, encrypt(idNo), maskId(idNo), 'ผู้ใช้ ThaiD']);
  }
  const old = req.cookies?.[SESSION_COOKIE];
  await destroySession(typeof old === 'string' ? old : undefined);
  const token = await createSession(cit!.registered ? 'citizen' : 'pending-register', { citizenId: cit!.id });
  setCookie(res, token);
  res.json(cit!.registered ? { registered: true, landing: '/citizen' } : { registered: false, landing: '/register' });
}));

router.post('/api/auth/register', ah(async (req, res) => {
  const p = req.pendingRegister;
  if (!p) {
    if (req.user) return apiError(res, 409, 'ALREADY_REGISTERED', 'ลงทะเบียนแล้ว');
    return apiError(res, 401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
  }
  const mobile = req.body?.mobile;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (typeof mobile !== 'string' || !/^0[0-9]{9}$/.test(mobile)) return apiError(res, 400, 'INVALID_MOBILE', MSG.mobile);
  if (req.body?.consent !== true) return apiError(res, 400, 'CONSENT_REQUIRED', MSG.consent);
  await query(`UPDATE citizens SET mobile_enc = $2, email = $3, registered = true, consent = true WHERE id = $1`,
    [p.citizenId, encrypt(mobile), email]);
  await destroySession(p.token);
  setCookie(res, await createSession('citizen', { citizenId: p.citizenId }));
  res.status(201).json({ registered: true, landing: '/citizen' });
}));

router.post('/api/auth/staff/login', ah(async (req, res) => {
  const { username, password } = req.body ?? {};
  const u = typeof username === 'string' && typeof password === 'string'
    ? await one<{ username: string; password_hash: string; display_name: string; role: string; dept: string }>(
        `SELECT username, password_hash, display_name, role, dept FROM staff_users WHERE username = $1`, [username])
    : null;
  const ok = u ? verifyPassword(password, u.password_hash) : false;
  if (!u || !ok) return apiError(res, 401, 'INVALID_CREDENTIALS', MSG.cred);
  const old = req.cookies?.[SESSION_COOKIE];
  await destroySession(typeof old === 'string' ? old : undefined);
  const token = await createSession('staff', { username: u.username, data: { name: u.display_name, role: u.role, dept: u.dept } });
  setCookie(res, token);
  const role = u.role as Express.SessionUser['role'];
  await audit({ username: u.username, role: u.role, event: 'STAFF_LOGIN' }); // B13: FR-23 ล็อกอินเจ้าหน้าที่ต้องลง Audit
  res.json({ role, dept: u.dept, landing: landingFor(role) });
}));

router.post('/api/auth/logout', ah(async (req, res) => {
  const t = req.cookies?.[SESSION_COOKIE];
  await destroySession(typeof t === 'string' ? t : undefined);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(204).end();
}));

router.get('/api/me', requireAuth, (req, res) => {
  const u = req.user!;
  res.json({ username: u.username, name: u.name, role: u.role, dept: u.dept ?? '' });
});

// method อื่นบน /api/auth/* → 405
router.all('/api/auth/*', (_req, res) => apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed'));

// ---------- หน้า ----------
router.get('/', (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user.role));
  res.redirect(req.pendingRegister ? '/register' : '/login');
});

router.get('/login', ah(async (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user.role));
  await res.page('login', { title: 'เข้าสู่ระบบ' });
}));

router.get('/register', ah(async (req, res) => {
  if (!req.pendingRegister) return res.redirect(req.user ? landingFor(req.user.role) : '/login');
  await res.page('register', { title: 'ลงทะเบียน', regName: req.pendingRegister.name });
}));

export default router;
