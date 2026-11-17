# NOTES-B01 · สัญญาโครงโปรเจกต์ (สำหรับบล็อกอื่น)
- รัน: `docker compose up -d --build` (ไม่ตั้ง TEST_MODE = ปิด test hook · `TEST_MODE=1` = เปิด · `BUG_MODE=B03,B07`) · พอร์ต 3000 (`WEB_PORT`) · DB = PostgreSQL 16 (tmpfs, ฐานว่างจะ seed ตอนบูต)
- Route: สร้าง `src/routes/<ชื่อ>.ts` แล้ว `export default Router()` ระบุ path เต็มเอง · ห้ามแก้ app.ts / schema.sql
- เวลา: `import { now, toIso, fmtThai, fmtBaht, bkkDateTime } from '../lib/clock.ts'` ห้าม `new Date()`/`Date.now()` ในกฎธุรกิจ · `isBug('B03')` จาก `lib/bugmode.ts`
- DB: `lib/db.ts` (`query/one/tx/nextNumber`) · เข้ารหัส/แฮช: `lib/crypto.ts` · `lib/http.ts` (`ah`, `apiError`)
- Hook: `lib/hooks.ts` → `onRequest(fn)` (SLA/auto-cancel ทุกคำขอ ยกเว้น /api/test/*), `onReset(fn)` (ล้าง state ในหน่วยความจำ ก่อน seed)
- หน้า: `res.page('view', {title})` ห่อ views/layout.ejs (ต้องตั้ง `res.locals.user`/`req.user` = {username,name,role,dept}) · `res.forbidden()` · `res.notFoundCase()` · เมนู/`user-name`/`user-role`/`logout-btn`/`bell-count` อยู่ใน layout แล้ว · layout เรียก `POST /api/auth/logout` (B03)
- Reset (`routes/test.ts`): TRUNCATE ทุกตารางใน public → นาฬิกา default → onReset hooks → `seed()` จาก `src/db/seed.ts` (stub; B02 เขียนทับ) · seed ต้องตั้ง counters: case=30 receipt=30 doc=1 draft=2 payment=1
- ยังไม่ทำ (บล็อกเจ้าของ): `/api/test/payments/<ref>/pay`, `/api/test/documents/<docNo>/tamper` — เพิ่มใน route ของบล็อกนั้น (guard TEST_MODE ทำที่ app.ts แล้ว)
- เวลาจริง: ไม่ตั้ง TEST_MODE นาฬิกา = เวลาเครื่อง · `DB_PATH` ไม่ใช้ (PostgreSQL) → TC-NFR-04 ตรวจผ่าน psql/pg_dump
