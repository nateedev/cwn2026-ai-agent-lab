// Test hook ตาม CONTRACT §8 (เปิดเมื่อ TEST_MODE=1 เท่านั้น · app.ts คืน 404 ให้ /api/test/* เมื่อปิด)
// เพิ่ม hook อื่นใน /api/test/* (payments/<ref>/pay, documents/<docNo>/tamper) ที่ไฟล์ route ของบล็อกเจ้าของ
import { Router } from 'express';
import { seed } from '../db/seed.ts';
import { pool } from '../lib/db.ts';
import { DEFAULT_NOW_ISO, now, parseIso, resetClock, setNow, toIso } from '../lib/clock.ts';
import { runResetHooks } from '../lib/hooks.ts';
import { ah, apiError } from '../lib/http.ts';

const router = Router();

let resetChain: Promise<unknown> = Promise.resolve();

/** ล้างทุกตาราง (รวม session/OTP/audit/ไฟล์) แล้ว seed ใหม่ + นาฬิกากลับค่าเริ่มต้น */
export async function resetAll(): Promise<void> {
  const run = async () => {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    if (rows.length) {
      const names = rows.map((r: { tablename: string }) => `"${r.tablename}"`).join(', ');
      await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    }
    resetClock();
    await runResetHooks();
    await seed();
  };
  const p = resetChain.then(run, run);
  resetChain = p.catch(() => {});
  await p;
}

router.post('/api/test/reset', ah(async (_req, res) => {
  await resetAll();
  res.json({ ok: true, now: DEFAULT_NOW_ISO });
}));

router.get('/api/test/clock', (_req, res) => {
  res.json({ now: toIso(now()) });
});

router.put('/api/test/clock', (req, res) => {
  const d = parseIso(req.body?.now);
  if (!d) return apiError(res, 400, 'INVALID_TIME', 'เวลาไม่ถูกต้อง ต้องเป็น ISO 8601 ที่มี offset');
  setNow(d);
  res.json({ now: toIso(now()) });
});

export default router;
