// helpers2.ts · ตัวช่วยของชุด Playwright ที่ 2 (NOTI–NFR) · ไม่พึ่ง helpers.ts ของ B11
// ใช้ได้เฉพาะ CONTRACT / TEST-DATA / TEST-PLAN (ไม่อ่านโค้ดเว็บ)
import { expect, test, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const STAFF_PW = 'Test@1234';
export const OTP = '123456';
export const CIT = {
  somchai: '1101700123456',
  somying: '3100600987659',
  mana: '5500400111221',
  piti: '1909900555015',
} as const;
export const NOW0 = '2026-12-01T09:00:00+07:00';
export const case_ = (n: number) => `EG-2569-${String(n).padStart(6, '0')}`;

// ---------- session ----------
export type Sess = {
  ctx: BrowserContext;
  api: APIRequestContext; // ใช้ cookie เดียวกับหน้าเว็บของ context นี้
  newPage: () => Promise<Page>;
};

const live = new Set<BrowserContext>();

export async function newSession(browser: Browser): Promise<Sess> {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, acceptDownloads: true,
    // VIDEO=1 → อัดวิดีโอไว้ทำ GIF ใน test-report/ (ไม่กระทบผลที่คาดหวัง)
    ...(process.env.VIDEO === '1' ? { recordVideo: { dir: test.info().outputDir } } : {}) });
  live.add(ctx);
  return { ctx, api: ctx.request, newPage: () => ctx.newPage() };
}
export async function closeAll() {
  for (const c of live) await c.close().catch(() => {});
  live.clear();
}
export const anon = (browser: Browser) => newSession(browser);

export async function json(res: APIResponse): Promise<any> {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { __raw: t }; }
}

// ---------- สูตรกลาง ----------
export async function reset(browser: Browser): Promise<Sess> {
  const s = await newSession(browser);
  const r = await s.api.post('/api/test/reset');
  expect(r.status(), 'RESET').toBe(200);
  const b = await json(r);
  expect(b.now).toBe(NOW0);
  return s;
}
export async function setClock(s: Sess, iso: string) {
  const r = await s.api.put('/api/test/clock', { data: { now: iso } });
  expect(r.status(), `CLOCK(${iso})`).toBe(200);
}
export async function loginStaff(browser: Browser, username: string): Promise<Sess> {
  const s = await newSession(browser);
  const r = await s.api.post('/api/auth/staff/login', { data: { username, password: STAFF_PW } });
  expect(r.status(), `LOGIN_S ${username}`).toBe(200);
  return s;
}
export async function loginCitizen(browser: Browser, idNo: string): Promise<Sess> {
  const s = await newSession(browser);
  const a = await s.api.post('/api/auth/thaid/start', { data: { idNo } });
  expect(a.status(), 'thaid start').toBe(200);
  const b = await s.api.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP } });
  expect(b.status(), 'thaid verify').toBe(200);
  return s;
}

export function pdfBuf(n = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, n - head.length - tail.length), 0x20), tail]);
}

const DOCS: Record<string, string[]> = {
  'SV-01': ['id-card'],
  'SV-02': ['id-card', 'map'],
  'SV-03': ['id-card', 'plan', 'deed'],
};

/** NEW_PAID: CLOCK → LOGIN_C → draft → files → payment → pay → caseNo */
export async function newPaid(
  browser: Browser,
  o: { id?: string; serviceId: 'SV-01' | 'SV-02' | 'SV-03'; qty?: number; areaSqm?: number; at?: string },
) {
  if (o.at) { const a = await anon(browser); await setClock(a, o.at); }
  const s = await loginCitizen(browser, o.id ?? CIT.somchai);
  const body: any = { serviceId: o.serviceId };
  if (o.serviceId === 'SV-01') body.qty = o.qty ?? 1;
  if (o.serviceId === 'SV-03') body.areaSqm = o.areaSqm ?? 100;
  const d = await s.api.post('/api/drafts', { data: body });
  expect(d.status(), 'create draft').toBe(201);
  const { draftId, fee } = await json(d);
  for (const key of DOCS[o.serviceId]) {
    const f = await s.api.post(`/api/drafts/${draftId}/files`, {
      multipart: { docKey: key, file: { name: `${key}.pdf`, mimeType: 'application/pdf', buffer: pdfBuf(1024) } },
    });
    expect(f.status(), `upload ${key}`).toBe(201);
  }
  const p = await s.api.post(`/api/drafts/${draftId}/payment`);
  expect(p.status(), 'create QR').toBe(201);
  const { ref } = await json(p);
  const pay = await s.api.post(`/api/test/payments/${ref}/pay`, { data: { amount: fee } });
  expect(pay.status(), 'pay').toBe(200);
  const g = await json(await s.api.get(`/api/payments/${ref}`));
  expect(g.caseNo).toMatch(/^EG-\d{4}-\d{6}$/);
  return { s, draftId: draftId as string, ref: ref as string, fee: fee as number, caseNo: g.caseNo as string };
}

// ---------- assertion ช่วย ----------
export async function expectErr(res: APIResponse, status: number, code?: string, message?: string) {
  expect(res.status()).toBe(status);
  if (code || message) {
    const b = await json(res);
    if (code) expect(b.code).toBe(code);
    if (message) expect(b.message).toBe(message);
  }
}
export const tid = (page: Page, id: string) => page.getByTestId(id);
export const rowOf = (page: Page, testid: string, caseNo: string) =>
  page.locator(`[data-testid="${testid}"][data-case-no="${caseNo}"]`);

