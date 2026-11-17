# test-report · ผลรัน TEST-PLAN (ขั้น 4)

| ไฟล์ | เนื้อหา |
|---|---|
| `results.json` | ผล Playwright (JSON reporter) · TEST_MODE=1 ไม่ตั้ง BUG_MODE · ผ่าน 51/51 (รัน 2026-11-19 12:11–12:16 · โค้ดฉบับที่ย้าย SLA hook ไปก่อนตัวอ่าน body) |
| `index.html` | Playwright HTML report (รอบเดียวกับ `results.json` · 51 expected / 0 unexpected) |
| `gif/<TC>.gif` | GIF ของ TC ระดับ P1 · **43/43** (รายชื่อใน `app/scripts/p1-list.txt`) |

## ที่มาของ GIF

- **40 ไฟล์ (จากวิดีโอ):** แปลงจากวิดีโอที่ Playwright อัดหน้าเว็บระหว่างรันชุดเต็ม 2026-11-19 12:11–12:16 (`VIDEO=1` ใน `scripts/test-report.sh`)
- **3 ไฟล์ (จาก trace) ([TC-PAY-02](gif/TC-PAY-02.gif) · [TC-PAY-03](gif/TC-PAY-03.gif) · [TC-PDPA-02](gif/TC-PDPA-02.gif)):** test เรียก API อย่างเดียว ไม่เปิดหน้าเว็บ จึงไม่มีวิดีโอ
  - รัน 3 TC นี้กับเว็บจริงด้วย `npx playwright test -g "TC-PAY-02|TC-PAY-03|TC-PDPA-02" --trace on` (ผ่าน 3/3 · รัน 2026-11-19 12:16 กับโค้ดฉบับเดียวกัน) โดยไม่แก้ test หรือ config
  - เปิด `trace.zip` ที่ได้ใน Playwright Trace Viewer แล้วอัดหน้าจอขณะไล่ดูทีละ action และแท็บ Network (request/response ของ API ที่ test เรียกจริง)
  - แปลงเป็น GIF ด้วยค่า ffmpeg เดียวกับ `scripts/test-report.sh` · ไม่มีภาพที่สร้างขึ้นเอง

## รันซ้ำ

```bash
cd app
scripts/test-report.sh      # TEST_MODE=1 · อัดวิดีโอ · สร้าง test-report/ (ต้องมี ffmpeg สำหรับ GIF)
```
