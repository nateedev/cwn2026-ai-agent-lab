// จุดเริ่มต้นของเว็บ e-Service กลาง · บล็อกอื่นห้ามแก้ไฟล์นี้: เพิ่มไฟล์ใน src/routes/*.ts ที่ `export default` Router (หรือ `export const router`)
// ไฟล์ที่ขึ้นต้นด้วย `_` ถูกข้าม · โหลดเรียงชื่อ (test.ts ก่อนเสมอ) · Router ต้องระบุ path เต็มเอง (mount ที่ "/")
// จุดต่อ: src/lib/hooks.ts (onRequest / onReset) · ผู้ใช้ปัจจุบัน: ตั้ง req.user + res.locals.user ใน middleware ของ B03
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { seed } from './db/seed.ts';
import { isTestMode } from './lib/clock.ts';
import { activeBugs } from './lib/bugmode.ts';
import { one, pool } from './lib/db.ts';
import { runRequestHooks } from './lib/hooks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export async function initDb(): Promise<void> {
  for (let i = 0; ; i++) {
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (i >= 60) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.query(await readFile(path.join(here, 'db', 'schema.sql'), 'utf8'));
  const empty = await one(`SELECT 1 AS x FROM services LIMIT 1`);
  if (!empty) await seed();
}

const rank = (f: string) => (f === 'test.ts' ? 0 : f === 'auth.ts' ? 1 : 2);
async function loadRouters(app: express.Express): Promise<string[]> {
  const dir = path.join(here, 'routes');
  const files = (await readdir(dir))
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('_'))
    // B13: test.ts ก่อนเสมอ แล้ว auth.ts (session middleware ต้องมาก่อน audit-admin.ts ที่เรียงชื่อมาก่อน)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const r: Router | undefined = mod.default ?? mod.router;
    if (typeof r !== 'function') { console.warn(`[routes] ${f}: ไม่มี default/router export ข้าม`); continue; }
    app.use(r);
  }
  return files;
}

export async function createApp(): Promise<express.Express> {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));

  // CONTRACT 0.7: ทุกคำขอยกเว้น /api/test/* ประเมิน SLA/ยกเลิกอัตโนมัติ (บล็อก SLA ลงทะเบียนผ่าน onRequest)
  //   วางก่อนตัวอ่าน body · static · /api/health: คำขอที่อ่าน body ไม่ได้ (เช่น JSON ผิดรูปแบบ → 400) ก็ผ่าน hook ด้วย
  app.use(async (req, _res, next) => {
    if (req.path.startsWith('/api/test/')) return next();
    await runRequestHooks(req);
    next();
  });

  // CONTRACT 0.10: รับ body ≥ 6 MB (ไฟล์ multipart ให้ multer ของบล็อกนั้นจัดการเอง)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(root, 'public')));

  // CONTRACT 6.6 (ไม่ขึ้นกับ TEST_MODE / ไม่ต้องล็อกอิน)
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });

  // CONTRACT 0.8: ไม่ตั้ง TEST_MODE=1 → /api/test/* = 404
  app.use('/api/test', (_req, res, next) => {
    if (!isTestMode()) return res.status(404).json({ code: 'NOT_FOUND', message: 'ไม่พบ' });
    next();
  });

  // helper เรนเดอร์หน้า: res.page('view', {title, ...locals}) ห่อด้วย views/layout.ejs
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.page = async (view, locals = {}) => {
      try {
        const user = (res.locals.user ?? req.user) as Express.SessionUser | undefined;
        let bellCount = res.locals.bellCount as number | undefined;
        if (user && (user.role === 'officer' || user.role === 'head') && bellCount === undefined) {
          const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE username = $1`, [user.username]);
          bellCount = r?.n ?? 0;
        }
        const data = { title: 'e-Service เทศบาลนครตัวอย่าง', success: null, error: null, ...res.locals, user: user ?? null, bellCount: bellCount ?? 0, ...locals };
        const body = await new Promise<string>((ok, bad) => res.render(view, data, (e, html) => (e ? bad(e) : ok(html))));
        res.render('layout', { ...data, body }, (e, html) => (e ? next(e) : res.send(html)));
      } catch (e) { next(e); }
    };
    res.forbidden = () => { res.status(403); return res.page('forbidden', { title: 'ไม่มีสิทธิ์เข้าถึง' }); };
    res.notFoundCase = () => { res.status(404); return res.page('not-found', { title: 'ไม่พบคำขอ' }); };
    next();
  });

  const loaded = await loadRouters(app);
  console.log(`[routes] loaded: ${loaded.join(', ')}`);

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ code: 'NOT_FOUND', message: 'ไม่พบ' });
    res.status(404).type('html').send('<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ไม่พบหน้า</title></head><body><main><h1>ไม่พบหน้า</h1></main></body></html>');
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err?.status ?? err?.statusCode ?? 500;
    if (status >= 500) console.error(err);
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ code: status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR', message: status >= 500 ? 'เกิดข้อผิดพลาดภายในระบบ' : String(err?.message ?? 'bad request') });
    }
    res.status(status).type('html').send('<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ข้อผิดพลาด</title></head><body><main><h1>เกิดข้อผิดพลาด</h1></main></body></html>');
  });

  return app;
}

async function main() {
  await initDb();
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`e-Service listening on :${port} TEST_MODE=${isTestMode() ? 1 : 0} BUG_MODE=${activeBugs().join(',') || '-'}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
