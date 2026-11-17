// จุดต่อสำหรับบล็อกอื่น (ไม่ต้องแก้ app.ts)
//  - onRequest: รันก่อนทุกคำขอ HTTP ยกเว้น /api/test/* (CONTRACT 0.7: ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ)
//  - onReset:   รันหลัง reset ล้างตาราง ก่อน seed (ล้าง cache/session ในหน่วยความจำ)
import type { Request } from 'express';

type ReqHook = (req: Request) => Promise<void> | void;
type ResetHook = () => Promise<void> | void;

const reqHooks: ReqHook[] = [];
const resetHooks: ResetHook[] = [];

export const onRequest = (fn: ReqHook): void => { reqHooks.push(fn); };
export const onReset = (fn: ResetHook): void => { resetHooks.push(fn); };

export async function runRequestHooks(req: Request): Promise<void> {
  for (const h of reqHooks) {
    try { await h(req); } catch (e) { console.error('[onRequest hook]', e); }
  }
}
export async function runResetHooks(): Promise<void> {
  for (const h of resetHooks) await h();
}
