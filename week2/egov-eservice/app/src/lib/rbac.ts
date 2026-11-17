// RBAC + session (B03) · CONTRACT §1 (route/บทบาท) §5 (UNAUTHENTICATED/FORBIDDEN)
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { one, query } from './db.ts';
import { now, toIso } from './clock.ts';
import { newToken } from './crypto.ts';

export type Role = Express.SessionUser['role'];
export const SESSION_COOKIE = 'sid';

export const ROLE_LANDING: Record<Role, string> = {
  citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals',
  executive: '/dashboard', auditor: '/audit', admin: '/admin/services',
};
export const landingFor = (role: Role): string => ROLE_LANDING[role];

declare global {
  namespace Express {
    interface Request { pendingRegister?: { citizenId: number; name: string; token: string } }
  }
}

export async function createSession(kind: 'citizen' | 'staff' | 'pending-register',
  fields: { citizenId?: number; username?: string; data?: Record<string, unknown> }): Promise<string> {
  const token = newToken();
  await query(
    `INSERT INTO sessions(token,kind,citizen_id,username,data,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [token, kind, fields.citizenId ?? null, fields.username ?? null, JSON.stringify(fields.data ?? {}), toIso(now())]);
  return token;
}
export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

/** แนบ req.user / res.locals.user จาก cookie session (ทำงานก่อน route อื่นทั้งหมด) */
export const sessionMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const token = typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] as string : '';
    if (token) {
      const s = await one<{ kind: string; citizen_id: number | null; username: string | null; data: any }>(
        `SELECT kind, citizen_id, username, data FROM sessions WHERE token = $1`, [token]);
      if (s?.kind === 'staff' && s.username) {
        req.user = { username: s.username, name: s.data.name, role: s.data.role, dept: s.data.dept ?? '' };
      } else if (s?.kind === 'citizen' && s.citizen_id != null) {
        const c = await one<{ name: string; registered: boolean }>(`SELECT name, registered FROM citizens WHERE id = $1`, [s.citizen_id]);
        if (c?.registered) req.user = { username: `citizen-${s.citizen_id}`, name: c.name, role: 'citizen', dept: '', citizenId: s.citizen_id };
        else if (c) req.pendingRegister = { citizenId: s.citizen_id, name: c.name, token };
      } else if (s?.kind === 'pending-register' && s.citizen_id != null) {
        const c = await one<{ name: string; registered: boolean }>(`SELECT name, registered FROM citizens WHERE id = $1`, [s.citizen_id]);
        if (c && !c.registered) req.pendingRegister = { citizenId: s.citizen_id, name: c.name, token };
      }
    }
    if (req.user) res.locals.user = req.user;
    next();
  } catch (e) { next(e); }
};

const isApi = (req: Request) => (req.originalUrl ?? req.path).startsWith('/api/'); // B13: originalUrl เพราะ router.use(path) ตัด prefix ออกจาก req.path

/** ต้องล็อกอิน: หน้า → redirect (/login หรือ /register ถ้ายังไม่ลงทะเบียน) · API → 401 */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.user) return next();
  if (isApi(req)) return void res.status(401).json({ code: 'UNAUTHENTICATED', message: 'กรุณาเข้าสู่ระบบ' });
  res.redirect(req.pendingRegister ? '/register' : '/login');
};

/** จำกัดบทบาท: หน้า → 403 forbidden-msg · API → 403 FORBIDDEN */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (roles.includes(req.user!.role)) return next();
      if (isApi(req)) return void res.status(403).json({ code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์ทำรายการนี้' });
      void res.forbidden();
    });
  };
}
export const requireCitizen = requireRole('citizen');
export const requireOfficer = requireRole('officer', 'head');
export const requireHead = requireRole('head');
export const requireExecutive = requireRole('executive');
export const requireAuditor = requireRole('auditor');
export const requireAdmin = requireRole('admin');
