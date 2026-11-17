// Playwright ชุด 1 (B11): TC-AUTH · FEE · SUBMIT · UPLOAD · PAY · QUEUE · SLA (19 TC)
// เขียนจาก TEST-PLAN / CONTRACT / TEST-DATA เท่านั้น (ไม่อ่านโค้ดเว็บ)
// ไฟล์นี้ self-contained: ใช้ BASE_URL จาก env และสร้าง context เองทุกครั้ง (ไม่พึ่ง baseURL ใน config)
// ทุก TC เริ่มด้วย RESET แล้วล็อกอินใหม่ (CONTRACT 0.9) · เซิร์ฟเวอร์ใช้ร่วมกัน จึงรัน serial (ควรตั้ง workers: 1)
import * as zlib from 'zlib';
import { test, expect, request, Browser, BrowserContext, Page, APIRequestContext, APIResponse } from '@playwright/test';

const BASE = process.env.BASE_URL ?? process.env.BASE ?? 'http://localhost:3000';
const PW = 'Test@1234';
const OTP = '123456';

const ID = {
  somchai: '1101700123456',
  somying: '3100600987659',
  mana: '5500400111221',
  piti: '1909900555015',
};

const T0 = '2026-12-01T09:00:00+07:00';

// B13: ไม่ใช้ serial mode — TC แต่ละตัว reset เอง และ workers=1 รักษาลำดับอยู่แล้ว (serial ทำให้ TC ถัดไปไม่รันเมื่อเปิด BUG_MODE)
test.setTimeout(180_000);

// ───────────────────────── helpers ─────────────────────────
const apiCtxs: APIRequestContext[] = [];
const bctxs: BrowserContext[] = [];

test.afterEach(async () => {
  for (const c of apiCtxs.splice(0)) await c.dispose().catch(() => {});
  for (const c of bctxs.splice(0)) await c.close().catch(() => {});
});

async function newApi(): Promise<APIRequestContext> {
  const c = await request.newContext({ baseURL: BASE });
  apiCtxs.push(c);
  return c;
}
async function newPage(browser: Browser): Promise<Page> {
  const c = await browser.newContext({ baseURL: BASE,
    // VIDEO=1 → อัดวิดีโอไว้ทำ GIF ใน test-report/ (ไม่กระทบผลที่คาดหวัง)
    ...(process.env.VIDEO === '1' ? { recordVideo: { dir: test.info().outputDir } } : {}) });
  bctxs.push(c);
  return c.newPage();
}

/** RESET: คืน 200 และ now = 2026-12-01T09:00:00+07:00 */
async function reset(): Promise<APIRequestContext> {
  const a = await newApi();
  const r = await a.post('/api/test/reset');
  expect(r.status()).toBe(200);
  expect((await r.json()).now).toBe(T0);
  return a;
}
async function clock(a: APIRequestContext, iso: string) {
  const r = await a.put('/api/test/clock', { data: { now: iso } });
  expect(r.status()).toBe(200);
}
/** LOGIN_C ผ่าน API (ctx ใหม่) */
async function loginC(idNo: string, otp = OTP): Promise<APIRequestContext> {
  const a = await newApi();
  const s = await a.post('/api/auth/thaid/start', { data: { idNo } });
  expect(s.status()).toBe(200);
  const v = await a.post('/api/auth/thaid/verify', { data: { idNo, otp } });
  expect(v.status()).toBe(200);
  return a;
}
/** LOGIN_S ผ่าน API (ctx ใหม่) */
async function loginS(username: string): Promise<APIRequestContext> {
  const a = await newApi();
  const r = await a.post('/api/auth/staff/login', { data: { username, password: PW } });
  expect(r.status()).toBe(200);
  return a;
}
/** LOGIN_C ผ่านหน้า /login */
async function uiLoginC(page: Page, idNo: string) {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click().catch(() => {});
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill(OTP);
  await page.getByTestId('otp-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
/** LOGIN_S ผ่านแท็บเจ้าหน้าที่ */
async function uiLoginS(page: Page, username: string) {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(PW);
  await page.getByTestId('staff-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

// ไฟล์ทดสอบ (พอร์ตจาก make_testfiles.py ใน TEST-DATA ข้อ 11)
function pdf(n = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}
function jpg(n = 1024): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), len, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(n = 1024): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // zlib stream ของ 00 ff 00 00 (สร้างด้วย zlib ของ node)
  const idat = zlib.deflateSync(Buffer.from([0, 0xff, 0, 0]));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const base = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat)]);
  const iend = chunk('IEND', Buffer.alloc(0));
  const pad = n - base.length - iend.length - 12;
  return Buffer.concat([base, chunk('tEXt', Buffer.concat([Buffer.from('k\0', 'latin1'), Buffer.alloc(pad - 2, 0x78)])), iend]);
}
type F = { name: string; mimeType: string; buffer: Buffer };
const fPdf = (name: string, n = 1024): F => ({ name, mimeType: 'application/pdf', buffer: pdf(n) });
const fJpg = (name: string): F => ({ name, mimeType: 'image/jpeg', buffer: jpg() });
const fPng = (name: string): F => ({ name, mimeType: 'image/png', buffer: png() });
const fText = (name: string, mimeType = 'text/plain'): F => ({ name, mimeType, buffer: Buffer.from('hello') });
const fExe = (name: string): F => ({ name, mimeType: 'image/png', buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]) });

