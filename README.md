# CWN2026 · AI Agent Lab

งานส่งของรายวิชา CWN2026 แยกโฟลเดอร์ตามสัปดาห์

| สัปดาห์ | งาน | โฟลเดอร์ |
|---|---|---|
| Week 2 | e-Service กลางของ "เทศบาลนครตัวอย่าง" ด้วยทีมเอเจนต์ (dag-planner + agent-team + Playwright) | [`week2/egov-eservice/`](week2/egov-eservice/) |

## Week 2 · egov-eservice

### สรุปผล

| ขั้น | ผล |
|---|---|
| 1–2 วางแผน + ตรวจแผน | 13 บล็อก · ตรวจตามขั้น 2 แล้วแก้ `blocks.json` (route โหลดอัตโนมัติ · เพิ่ม FR-29/FR-24 · B13 difficulty 3) |
| 3 รันแผนจริง | 12/13 บล็อกผ่าน (บัญชี yolo1 · yolo2 · ผู้ตรวจ review cyolo1) · B05 timeout รอบแรก → เพิ่ม timeout แล้ว resume ผ่าน · B13 timeout ที่ 3,600 วินาที · งานทดสอบ 51 TC และ BUG_MODE ทำต่อในขั้น 4–5 (รายละเอียดใน `REPORT.md`) |
| 4 TEST-PLAN | **ผ่าน 51/51** (รันใหม่ 2026-11-19) · GIF 43/43 TC ระดับ P1 (40 จากวิดีโอหน้าเว็บ · 3 TC ที่เป็น API ล้วนทำจาก Playwright trace ของการรันจริง ดู `test-report/README.md`) · แก้เว็บ: `TEST_MODE` ไม่ตั้ง = ปิด test hook · PDF มี QR ไป `/verify/<รหัส>` · SLA hook ครอบ static, `/api/health` และคำขอที่อ่าน body ไม่ได้ (ย้ายไปก่อนตัวอ่าน body) |
| 5 BUG_MODE | **จับได้ 12/12** (รันใหม่ครบ 17 รอบ 2026-11-18) · ทำครบ BUGS.md §3 ทั้ง 6 ข้อ (รันซ้ำไม่ restart 51/51 ×2 · ปิดบั๊กแล้ว 51/51 · รวม `B03,B07` และ `B01,B05,B09` = union) · แก้เว็บ 1 จุด: B07 รั่วไปถึง "ไม่อนุมัติ" · คำถามถึง TA 1 ข้อ (B03 → TC-NOTI-02) ดู `BUG-HUNT.md` |

### ไฟล์

| ไฟล์ | ขั้น |
|---|---|
| `blocks.json` · `dag.png` · `gantt-plan.png` · `PLAN.md` | 1 วางแผน DAG + Gantt |
| `gantt-actual.png` · `compare.png` · `REPORT.md` | 3 รันแผนจริง |
| `app/` | เว็บ + ชุด Playwright (`app/test-runs/` = ผลดิบทุกรอบของขั้น 5) |
| `test-report/` | 4 ผลรัน TEST-PLAN 51 TC (`results.json` · `index.html` · `gif/`) |
| `BUG-HUNT.md` | 5 พิสูจน์ BUG_MODE B01–B12 |

### วิธีรันเว็บ

ต้องมี Docker (ไม่ต้องสร้างไฟล์ `.env` ทุกค่ามีค่าเริ่มต้นสำหรับทดสอบ)

```bash
cd week2/egov-eservice/app
TEST_MODE=1 docker compose up -d --build              # เว็บถูกต้อง http://localhost:3000
TEST_MODE=1 BUG_MODE=B03 docker compose up -d --build # เปิดบั๊กตามรหัส
```

### วิธีรัน Playwright

ต้องมี Node 22 และเปิดเว็บด้วย `TEST_MODE=1` ไว้ก่อน

```bash
cd week2/egov-eservice/app
npm ci
npx playwright install chromium
scripts/run-bugmode.sh "" B01 B02   # "" = เว็บถูกต้อง · ผลอยู่ที่ test-runs/
```

> หน่วยงานในงานนี้เป็นของสมมติ ThaiD / PromptPay / ลายเซ็นดิจิทัลเป็นตัวจำลองทั้งหมด
