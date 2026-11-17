import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** ห่อ handler async ให้ error ไปถึง error middleware (Express 4) */
export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** ข้อผิดพลาด API รูปแบบ CONTRACT: {"code","message"} */
export function apiError(res: Response, status: number, code: string, message = code, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ code, message, ...extra });
}