async function putFile(a: APIRequestContext, draftId: string, f: F, docKey: string): Promise<APIResponse> {
  return a.post(`/api/drafts/${draftId}/files`, { multipart: { file: f, docKey } });
}
type Svc = 'SV-01' | 'SV-02' | 'SV-03';
async function mkDraft(a: APIRequestContext, serviceId: Svc, opt: { qty?: number; areaSqm?: number } = {}) {
  const r = await a.post('/api/drafts', { data: { serviceId, ...opt } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { draftId: string; fee: number };
}
async function attachRequired(a: APIRequestContext, draftId: string, serviceId: Svc) {
  const docs: Record<Svc, string[]> = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };
  for (const k of docs[serviceId]) {
    const r = await putFile(a, draftId, fPdf(`${k}.pdf`), k);
    expect(r.status()).toBe(201);
  }
}
/** สร้างร่าง + ไฟล์บังคับ + QR (ยังไม่ชำระ) */
async function draftWithQr(a: APIRequestContext, serviceId: Svc, opt: { qty?: number; areaSqm?: number } = {}) {
  const d = await mkDraft(a, serviceId, opt);
  await attachRequired(a, d.draftId, serviceId);
  const p = await a.post(`/api/drafts/${d.draftId}/payment`);
  expect(p.status()).toBe(201);
  const pj = await p.json();
  return { draftId: d.draftId, fee: d.fee, ref: pj.ref as string, qrExpiresAt: pj.qrExpiresAt as string };
}
async function pay(a: APIRequestContext, ref: string, amount: number) {
  return a.post(`/api/test/payments/${ref}/pay`, { data: { amount } });
}
/** NEW_PAID: CLOCK → LOGIN_C → draft → files → payment → pay → caseNo (คืน ctx ผู้ยื่นที่ล็อกอินแล้ว) */
async function newPaid(
  anyCtx: APIRequestContext,
  o: { idNo?: string; service: Svc; at: string; qty?: number; areaSqm?: number },
) {
  await clock(anyCtx, o.at);
  const a = await loginC(o.idNo ?? ID.somchai);
  const q = await draftWithQr(a, o.service, { qty: o.qty, areaSqm: o.areaSqm });
  const r = await pay(a, q.ref, q.fee);
  expect(r.status()).toBe(200);
  const g = await a.get(`/api/payments/${q.ref}`);
  const caseNo = (await g.json()).caseNo as string;
  expect(caseNo).toMatch(/^EG-\d{4}-\d{6}$/);
  return { a, caseNo, ref: q.ref, fee: q.fee };
}
async function claim(a: APIRequestContext, caseNo: string) {
  return a.post(`/api/officer/cases/${caseNo}/claim`);
}
async function returnCase(a: APIRequestContext, caseNo: string, reason = 'xxxxxxxxxx') {
  return a.post(`/api/officer/cases/${caseNo}/return`, { data: { reason } });
}
const baht = (n: number) => '฿' + n.toLocaleString('en-US');
const same = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
/** B13: แปลง ISO เป็นรูปเดียวกัน (+07:00) เพื่อให้ข้อความล้มแสดงค่าจริงเทียบค่าคาดหวัง */
const isoN = (a: string) => { const t = new Date(a).getTime(); if (Number.isNaN(t)) return `invalid(${a})`; return new Date(t + 7 * 3600e3).toISOString().slice(0, 19) + '+07:00'; };
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** '2026-12-04T16:30:00+07:00' → '4 ธ.ค. 2569 16:30' */
function thaiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)!;
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${+m[1] + 543} ${m[4]}:${m[5]}`;
}
async function caseJson(a: APIRequestContext, caseNo: string) {
  const r = await a.get(`/api/cases/${caseNo}`);
  expect(r.status()).toBe(200);
  return r.json();
}
async function casesCount(a: APIRequestContext): Promise<number> {
  const r = await a.get('/api/cases');
  expect(r.status()).toBe(200);
  return (await r.json()).items.length;
}
const rowNos = (page: Page) =>
  page.getByTestId('queue-row').evaluateAll((els) => els.map((e) => (e.getAttribute('data-case-no') ?? '').slice(-6)));
const suffixes = (xs: string[]) => xs.map((x) => `EG-2569-${x}`);
async function claimButtonRows(page: Page) {
  return page
    .getByTestId('queue-row')
    .evaluateAll((els) =>
      els.filter((e) => e.querySelector('[data-testid="claim-btn"]')).map((e) => (e.getAttribute('data-case-no') ?? '').slice(-6)),
    );
}
async function auditItems(event: string, caseNo: string) {
  const au = await loginS('audit1');
  const r = await au.get(`/api/audit?event=${event}&from=2026-12-01&to=2026-12-01`);
  expect(r.status()).toBe(200);
  const j = await r.json();
  return (j.items as any[]).filter((i) => i.caseNo === caseNo);
}
/** ตีกลับ/ไม่อนุมัติบนจอ: ถ้าช่องเหตุผลยังไม่โชว์ ให้กดปุ่มเปิดก่อน */
async function uiReturn(page: Page, reason: string) {
  if (!(await page.getByTestId('return-reason').isVisible())) await page.getByTestId('return-btn').click();
  await page.getByTestId('return-reason').fill(reason);
  await page.getByTestId('return-submit').click();
}
const cases = (n: string) => `EG-2569-${n}`;

// ───────────────────────── AUTH ─────────────────────────
test.describe('AUTH', () => {
  test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
    const a = await reset();
    const page = await newPage(browser);
    const bad = ['110170012345', '11017001234567', '1101700123457', '11017001234ab'];
    for (const v of bad) {
      await page.goto('/login');
      await page.getByTestId('thaid-id-input').fill(v);
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('thaid-error')).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
      await expect(page.getByTestId('otp-step')).not.toBeVisible();
      const r = await a.post('/api/auth/thaid/start', { data: { idNo: v } });
      expect(r.status(), v).toBe(400);
      expect((await r.json()).code).toBe('INVALID_ID');
    }
    for (const v of [ID.somchai, ID.somying, ID.piti, ID.mana]) {
      await page.goto('/login');
      await page.getByTestId('thaid-id-input').fill(v);
      await page.getByTestId('thaid-submit').click();
      await expect(page.getByTestId('otp-step')).toBeVisible();
      await expect(page.getByTestId('thaid-error')).not.toBeVisible();
      const r = await a.post('/api/auth/thaid/start', { data: { idNo: v } });
      expect(r.status(), v).toBe(200);
      expect((await r.json()).status).toBe('OTP_SENT');
    }
  });

  test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
    const a = await reset(); // นาฬิกา 09:00:00
    const page = await newPage(browser);
    // ขั้น 1-3 ผ่านหน้าจอ
    await page.goto('/login');
    await page.getByTestId('thaid-id-input').fill(ID.piti);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await page.getByTestId('otp-input').fill('000000');
    await page.getByTestId('otp-submit').click();
    await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
    await page.getByTestId('otp-input').fill('000000');
    await page.getByTestId('otp-submit').click();
    await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
    await page.getByTestId('otp-input').fill('000000');
    await page.getByTestId('otp-submit').click();
    await expect(page.getByTestId('lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
    expect(isoN((await page.getByTestId('lock-until').getAttribute('data-iso'))!)).toBe(isoN('2026-12-01T09:15:00+07:00'));

    const verify = (ctx: APIRequestContext, idNo: string, otp: string) => ctx.post('/api/auth/thaid/verify', { data: { idNo, otp } });
    const c = await newApi();
    // 4 OTP ถูกทันที ยังล็อก
    let r = await verify(c, ID.piti, OTP);
    expect(r.status()).toBe(423);
    expect((await r.json()).code).toBe('LOCKED');
    // 5 สมชายล็อกอินปกติ
    await loginC(ID.somchai);
    // 6 09:14:59 ยังล็อก
    await clock(a, '2026-12-01T09:14:59+07:00');
    r = await verify(c, ID.piti, OTP);
    expect(r.status()).toBe(423);
    // 7 09:15:00 ปลดล็อก OTP ผิด → เหลือ 2 ครั้ง
    await clock(a, '2026-12-01T09:15:00+07:00');
    await c.post('/api/auth/thaid/start', { data: { idNo: ID.piti } });
    r = await verify(c, ID.piti, '000000');
    expect(r.status()).toBe(401);
    let j = await r.json();
    expect(j.code).toBe('OTP_INVALID');
    expect(j.attemptsLeft).toBe(2);
    // 8 OTP ถูก
    r = await verify(c, ID.piti, OTP);
    expect(r.status()).toBe(200);

    // 9 RESET · ผิด 2 → ถูก → ออก → ผิดอีก 2 ไม่ล็อก
    await reset();
    const d = await newApi();
    await d.post('/api/auth/thaid/start', { data: { idNo: ID.piti } });
    r = await verify(d, ID.piti, '000000');
    expect((await r.json()).attemptsLeft).toBe(2);
    r = await verify(d, ID.piti, '000000');
    expect((await r.json()).attemptsLeft).toBe(1);
    r = await verify(d, ID.piti, OTP);
    expect(r.status()).toBe(200);
    expect((await d.post('/api/auth/logout')).status()).toBe(204);
    await d.post('/api/auth/thaid/start', { data: { idNo: ID.piti } });
    r = await verify(d, ID.piti, '000000');
    expect(r.status()).toBe(401);
    expect((await r.json()).attemptsLeft).toBe(2);
    r = await verify(d, ID.piti, '000000');
    expect(r.status()).toBe(401);
    expect((await r.json()).attemptsLeft).toBe(1);
  });

  test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.mana);
    await page.goto('/register');
    const name = page.getByTestId('reg-name');
    await expect(name).toHaveValue('มานะ ตั้งใจ');
    expect(await name.evaluate((e: HTMLInputElement) => e.readOnly)).toBe(true);
    await name.click();
    await page.keyboard.type('xyz');
    await expect(name).toHaveValue('มานะ ตั้งใจ');

    const mobileErr = 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0';
    await page.getByTestId('reg-consent').setChecked(true);
    for (const m of ['081234567', '08123456789', '1812345678', '08123abcde']) {
      await page.getByTestId('reg-mobile').fill(m);
      await page.getByTestId('reg-submit').click();
      await expect(page.getByTestId('reg-error-mobile'), m).toHaveText(mobileErr);
      expect(new URL(page.url()).pathname).toBe('/register');
    }
    await page.getByTestId('reg-mobile').fill('0845678901');
    await page.getByTestId('reg-consent').setChecked(false);
    await page.getByTestId('reg-submit').click();
    await expect(page.getByTestId('reg-error-consent')).toHaveText('กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
    expect(new URL(page.url()).pathname).toBe('/register');

    await page.getByTestId('reg-consent').setChecked(true);
    await page.getByTestId('reg-email').fill('');
    await page.getByTestId('reg-submit').click();
    await page.waitForURL('**/citizen');
    await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');

    await page.getByTestId('logout-btn').click();
    await page.waitForURL('**/login');
    await uiLoginC(page, ID.mana);
    expect(new URL(page.url()).pathname).toBe('/citizen');

    // 8 RESET แล้วตรวจที่ API
    await reset();
    const a = await newApi();
    await a.post('/api/auth/thaid/start', { data: { idNo: ID.mana } });
    const v = await a.post('/api/auth/thaid/verify', { data: { idNo: ID.mana, otp: OTP } });
    expect(v.status()).toBe(200);
    expect((await v.json()).registered).toBe(false);
    let r = await a.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_MOBILE');
    r = await a.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('CONSENT_REQUIRED');
  });

  test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้น', async ({ browser }) => {
    const a = await reset();
    const page = await newPage(browser);
    const rows: [string, string, string, string, string, string | null][] = [
      ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'เจ้าหน้าที่', 'officer', 'registry'],
      ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'เจ้าหน้าที่', 'officer', 'registry'],
      ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'เจ้าหน้าที่', 'officer', 'works'],
      ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'หัวหน้าฝ่าย', 'head', null],
      ['exec1', '/dashboard', 'ผู้บริหาร', 'ผู้บริหาร', 'executive', null],
      ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'ผู้ตรวจสอบภายใน', 'auditor', null],
      ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'ผู้ดูแลระบบ', 'admin', null],
    ];
    await page.goto('/login');
    await page.getByTestId('login-tab-staff').click();
    await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
    for (const [u, path, name, roleTxt, role, dept] of rows) {
      await uiLoginS(page, u);
      expect(new URL(page.url()).pathname, u).toBe(path);
      await expect(page.getByTestId('user-name')).toHaveText(name);
      await expect(page.getByTestId('user-role')).toHaveText(roleTxt);
      await expect(page.getByTestId('user-role')).toHaveAttribute('data-role', role);
      if (dept) await expect(page.getByTestId('user-role')).toHaveAttribute('data-dept', dept);
      await page.getByTestId('logout-btn').click();
      await page.waitForURL('**/login');
    }
    for (const [u, p] of [['off.reg1', 'wrong'], ['nobody', PW], [ID.somchai, PW]]) {
      await page.goto('/login');
      await page.getByTestId('login-tab-staff').click();
      await page.getByTestId('staff-username').fill(u);
      await page.getByTestId('staff-password').fill(p);
      await page.getByTestId('staff-submit').click();
      await expect(page.getByTestId('staff-error'), u).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      const r = await a.post('/api/auth/staff/login', { data: { username: u, password: p } });
      expect(r.status()).toBe(401);
      expect((await r.json()).code).toBe('INVALID_CREDENTIALS');
    }
    await page.goto('/officer/queue');
    await page.waitForURL('**/login');
  });
});

// ───────────────────────── FEE ─────────────────────────
test.describe('FEE', () => {
  test('TC-FEE-01 ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    const api = page.request;

    const sv3: [number, number | null, string | null, string | null][] = [
      [0, null, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'],
      [-1, null, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'],
      [1, 1000, null, null],
      [100, 1000, null, null],
      [101, 1010, null, null],
      [102, 1020, null, null],
      [250, 2500, null, null],
      [300, 3000, null, null],
      [499, 4990, null, null],
      [500, 5000, null, null],
      [501, null, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน', 'AREA_TOO_LARGE'],
    ];
    await page.goto('/citizen/new/SV-03');
    for (const [area, fee, err, code] of sv3) {
      await page.getByTestId('area-input').fill(String(area));
      if (fee !== null) {
        await expect(page.getByTestId('fee-total'), `area ${area}`).toHaveText(baht(fee));
        await expect(page.getByTestId('fee-error')).not.toBeVisible();
        await expect(page.getByTestId('to-upload-btn')).toBeEnabled();
      } else {
        await expect(page.getByTestId('fee-total'), `area ${area}`).toHaveText('–');
        await expect(page.getByTestId('fee-error')).toHaveText(err!);
        await expect(page.getByTestId('to-upload-btn')).toBeDisabled();
      }
      const r = await api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: area } });
      if (fee !== null) {
        expect(r.status(), `api area ${area}`).toBe(201);
        expect((await r.json()).fee).toBe(fee);
      } else {
        expect(r.status(), `api area ${area}`).toBe(400);
        expect((await r.json()).code).toBe(code);
      }
    }

    const qtyErr = 'จำนวนฉบับต้อง 1–5 ฉบับ';
    await page.goto('/citizen/new/SV-01');
    for (const q of [0, 1, 2, 3, 4, 5, 6]) {
      await page.getByTestId('qty-input').fill(String(q));
      if (q >= 1 && q <= 5) {
        await expect(page.getByTestId('fee-total'), `qty ${q}`).toHaveText(baht(q * 20));
        await expect(page.getByTestId('fee-error')).not.toBeVisible();
      } else {
        await expect(page.getByTestId('fee-error'), `qty ${q}`).toHaveText(qtyErr);
      }
      const r = await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: q } });
      if (q >= 1 && q <= 5) {
        expect(r.status()).toBe(201);
        expect((await r.json()).fee).toBe(q * 20);
      } else {
        expect(r.status()).toBe(400);
        expect((await r.json()).code).toBe('INVALID_QTY');
      }
    }

    await page.goto('/citizen/new/SV-02');
    await expect(page.getByTestId('fee-total')).toHaveText('฿500');
    const r2 = await api.post('/api/drafts', { data: { serviceId: 'SV-02' } });
    expect(r2.status()).toBe(201);
    expect((await r2.json()).fee).toBe(500);
  });
});

// ───────────────────────── SUBMIT ─────────────────────────
test.describe('SUBMIT', () => {
  test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
    const anon = await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    await page.goto('/citizen');
    await page.getByTestId('start-service-SV-01').click();
    await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
    await page.getByTestId('qty-input').fill('2');
    await expect(page.getByTestId('fee-total')).toHaveText('฿40');
    await page.getByTestId('to-upload-btn').click();

    await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await page.getByTestId('upload-input-id-card').setInputFiles(fPdf('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('file-item')).toHaveAttribute('data-doc-key', 'id-card');
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
    await page.getByTestId('to-payment-btn').click();

    await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
    await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
    await page.getByTestId('create-qr-btn').click();
    await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
    expect(isoN((await page.getByTestId('qr-expires').getAttribute('data-iso'))!)).toBe(isoN('2026-12-01T09:15:00+07:00'));
    await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');

    const pr = await pay(anon, 'PP-0002', 40);
    expect(pr.status()).toBe(200);
    expect(await pr.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
    await page.getByTestId('refresh-payment-btn').click();
    await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
    await expect(page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
    await expect(page.getByTestId('receipt-no')).toHaveText('RC-2569-000031');
    await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
    await expect.poll(async () => isoN((await page.getByTestId('receipt-paid-at').getAttribute('data-iso')) ?? '')).toBe(isoN(T0)); // B13: รอ fetch รอบสอง

    await page.getByTestId('go-case-btn').click();
    await page.waitForURL('**/citizen/cases/EG-2569-000031');
    await expect(page.getByTestId('case-status')).toHaveText('ส่งคำขอแล้ว');
    await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'SUBMITTED');
    await expect(page.getByTestId('case-fee')).toHaveText('฿40');
    await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
    expect(isoN((await page.getByTestId('sla-due').getAttribute('data-iso'))!)).toBe(isoN('2026-12-04T16:30:00+07:00'));
    await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');
    await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
    await expect(page.getByTestId('case-step')).toHaveCount(0);

    const off = await newPage(browser);
    await uiLoginS(off, 'off.reg1');
    await off.goto('/officer/queue');
    const row = off.locator('[data-testid="queue-row"][data-case-no="EG-2569-000031"]');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('row-owner')).toHaveText('');
    await expect(row.getByTestId('claim-btn')).toHaveCount(1);
    const nos = await rowNos(off);
    expect(nos.indexOf('000031')).toBe(nos.indexOf('000030') + 1);
  });

  test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    const att = (key: string, f: F) => page.getByTestId(`upload-input-${key}`).setInputFiles(f);

    // SV-02
    await page.goto('/citizen/new/SV-02');
    await page.getByTestId('to-upload-btn').click();
    await att('id-card', fPdf('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
    await att('map', fPdf('map.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(2);
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
    await expect(page.getByTestId('missing-docs')).toHaveCount(0);
    await page.locator('[data-testid="file-item"][data-doc-key="map"]').getByTestId('file-remove-btn').click();
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

    // SV-03 (พื้นที่ 100)
    await page.goto('/citizen/new/SV-03');
    await page.getByTestId('area-input').fill('100');
    await page.getByTestId('to-upload-btn').click();
    await att('id-card', fPdf('id-card.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');
    await att('deed', fPdf('deed.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(2);
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
    await att('plan', fJpg('plan-as-jpg.jpg'));
    await expect(page.getByTestId('upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
    await expect(page.getByTestId('file-item')).toHaveCount(2);
    await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
    await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
    await att('plan', fPdf('plan.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(3);
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
    await expect(page.getByTestId('missing-docs')).toHaveCount(0);

    // API
    const a = await loginC(ID.somchai);
    const d = await mkDraft(a, 'SV-03', { areaSqm: 100 });
    expect((await putFile(a, d.draftId, fPdf('id-card.pdf'), 'id-card')).status()).toBe(201);
    expect((await putFile(a, d.draftId, fPdf('deed.pdf'), 'deed')).status()).toBe(201);
    const p1 = await a.post(`/api/drafts/${d.draftId}/payment`);
    expect(p1.status()).toBe(409);
    const j = await p1.json();
    expect(j.code).toBe('MISSING_DOCS');
    expect(j.missing).toEqual(['แบบแปลน']);
    expect((await putFile(a, d.draftId, fPdf('plan.pdf'), 'plan')).status()).toBe(201);
    expect((await a.post(`/api/drafts/${d.draftId}/payment`)).status()).toBe(201);
  });

  test('TC-SUBMIT-03 ร่าง และการยกเลิก', async ({ browser }) => {
    // ส่วน A ร่าง
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    const drafts = page.getByTestId('my-draft-row');
    await expect(drafts).toHaveCount(2);
    const d1 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0001"]');
    const d2 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0002"]');
    await expect(d1).toHaveAttribute('data-status', 'DRAFT');
    await expect(d2).toHaveAttribute('data-status', 'PENDING_PAYMENT');
    for (const row of [d1, d2]) expect(await row.innerText()).not.toContain('EG-');
    await d1.getByTestId('open-draft-btn').click();
    await expect(page.getByTestId('qty-input')).toHaveValue('2');
    await expect(page.getByTestId('fee-total')).toHaveText('฿40');
    await page.goto('/citizen/new/SV-01');
    await page.getByTestId('qty-input').fill('3');
    await page.getByTestId('save-draft-btn').click();
    await expect(page.getByTestId('draft-id')).toHaveText('DR-0003');
    await page.goto('/citizen');
    await expect(page.getByTestId('my-case-row')).toHaveCount(10);
    expect(await casesCount(page.request)).toBe(10);
    const dl = await page.request.get('/api/drafts');
    expect((await dl.json()).items).toHaveLength(3);

    // ส่วน B ยกเลิก
    await reset();
    const p2 = await newPage(browser);
    await uiLoginC(p2, ID.somchai);
    await p2.goto('/citizen/cases/EG-2569-000030');
    await expect(p2.getByTestId('cancel-case-btn')).toHaveCount(1);
    await p2.getByTestId('cancel-case-btn').click();
    await expect(p2.getByTestId('cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
    await p2.getByTestId('confirm-cancel-btn').click();
    await expect(p2.getByTestId('case-status')).toHaveText('ยกเลิก');
    await expect(p2.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
    await expect(p2.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
    await expect(p2.getByTestId('cancel-case-btn')).toHaveCount(0);
    const off = await newPage(browser);
    await uiLoginS(off, 'off.reg1');
    await off.goto('/officer/queue');
    await expect(off.getByTestId('queue-row')).toHaveCount(16);
    expect(await rowNos(off)).not.toContain('000030');
    const ex = await newPage(browser);
    await uiLoginS(ex, 'exec1');
    await ex.goto('/dashboard');
    await expect(ex.getByTestId('kpi-backlog')).toHaveText('20');
    await expect(ex.getByTestId('kpi-received')).toHaveText('3');

    // ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ
    await reset();
    const reg1 = await loginS('off.reg1');
    expect((await claim(reg1, cases('000030'))).status()).toBe(200);
    const p3 = await newPage(browser);
    await uiLoginC(p3, ID.somchai);
    await p3.goto('/citizen/cases/EG-2569-000030');
    await expect(p3.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
    await expect(p3.getByTestId('cancel-case-btn')).toHaveCount(0);
    for (const n of ['000030', '000013']) {
      const r = await p3.request.post(`/api/cases/${cases(n)}/cancel`);
      expect(r.status(), n).toBe(409);
      const j = await r.json();
      expect(j.code).toBe('CANNOT_CANCEL');
      expect(j.message).toBe('ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');
    }

    // ส่วน E ลบร่าง
    await reset();
    const s = await loginC(ID.somchai);
    expect((await s.delete('/api/drafts/DR-0001')).status()).toBe(204);
    expect((await s.get('/api/drafts/DR-0001')).status()).toBe(404);
    const p5 = await newPage(browser);
    await uiLoginC(p5, ID.somchai);
    await p5.goto('/citizen');
    await expect(p5.getByTestId('my-draft-row')).toHaveCount(1);
    await expect(p5.getByTestId('my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
    expect((await s.delete('/api/drafts/DR-0002')).status()).toBe(204);
    expect((await s.get('/api/payments/PP-0001')).status()).toBe(404);
    expect((await pay(s, 'PP-0001', 500)).status()).toBe(404);

    // ส่วน F ยกเลิกชนกับรับเรื่อง
    await reset();
    const somchai = await loginC(ID.somchai);
    const officerPage = await newPage(browser);
    await uiLoginS(officerPage, 'off.reg1');
    const [cr, cl] = await Promise.all([
      somchai.post(`/api/cases/${cases('000030')}/cancel`),
      officerPage.request.post(`/api/officer/cases/${cases('000030')}/claim`),
    ]);
    const pair = [cr.status(), cl.status()];
    const cancelWon = cr.status() === 200 && cl.status() === 409;
    const claimWon = cl.status() === 200 && cr.status() === 409;
    expect(cancelWon || claimWon, `สถานะ ${pair}`).toBe(true);
    if (cancelWon) expect((await cl.json()).code).toBe('INVALID_STATE');
    if (claimWon) expect((await cr.json()).code).toBe('CANNOT_CANCEL');
    const fin = await caseJson(somchai, cases('000030'));
    await officerPage.goto('/officer/queue');
    await expect(officerPage.getByTestId('workload-count')).toHaveText(cancelWon ? '3' : '4');
    if (cancelWon) {
      expect(fin.status).toBe('CANCELLED');
      expect(fin.owner ?? null).toBeNull();
    } else {
      expect(fin.status).toBe('IN_REVIEW');
      expect(fin.owner).toBe('off.reg1');
    }
  });
});

// ───────────────────────── UPLOAD ─────────────────────────
async function uiAttachStep(page: Page, qty = 1) {
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill(String(qty));
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
}
async function draftFileCount(a: APIRequestContext, draftId: string): Promise<number | undefined> {
  const j = await (await a.get(`/api/drafts/${draftId}`)).json();
  const d = j.items?.[0] ?? j;
  if (Array.isArray(d.files)) return d.files.length;
  if (typeof d.fileCount === 'number') return d.fileCount;
  return undefined;
}

test.describe('UPLOAD', () => {
  test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    const api = page.request;
    await uiAttachStep(page);
    const inp = page.getByTestId('upload-input-id-card');

    for (const [n, ok] of [[5242879, true], [5242880, true], [5242881, false]] as const) {
      await inp.setInputFiles(fPdf(`size-${n}.pdf`, n));
      if (ok) {
        await expect(page.getByTestId('file-item'), String(n)).toHaveCount(1);
        await expect(page.getByTestId('upload-error')).not.toBeVisible();
        await page.getByTestId('file-remove-btn').click();
        await expect(page.getByTestId('file-item')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('upload-error')).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
        await expect(page.getByTestId('file-item')).toHaveCount(0);
      }
      const d = await mkDraft(api, 'SV-01', { qty: 1 });
      const r = await putFile(api, d.draftId, fPdf(`size-${n}.pdf`, n), 'id-card');
      if (ok) expect(r.status(), `api ${n}`).toBe(201);
      else {
        expect(r.status(), `api ${n}`).toBe(400);
        expect((await r.json()).code).toBe('FILE_TOO_LARGE');
      }
    }

    // จำนวน
    await uiAttachStep(page);
    await inp.setInputFiles(fPdf('id-card.pdf'));
    await page.getByTestId('upload-input-extra').setInputFiles([1, 2, 3, 4].map((i) => fPdf(`multi-${i}.pdf`)));
    await expect(page.getByTestId('file-item')).toHaveCount(5);
    await page.getByTestId('upload-input-extra').setInputFiles(fPdf('multi-5.pdf'));
    await expect(page.getByTestId('upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
    await expect(page.getByTestId('file-item')).toHaveCount(5);
    await page.locator('[data-testid="file-item"][data-name="multi-4.pdf"]').getByTestId('file-remove-btn').click();
    await expect(page.getByTestId('file-item')).toHaveCount(4);
    await page.getByTestId('upload-input-extra').setInputFiles(fPdf('multi-5.pdf'));
    await expect(page.getByTestId('file-item')).toHaveCount(5);

    const d = await mkDraft(api, 'SV-01', { qty: 1 });
    expect((await putFile(api, d.draftId, fPdf('id-card.pdf'), 'id-card')).status()).toBe(201);
    for (let i = 1; i <= 4; i++) expect((await putFile(api, d.draftId, fPdf(`multi-${i}.pdf`), 'extra')).status()).toBe(201);
    const r6 = await putFile(api, d.draftId, fPdf('multi-5.pdf'), 'extra');
    expect(r6.status()).toBe(400);
    expect((await r6.json()).code).toBe('FILE_COUNT');
  });

  test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    const api = page.request;
    await uiAttachStep(page);
    const inp = page.getByTestId('upload-input-id-card');
    const typeErr = 'รองรับเฉพาะไฟล์ PDF, JPG, PNG';
    const accepted: F[] = [fPdf('ok-id.pdf'), fJpg('real.jpg'), fPng('real.png')];
    const rejected: F[] = [
      fText('fake-text.pdf', 'application/pdf'), // เนื้อเป็นข้อความ ส่งด้วย Content-Type pdf
      fText('fake-text.pdf'),
      fText('fake-text.jpg'),
      fExe('exe-as.png'),
      fText('notes.txt'),
    ];
    for (const f of accepted) {
      await inp.setInputFiles(f);
      await expect(page.getByTestId('file-item'), f.name).toHaveCount(1);
      await page.getByTestId('file-remove-btn').click();
      await expect(page.getByTestId('file-item')).toHaveCount(0);
    }
    for (const f of rejected) {
      await inp.setInputFiles(f);
      await expect(page.getByTestId('upload-error'), f.name).toHaveText(typeErr);
      await expect(page.getByTestId('file-item')).toHaveCount(0);
    }

    for (const f of accepted) {
      const d = await mkDraft(api, 'SV-01', { qty: 1 });
      expect((await putFile(api, d.draftId, f, 'id-card')).status(), f.name).toBe(201);
    }
    const d = await mkDraft(api, 'SV-01', { qty: 1 });
    const before = await draftFileCount(api, d.draftId);
    for (const f of rejected) {
      const r = await putFile(api, d.draftId, f, 'id-card');
      expect(r.status(), f.name).toBe(400);
      expect((await r.json()).code).toBe('FILE_TYPE');
    }
    const after = await draftFileCount(api, d.draftId);
    if (before !== undefined) expect(after).toBe(before);
  });
});

// ───────────────────────── PAY ─────────────────────────
test.describe('PAY', () => {
  test('TC-PAY-01 อายุ QR 15:00', async ({ browser }) => {
    const rounds: [string | null, number, string | null][] = [
      [null, 200, 'EG-2569-000031'], // อายุ 5:00
      ['2026-12-01T09:09:59+07:00', 200, 'EG-2569-000031'], // 14:59
      ['2026-12-01T09:10:00+07:00', 410, null], // 15:00
      ['2026-12-01T09:10:01+07:00', 410, null], // 15:01
    ];
    for (let i = 0; i < rounds.length; i++) {
      const [at, status, caseNo] = rounds[i];
      const anon = await reset();
      if (at) await clock(anon, at);
      const page = await newPage(browser);
      await uiLoginC(page, ID.somchai);
      const s = page.request;
      const r = await pay(s, 'PP-0001', 500);
      expect(r.status(), `รอบ ${i + 1}`).toBe(status);
      const j = await r.json();
      if (status === 200) {
        expect(j.status).toBe('PAID');
        expect(j.caseNo).toBe(caseNo);
      } else {
        expect(j.code).toBe('QR_EXPIRED');
        expect((await (await s.get('/api/payments/PP-0001')).json()).status).toBe('EXPIRED');
        expect(await casesCount(s)).toBe(10);
      }
      if (i === 2) {
        await page.goto('/citizen/new/SV-02?draft=DR-0002');
        await expect(page.getByTestId('qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
        await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
        await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
        await expect(page.getByTestId('regenerate-qr-btn')).toHaveCount(1);
        await page.getByTestId('regenerate-qr-btn').click();
        await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
        expect(isoN((await page.getByTestId('qr-expires').getAttribute('data-iso'))!)).toBe(isoN('2026-12-01T09:25:00+07:00'));
        const r2 = await pay(s, 'PP-0002', 500);
        expect(r2.status()).toBe(200);
        expect((await r2.json()).caseNo).toBe('EG-2569-000031');
      }
    }
  });

  test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async () => {
    await reset();
    const a = await loginC(ID.somchai);
    const q = await draftWithQr(a, 'SV-01', { qty: 1 });
    expect(q.ref).toBe('PP-0002');
    for (const amt of [19, 21]) {
      const r = await pay(a, q.ref, amt);
      expect(r.status(), `amount ${amt}`).toBe(422);
      expect((await r.json()).code).toBe('AMOUNT_MISMATCH');
      expect((await (await a.get(`/api/payments/${q.ref}`)).json()).status).toBe('PENDING');
      expect(await casesCount(a)).toBe(10);
    }
    let r = await pay(a, q.ref, 20);
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
    expect(await casesCount(a)).toBe(11);
    r = await pay(a, q.ref, 20);
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ duplicate: true, caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
    expect(await casesCount(a)).toBe(11);
    const q2 = await draftWithQr(a, 'SV-01', { qty: 1 });
    r = await pay(a, q2.ref, 20);
    expect(await r.json()).toMatchObject({ caseNo: 'EG-2569-000032', receiptNo: 'RC-2569-000032' });
  });

  test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async () => {
    await reset();
    const somchai = await loginC(ID.somchai);
    const somying = await loginC(ID.somying);
    const refs: string[] = [];
    for (const a of [somchai, somying]) for (let i = 0; i < 3; i++) refs.push((await draftWithQr(a, 'SV-01', { qty: 1 })).ref);
    expect(refs).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);
    const rs = await Promise.all(refs.map((ref) => pay(somchai, ref, 20)));
    const js = [];
    for (const r of rs) {
      expect(r.status()).toBe(200);
      js.push(await r.json());
    }
    const caseNos = js.map((j) => j.caseNo).sort();
    const receipts = js.map((j) => j.receiptNo).sort();
    const want = [31, 32, 33, 34, 35, 36].map((n) => `0000${n}`); // B13: เลข 6 หลัก (เดิม 000${n} ได้ 5 หลัก)
    expect(caseNos).toEqual(want.map((n) => `EG-2569-${n}`));
    expect(receipts).toEqual(want.map((n) => `RC-2569-${n}`));
    expect(new Set(caseNos).size).toBe(6);
    for (const a of [somchai, somying]) {
      const items = (await (await a.get('/api/cases')).json()).items as { caseNo: string }[];
      expect(items.filter((i) => i.caseNo >= 'EG-2569-000031')).toHaveLength(3);
    }
    const q = await draftWithQr(somchai, 'SV-01', { qty: 1 });
    expect((await (await pay(somchai, q.ref, 20)).json()).caseNo).toBe('EG-2569-000037');
  });

  test('TC-PAY-04 เลขคำขอข้ามปี', async ({ browser }) => {
    const anon = await reset();
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    const a = page.request;
    // 1 สร้างร่าง + QR ผ่านหน้าจอ ณ 23:58
    await clock(anon, '2026-12-31T23:58:00+07:00');
    await page.goto('/citizen/new/SV-01');
    await page.getByTestId('qty-input').fill('1');
    await page.getByTestId('to-upload-btn').click();
    await page.getByTestId('upload-input-id-card').setInputFiles(fPdf('id-card.pdf'));
    await page.getByTestId('to-payment-btn').click();
    await page.getByTestId('create-qr-btn').click();
    await expect(page.getByTestId('qr-ref')).toHaveText(/^PP-\d{4}$/); // B13: รอให้ QR สร้างเสร็จก่อนอ่าน (เดิมอ่านได้ค่าว่าง)
    const ref = (await page.getByTestId('qr-ref').innerText()).trim();
    expect(await casesCount(a)).toBe(10);
    // 2 ชำระ 23:59
    await clock(anon, '2026-12-31T23:59:00+07:00');
    const r = await pay(a, ref, 20);
    expect(await r.json()).toMatchObject({ caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
    await page.getByTestId('refresh-payment-btn').click();
    await expect(page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
    await expect.poll(async () => isoN((await page.getByTestId('receipt-paid-at').getAttribute('data-iso')) ?? '')).toBe(isoN('2026-12-31T23:59:00+07:00')); // B13: data-iso มาจาก fetch รอบสอง ต้องรอ
    // 3-4 ปีใหม่
    await clock(anon, '2027-01-01T00:00:00+07:00');
    const q3 = await draftWithQr(a, 'SV-01', { qty: 1 });
    expect(await (await pay(a, q3.ref, 20)).json()).toMatchObject({ caseNo: 'EG-2570-000001', receiptNo: 'RC-2570-000001' });
    const q4 = await draftWithQr(a, 'SV-01', { qty: 1 });
    expect((await (await pay(a, q4.ref, 20)).json()).caseNo).toBe('EG-2570-000002');
    // 5
    expect((await caseJson(a, 'EG-2569-000031')).caseNo).toBe('EG-2569-000031');
  });
});

// ───────────────────────── QUEUE ─────────────────────────
test.describe('QUEUE', () => {
  test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginS(page, 'off.reg1');
    await page.goto('/officer/queue');
    await expect(page.getByTestId('queue-filter')).toHaveValue('all');
    const order = ['000020', '000022', '000024', '000023', '000025', '000026', '000013', '000015', '000027', '000028', '000029', '000030', '000016', '000018', '000019', '000012', '000021'];
    await expect(page.getByTestId('queue-row')).toHaveCount(17);
    expect(await rowNos(page)).toEqual(order);
    const lv = page.getByTestId('queue-row').getByTestId('row-sla-level');
    await expect(lv.nth(0)).toHaveText('เกินกำหนด');
    await expect(lv.nth(1)).toHaveText('ใกล้ครบกำหนด');
    await expect(lv.nth(2)).toHaveText('ใกล้ครบกำหนด');
    const masks = await page.getByTestId('row-id-masked').allInnerTexts();
    expect(masks).toHaveLength(17);
    for (const m of masks) expect(m.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
    await expect(page.getByTestId('claim-btn')).toHaveCount(4);
    expect((await claimButtonRows(page)).sort()).toEqual(['000024', '000028', '000029', '000030']);
    await page.getByTestId('queue-filter').selectOption('unclaimed');
    await expect.poll(() => rowNos(page)).toEqual(['000024', '000028', '000029', '000030']);
    await page.getByTestId('queue-filter').selectOption('mine');
    await expect.poll(() => rowNos(page)).toEqual(['000020', '000022', '000023']);
    await expect(page.getByTestId('workload-count')).toHaveText('3');
    const not = ['000017', '000011', '000014', '000001', '000008', '000009'];
    await page.getByTestId('queue-filter').selectOption('all');
    await expect.poll(async () => (await rowNos(page)).length).toBe(17);
    for (const n of not) expect(await rowNos(page)).not.toContain(n);

    // off.reg2
    const p2 = await newPage(browser);
    await uiLoginS(p2, 'off.reg2');
    await p2.goto('/officer/queue');
    await p2.getByTestId('queue-filter').selectOption('mine');
    await expect
      .poll(() => rowNos(p2))
      .toEqual(['000025', '000026', '000013', '000015', '000027', '000016', '000018', '000012', '000021']);
    await expect(p2.getByTestId('workload-count')).toHaveText('9');

    // off.works1
    const p3 = await newPage(browser);
    await uiLoginS(p3, 'off.works1');
    await p3.goto('/officer/queue');
    await expect(p3.getByTestId('queue-row')).toHaveCount(1);
    expect(await rowNos(p3)).toEqual(['000010']);

    // head1
    const p4 = await newPage(browser);
    await uiLoginS(p4, 'head1');
    await p4.goto('/officer/queue');
    await expect(p4.getByTestId('queue-row')).toHaveCount(18);
    const hn = await rowNos(p4);
    const i10 = hn.indexOf('000010');
    expect(hn.slice(i10, i10 + 4)).toEqual(['000010', '000023', '000025', '000026']);
    await expect(p4.getByTestId('claim-btn')).toHaveCount(0);
  });

  test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
    // ส่วน 1 UI พร้อมกัน
    await reset();
    const pa = await newPage(browser);
    const pb = await newPage(browser);
    await uiLoginS(pa, 'off.reg1');
    await uiLoginS(pb, 'off.reg2');
    await pa.goto('/officer/queue');
    await pb.goto('/officer/queue');
    const sel = (p: Page) => p.locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]');
    await expect(sel(pa)).toHaveCount(1);
    await expect(sel(pb)).toHaveCount(1);
    await Promise.all([sel(pa).getByTestId('claim-btn').click(), sel(pb).getByTestId('claim-btn').click()]);
    const view = await newApi();
    const stat = await loginS('off.reg1');
    await expect
      .poll(async () => (await caseJson(stat, cases('000028'))).status)
      .toBe('IN_REVIEW');
    const c28 = await caseJson(stat, cases('000028'));
    expect(['off.reg1', 'off.reg2']).toContain(c28.owner);
    const winner = c28.owner === 'off.reg1' ? pa : pb;
    const loser = c28.owner === 'off.reg1' ? pb : pa;
    await expect(loser.getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
    await expect(winner.getByTestId('action-error')).not.toBeVisible();
    await expect(sel(winner).getByTestId('row-owner')).not.toHaveText('');
    expect(await auditItems('CLAIM', cases('000028'))).toHaveLength(1);
    void view;

    // ส่วน 2 API 10 ครั้งพร้อมกัน
    await reset();
    const r1 = await loginS('off.reg1');
    const r2 = await loginS('off.reg2');
    const calls = [...Array(5).fill(r1), ...Array(5).fill(r2)] as APIRequestContext[];
    const res = await Promise.all(calls.map((c) => claim(c, cases('000029'))));
    const codes = res.map((r) => r.status());
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);
    for (const r of res) if (r.status() === 409) expect((await r.json()).code).toBe('ALREADY_CLAIMED');
    const win = res.findIndex((r) => r.status() === 200);
    const winName = calls[win] === r1 ? 'off.reg1' : 'off.reg2';
    expect((await caseJson(r1, cases('000029'))).owner).toBe(winName);
    expect(await auditItems('CLAIM', cases('000029'))).toHaveLength(1);

    // ส่วน 3 ต่อกัน
    await reset();
    const s1 = await loginS('off.reg1');
    const s2 = await loginS('off.reg2');
    let r = await claim(s1, cases('000029'));
    expect(r.status()).toBe(200);
    expect((await r.json()).owner).toBe('off.reg1');
    r = await claim(s2, cases('000029'));
    expect(r.status()).toBe(409);
    const j = await r.json();
    expect(j.code).toBe('ALREADY_CLAIMED');
    expect(j.message).toBe('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
    expect((await caseJson(s1, cases('000029'))).owner).toBe('off.reg1');
    const p2 = await newPage(browser);
    await uiLoginS(p2, 'off.reg2');
    await p2.goto('/officer/queue');
    await expect(p2.getByTestId('workload-count')).toHaveText('9');
    expect((await claim(s1, cases('000029'))).status()).toBe(409);
    expect(await auditItems('CLAIM', cases('000029'))).toHaveLength(1);
  });

  test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ browser }) => {
    await reset();
    const page = await newPage(browser);
    await uiLoginS(page, 'off.reg2');
    await page.goto('/officer/queue');
    const wl = page.getByTestId('workload-count');
    const row = (n: string) => page.locator(`[data-testid="queue-row"][data-case-no="EG-2569-${n}"]`);
    await expect(wl).toHaveText('9');
    await row('000028').getByTestId('claim-btn').click();
    await expect(wl).toHaveText('10');
    await row('000029').getByTestId('claim-btn').click();
    await expect(page.getByTestId('action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
    await expect(wl).toHaveText('10');
    const reg2 = page.request;
    expect((await caseJson(reg2, cases('000029'))).status).toBe('SUBMITTED');
    expect((await caseJson(reg2, cases('000029'))).owner ?? null).toBeNull();
    const w = await reg2.post(`/api/officer/cases/${cases('000029')}/claim`);
    expect(w.status()).toBe(409);
    expect((await w.json()).code).toBe('WORKLOAD_LIMIT');

    await page.goto('/officer/cases/EG-2569-000025');
    await page.getByTestId('approve-btn').click();
    await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'APPROVED');
    await page.goto('/officer/queue');
    await expect(wl).toHaveText('9');
    await row('000029').getByTestId('claim-btn').click();
    await expect(wl).toHaveText('10');
    const reg1 = await loginS('off.reg1');
    expect((await claim(reg1, cases('000030'))).status()).toBe(200);

    // 7 RESET · return 000025
    await reset();
    const p2 = await newPage(browser);
    await uiLoginS(p2, 'off.reg2');
    await p2.goto('/officer/cases/EG-2569-000025');
    await uiReturn(p2, 'xxxxxxxxxx');
    await expect(p2.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
    await p2.goto('/officer/queue');
    await expect(p2.getByTestId('workload-count')).toHaveText('8');
    // 8
    for (const n of ['000028', '000029']) {
      await p2.locator(`[data-testid="queue-row"][data-case-no="EG-2569-${n}"]`).getByTestId('claim-btn').click();
      await expect(p2.locator(`[data-testid="queue-row"][data-case-no="EG-2569-${n}"]`).getByTestId('row-owner')).not.toHaveText('');
    }
    await expect(p2.getByTestId('workload-count')).toHaveText('10');
    // 9 สมหญิงส่งแก้
    const citizen = await newPage(browser);
    await uiLoginC(citizen, ID.somying);
    await citizen.goto('/citizen/cases/EG-2569-000025');
    await citizen.getByTestId('submit-fix-btn').click();
    await expect(citizen.getByTestId('action-error')).not.toBeVisible();
    await expect(citizen.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
    const ownerCase = await caseJson(p2.request, cases('000025'));
    expect(ownerCase.owner).toBe('off.reg2');
    await p2.goto('/officer/queue');
    await expect(p2.getByTestId('workload-count')).toHaveText('11');
    // 10
    const last = await claim(p2.request, cases('000030'));
    expect(last.status()).toBe(409);
    const lj = await last.json();
    expect(lj.code).toBe('WORKLOAD_LIMIT');
    expect(lj.message).toBe('รับงานได้สูงสุด 10 เรื่อง');
    await p2.reload();
    await expect(p2.getByTestId('workload-count')).toHaveText('11');
  });
});

// ───────────────────────── SLA ─────────────────────────
test.describe('SLA', () => {
  test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
    type Row = { k: string; svc: Svc; at: string; qty?: number; areaSqm?: number; due: string };
    const rows: Row[] = [
      { k: 'a', svc: 'SV-01', qty: 3, at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00' },
      { k: 'b', svc: 'SV-01', qty: 1, at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00' },
      { k: 'c', svc: 'SV-01', qty: 1, at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00' },
      { k: 'd', svc: 'SV-01', qty: 1, at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00' },
      { k: 'e', svc: 'SV-01', qty: 1, at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00' },
      { k: 'f', svc: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00' },
      { k: 'g', svc: 'SV-03', areaSqm: 100, at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00' },
      { k: 'h', svc: 'SV-01', qty: 1, at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00' },
      { k: 'i', svc: 'SV-01', qty: 1, at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00' },
    ];
    for (const r of rows) {
      const anon = await reset();
      const n = await newPaid(anon, { service: r.svc, at: r.at, qty: r.qty, areaSqm: r.areaSqm });
      expect(n.caseNo, r.k).toBe('EG-2569-000031');
      const j = await caseJson(n.a, n.caseNo);
      expect(isoN(j.dueAt), `แถว ${r.k} dueAt=${j.dueAt}`).toBe(isoN(r.due));
      const page = await newPage(browser);
      await uiLoginC(page, ID.somchai);
      await page.goto(`/citizen/cases/${n.caseNo}`);
      await expect(page.getByTestId('sla-due'), `แถว ${r.k}`).toHaveText(thaiDate(r.due));
      expect(isoN((await page.getByTestId('sla-due').getAttribute('data-iso'))!), `แถว ${r.k} iso`).toBe(isoN(r.due));
    }
  });

  test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
    // ส่วน 1
    let anon = await reset();
    let n = await newPaid(anon, { service: 'SV-01', qty: 1, at: T0 });
    expect(n.caseNo).toBe('EG-2569-000031');
    expect(isoN((await caseJson(n.a, n.caseNo)).dueAt)).toBe(isoN('2026-12-04T16:30:00+07:00'));
    await clock(anon, '2026-12-02T11:00:00+07:00');
    const reg1 = await loginS('off.reg1');
    expect((await claim(reg1, n.caseNo)).status()).toBe(200);
    expect((await returnCase(reg1, n.caseNo)).status()).toBe(200);
    const page = await newPage(browser);
    await uiLoginC(page, ID.somchai);
    await page.goto(`/citizen/cases/${n.caseNo}`);
    await expect(page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
    await expect(page.getByTestId('sla-level')).toHaveText('หยุดนับ');
    await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
    expect(isoN((await page.getByTestId('fix-deadline').getAttribute('data-iso'))!)).toBe(isoN('2026-12-09T11:00:00+07:00'));
    await clock(anon, '2026-12-03T10:00:00+07:00');
    await page.goto(`/citizen/cases/${n.caseNo}`);
    await page.getByTestId('submit-fix-btn').click();
    await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
    await expect(page.getByTestId('sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
    expect(isoN((await page.getByTestId('sla-due').getAttribute('data-iso'))!)).toBe(isoN('2026-12-08T16:30:00+07:00'));
    await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');
    const j1 = await caseJson(reg1, n.caseNo);
    expect(j1.owner).toBe('off.reg1');
    expect(isoN(j1.dueAt)).toBe(isoN('2026-12-08T16:30:00+07:00'));

    // ส่วน 2 seed 000017
    anon = await reset();
    const p2 = await newPage(browser);
    await uiLoginC(p2, ID.somchai);
    await p2.goto('/citizen/cases/EG-2569-000017');
    await expect(p2.getByTestId('sla-level')).toHaveText('หยุดนับ');
    expect(isoN((await p2.getByTestId('sla-due').getAttribute('data-iso'))!)).toBe(isoN('2026-11-27T16:30:00+07:00'));
    await p2.getByTestId('submit-fix-btn').click();
    await expect(p2.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
    expect(isoN((await p2.getByTestId('sla-due').getAttribute('data-iso'))!)).toBe(isoN('2026-12-01T16:30:00+07:00'));
    await expect(p2.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');
    const reg1b = await loginS('off.reg1');
    expect((await caseJson(reg1b, 'EG-2569-000017')).owner).toBe('off.reg1');

    // ส่วน 3
    anon = await reset();
    await clock(anon, '2026-12-04T10:00:00+07:00');
    let s = await loginC(ID.somchai);
    let r = await s.post('/api/cases/EG-2569-000017/resubmit');
    expect(r.status()).toBe(200);
    expect(isoN((await r.json()).dueAt)).toBe(isoN('2026-12-04T16:30:00+07:00'));
    const j3 = await caseJson(s, 'EG-2569-000017');
    expect(j3.slaLevel).toBe('near');

    // ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน
    anon = await reset();
    n = await newPaid(anon, { service: 'SV-01', qty: 1, at: T0 });
    await clock(anon, '2026-12-02T09:00:00+07:00');
    let o = await loginS('off.reg1');
    expect((await claim(o, n.caseNo)).status()).toBe(200);
    expect((await returnCase(o, n.caseNo)).status()).toBe(200);
    await clock(anon, '2026-12-02T15:00:00+07:00');
    r = await n.a.post(`/api/cases/${n.caseNo}/resubmit`);
    expect(r.status()).toBe(200);
    expect(isoN((await r.json()).dueAt)).toBe(isoN('2026-12-04T16:30:00+07:00'));
    expect(isoN((await caseJson(n.a, n.caseNo)).dueAt)).toBe(isoN('2026-12-04T16:30:00+07:00'));

    // ส่วน 5 คร่อมสุดสัปดาห์และส่งแก้หลัง 16:30
    anon = await reset();
    n = await newPaid(anon, { service: 'SV-01', qty: 1, at: T0 });
    await clock(anon, '2026-12-04T10:00:00+07:00');
    o = await loginS('off.reg1');
    expect((await claim(o, n.caseNo)).status()).toBe(200);
    expect((await returnCase(o, n.caseNo)).status()).toBe(200);
    await clock(anon, '2026-12-08T17:00:00+07:00');
    r = await n.a.post(`/api/cases/${n.caseNo}/resubmit`);
    expect(r.status()).toBe(200);
    expect(isoN((await r.json()).dueAt)).toBe(isoN('2026-12-08T16:30:00+07:00'));
    const j5 = await caseJson(n.a, n.caseNo);
    expect(isoN(j5.dueAt)).toBe(isoN('2026-12-08T16:30:00+07:00'));
    expect(j5.slaLevel).toBe('overdue');
    void s;
  });

  test('TC-SLA-03 ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ browser }) => {
    const lvTxt: Record<string, string> = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
    const check = async (page: Page, a: APIRequestContext, caseNo: string, level: string, label: string) => {
      await page.goto(`/citizen/cases/${caseNo}`);
      await expect(page.getByTestId('sla-level'), label).toHaveText(lvTxt[level]);
      await expect(page.getByTestId('sla-level'), label).toHaveAttribute('data-level', level);
      expect((await caseJson(a, caseNo)).slaLevel, label).toBe(level);
    };

    // ส่วน A
    let anon = await reset();
    const n = await newPaid(anon, { service: 'SV-01', qty: 1, at: T0 });
    expect(n.caseNo).toBe('EG-2569-000031');
    const pa = await newPage(browser);
    await uiLoginC(pa, ID.somchai);
    const rowsA: [string, string][] = [
      ['2026-12-01T09:00:00+07:00', 'normal'],
      ['2026-12-02T09:00:00+07:00', 'normal'],
      ['2026-12-03T09:00:00+07:00', 'near'],
      ['2026-12-04T16:30:00+07:00', 'near'],
      ['2026-12-04T16:30:01+07:00', 'overdue'],
      ['2026-12-04T16:31:00+07:00', 'overdue'],
      ['2026-12-05T10:00:00+07:00', 'overdue'],
    ];
    for (const [at, lv] of rowsA) {
      await clock(anon, at);
      await check(pa, n.a, n.caseNo, lv, `A ${at}`);
    }

    // ส่วน B (000016 ของปิติ)
    anon = await reset();
    const pb = await newPage(browser);
    await uiLoginC(pb, ID.piti);
    const piti = pb.request;
    const rowsB: [string, string][] = [
      ['2026-12-03T09:00:00+07:00', 'normal'],
      ['2026-12-04T09:00:00+07:00', 'near'],
      ['2026-12-08T16:30:00+07:00', 'near'],
      ['2026-12-08T16:31:00+07:00', 'overdue'],
    ];
    for (const [at, lv] of rowsB) {
      await clock(anon, at);
      await check(pb, piti, 'EG-2569-000016', lv, `B ${at}`);
    }

    // ส่วน C (seed ที่ 09:00)
    anon = await reset();
    const po = await newPage(browser);
    await uiLoginS(po, 'off.reg1');
    await po.goto('/officer/queue');
    const rowLv = async (no: string) =>
      (await po.locator(`[data-testid="queue-row"][data-case-no="EG-2569-${no}"]`).getByTestId('row-sla-level').innerText()).trim();
    const expC: [string, string][] = [
      ['000020', 'เกินกำหนด'],
      ['000022', 'ใกล้ครบกำหนด'],
      ['000024', 'ใกล้ครบกำหนด'],
      ['000025', 'ปกติ'],
    ];
    for (const [no, t] of expC) expect(await rowLv(no), no).toBe(t);
    const ps = await newPage(browser);
    await uiLoginC(ps, ID.somchai);
    await ps.goto('/citizen/cases/EG-2569-000017');
    await expect(ps.getByTestId('sla-level')).toHaveText('หยุดนับ');
    const py = await newPage(browser);
    await uiLoginC(py, ID.somying);
    await py.goto('/citizen/cases/EG-2569-000001');
    await expect(py.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
    await clock(anon, '2026-12-01T16:30:00+07:00');
    await po.goto('/officer/queue');
    expect(await rowLv('000022')).toBe('ใกล้ครบกำหนด');
    await clock(anon, '2026-12-01T16:31:00+07:00');
    await po.goto('/officer/queue');
    expect(await rowLv('000022')).toBe('เกินกำหนด');
  });
});