export async function expectStatus(page: Page, code: string, thai: string) {
  await expect(tid(page, 'case-status')).toHaveText(thai);
  await expect(tid(page, 'case-status')).toHaveAttribute('data-status', code);
}
export async function attrList(page: Page, testid: string, attr: string): Promise<string[]> {
  return page.locator(`[data-testid="${testid}"]`).evaluateAll((els, a) => els.map((e) => e.getAttribute(a as string) ?? ''), attr);
}
export async function numText(page: Page, testid: string): Promise<number> {
  const t = (await tid(page, testid).first().textContent()) ?? '';
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

// ---------- ปุ่มดำเนินการผ่านหน้าจอ ----------
export async function uiReturn(page: Page, reason: string) {
  if (!(await tid(page, 'return-reason').isVisible().catch(() => false))) await tid(page, 'return-btn').click();
  await tid(page, 'return-reason').fill(reason);
  await tid(page, 'return-submit').click();
}
export async function uiReject(page: Page, reason: string) {
  if (!(await tid(page, 'reject-reason').isVisible().catch(() => false))) await tid(page, 'reject-btn').click();
  await tid(page, 'reject-reason').fill(reason);
  await tid(page, 'reject-submit').click();
}
export async function uiUnmask(page: Page, reason: string) {
  if (!(await tid(page, 'unmask-reason').isVisible().catch(() => false))) await tid(page, 'show-full-id-btn').click();
  await tid(page, 'unmask-reason').fill(reason);
  await tid(page, 'unmask-submit').click();
}

// ---------- Audit ----------
export type AuditRow = { id: string; event: string; actor: string; caseNo: string; role: string; iso: string; transition: string; detail: string };
export async function readAudit(page: Page): Promise<AuditRow[]> {
  return page.locator('[data-testid="audit-row"]').evaluateAll((rows) =>
    rows.map((r) => {
      const q = (id: string) => r.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      return {
        id: r.getAttribute('data-id') ?? '',
        event: r.getAttribute('data-event') ?? '',
        actor: r.getAttribute('data-actor') ?? '',
        caseNo: r.getAttribute('data-case-no') ?? '',
        role: (q('audit-role')?.textContent ?? '').trim(),
        iso: q('audit-time')?.getAttribute('data-iso') ?? '',
        transition: (q('audit-transition')?.textContent ?? '').trim(),
        detail: (q('audit-detail')?.textContent ?? '').trim(),
      };
    }),
  );
}
export async function auditFilter(page: Page, f: { actor?: string; event?: string; from?: string; to?: string } = {}) {
  await tid(page, 'audit-filter-actor').fill(f.actor ?? '');
  await tid(page, 'audit-filter-event').selectOption(f.event ?? '');
  await tid(page, 'audit-filter-from').fill(f.from ?? '');
  await tid(page, 'audit-filter-to').fill(f.to ?? '');
  await tid(page, 'audit-apply-btn').click();
  await page.waitForLoadState('networkidle').catch(() => {});
}
export async function auditPage(s: Sess, f: { actor?: string; event?: string; from?: string; to?: string } = {}): Promise<{ page: Page; rows: AuditRow[] }> {
  const page = await s.newPage();
  await page.goto('/audit');
  await auditFilter(page, f);
  const want = Boolean(f.actor || f.event || f.from || f.to);
  if (want) await page.waitForTimeout(200);
  return { page, rows: await readAudit(page) };
}

// ---------- Dashboard ----------
export type Kpis = { received: string; closed: string; ontime: string; backlog: string; overdue: string };
export async function readKpis(page: Page): Promise<Kpis | null> {
  try {
    const g = async (id: string) => ((await tid(page, id).first().textContent({ timeout: 1500 })) ?? '').trim();
    return {
      received: await g('kpi-received'),
      closed: await g('kpi-closed'),
      ontime: await g('kpi-ontime-pct'),
      backlog: await g('kpi-backlog'),
      overdue: await g('kpi-overdue'),
    };
  } catch { return null; }
}
export async function pickDashboard(page: Page, period: string, service: string) {
  await tid(page, 'period-select').selectOption(period);
  await tid(page, 'service-select').selectOption(service);
}

// ---------- ไฟล์ส่งออก ----------
const NAMES_RE = /สมชาย|สมหญิง|ปิติ|มานะ/;
export const PII_RES = { id13: /\d{13}/, phone: /0\d{9}/, names: NAMES_RE };

export async function pdfText(buf: Buffer): Promise<string> {
  try {
    // @ts-ignore ไม่มี type ของ pdf-parse/lib
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const fn = mod.default ?? mod;
    const r = await fn(buf);
    return String(r.text);
  } catch {
    // ไม่มี pdf-parse: อ่านบรรทัด ASCII ตรง ๆ (ตัดวันที่ metadata D:YYYY… ออก)
    return buf.toString('latin1').replace(/D:\d{8,}[^\s)>]*/g, '');
  }
}
export async function xlsxRows(buf: Buffer): Promise<string[][]> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row: any) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (c: any) => cells.push(String(c.text ?? c.value ?? '').trim()));
    out.push(cells);
  });
  return out;
}

// ---------- keyboard ----------
export async function tabTo(page: Page, testid: string, bad: string[], max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      return { id: el.getAttribute('data-testid') ?? '', tag: el.tagName, visible };
    });
    if (info && !info.visible) bad.push(`${info.tag}[${info.id}] ไม่มี outline/ring`);
    if (info?.id === testid) return;
  }
  throw new Error(`Tab ไม่ถึง ${testid} ภายใน ${max} ครั้ง`);
}
