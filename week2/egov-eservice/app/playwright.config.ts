// B13 · Playwright config รวม part1 (B11) + part2 (B12)
// ทุก TC เรียก POST /api/test/reset บนเซิร์ฟเวอร์เดียวกัน → ต้องรันทีละตัว (workers 1, ไม่ parallel)
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    trace: 'retain-on-failure',
    // VIDEO=1 → อัดวิดีโอทุก TC (ใช้ทำ GIF ของ TC ระดับ P1 ใน test-report/)
    video: process.env.VIDEO === '1' ? 'on' : 'off',
  },
});
