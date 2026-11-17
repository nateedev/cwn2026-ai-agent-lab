// part2.spec.ts · Playwright ชุด 2 · TC-NOTI · WORKFLOW · DOC · PDPA · DASH · AUDIT · RBAC · NFR (31 TC)
// ผลที่คาดหวังคิดจาก TEST-PLAN / CONTRACT / TEST-DATA เท่านั้น
// รันแบบทีละ test (workers=1) เพราะทุก TC ใช้ฐานข้อมูลเดียวกันและเริ่มด้วย RESET
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  BASE, CIT, NOW0, case_, anon, closeAll, json, reset, setClock, loginStaff, loginCitizen, newPaid, newSession, pdfBuf,
  expectErr, tid, rowOf, expectStatus, attrList, numText, uiReturn, uiReject, uiUnmask, readAudit, auditFilter, auditPage,
  readKpis, pickDashboard, pdfText, xlsxRows, PII_RES, tabTo, type Sess,
} from './helpers2';

test.describe.configure({ timeout: 240_000 });
test.afterEach(async () => { await closeAll(); });

const C = (n: number) => case_(n);
const sortd = (a: string[]) => [...a].sort();

// =====================================================================
// NOTI
// =====================================================================
type Users = { reg1: Sess; reg2: Sess; head: Sess; works: Sess };
async function notiRead(s: Sess) {
  const page = await s.newPage();
  await page.goto('/notifications');
  const items = await page.locator('[data-testid="noti-item"]').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-case-no')}|${e.getAttribute('data-level')}`));
  return { page, items: items.sort(), bell: await numText(page, 'bell-count') };
}
async function notiApi(s: Sess): Promise<string[]> {
  const r = await s.api.get('/api/notifications');
  expect(r.status()).toBe(200);
  return (await json(r)).items.map((i: any) => `${i.caseNo}|${i.level}`).sort();
}
async function loginFour(browser: any): Promise<Users> {
  const reg1 = await loginStaff(browser, 'off.reg1'); // request แรกกระตุ้นการประเมิน
  const reg2 = await loginStaff(browser, 'off.reg2');
  const head = await loginStaff(browser, 'head1');
  const works = await loginStaff(browser, 'off.works1');
  return { reg1, reg2, head, works };
}
const N01_REG1 = [`${C(24)}|near`, `${C(22)}|near`, `${C(20)}|overdue`];

async function noti01Flow(browser: any): Promise<Users> {
  await reset(browser);
  const u = await loginFour(browser);
  const r1 = await notiRead(u.reg1), r2 = await notiRead(u.reg2), h = await notiRead(u.head), w = await notiRead(u.works);
  expect(r1.items).toEqual(sortd(N01_REG1)); expect(r1.bell).toBe(3);
  expect(r2.items).toEqual([`${C(24)}|near`]); expect(r2.bell).toBe(1);
  expect(h.items).toEqual([`${C(20)}|overdue`]); expect(h.bell).toBe(1);
  expect(w.items).toEqual([]); expect(w.bell).toBe(0);
  await expect(tid(w.page, 'noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
  await expect(r1.page.locator(`[data-testid="noti-item"][data-case-no="${C(24)}"]`)).toHaveText(`คำขอ ${C(24)} ใกล้ครบกำหนด`);
  await expect(r1.page.locator(`[data-testid="noti-item"][data-case-no="${C(20)}"]`)).toHaveText(`คำขอ ${C(20)} เกินกำหนด`);
  expect(await notiApi(u.reg1)).toEqual(sortd(N01_REG1));
  expect(await notiApi(u.works)).toEqual([]);
  // ต่อ: 16:31 แล้วมี request ใด ๆ
  await setClock(await anon(browser), '2026-12-01T16:31:00+07:00');
  expect((await u.reg1.api.get('/api/me')).status()).toBe(200);
  const r1b = await notiRead(u.reg1), hb = await notiRead(u.head), r2b = await notiRead(u.reg2);
  expect(r1b.items).toEqual(sortd([...N01_REG1, `${C(22)}|overdue`])); expect(r1b.bell).toBe(4);
  expect(hb.items).toEqual(sortd([`${C(20)}|overdue`, `${C(22)}|overdue`])); expect(hb.bell).toBe(2);
  expect(r2b.items).toEqual([`${C(24)}|near`]); expect(r2b.bell).toBe(1);
  return u;
}

test('TC-NOTI-01 · ผู้รับแจ้งเตือนตามระดับ', async ({ browser }) => {
  await noti01Flow(browser);
});

test('TC-NOTI-02 · ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ browser }) => {
  // ส่วน A ไม่แจ้งซ้ำ
  const u = await noti01Flow(browser);
  const p = await u.reg1.newPage();
  for (let i = 0; i < 3; i++) { await p.goto('/notifications'); await notiApi(u.reg1); }
  await p.goto('/officer/queue'); await p.goto('/officer/queue');
  const r1 = await notiRead(u.reg1), h = await notiRead(u.head);
  expect(r1.bell).toBe(4); expect(h.bell).toBe(2);
  expect(new Set(r1.items).size).toBe(r1.items.length);
  expect(await notiApi(u.reg1)).toHaveLength(4);
  expect(await notiApi(u.head)).toHaveLength(2);

  // ส่วน B ข้ามระดับ (ส. 5 ธ.ค.)
  await reset(browser);
  await setClock(await anon(browser), '2026-12-05T10:00:00+07:00');
  const b = await loginFour(browser);
  const od = (ns: number[]) => ns.map((n) => `${C(n)}|overdue`);
  const exp = {
    reg1: od([20, 22, 23, 24, 28, 29, 30]),
    reg2: [...od([13, 15, 24, 25, 26, 27, 28, 29, 30]), `${C(16)}|near`],
    works: od([10]),
    head: [...od([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30]), `${C(11)}|near`],
  };
  const got = { reg1: await notiRead(b.reg1), reg2: await notiRead(b.reg2), works: await notiRead(b.works), head: await notiRead(b.head) };
  expect(got.reg1.items).toEqual(sortd(exp.reg1)); expect(got.reg1.bell).toBe(7);
  expect(got.reg2.items).toEqual(sortd(exp.reg2)); expect(got.reg2.bell).toBe(10);
  expect(got.works.items).toEqual(sortd(exp.works)); expect(got.works.bell).toBe(1);
  expect(got.head.items).toEqual(sortd(exp.head)); expect(got.head.bell).toBe(15);
  // 000024: ไม่มี near ย้อนหลัง
  for (const k of ['reg1', 'reg2', 'head'] as const) {
    expect(got[k].items.filter((x) => x.startsWith(C(24)))).toEqual([`${C(24)}|overdue`]);
  }

  // ส่วน C ขั้นรออนุมัติ/รอออกเอกสาร
  await reset(browser);
  const aa = await anon(browser);
  await setClock(aa, '2026-12-04T09:00:00+07:00');
  const head = await loginStaff(browser, 'head1');
  const reg1 = await loginStaff(browser, 'off.reg1');
  const reg2 = await loginStaff(browser, 'off.reg2');
  const mine = async (s: Sess, n: number) => (await notiApi(s)).filter((x) => x.startsWith(C(n))).sort();
  expect(await mine(head, 14)).toEqual([`${C(14)}|near`]);
  expect(await mine(reg1, 14)).toEqual([]); expect(await mine(reg2, 14)).toEqual([]);
  await setClock(aa, '2026-12-04T16:31:00+07:00');
  await head.api.get('/api/me');
  expect(await mine(head, 14)).toEqual(sortd([`${C(14)}|near`, `${C(14)}|overdue`]));
  expect(await mine(reg1, 14)).toEqual([]); expect(await mine(reg2, 14)).toEqual([]);
  await setClock(aa, '2026-12-08T09:00:00+07:00');
  await reg1.api.get('/api/me');
  expect(await mine(reg1, 19)).toEqual([`${C(19)}|near`]);
  expect(await mine(reg2, 19)).toEqual([]); expect(await mine(head, 19)).toEqual([]);
  await setClock(aa, '2026-12-09T16:31:00+07:00');
  await reg1.api.get('/api/me');
  expect(await mine(reg1, 19)).toEqual(sortd([`${C(19)}|near`, `${C(19)}|overdue`]));
  expect(await mine(head, 19)).toEqual([`${C(19)}|overdue`]);
  expect(await mine(reg2, 19)).toEqual([]);
});

// =====================================================================
// WORKFLOW
// =====================================================================
test('TC-WORKFLOW-01 · SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const page = await reg2.newPage();
  await page.goto(`/officer/cases/${C(25)}`);
  // 1
  await expectStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await expect(tid(page, 'approve-btn')).toHaveCount(1);
  await expect(tid(page, 'return-btn')).toHaveCount(1);
  await expect(tid(page, 'reject-btn')).toHaveCount(1);
  await expect(tid(page, 'forward-btn')).toHaveCount(0);
  await expect(tid(page, 'issue-btn')).toHaveCount(0);
  await expect(tid(page, 'case-fee')).toHaveText('฿60');
  // 2
  const reg1 = await loginStaff(browser, 'off.reg1');
  await expectErr(await reg1.api.post(`/api/cases/${C(26)}/approve`), 403, 'FORBIDDEN');
  // 3
  await tid(page, 'approve-btn').click();
  await expectStatus(page, 'APPROVED', 'อนุมัติ');
  await expect(tid(page, 'issue-btn')).toHaveCount(1);
  await expect(tid(page, 'approve-btn')).toHaveCount(0);
  // 4
  await tid(page, 'issue-btn').click();
  await expectStatus(page, 'COMPLETED', 'เสร็จสิ้น');
  await expect(tid(page, 'doc-no')).toHaveText('DOC-2569-000002');
  await expect(tid(page, 'verify-code')).toHaveText(/^[A-Z0-9]{8}$/);
  await expect(tid(page, 'closed-at')).toHaveAttribute('data-iso', NOW0);
  await expect(tid(page, 'sla-level')).toHaveText('ปิดแล้ว');
  // 5
  const sy = await loginCitizen(browser, CIT.somying);
  const cp = await sy.newPage();
  await cp.goto(`/citizen/cases/${C(25)}`);
  await expectStatus(cp, 'COMPLETED', 'เสร็จสิ้น');
  await expect(tid(cp, 'download-doc-btn')).toHaveCount(1);
  const pdf = await sy.api.get('/api/documents/DOC-2569-000002/pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect(pdf.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  expect((await pdf.body()).toString('latin1')).toContain('docNo=DOC-2569-000002 caseNo=EG-2569-000025');
  // 6
  const ex = await loginStaff(browser, 'exec1');
  const d = await json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
  expect(d.closed).toBe(1); expect(d.onTime).toBe(1); expect(d.received).toBe(3); expect(d.backlog).toBe(20);
});

test('TC-WORKFLOW-02 · SV-02 ผ่านหัวหน้า', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const page = await reg2.newPage();
  await page.goto(`/officer/cases/${C(13)}`);
  await expect(tid(page, 'approve-btn')).toHaveCount(0);
  await expect(tid(page, 'forward-btn')).toHaveCount(1);
  await expect(tid(page, 'forward-target')).toHaveCount(0);
  await tid(page, 'forward-btn').click();
  await expectStatus(page, 'PENDING_APPROVAL', 'รออนุมัติ');
  await page.goto('/officer/queue');
  await expect(tid(page, 'workload-count')).toHaveText('8');
  await expect(rowOf(page, 'queue-row', C(13))).toHaveCount(0);
  // 3
  const head = await loginStaff(browser, 'head1');
  const hp = await head.newPage();
  await hp.goto('/head/approvals');
  await expect(tid(hp, 'approval-row')).toHaveCount(3);
  expect(await attrList(hp, 'approval-row', 'data-case-no')).toEqual([C(13), C(14), C(11)]);
  // 4
  await hp.locator(`[data-testid="approval-row"][data-case-no="${C(13)}"]`).getByTestId('approval-open').click();
  await expect(tid(hp, 'approve-btn')).toHaveCount(1);
  await expect(tid(hp, 'reject-btn')).toHaveCount(1);
  await expect(tid(hp, 'issue-btn')).toHaveCount(0);
  // 5
  await tid(hp, 'approve-btn').click();
  await expectStatus(hp, 'APPROVED', 'อนุมัติ');
  await expect(tid(hp, 'issue-btn')).toHaveCount(0);
  // 6
  const reg1 = await loginStaff(browser, 'off.reg1');
  const r1p = await reg1.newPage();
  await r1p.goto(`/officer/cases/${C(13)}`);
  await expect(tid(r1p, 'issue-btn')).toHaveCount(0);
  await expectErr(await reg1.api.post(`/api/officer/cases/${C(13)}/issue`), 403, 'FORBIDDEN');
  // 7
  await page.goto(`/officer/cases/${C(13)}`);
  await tid(page, 'issue-btn').click();
  await expectStatus(page, 'COMPLETED', 'เสร็จสิ้น');
  await expect(tid(page, 'doc-no')).toHaveText('DOC-2569-000002');
  const code = ((await tid(page, 'verify-code').textContent()) ?? '').trim();
  const an = await anon(browser); const vp = await an.newPage();
  await vp.goto(`/verify/${code}`);
  await expect(tid(vp, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
  // 8
  await reset(browser);
  const reg1b = await loginStaff(browser, 'off.reg1');
  const p8 = await reg1b.newPage();
  await p8.goto(`/officer/cases/${C(19)}`);
  await tid(p8, 'issue-btn').click();
  await expectStatus(p8, 'COMPLETED', 'เสร็จสิ้น');
  await expect(tid(p8, 'doc-no')).toHaveText('DOC-2569-000002');
  const code2 = ((await tid(p8, 'verify-code').textContent()) ?? '').trim();
  const an2 = await anon(browser); const vp2 = await an2.newPage();
  await vp2.goto(`/verify/${code2}`);
  await expect(tid(vp2, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-03 · SV-03 สามขั้นตอน', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const page = await reg2.newPage();
  await page.goto(`/officer/cases/${C(12)}`);
  await expect(tid(page, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
  await expect(tid(page, 'case-fee')).toHaveText('฿1,010');
  await expect(tid(page, 'forward-btn')).toHaveCount(1);
  await tid(page, 'forward-btn').click();
  await expectStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await expect(tid(page, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
  await expect(tid(page, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');
  await page.goto('/officer/queue');
  await expect(tid(page, 'workload-count')).toHaveText('8');
  await expect(rowOf(page, 'queue-row', C(12))).toHaveCount(0);
  await expect(tid(page, 'queue-row')).toHaveCount(16);
  // 4
  const works = await loginStaff(browser, 'off.works1');
  const wp = await works.newPage();
  await wp.goto('/officer/queue');
  await expect(tid(wp, 'queue-row')).toHaveCount(2);
  expect(await attrList(wp, 'queue-row', 'data-case-no')).toEqual([C(10), C(12)]);
  await expect(tid(wp, 'claim-btn')).toHaveCount(2);
  // 5
  const reg1 = await loginStaff(browser, 'off.reg1');
  await expectErr(await reg1.api.post(`/api/officer/cases/${C(12)}/claim`), 403, 'FORBIDDEN');
  // 6
  await wp.goto(`/officer/cases/${C(12)}`);
  await tid(wp, 'claim-btn').click();
  await expect(tid(wp, 'case-owner')).toHaveText('off.works1');
  await tid(wp, 'forward-btn').click();
  await expectStatus(wp, 'PENDING_APPROVAL', 'รออนุมัติ');
  await expect(tid(wp, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  // 7
  const head = await loginStaff(browser, 'head1');
  const hp = await head.newPage();
  await hp.goto('/head/approvals');
  await expect(tid(hp, 'approval-row')).toHaveCount(3);
  await expect(rowOf(hp, 'approval-row', C(12))).toHaveCount(1);
  await rowOf(hp, 'approval-row', C(12)).getByTestId('approval-open').click();
  await tid(hp, 'approve-btn').click();
  await expectStatus(hp, 'APPROVED', 'อนุมัติ');
  // 8
  await wp.goto(`/officer/cases/${C(12)}`);
  await expect(tid(wp, 'issue-btn')).toHaveCount(0);
  await page.goto(`/officer/cases/${C(12)}`);
  await expect(tid(page, 'issue-btn')).toHaveCount(1);
  await tid(page, 'issue-btn').click();
  await expectStatus(page, 'COMPLETED', 'เสร็จสิ้น');
  const code = ((await tid(page, 'verify-code').textContent()) ?? '').trim();
  const vp = await (await anon(browser)).newPage();
  await vp.goto(`/verify/${code}`);
  await expect(tid(vp, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-04 · ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser }) => {
  const R = 'xxxxxxxxxx';
  // ส่วน A
  await reset(browser);
  const reg1 = await loginStaff(browser, 'off.reg1');
  const sc = await loginCitizen(browser, CIT.somchai);
  const page = await reg1.newPage();
  await page.goto(`/officer/cases/${C(20)}`);
  await expect(tid(page, 'return-count')).toHaveText('0');
  await uiReturn(page, R);
  await expectStatus(page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
  await expect(tid(page, 'return-count')).toHaveText('1');
  expect((await sc.api.post(`/api/cases/${C(20)}/resubmit`)).status()).toBe(200);
  let g = await json(await reg1.api.get(`/api/cases/${C(20)}`));
  expect(g.status).toBe('IN_REVIEW'); expect(g.owner).toBe('off.reg1');
  const r2 = await json(await reg1.api.post(`/api/officer/cases/${C(20)}/return`, { data: { reason: R } }));
  expect(r2.status).toBe('NEED_FIX'); expect(r2.returnCount).toBe(2);
  expect((await sc.api.post(`/api/cases/${C(20)}/resubmit`)).status()).toBe(200);
  await page.goto(`/officer/cases/${C(20)}`);
  await expectStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await expect(tid(page, 'return-btn')).toHaveCount(0);
  await expectErr(await reg1.api.post(`/api/officer/cases/${C(20)}/return`, { data: { reason: R } }), 409, 'RETURN_LIMIT', 'ตีกลับได้สูงสุด 2 ครั้ง');
  g = await json(await reg1.api.get(`/api/cases/${C(20)}`));
  expect(g.status).toBe('IN_REVIEW'); expect(g.returnCount).toBe(2);
  await expect(tid(page, 'return-count')).toHaveText('2');
  await expect(tid(page, 'approve-btn')).toHaveCount(1);
  await expect(tid(page, 'reject-btn')).toHaveCount(1);

  // ส่วน B
  await reset(browser);
  const b1 = await loginStaff(browser, 'off.reg1');
  const bp = await b1.newPage();
  await bp.goto(`/officer/cases/${C(23)}`);
  await expect(tid(bp, 'return-count')).toHaveText('2');
  await expect(tid(bp, 'return-btn')).toHaveCount(0);
  await expectErr(await b1.api.post(`/api/officer/cases/${C(23)}/return`, { data: { reason: R } }), 409, 'RETURN_LIMIT');
  await expectStatus(bp, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await expect(tid(bp, 'approve-btn')).toHaveCount(1);
  await expect(tid(bp, 'reject-btn')).toHaveCount(1);

  // ส่วน C
  await reset(browser);
  const c2 = await loginStaff(browser, 'off.reg2');
  const cc = await loginCitizen(browser, CIT.somchai);
  for (let i = 0; i < 2; i++) {
    expect((await c2.api.post(`/api/officer/cases/${C(13)}/return`, { data: { reason: R } })).status()).toBe(200);
    expect((await cc.api.post(`/api/cases/${C(13)}/resubmit`)).status()).toBe(200);
  }
  const cpg = await c2.newPage();
  await cpg.goto(`/officer/cases/${C(13)}`);
  await expect(tid(cpg, 'return-btn')).toHaveCount(0);
  await expect(tid(cpg, 'approve-btn')).toHaveCount(0);
  await expect(tid(cpg, 'reject-btn')).toHaveCount(0);
  await expect(tid(cpg, 'forward-btn')).toHaveCount(1);
  expect((await c2.api.post(`/api/cases/${C(13)}/reject`, { data: { reason: R } })).status()).toBe(403);
  await tid(cpg, 'forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
  await tid(cpg, 'forward-btn').click();
  await expectStatus(cpg, 'PENDING_APPROVAL', 'รออนุมัติ');
  const aud = await loginStaff(browser, 'audit1');
  const { rows } = await auditPage(aud, { event: 'FORWARD' });
  const fr = rows.filter((r) => r.caseNo === C(13));
  expect(fr.length).toBeGreaterThanOrEqual(1);
  expect(fr.some((r) => r.detail.includes('ส่งต่อให้หัวหน้าพิจารณา'))).toBe(true);
  const head = await loginStaff(browser, 'head1');
  const hp = await head.newPage();
  await hp.goto(`/officer/cases/${C(13)}`);
  await expect(tid(hp, 'reject-btn')).toHaveCount(1);
  await expect(tid(hp, 'approve-btn')).toHaveCount(1);
});

test('TC-WORKFLOW-05 · เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ browser }) => {
  const MSG = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
  const R9 = 'xxxxxxxxx', R10 = 'xxxxxxxxxx', SP = ' '.repeat(10);
  // A
  await reset(browser);
  const reg1 = await loginStaff(browser, 'off.reg1');
  const page = await reg1.newPage();
  await page.goto(`/officer/cases/${C(20)}`);
  await uiReturn(page, R9);
  await expect(tid(page, 'return-reason-error')).toHaveText(MSG);
  await expectErr(await reg1.api.post(`/api/officer/cases/${C(20)}/return`, { data: { reason: R9 } }), 400, 'REASON_TOO_SHORT', MSG);
  await expectStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
  await uiReturn(page, SP);
  await expect(tid(page, 'return-reason-error')).toHaveText(MSG);
  await expectErr(await reg1.api.post(`/api/officer/cases/${C(20)}/return`, { data: { reason: SP } }), 400, 'REASON_TOO_SHORT');
  await uiReturn(page, R10);
  await expectStatus(page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
  const sc = await loginCitizen(browser, CIT.somchai);
  const cp = await sc.newPage();
  await cp.goto(`/citizen/cases/${C(20)}`);
  await expect(tid(cp, 'return-reason-display')).toHaveText(R10);
  // B
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const bp = await reg2.newPage();
  await bp.goto(`/officer/cases/${C(26)}`);
  await uiReject(bp, R9);
  await expect(tid(bp, 'reject-reason-error')).toHaveText(MSG);
  await expectErr(await reg2.api.post(`/api/cases/${C(26)}/reject`, { data: { reason: R9 } }), 400, 'REASON_TOO_SHORT');
  await uiReject(bp, R10);
  await expectStatus(bp, 'REJECTED', 'ไม่อนุมัติ');
  await expect(tid(bp, 'closed-at')).toHaveAttribute('data-iso', NOW0);
  await expect(tid(bp, 'sla-level')).toHaveText('ปิดแล้ว');
  const sc2 = await loginCitizen(browser, CIT.somchai);
  const cp2 = await sc2.newPage();
  await cp2.goto(`/citizen/cases/${C(26)}`);
  await expect(tid(cp2, 'no-refund-note')).toHaveCount(1);
  const ex = await loginStaff(browser, 'exec1');
  const d = await json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
  expect(d.closed).toBe(1); expect(d.onTime).toBe(1);
  // C
  await reset(browser);
  const head = await loginStaff(browser, 'head1');
  const hp = await head.newPage();
  await hp.goto(`/officer/cases/${C(11)}`);
  await uiReject(hp, R9);
  await expect(tid(hp, 'reject-reason-error')).toHaveText(MSG);
  await expectErr(await head.api.post(`/api/cases/${C(11)}/reject`, { data: { reason: R9 } }), 400, 'REASON_TOO_SHORT');
  await uiReject(hp, R10);
  await expectStatus(hp, 'REJECTED', 'ไม่อนุมัติ');
});

test('TC-WORKFLOW-06 · เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
  // หน้าตั้งต้น
  await reset(browser);
  const s0 = await loginCitizen(browser, CIT.somchai);
  const p0 = await s0.newPage();
  await p0.goto(`/citizen/cases/${C(17)}`);
  await expectStatus(p0, 'NEED_FIX', 'รอแก้ไขเอกสาร');
  await expect(tid(p0, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
  await expect(tid(p0, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
  await expect(tid(p0, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
  await expect(tid(p0, 'submit-fix-btn')).toHaveCount(1);
  // A 167:59
  const a0 = await reset(browser);
  await setClock(a0, '2026-12-04T13:59:00+07:00');
  const sa = await loginCitizen(browser, CIT.somchai);
  const pa = await sa.newPage();
  await pa.goto(`/citizen/cases/${C(17)}`);
  await expect(tid(pa, 'submit-fix-btn')).toBeEnabled();
  const ra = await sa.api.post(`/api/cases/${C(17)}/resubmit`);
  expect(ra.status()).toBe(200);
  expect((await json(ra)).status).toBe('IN_REVIEW');
  await pa.reload();
  await expectStatus(pa, 'IN_REVIEW', 'กำลังตรวจสอบ');
  // B 168:00
  const b0 = await reset(browser);
  await setClock(b0, '2026-12-04T14:00:00+07:00');
  const sb = await loginCitizen(browser, CIT.somchai);
  const pb = await sb.newPage();
  await pb.goto(`/citizen/cases/${C(17)}`);
  await expectStatus(pb, 'CANCELLED', 'ยกเลิก');
  await expect(tid(pb, 'submit-fix-btn')).toHaveCount(0);
  await expect(tid(pb, 'no-refund-note')).toHaveCount(1);
  expect((await sb.api.post(`/api/cases/${C(17)}/resubmit`)).status()).toBe(409);
  await expect(pb.locator('[data-testid="case-timeline"] [data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]')).toHaveCount(1);
  const ex = await loginStaff(browser, 'exec1');
  const d = await json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
  expect(d.backlog).toBe(20);
});

// =====================================================================
// DOC
// =====================================================================
async function issueFlow(s: Sess, caseNo: string, approve = true) {
  if (approve) expect((await s.api.post(`/api/cases/${caseNo}/approve`)).status()).toBe(200);
  const r = await s.api.post(`/api/officer/cases/${caseNo}/issue`);
  expect(r.status()).toBe(200);
  return json(r);
}
async function verifyAt(an: Sess, code: string, clock?: string) {
  if (clock) await setClock(an, clock);
  const page = await an.newPage();
  const resp = await page.goto(`/verify/${code}`);
  const out = {
    status: resp!.status(),
    result: await tid(page, 'verify-result').getAttribute('data-result'),
    text: ((await tid(page, 'verify-result').textContent()) ?? '').trim(),
    // B13: TAMPERED/NOT_FOUND ไม่มี verify-expires → อย่ารอ element (เดิมค้างจน timeout)
    expires: (await tid(page, 'verify-expires').count()) ? await tid(page, 'verify-expires').getAttribute('data-iso') : null,
    page,
  };
  return out;
}

test('TC-DOC-01 · ออกเอกสารและข้อมูลในเอกสาร', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const iss = await issueFlow(reg2, C(25));
  expect(iss.docNo).toBe('DOC-2569-000002'); expect(iss.status).toBe('COMPLETED');
  expect(iss.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
  const code = iss.verifyCode as string;
  const sy = await loginCitizen(browser, CIT.somying);
  const pdf = await sy.api.get('/api/documents/DOC-2569-000002/pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect(pdf.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  expect((await pdf.body()).toString('latin1')).toContain(`docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${code} validUntil=2027-02-28`);
  // /verify
  const an = await anon(browser);
  const v = await verifyAt(an, code);
  expect(v.status).toBe(200);
  await expect(tid(v.page, 'verify-result')).toHaveText('เอกสารถูกต้อง');
  await expect(tid(v.page, 'verify-doc-no')).toHaveText('DOC-2569-000002');
  await expect(tid(v.page, 'verify-applicant')).toHaveText('สมหญิง ร***');
  await expect(tid(v.page, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
  await expect(tid(v.page, 'verify-issued')).toHaveAttribute('data-iso', NOW0);
  await expect(tid(v.page, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
  await expect(tid(v.page, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');
  // doc-qr
  const op = await reg2.newPage();
  await op.goto(`/officer/cases/${C(25)}`);
  await expect(tid(op, 'doc-qr')).toHaveAttribute('data-url', `${BASE}/verify/${code}`);
  // API verify
  const av = await an.api.get(`/api/verify/${code}`);
  expect(av.status()).toBe(200);
  const avj = await json(av);
  expect(avj.result).toBe('VALID'); expect(avj.validUntil).toBe('2027-02-28'); expect(avj.issuedAt).toBe(NOW0);
  // ผู้ที่ไม่ใช่ผู้ยื่น
  const sc = await loginCitizen(browser, CIT.somchai);
  expect((await sc.api.get('/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);
  // issue ซ้ำ
  await expectErr(await reg2.api.post(`/api/officer/cases/${C(25)}/issue`), 409, 'INVALID_STATE');
  // เอกสารถัดไปยังเป็น 000003 (ออกใบอื่น)
  const reg1 = await loginStaff(browser, 'off.reg1');
  const nxt = await issueFlow(reg1, C(19), false);
  expect(nxt.docNo).toBe('DOC-2569-000003');
});

test('TC-DOC-02 · ตรวจเอกสาร /verify', async ({ browser }) => {
  await reset(browser);
  const an = await anon(browser);
  const page = await an.newPage();
  const resp = await page.goto('/verify/K7M2Q9XA');
  expect(resp!.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/verify/K7M2Q9XA');
  await expect(tid(page, 'verify-result')).toHaveText('เอกสารถูกต้อง');
  await expect(tid(page, 'verify-result')).toHaveAttribute('data-result', 'VALID');
  await expect(tid(page, 'verify-doc-no')).toHaveText('DOC-2569-000001');
  await expect(tid(page, 'verify-applicant')).toHaveText('สมชาย ใ***');
  await expect(tid(page, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
  await expect(tid(page, 'verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
  await expect(tid(page, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
  await expect(tid(page, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('ใจดี'); expect(body).not.toContain('1101700123456');
  const p2 = await an.newPage();
  const r2 = await p2.goto('/verify/ZZZZZZZZ');
  expect(r2!.status()).toBe(404);
  await expect(tid(p2, 'verify-result')).toHaveText('ไม่พบเอกสาร');
  await expect(tid(p2, 'verify-result')).toHaveAttribute('data-result', 'NOT_FOUND');
  await expect(tid(p2, 'verify-applicant')).toHaveCount(0);
  await expect(tid(p2, 'verify-doc-no')).toHaveCount(0);
  const a1 = await an.api.get('/api/verify/K7M2Q9XA');
  expect(a1.status()).toBe(200);
  const j1 = await json(a1);
  expect(j1.result).toBe('VALID'); expect(j1.applicantMasked).toBe('สมชาย ใ***');
  expect(JSON.stringify(j1)).not.toContain('ใจดี');
  const a2 = await an.api.get('/api/verify/ZZZZZZZZ');
  expect(a2.status()).toBe(404);
  expect(await json(a2)).toEqual({ result: 'NOT_FOUND' });
});

test('TC-DOC-03 · เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
  const check = async (an: Sess, code: string, clock: string, thai: string, result: string, expires?: string) => {
    const v = await verifyAt(an, code, clock);
    expect(v.status, clock).toBe(200);
    expect(v.text, clock).toBe(thai);
    expect(v.result, clock).toBe(result);
    if (expires) expect(v.expires, clock).toBe(expires);
    await v.page.close();
  };
  // A
  await reset(browser);
  let reg2 = await loginStaff(browser, 'off.reg2');
  const c1 = (await issueFlow(reg2, C(25))).verifyCode;
  let an = await anon(browser);
  await check(an, c1, '2027-02-28T23:59:00+07:00', 'เอกสารถูกต้อง', 'VALID', '2027-02-28');
  await check(an, c1, '2027-03-01T00:00:00+07:00', 'เอกสารหมดอายุ', 'EXPIRED', '2027-02-28');
  // B
  await reset(browser);
  const reg1 = await loginStaff(browser, 'off.reg1');
  const c2 = (await issueFlow(reg1, C(19), false)).verifyCode;
  an = await anon(browser);
  await check(an, c2, '2027-11-30T23:59:00+07:00', 'เอกสารถูกต้อง', 'VALID', '2027-11-30');
  await check(an, c2, '2027-12-01T00:00:00+07:00', 'เอกสารหมดอายุ', 'EXPIRED');
  // C
  await reset(browser);
  an = await anon(browser);
  await check(an, 'K7M2Q9XA', '2027-02-02T23:59:00+07:00', 'เอกสารถูกต้อง', 'VALID');
  await check(an, 'K7M2Q9XA', '2027-02-03T00:00:00+07:00', 'เอกสารหมดอายุ', 'EXPIRED');
  // E 29 ก.พ.
  const e0 = await reset(browser);
  await setClock(e0, '2028-02-29T10:00:00+07:00');
  reg2 = await loginStaff(browser, 'off.reg2');
  const e1 = await issueFlow(reg2, C(25));
  const reg1e = await loginStaff(browser, 'off.reg1');
  const e2 = await issueFlow(reg1e, C(19), false);
  expect(e1.docNo).toBe('DOC-2571-000001'); expect(e2.docNo).toBe('DOC-2571-000002');
  an = await anon(browser);
  await check(an, e1.verifyCode, '2028-05-28T23:59:00+07:00', 'เอกสารถูกต้อง', 'VALID', '2028-05-28');
  await check(an, e1.verifyCode, '2028-05-29T00:00:00+07:00', 'เอกสารหมดอายุ', 'EXPIRED');
  await check(an, e2.verifyCode, '2029-02-27T23:59:00+07:00', 'เอกสารถูกต้อง', 'VALID', '2029-02-27');
  await check(an, e2.verifyCode, '2029-02-28T00:00:00+07:00', 'เอกสารหมดอายุ', 'EXPIRED');
  // D
  await reset(browser);
  an = await anon(browser);
  const t = await an.api.post('/api/test/documents/DOC-2569-000001/tamper');
  expect(t.status()).toBe(200); expect(await json(t)).toEqual({ ok: true });
  const v = await verifyAt(an, 'K7M2Q9XA');
  expect(v.text).toBe('ลายเซ็นไม่ถูกต้อง'); expect(v.result).toBe('TAMPERED');
  await expect(tid(v.page, 'verify-doc-no')).toHaveCount(0);
  await expect(tid(v.page, 'verify-applicant')).toHaveCount(0);
  await check(an, 'K7M2Q9XA', '2027-03-01T00:00:00+07:00', 'ลายเซ็นไม่ถูกต้อง', 'TAMPERED');
});

// =====================================================================
// PDPA
// =====================================================================
test('TC-PDPA-01 · ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const page = await reg2.newPage();
  await page.goto('/officer/queue');
  await expect(tid(page, 'row-id-masked').first()).toBeVisible();
  const all = await tid(page, 'row-id-masked').allTextContents();
  expect(all.length).toBeGreaterThan(0);
  for (const t of all) expect(t.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
  await expect(rowOf(page, 'queue-row', C(25)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
  await expect(rowOf(page, 'queue-row', C(26)).getByTestId('row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');
  await page.goto(`/officer/cases/${C(25)}`);
  await expect(tid(page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  const html = await page.content();
  expect(html).not.toContain('3100600987659'); expect(html).not.toContain('3-1006-00987-65-9');
  const head = await loginStaff(browser, 'head1');
  const hp = await head.newPage();
  await hp.goto(`/officer/cases/${C(25)}`);
  await expect(tid(hp, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  const sy = await loginCitizen(browser, CIT.somying);
  const sp = await sy.newPage();
  await sp.goto(`/citizen/cases/${C(25)}`);
  await expect(tid(sp, 'case-id-full')).toHaveText('3-1006-00987-65-9');
  const sc = await loginCitizen(browser, CIT.somchai);
  const cp = await sc.newPage();
  await cp.goto(`/citizen/cases/${C(20)}`);
  await expect(tid(cp, 'case-id-full')).toHaveText('1-1017-00123-45-6');
});

function deepHasKey(o: any, key: string): boolean {
  if (Array.isArray(o)) return o.some((x) => deepHasKey(x, key));
  if (o && typeof o === 'object') return Object.keys(o).some((k) => k === key || deepHasKey(o[k], key));
  return false;
}
function collectMasked(o: any, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => collectMasked(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'idMasked') out.push(String(v)); else collectMasked(v, out); }
  return out;
}

test('TC-PDPA-02 · API (JSON) ไม่ส่งเลขบัตรเต็ม', async ({ browser }) => {
  await reset(browser);
  const paths = ['/api/officer/queue?filter=all', `/api/cases/${C(25)}`, `/api/cases/${C(26)}`, `/api/cases/${C(20)}`, '/api/notifications', `/api/cases/${C(25)}/files`];
  for (const user of ['off.reg1', 'head1']) {
    const s = await loginStaff(browser, user);
    for (const p of paths) {
      const r = await s.api.get(p);
      expect(r.status(), `${user} ${p}`).toBe(200);
      expect(r.headers()['content-type']).toContain('application/json');
      const b = await r.json();
      const str = JSON.stringify(b);
      expect(str, `${user} ${p}`).not.toMatch(/\d{13}/);
      expect(str, `${user} ${p}`).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
      expect(deepHasKey(b, 'idNo'), `${user} ${p} idNo`).toBe(false);
      for (const n of ['3100600987659', '1101700123456', '1909900555015']) expect(str).not.toContain(n);
      for (const m of collectMasked(b)) expect(m).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
      if (p.startsWith('/api/officer/queue')) {
        expect(b.items.length).toBeGreaterThan(0);
        for (const it of b.items) expect(it.idMasked).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
      }
    }
  }
});

test('TC-PDPA-03 · แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const page = await reg2.newPage();
  await page.goto(`/officer/cases/${C(25)}`);
  await tid(page, 'show-full-id-btn').click();
  await tid(page, 'unmask-submit').click();
  await expect(tid(page, 'unmask-error')).toHaveText('กรุณากรอกเหตุผล');
  await expect(tid(page, 'full-id')).toHaveCount(0);
  await expectErr(await reg2.api.post(`/api/officer/cases/${C(25)}/unmask`, { data: { reason: '' } }), 400, 'REASON_REQUIRED');
  await uiUnmask(page, '   ');
  await expect(tid(page, 'unmask-error')).toHaveText('กรุณากรอกเหตุผล');
  await expect(tid(page, 'full-id')).toHaveCount(0);
  await expectErr(await reg2.api.post(`/api/officer/cases/${C(25)}/unmask`, { data: { reason: '   ' } }), 400, 'REASON_REQUIRED');
  await uiUnmask(page, 'ตรวจสอบตัวตนซ้ำ');
  await expect(tid(page, 'full-id')).toHaveText('3-1006-00987-65-9');
  await page.reload();
  await expect(tid(page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
  await expect(tid(page, 'full-id')).toHaveCount(0);
  const aud = await loginStaff(browser, 'audit1');
  const { page: ap, rows } = await auditPage(aud, { event: 'UNMASK' });
  await expect.poll(async () => numText(ap, 'audit-count')).toBe(1);
  expect(rows).toHaveLength(1);
  const r = rows[0];
  expect(r.actor).toBe('off.reg2'); expect(r.role).toBe('officer'); expect(r.caseNo).toBe(C(25));
  expect(r.event).toBe('UNMASK'); expect(r.detail).toContain('ตรวจสอบตัวตนซ้ำ'); expect(r.iso).toBe(NOW0);
  for (const s of [await loginStaff(browser, 'exec1'), aud, await loginCitizen(browser, CIT.somying)]) {
    expect((await s.api.post(`/api/officer/cases/${C(25)}/unmask`, { data: { reason: 'x' } })).status()).toBe(403);
  }
});

// =====================================================================
// DASH
// =====================================================================
const BAD_PII = (t: string) => {
  expect(t).not.toMatch(PII_RES.id13); expect(t).not.toMatch(PII_RES.phone); expect(t).not.toMatch(PII_RES.names);
};

test('TC-DASH-01 · Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
  await reset(browser);
  const ex = await loginStaff(browser, 'exec1');
  const page = await ex.newPage();
  await page.goto('/dashboard');
  await expect(tid(page, 'period-select')).toHaveValue('2026-12');
  await expect(tid(page, 'service-select')).toHaveValue('ALL');
  await expect(tid(page, 'kpi-received')).toHaveText('3');
  await expect(tid(page, 'kpi-closed')).toHaveText('0');
  await expect(tid(page, 'kpi-ontime-pct')).toHaveText('–');
  await expect(tid(page, 'kpi-backlog')).toHaveText('21');
  await expect(tid(page, 'kpi-overdue')).toHaveText('1');
  const api = await json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
  expect(api.received).toBe(3); expect(api.closed).toBe(0); expect(api.ontimePct).toBeNull();
  expect(api.backlog).toBe(21); expect(api.overdue).toBe(1);
  await expect(tid(page, 'workload-row')).toHaveCount(3);
  const w: Record<string, string> = {};
  for (const u of ['off.reg1', 'off.reg2', 'off.works1']) {
    w[u] = ((await page.locator(`[data-testid="workload-row"][data-username="${u}"]`).getByTestId('workload-value').textContent()) ?? '').trim();
  }
  expect(w).toEqual({ 'off.reg1': '3', 'off.reg2': '9', 'off.works1': '0' });
  BAD_PII(await page.evaluate(() => document.body.innerText));
  const rows = [
    { s: 'SV-01', r: '3', c: '0', o: '–', b: '11', od: '1' },
    { s: 'SV-02', r: '0', c: '0', o: '–', b: '7', od: '0' },
    { s: 'SV-03', r: '0', c: '0', o: '–', b: '3', od: '0' },
  ];
  for (const x of rows) {
    await pickDashboard(page, '2026-12', x.s);
    await expect.poll(() => readKpis(page)).toEqual({ received: x.r, closed: x.c, ontime: x.o, backlog: x.b, overdue: x.od });
    const a = await json(await ex.api.get(`/api/dashboard?period=2026-12&service=${x.s}`));
    expect([a.received, a.closed, a.backlog, a.overdue]).toEqual([+x.r, +x.c, +x.b, +x.od]);
    expect(a.ontimePct).toBeNull();
  }
});

test('TC-DASH-02 · Dashboard ย้อนหลัง', async ({ browser }) => {
  await reset(browser);
  const ex = await loginStaff(browser, 'exec1');
  const page = await ex.newPage();
  await page.goto('/dashboard');
  const BL: Record<string, [string, string]> = { ALL: ['21', '1'], 'SV-01': ['11', '1'], 'SV-02': ['7', '0'], 'SV-03': ['3', '0'] };
  const T: [string, string, number, number, number, string][] = [
    ['2026-10', 'ALL', 1, 1, 1, '100.0%'],
    ['2026-11', 'ALL', 26, 7, 6, '85.7%'],
    ['2026-11', 'SV-01', 12, 3, 3, '100.0%'],
    ['2026-11', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026-11', 'SV-03', 4, 1, 1, '100.0%'],
    ['2026', 'ALL', 30, 8, 7, '87.5%'],
    ['2026', 'SV-01', 16, 4, 4, '100.0%'],
    ['2026', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026', 'SV-03', 4, 1, 1, '100.0%'],
  ];
  for (const [p, s, rec, clo, on, pct] of T) {
    await pickDashboard(page, p, s);
    const [bk, od] = BL[s];
    await expect.poll(() => readKpis(page), { message: `${p} ${s}` }).toEqual({ received: String(rec), closed: String(clo), ontime: pct, backlog: bk, overdue: od });
    const a = await json(await ex.api.get(`/api/dashboard?period=${p}&service=${s}`));
    expect(a.received).toBe(rec); expect(a.closed).toBe(clo); expect(a.onTime).toBe(on);
    expect(a.ontimePct).toBeCloseTo(parseFloat(pct), 1);
    expect(a.backlog).toBe(+bk); expect(a.overdue).toBe(+od);
  }
});

test('TC-DASH-03 · ส่งออก Excel/PDF เท่าหน้าจอ', async ({ browser }) => {
  await reset(browser);
  const ex = await loginStaff(browser, 'exec1');
  const page = await ex.newPage();
  await page.goto('/dashboard');
  const dl = async (btn: string) => {
    const [d] = await Promise.all([page.waitForEvent('download'), tid(page, btn).click()]);
    const p = await d.path();
    return readFileSync(p!);
  };
  await pickDashboard(page, '2026-11', 'ALL');
  await expect.poll(() => readKpis(page)).toEqual({ received: '26', closed: '7', ontime: '85.7%', backlog: '21', overdue: '1' });
  const screen = await readKpis(page);
  const x1 = await xlsxRows(await dl('export-xlsx-btn'));
  const m1 = Object.fromEntries(x1.slice(1).map((r) => [r[0], r[1]]));
  expect(m1['รับเรื่อง']).toBe('26'); expect(m1['ปิดงาน']).toBe('7'); expect(m1['ทันกำหนด %']).toBe('85.7%');
  expect(m1['งานคงค้าง']).toBe('21'); expect(m1['เกินกำหนดคงค้าง']).toBe('1');
  expect([m1['รับเรื่อง'], m1['ปิดงาน'], m1['ทันกำหนด %'], m1['งานคงค้าง'], m1['เกินกำหนดคงค้าง']]).toEqual(
    [screen!.received, screen!.closed, screen!.ontime, screen!.backlog, screen!.overdue]);
  const pdfB = await dl('export-pdf-btn');
  const pt = await pdfText(pdfB);
  expect(pt).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
  expect(pdfB.subarray(0, 4).toString('latin1')).toBe('%PDF');
  await pickDashboard(page, '2026-12', 'ALL');
  await expect.poll(() => readKpis(page)).toEqual({ received: '3', closed: '0', ontime: '–', backlog: '21', overdue: '1' });
  const x2 = await xlsxRows(await dl('export-xlsx-btn'));
  expect(x2.slice(1, 6).map((r) => r[1])).toEqual(['3', '0', '–', '21', '1']);
  for (const t of [x1.flat().join('\n'), x2.flat().join('\n'), pt]) BAD_PII(t);
  // Audit: EXPORT = 3 (ตรวจก่อนเรียก API ส่งออกซ้ำ)
  const aud = await loginStaff(browser, 'audit1');
  const { page: ap, rows } = await auditPage(aud, { event: 'EXPORT' });
  await expect.poll(async () => numText(ap, 'audit-count')).toBe(3);
  expect(rows).toHaveLength(3);
  for (const r of rows) { expect(r.actor).toBe('exec1'); expect(r.role).toBe('executive'); }
  const det = rows.map((r) => r.detail);
  expect(det.some((d) => d.includes('xlsx') && d.includes('2026-11'))).toBe(true);
  expect(det.some((d) => d.includes('pdf') && d.includes('2026-11'))).toBe(true);
  expect(det.some((d) => d.includes('xlsx') && d.includes('2026-12'))).toBe(true);
  // Content-Type ของ PDF (หลังตรวจ Audit เพื่อไม่ให้เกิดแถว EXPORT เกิน)
  const pr = await ex.api.get('/api/dashboard/export?format=pdf&period=2026-11&service=ALL');
  expect(pr.headers()['content-type']).toContain('application/pdf');
});

test('TC-DASH-04 · ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
  const r0 = await reset(browser);
  await setClock(r0, '2026-12-03T16:00:00+07:00');
  const reg1 = await loginStaff(browser, 'off.reg1');
  const reg2 = await loginStaff(browser, 'off.reg2');
  const ex = await loginStaff(browser, 'exec1');
  const dpage = await ex.newPage();
  await dpage.goto('/dashboard');
  expect((await reg2.api.post(`/api/cases/${C(25)}/approve`)).status()).toBe(200);
  expect((await reg1.api.post(`/api/cases/${C(23)}/approve`)).status()).toBe(200);
  const dash = async () => json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
  const closedAt = async (s: Sess, n: number, iso: string) => {
    const p = await s.newPage();
    await p.goto(`/officer/cases/${C(n)}`);
    await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', iso);
    await p.close();
  };
  const ui = async (n: number) => { await dpage.reload(); await expect(tid(dpage, 'kpi-closed')).toHaveText(String(n)); };
  // 2
  await setClock(r0, '2026-12-03T16:29:59+07:00');
  expect((await reg2.api.post(`/api/officer/cases/${C(25)}/issue`)).status()).toBe(200);
  let d = await dash(); expect([d.closed, d.onTime]).toEqual([1, 1]); await ui(1);
  await closedAt(reg2, 25, '2026-12-03T16:29:59+07:00');
  // 3
  await setClock(r0, '2026-12-03T16:30:00+07:00');
  expect((await reg2.api.post(`/api/cases/${C(26)}/reject`, { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(200);
  d = await dash(); expect([d.closed, d.onTime]).toEqual([2, 2]); await ui(2);
  await closedAt(reg2, 26, '2026-12-03T16:30:00+07:00');
  // 4
  await setClock(r0, '2026-12-03T16:30:01+07:00');
  expect((await reg1.api.post(`/api/officer/cases/${C(23)}/issue`)).status()).toBe(200);
  d = await dash(); expect([d.closed, d.onTime]).toEqual([3, 2]); await ui(3);
  await closedAt(reg1, 23, '2026-12-03T16:30:01+07:00');
  expect(d.backlog).toBe(18);
  await expect(tid(dpage, 'kpi-backlog')).toHaveText('18');
});

// =====================================================================
// AUDIT
// =====================================================================
test('TC-AUDIT-01 · เหตุการณ์และฟิลด์ใน Audit', async ({ browser }) => {
  await reset(browser);
  const R = 'xxxxxxxxxx';
  const reg2 = await loginStaff(browser, 'off.reg2');
  expect((await reg2.api.post(`/api/officer/cases/${C(28)}/claim`)).status()).toBe(200);
  const reg1 = await loginStaff(browser, 'off.reg1');
  expect((await reg1.api.post(`/api/officer/cases/${C(20)}/return`, { data: { reason: R } })).status()).toBe(200);
  expect((await reg2.api.post(`/api/officer/cases/${C(13)}/forward`)).status()).toBe(200);
  const head = await loginStaff(browser, 'head1');
  expect((await head.api.post(`/api/cases/${C(13)}/approve`)).status()).toBe(200);
  expect((await reg2.api.post(`/api/cases/${C(25)}/approve`)).status()).toBe(200);
  expect((await reg2.api.post(`/api/officer/cases/${C(25)}/issue`)).status()).toBe(200);
  expect((await reg2.api.post(`/api/cases/${C(26)}/reject`, { data: { reason: R } })).status()).toBe(200);
  expect((await reg2.api.post(`/api/officer/cases/${C(25)}/unmask`, { data: { reason: 'ตรวจสอบตัวตนซ้ำ' } })).status()).toBe(200);
  const ex = await loginStaff(browser, 'exec1');
  expect((await ex.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200);
  const admin = await loginStaff(browser, 'admin1');
  expect((await admin.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } })).status()).toBe(200);
  const aud = await loginStaff(browser, 'audit1');
  const page = await aud.newPage();
  await page.goto('/audit');
  await expect.poll(async () => numText(page, 'audit-count')).toBe(16);
  const rows = await readAudit(page);
  expect(rows).toHaveLength(16);
  const ids = rows.map((r) => Number(r.id));
  for (let i = 1; i < ids.length; i++) expect(ids[i - 1]).toBeGreaterThan(ids[i]); // ใหม่ → เก่า (เวลาเท่ากันเรียง id มาก → น้อย)
  for (const r of rows) expect(r.iso).toBe(NOW0);
  const by = (e: string) => rows.filter((r) => r.event === e);
  const one = (e: string) => { expect(by(e)).toHaveLength(1); return by(e)[0]; };
  const logins = by('STAFF_LOGIN');
  expect(logins).toHaveLength(6);
  expect(sortd(logins.map((r) => r.actor))).toEqual(sortd(['off.reg2', 'off.reg1', 'head1', 'exec1', 'admin1', 'audit1']));
  for (const r of logins) { expect(r.caseNo).toMatch(/^(–|-|)$/); expect(r.transition).toBe('–'); }
  let r = one('CLAIM'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg2', 'officer', C(28), 'SUBMITTED → IN_REVIEW']);
  r = one('RETURN'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg1', 'officer', C(20), 'IN_REVIEW → NEED_FIX']); expect(r.detail).toContain(R);
  r = one('FORWARD'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg2', 'officer', C(13), 'IN_REVIEW → PENDING_APPROVAL']);
  const ap = by('APPROVE'); expect(ap).toHaveLength(2);
  const aH = ap.find((x) => x.actor === 'head1')!, aR = ap.find((x) => x.actor === 'off.reg2')!;
  expect([aH.role, aH.caseNo, aH.transition]).toEqual(['head', C(13), 'PENDING_APPROVAL → APPROVED']);
  expect([aR.role, aR.caseNo, aR.transition]).toEqual(['officer', C(25), 'IN_REVIEW → APPROVED']);
  r = one('ISSUE'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg2', 'officer', C(25), 'APPROVED → COMPLETED']); expect(r.detail).toContain('DOC-2569-000002');
  r = one('REJECT'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg2', 'officer', C(26), 'IN_REVIEW → REJECTED']); expect(r.detail).toContain(R);
  r = one('UNMASK'); expect([r.actor, r.role, r.caseNo, r.transition]).toEqual(['off.reg2', 'officer', C(25), '–']); expect(r.detail).toContain('ตรวจสอบตัวตนซ้ำ');
  r = one('EXPORT'); expect([r.actor, r.role, r.transition]).toEqual(['exec1', 'executive', '–']); expect(r.detail).toContain('xlsx'); expect(r.detail).toContain('2026-12');
  r = one('ADMIN_CHANGE'); expect([r.actor, r.role, r.transition]).toEqual(['admin1', 'admin', '–']); expect(r.detail).toContain('SV-01 fee 20 → 25');
  // กรอง
  await auditFilter(page, { actor: 'off.reg2' });
  await expect.poll(async () => numText(page, 'audit-count')).toBe(7);
  expect(sortd((await readAudit(page)).map((x) => x.event))).toEqual(sortd(['STAFF_LOGIN', 'CLAIM', 'FORWARD', 'APPROVE', 'ISSUE', 'REJECT', 'UNMASK']));
  await auditFilter(page, { event: 'APPROVE' });
  await expect.poll(async () => numText(page, 'audit-count')).toBe(2);
  expect(sortd((await readAudit(page)).map((x) => x.actor))).toEqual(['head1', 'off.reg2']);
  await auditFilter(page, { actor: 'off.reg2', event: 'APPROVE' });
  await expect.poll(async () => numText(page, 'audit-count')).toBe(1);
  // CSV
  await auditFilter(page, {});
  await expect.poll(async () => numText(page, 'audit-count')).toBe(16);
  const [dl] = await Promise.all([page.waitForEvent('download'), tid(page, 'audit-export-csv-btn').click()]);
  const csv = readFileSync((await dl.path())!, 'utf8').replace(/^﻿/, '');
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  expect(lines[0]).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
  expect(lines.length - 1).toBe(16);
  await page.goto('/audit');
  await expect.poll(async () => numText(page, 'audit-count')).toBe(17);
  const last = (await readAudit(page))[0];
  expect([last.event, last.actor]).toEqual(['EXPORT', 'audit1']);
  expect(last.detail).toContain('audit-csv');
});

test('TC-AUDIT-02 · Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
  await reset(browser);
  const aud = await loginStaff(browser, 'audit1');
  const before = (await json(await aud.api.get('/api/audit'))).items as any[];
  expect(before.length).toBe(1);
  const id = before[0].id;
  const admin = await loginStaff(browser, 'admin1');
  for (const s of [admin, aud]) {
    const calls = [
      await s.api.put(`/api/audit/${id}`, { data: { detail: 'x' } }),
      await s.api.patch(`/api/audit/${id}`, { data: { detail: 'x' } }),
      await s.api.delete(`/api/audit/${id}`),
      await s.api.put('/api/audit', { data: {} }),
      await s.api.delete('/api/audit'),
      await s.api.delete('/api/audit/999999'),
    ];
    for (const c of calls) expect(c.status()).toBe(405);
    const b = await json(calls[0]);
    expect(b.code).toBe('METHOD_NOT_ALLOWED');
  }
  const after = (await json(await aud.api.get('/api/audit'))).items as any[];
  for (const b of before) expect(after.find((a) => a.id === b.id)).toEqual(b);
  const added = after.filter((a) => !before.some((b) => b.id === a.id));
  expect(added).toHaveLength(1);
  expect([added[0].event, added[0].username]).toEqual(['STAFF_LOGIN', 'admin1']);
  const page = await aud.newPage();
  await page.goto('/audit');
  await expect(tid(page, 'audit-row').first()).toBeVisible();
  await expect(tid(page, 'audit-edit-btn')).toHaveCount(0);
  await expect(tid(page, 'audit-delete-btn')).toHaveCount(0);
  expect((await admin.api.get('/api/audit')).status()).toBe(403);
});

test('TC-AUDIT-03 · กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
  const a0 = await reset(browser);
  const L: [string, string, string][] = [
    ['L1', '2026-11-30T23:59:59+07:00', 'off.reg1'],
    ['L2', '2026-12-01T00:00:00+07:00', 'off.reg2'],
    ['L3', '2026-12-01T23:59:59+07:00', 'off.works1'],
    ['L4', '2026-12-02T00:00:00+07:00', 'off.reg1'],
    ['L5', '2026-12-02T09:00:00+07:00', 'audit1'],
  ];
  let aud!: Sess;
  for (const [, clock, user] of L) {
    await setClock(a0, clock);
    const s = await loginStaff(browser, user);
    if (user === 'audit1') aud = s;
  }
  const ISO = Object.fromEntries(L.map(([k, c]) => [k, c]));
  const page = await aud.newPage();
  await page.goto('/audit');
  const cases: { from?: string; to?: string; actor?: string; want: string[] }[] = [
    { from: '2026-12-01', to: '2026-12-01', want: ['L2', 'L3'] },
    { from: '2026-11-30', to: '2026-11-30', want: ['L1'] },
    { from: '2026-11-30', to: '2026-12-01', want: ['L1', 'L2', 'L3'] },
    { from: '2026-12-02', want: ['L4', 'L5'] },
    { to: '2026-11-30', want: ['L1'] },
    { from: '2026-12-01', to: '2026-12-02', want: ['L2', 'L3', 'L4', 'L5'] },
    { from: '2026-12-01', to: '2026-12-01', actor: 'off.reg2', want: ['L2'] },
  ];
  for (const c of cases) {
    const label = JSON.stringify(c);
    const exp = sortd(c.want.map((k) => ISO[k]));
    await auditFilter(page, { from: c.from, to: c.to, actor: c.actor });
    await expect.poll(async () => sortd((await readAudit(page)).map((r) => r.iso)), { message: label }).toEqual(exp);
    expect(await numText(page, 'audit-count'), label).toBe(c.want.length);
    const q = new URLSearchParams({ from: c.from ?? '', to: c.to ?? '', actor: c.actor ?? '' });
    const api = await json(await aud.api.get(`/api/audit?${q}`));
    expect(api.count, label).toBe(c.want.length);
    expect(sortd(api.items.map((i: any) => i.time)), label).toEqual(exp);
  }
});

// =====================================================================
// RBAC
// =====================================================================
test('TC-RBAC-01 · ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
  await reset(browser);
  const sy = await loginCitizen(browser, CIT.somying);
  const page = await sy.newPage();
  const resp = await page.goto(`/citizen/cases/${C(5)}`);
  expect(resp!.status()).toBe(404);
  await expect(tid(page, 'not-found-msg')).toHaveText('ไม่พบคำขอ');
  await expect(tid(page, 'case-no')).toHaveCount(0);
  await expect(tid(page, 'case-status')).toHaveCount(0);
  expect(await page.content()).not.toContain('สมชาย');
  const r1 = await sy.api.get(`/api/cases/${C(5)}`);
  expect(r1.status()).toBe(404);
  expect(await json(r1)).toEqual({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' });
  const r2 = await sy.api.get('/api/cases/EG-2569-999999');
  expect(r2.status()).toBe(404);
  expect(await r2.text()).toBe(await r1.text());
  expect((await sy.api.get('/api/documents/DOC-2569-000001/pdf')).status()).toBe(404);
  expect((await sy.api.get('/api/drafts/DR-0001')).status()).toBe(404);
  expect((await sy.api.post(`/api/cases/${C(30)}/cancel`)).status()).toBe(404);
  const p2 = await sy.newPage();
  const own = await p2.goto(`/citizen/cases/${C(7)}`);
  expect(own!.status()).toBe(200);
  await expect(tid(p2, 'case-no')).toHaveText(C(7));
  const sc = await loginCitizen(browser, CIT.somchai);
  expect((await sc.api.get(`/api/cases/${C(5)}`)).status()).toBe(200);
});

test('TC-RBAC-02 · เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API)', async ({ browser }) => {
  await reset(browser);
  const reg2 = await loginStaff(browser, 'off.reg2');
  const st = async (s: Sess, n: number) => (await json(await s.api.get(`/api/cases/${C(n)}`))).status;
  await expectErr(await reg2.api.post(`/api/cases/${C(14)}/approve`), 403, 'FORBIDDEN');
  expect(await st(reg2, 14)).toBe('PENDING_APPROVAL');
  expect((await reg2.api.post(`/api/cases/${C(13)}/approve`)).status()).toBe(403);
  expect(await st(reg2, 13)).toBe('IN_REVIEW');
  expect((await reg2.api.post(`/api/cases/${C(14)}/reject`, { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(403);
  expect(await st(reg2, 14)).toBe('PENDING_APPROVAL');
  const page = await reg2.newPage();
  for (const n of [13, 14]) { await page.goto(`/officer/cases/${C(n)}`); await expect(tid(page, 'approve-btn')).toHaveCount(0); }
  const head = await loginStaff(browser, 'head1');
  expect((await head.api.post(`/api/cases/${C(25)}/approve`)).status()).toBe(403);
  const ok = await head.api.post(`/api/cases/${C(14)}/approve`);
  expect(ok.status()).toBe(200); expect((await json(ok)).status).toBe('APPROVED');
  const aud = await loginStaff(browser, 'audit1');
  const { rows } = await auditPage(aud, { event: 'APPROVE' });
  expect(rows).toHaveLength(1);
  expect(rows[0].actor).toBe('head1');
  expect(rows.some((r) => r.actor === 'off.reg2')).toBe(false);
});

type RoleKey = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
const ROLES: RoleKey[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const STAFF_OF: Partial<Record<RoleKey, string>> = { officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };
async function roleSession(browser: any, role: RoleKey): Promise<Sess> {
  if (role === 'anon') return anon(browser);
  if (role === 'citizen') return loginCitizen(browser, CIT.somchai);
  return loginStaff(browser, STAFF_OF[role]!);
}

test('TC-RBAC-03 · ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
  // L = redirect /login · OK = 200 · 403 = forbidden-msg
  const PAGES: [string, string[]][] = [
    ['/citizen', ['L', 'OK', '403', '403', '403', '403', '403']],
    ['/officer/queue', ['L', '403', 'OK', 'OK', '403', '403', '403']],
    ['/head/approvals', ['L', '403', '403', 'OK', '403', '403', '403']],
    ['/dashboard', ['L', '403', '403', '403', 'OK', '403', '403']],
    ['/audit', ['L', '403', '403', '403', '403', 'OK', '403']],
    ['/admin/services', ['L', '403', '403', '403', '403', '403', 'OK']],
    ['/admin/holidays', ['L', '403', '403', '403', '403', '403', 'OK']],
    ['/admin/users', ['L', '403', '403', '403', '403', '403', 'OK']],
    ['/notifications', ['L', '403', 'OK', 'OK', '403', '403', '403']],
    ['/verify/K7M2Q9XA', ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK']],
  ];
  const API: [string, string, any, number[]][] = [
    ['GET', '/api/officer/queue', undefined, [401, 403, 200, 200, 403, 403, 403]],
    ['GET', '/api/notifications', undefined, [401, 403, 200, 200, 403, 403, 403]],
    ['GET', '/api/dashboard?period=2026-12&service=ALL', undefined, [401, 403, 403, 403, 200, 403, 403]],
    ['GET', '/api/audit', undefined, [401, 403, 403, 403, 403, 200, 403]],
    ['GET', '/api/admin/services', undefined, [401, 403, 403, 403, 403, 403, 200]],
    ['POST', '/api/drafts', { serviceId: 'SV-01', qty: 1 }, [401, 201, 403, 403, 403, 403, 403]],
    ['GET', `/api/cases/${C(25)}`, undefined, [401, 200, 200, 200, 403, 403, 403]],
    ['POST', `/api/officer/cases/${C(28)}/claim`, undefined, [401, 403, 200, 403, 403, 403, 403]],
  ];
  const NAV: Record<RoleKey, string[]> = {
    anon: [], citizen: ['nav-my-cases'], officer: ['nav-queue', 'nav-bell'], head: ['nav-queue', 'nav-approvals', 'nav-bell'],
    executive: ['nav-dashboard'], auditor: ['nav-audit'], admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
  };
  const ALL_NAV = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell'];
  const LANDING: Record<string, string> = { citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals', executive: '/dashboard', auditor: '/audit', admin: '/admin/services' };

  for (let i = 0; i < ROLES.length; i++) {
    const role = ROLES[i];
    await reset(browser);
    const s = await roleSession(browser, role);
    // ส่วน A หน้า
    const page = await s.newPage();
    for (const [path, exp] of PAGES) {
      const resp = await page.goto(path);
      const e = exp[i], label = `${role} ${path}`;
      if (e === 'L') expect(new URL(page.url()).pathname, label).toBe('/login');
      else if (e === 'OK') { expect(resp!.status(), label).toBe(200); expect(new URL(page.url()).pathname, label).toBe(path); }
      else { expect(resp!.status(), label).toBe(403); await expect(tid(page, 'forbidden-msg'), label).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้'); }
    }
    // ส่วน D เมนู
    if (role !== 'anon') {
      await page.goto(LANDING[role]);
      for (const n of ALL_NAV) await expect(tid(page, n), `${role} ${n}`).toHaveCount(NAV[role].includes(n) ? 1 : 0);
    }
    // ส่วน B API (claim เป็นลำดับสุดท้าย)
    const sy = role === 'citizen' ? await loginCitizen(browser, CIT.somying) : null;
    for (const [m, path, body, exp] of API) {
      const who = sy && path === `/api/cases/${C(25)}` ? sy : s;
      const res = m === 'GET' ? await who.api.get(path) : await who.api.post(path, body ? { data: body } : {});
      expect(res.status(), `${role} ${m} ${path}`).toBe(exp[i]);
    }
  }
  // ส่วน C ขอบเขตแผนก
  await reset(browser);
  const works = await loginStaff(browser, 'off.works1');
  const reg1 = await loginStaff(browser, 'off.reg1');
  expect((await works.api.post(`/api/officer/cases/${C(28)}/claim`)).status()).toBe(403);
  expect((await reg1.api.post(`/api/officer/cases/${C(10)}/claim`)).status()).toBe(403);
  const wp = await works.newPage();
  await wp.goto('/officer/queue');
  await expect(tid(wp, 'queue-row')).toHaveCount(1);
  expect(await attrList(wp, 'queue-row', 'data-case-no')).toEqual([C(10)]);
});

test('TC-RBAC-04 · ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
  await reset(browser);
  const admin = await loginStaff(browser, 'admin1');
  const ap = await admin.newPage();
  await ap.goto('/admin/holidays');
  await expect(tid(ap, 'holiday-row')).toHaveCount(4);
  expect(await attrList(ap, 'holiday-row', 'data-date')).toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
  // 2
  const n1 = await newPaid(browser, { serviceId: 'SV-01', qty: 1, at: NOW0 });
  expect(n1.caseNo).toBe(C(31)); expect(n1.fee).toBe(20);
  expect((await json(await n1.s.api.get(`/api/cases/${C(31)}`))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  // 3
  await ap.goto('/admin/services');
  await tid(ap, 'svc-fee-SV-01').fill('25'); await tid(ap, 'svc-save-SV-01').click();
  await expect(tid(ap, 'action-success')).toBeVisible();
  await ap.goto('/admin/services');
  await tid(ap, 'svc-fee-SV-02').fill('600'); await tid(ap, 'svc-save-SV-02').click();
  await expect(tid(ap, 'action-success')).toBeVisible();
  // 4
  const sc = await loginCitizen(browser, CIT.somchai);
  const fee = async (b: any) => (await json(await sc.api.post('/api/drafts', { data: b }))).fee;
  expect(await fee({ serviceId: 'SV-01', qty: 5 })).toBe(125);
  expect(await fee({ serviceId: 'SV-01', qty: 1 })).toBe(25);
  expect(await fee({ serviceId: 'SV-02' })).toBe(600);
  const cp = await sc.newPage();
  await cp.goto('/citizen/new/SV-01');
  await tid(cp, 'qty-input').fill('5');
  await expect(tid(cp, 'fee-total')).toHaveText('฿125');
  await tid(cp, 'qty-input').fill('1');
  await expect(tid(cp, 'fee-total')).toHaveText('฿25');
  await cp.goto(`/citizen/cases/${C(30)}`);
  await expect(tid(cp, 'case-fee')).toHaveText('฿20');
  // 5
  await cp.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(tid(cp, 'payment-amount')).toHaveText('฿500');
  const bad = await sc.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 600 } });
  await expectErr(bad, 422, 'AMOUNT_MISMATCH');
  const good = await sc.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } });
  expect(good.status()).toBe(200);
  const gj = await json(good); expect(gj.status).toBe('PAID'); expect(gj.caseNo).toBe(C(32));
  // 6
  await ap.goto('/admin/holidays');
  await tid(ap, 'holiday-date-input').fill('2026-12-02');
  await tid(ap, 'holiday-name-input').fill('วันหยุดทดสอบ');
  await tid(ap, 'holiday-add-btn').click();
  await expect(tid(ap, 'holiday-row')).toHaveCount(5);
  expect((await json(await sc.api.get(`/api/cases/${C(31)}`))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  // 7
  const n2 = await newPaid(browser, { serviceId: 'SV-01', qty: 1, at: NOW0 });
  expect(n2.caseNo).toBe(C(33)); expect(n2.fee).toBe(25);
  expect((await json(await n2.s.api.get(`/api/cases/${C(33)}`))).dueAt).toBe('2026-12-08T16:30:00+07:00');
  // 8
  const pu = await admin.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } });
  expect(pu.status()).toBe(200);
  const ex = await loginStaff(browser, 'exec1');
  const me = await json(await ex.api.get('/api/me'));
  expect(me.role).toBe('auditor');
  const exPage = await ex.newPage();
  await exPage.goto('/dashboard');
  await expect(tid(exPage, 'forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
  const lr = await (await anon(browser)).api.post('/api/auth/staff/login', { data: { username: 'exec1', password: 'Test@1234' } });
  expect((await json(lr)).landing).toBe('/audit');
  // 9
  await exPage.goto('/audit');
  await auditFilter(exPage, { event: 'ADMIN_CHANGE' });
  await expect.poll(async () => numText(exPage, 'audit-count')).toBe(4);
  const rows = await readAudit(exPage);
  for (const r of rows) { expect(r.actor).toBe('admin1'); expect(r.role).toBe('admin'); }
  const det = rows.map((r) => r.detail).join('\n');
  for (const t of ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor']) expect(det).toContain(t);
  // 10
  expect((await admin.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).status()).toBe(403);
  // 11
  await ap.goto('/admin/holidays');
  await ap.locator('[data-testid="holiday-row"][data-date="2026-12-02"]').getByTestId('holiday-delete-btn').click();
  await expect(tid(ap, 'holiday-row')).toHaveCount(4);
  await exPage.goto('/audit');
  await auditFilter(exPage, { event: 'ADMIN_CHANGE' });
  await expect.poll(async () => numText(exPage, 'audit-count')).toBe(5);
  expect((await readAudit(exPage)).some((r) => r.detail.includes('holiday delete 2026-12-02'))).toBe(true);
});

test('TC-RBAC-05 · สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
  await reset(browser);
  const S: Record<string, Sess> = {
    reg1: await loginStaff(browser, 'off.reg1'), reg2: await loginStaff(browser, 'off.reg2'), works: await loginStaff(browser, 'off.works1'),
    head: await loginStaff(browser, 'head1'), exec: await loginStaff(browser, 'exec1'), aud: await loginStaff(browser, 'audit1'),
    admin: await loginStaff(browser, 'admin1'), somying: await loginCitizen(browser, CIT.somying), somchai: await loginCitizen(browser, CIT.somchai),
    anon: await anon(browser),
  };
  const ID = ['id-card.pdf'], ALL3 = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
  type Row = [string, number, number, string[]?];
  const rows: [string, string, number, string[] | null][] = [
    ['reg1', C(25), 200, ID], ['works', C(25), 403, null], ['reg2', C(12), 200, ALL3], ['works', C(12), 403, null],
    ['works', C(10), 200, ALL3], ['reg1', C(10), 200, ALL3], ['works', C(11), 200, ALL3],
    ['head', C(25), 200, ID], ['head', C(10), 200, ALL3], ['head', C(12), 200, ALL3],
    ['somying', C(25), 200, ID], ['somchai', C(25), 404, null],
    ['exec', C(25), 403, null], ['aud', C(25), 403, null], ['admin', C(25), 403, null], ['anon', C(25), 401, null],
  ];
  // fileId ตัวอย่างจากผู้มีสิทธิ์
  const donor = (await json(await S.somying.api.get(`/api/cases/${C(25)}/files`))).items[0].fileId;
  for (const [who, caseNo, code, names] of rows) {
    const r = await S[who].api.get(`/api/cases/${caseNo}/files`);
    expect(r.status(), `${who} ${caseNo} list`).toBe(code);
    if (code === 200) {
      const items = (await json(r)).items as any[];
      expect(sortd(items.map((i) => i.name)), `${who} ${caseNo}`).toEqual(names);
      for (const it of items) {
        const f = await S[who].api.get(`/api/files/${it.fileId}`);
        expect(f.status(), `${who} file ${it.name}`).toBe(200);
        expect(f.headers()['content-type']).toContain('application/pdf');
        expect((await f.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
      }
    } else {
      const fid = who === 'somchai' || who === 'anon' || ['exec', 'aud', 'admin'].includes(who) ? donor
        : (await json(await S.head.api.get(`/api/cases/${caseNo}/files`))).items[0].fileId;
      const f = await S[who].api.get(`/api/files/${fid}`);
      expect(f.status(), `${who} ${caseNo} file`).toBe(code);
    }
  }
  expect((await S.reg1.api.get('/api/files/99999999')).status()).toBe(404);
  // UI
  const p1 = await S.reg1.newPage();
  await p1.goto(`/officer/cases/${C(25)}`);
  await expect(tid(p1, 'doc-item')).toHaveCount(1);
  await expect(tid(p1, 'doc-item')).toHaveAttribute('data-name', 'id-card.pdf');
  const href = await tid(p1, 'doc-item').getByTestId('doc-download-link').getAttribute('href');
  const dl = await S.reg1.api.get(href!);
  expect(dl.status()).toBe(200); expect((await dl.body()).length).toBeGreaterThan(0);
  const p2 = await S.reg2.newPage();
  await p2.goto(`/officer/cases/${C(12)}`);
  await expect(tid(p2, 'doc-item')).toHaveCount(3);
  const p3 = await S.somying.newPage();
  await p3.goto(`/citizen/cases/${C(25)}`);
  await expect(tid(p3, 'doc-item')).toHaveCount(1);
});

test('TC-RBAC-06 · ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
  await reset(browser);
  const admin = await loginStaff(browser, 'admin1');
  const put = (b: any) => admin.api.put('/api/admin/services/SV-01', { data: b });
  const FEE_MSG = 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท', SLA_MSG = 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ';
  const ap = await admin.newPage();
  await ap.goto('/admin/services');
  // UI: fee = -1
  await tid(ap, 'svc-fee-SV-01').fill('-1'); await tid(ap, 'svc-save-SV-01').click();
  await expect(tid(ap, 'action-error')).toHaveText(FEE_MSG);
  await expectErr(await put({ fee: -1, sla: 3 }), 400, 'INVALID_FEE');
  expect((await json(await admin.api.get('/api/admin/services'))).items.find((x: any) => x.id === 'SV-01').fee).toBe(20);
  expect((await put({ fee: 0, sla: 3 })).status()).toBe(200);
  expect((await put({ fee: 100000, sla: 3 })).status()).toBe(200);
  await expectErr(await put({ fee: 100001, sla: 3 }), 400, 'INVALID_FEE');
  // SLA (fee คงที่ที่ 100000 ไม่ให้เกิดแถว Audit เพิ่ม)
  await ap.goto('/admin/services');
  await tid(ap, 'svc-sla-SV-01').fill('0'); await tid(ap, 'svc-save-SV-01').click();
  await expect(tid(ap, 'action-error')).toHaveText(SLA_MSG);
  await expectErr(await put({ fee: 100000, sla: 0 }), 400, 'INVALID_SLA');
  expect((await put({ fee: 100000, sla: 1 })).status()).toBe(200);
  expect((await put({ fee: 100000, sla: 60 })).status()).toBe(200);
  await expectErr(await put({ fee: 100000, sla: 61 }), 400, 'INVALID_SLA');
  // วันหยุด
  await ap.goto('/admin/holidays');
  await expect(tid(ap, 'holiday-row')).toHaveCount(4);
  await expectErr(await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }), 409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว');
  await ap.reload();
  await expect(tid(ap, 'holiday-row')).toHaveCount(4);
  expect((await admin.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } })).status()).toBe(201);
  await expectErr(await admin.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }), 409, 'SELF_ROLE_CHANGE');
  expect((await json(await admin.api.get('/api/me'))).role).toBe('admin');
  // Audit
  const aud = await loginStaff(browser, 'audit1');
  const { page, rows } = await auditPage(aud, { event: 'ADMIN_CHANGE' });
  await expect.poll(async () => numText(page, 'audit-count')).toBe(5);
  expect(rows).toHaveLength(5);
});

// =====================================================================
// NFR
// =====================================================================
test('TC-NFR-01 · Responsive 375 / 768 / 1280', async ({ browser }) => {
  await reset(browser);
  const sizes = [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];
  const plan: [() => Promise<Sess>, string[]][] = [
    [() => anon(browser), ['/login', '/verify/K7M2Q9XA']],
    [() => loginCitizen(browser, CIT.somchai), ['/citizen', '/citizen/new/SV-03', `/citizen/cases/${C(13)}`]],
    [() => loginStaff(browser, 'off.reg1'), ['/officer/queue', `/officer/cases/${C(20)}`]],
    [() => loginStaff(browser, 'head1'), ['/head/approvals']],
    [() => loginStaff(browser, 'exec1'), ['/dashboard']],
    [() => loginStaff(browser, 'audit1'), ['/audit']],
    [() => loginStaff(browser, 'admin1'), ['/admin/services']],
  ];
  let checks = 0;
  for (const [mk, paths] of plan) {
    const s = await mk();
    const page = await s.newPage();
    for (const sz of sizes) {
      await page.setViewportSize(sz);
      for (const p of paths) {
        await page.goto(p, { waitUntil: 'load' });
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        expect.soft(m.sw, `${p} @${sz.width}`).toBeLessThanOrEqual(m.iw);
        checks++;
      }
    }
  }
  expect(checks).toBe(33);
  // งานหลักที่ 375 px
  const s = await anon(browser);
  const page = await s.newPage();
  await page.setViewportSize(sizes[0]);
  await page.goto('/login');
  await tid(page, 'thaid-id-input').fill(CIT.somchai); await tid(page, 'thaid-submit').click();
  await tid(page, 'otp-input').fill('123456'); await tid(page, 'otp-submit').click();
  await page.waitForURL('**/citizen');
  await tid(page, 'start-service-SV-01').click();
  await tid(page, 'qty-input').fill('1');
  await expect(tid(page, 'fee-total')).toHaveText('฿20');
  await tid(page, 'to-upload-btn').click();
  await tid(page, 'upload-input-id-card').setInputFiles({ name: 'id-card.pdf', mimeType: 'application/pdf', buffer: pdfBuf(1024) });
  await expect(tid(page, 'file-item')).toHaveCount(1);
  await expect(tid(page, 'to-payment-btn')).toBeEnabled();
  await tid(page, 'to-payment-btn').click();
  await expect(tid(page, 'create-qr-btn')).toBeVisible();
  const bb = await tid(page, 'create-qr-btn').boundingBox();
  expect(bb!.x).toBeGreaterThanOrEqual(0);
  expect(bb!.x + bb!.width).toBeLessThanOrEqual(375);
});

test('TC-NFR-02 · WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
  await reset(browser);
  const mana = await loginCitizen(browser, CIT.mana);
  const S = {
    anon: await anon(browser), citizen: await loginCitizen(browser, CIT.somchai), reg1: await loginStaff(browser, 'off.reg1'),
    head: await loginStaff(browser, 'head1'), exec: await loginStaff(browser, 'exec1'), aud: await loginStaff(browser, 'audit1'), admin: await loginStaff(browser, 'admin1'), mana,
  };
  const PAGES: [keyof typeof S, string][] = [
    ['anon', '/login'], ['mana', '/register'], ['citizen', '/citizen'], ['citizen', '/citizen/new/SV-01'], ['citizen', `/citizen/cases/${C(17)}`],
    ['reg1', '/officer/queue'], ['reg1', `/officer/cases/${C(20)}`], ['head', '/head/approvals'], ['exec', '/dashboard'], ['aud', '/audit'],
    ['admin', '/admin/services'], ['reg1', '/notifications'], ['anon', '/verify/K7M2Q9XA'],
  ];
  const STATUS: Record<string, string> = { DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก' };
  const LEVEL: Record<string, string> = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
  const readStatus = (page: Page) => page.evaluate(() => {
    const out: { id: string; text: string; code: string }[] = [];
    for (const id of ['case-status', 'row-status', 'sla-level', 'row-sla-level']) {
      document.querySelectorAll(`[data-testid="${id}"]`).forEach((e) => out.push({ id, text: (e.textContent ?? '').trim(), code: e.getAttribute('data-status') ?? e.getAttribute('data-level') ?? '' }));
    }
    return out;
  });
  const unlabeled = (page: Page) => page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll('input, select, textarea').forEach((n) => {
      const el = n as HTMLInputElement;
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) return;
      let ok = Boolean(el.getAttribute('aria-label')?.trim());
      const lb = el.getAttribute('aria-labelledby');
      if (!ok && lb) ok = lb.split(/\s+/).some((i) => (document.getElementById(i)?.textContent ?? '').trim().length > 0);
      if (!ok && el.labels) ok = Array.from(el.labels).some((l) => (l.textContent ?? '').trim().length > 0);
      if (!ok && el.getAttribute('title')?.trim()) ok = true;
      if (!ok) bad.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.name ?? el.id}]`);
    });
    return bad;
  });
  for (const [who, path] of PAGES) {
    const page = await S[who].newPage();
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const hard = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect.soft(hard.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`), `axe ${path}`).toEqual([]);
    expect.soft(await unlabeled(page), `label ${path}`).toEqual([]);
    const st = await readStatus(page);
    for (const x of st) {
      expect.soft(x.text.length, `status text ${path}`).toBeGreaterThan(0);
      const want = x.id.includes('sla') ? LEVEL[x.code] : STATUS[x.code];
      expect.soft(x.text, `status table ${path} ${x.id}`).toBe(want);
    }
    if (st.length) {
      await page.emulateMedia({ forcedColors: 'active' });
      for (const x of st) {
        const sel = page.locator(`[data-testid="${x.id}"]`).filter({ hasText: x.text }).first();
        await expect.soft(sel, `forced-colors ${path} ${x.id}`).toBeVisible();
        await expect.soft(sel).toHaveText(x.text);
      }
      await page.emulateMedia({ forcedColors: 'none' });
    }
    await page.close();
  }
  // ส่วน B คีย์บอร์ดอย่างเดียว
  const ks = await anon(browser);
  const kp = await ks.newPage();
  const bad: string[] = [];
  await kp.goto('/login');
  await tabTo(kp, 'thaid-id-input', bad);
  await kp.keyboard.type(CIT.somchai); await kp.keyboard.press('Enter');
  await tid(kp, 'otp-input').waitFor({ state: 'visible' });
  if (!(await kp.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'otp-input'))) await tabTo(kp, 'otp-input', bad);
  await kp.keyboard.type('123456'); await kp.keyboard.press('Enter');
  await kp.waitForURL('**/citizen');
  await tabTo(kp, 'start-service-SV-01', bad); await kp.keyboard.press('Enter');
  await tid(kp, 'qty-input').waitFor({ state: 'visible' });
  await tabTo(kp, 'qty-input', bad);
  await kp.keyboard.press('Control+A'); await kp.keyboard.type('1');
  await tabTo(kp, 'to-upload-btn', bad); await kp.keyboard.press('Enter');
  await tabTo(kp, 'upload-input-id-card', bad);
  await tid(kp, 'upload-input-id-card').setInputFiles({ name: 'id-card.pdf', mimeType: 'application/pdf', buffer: pdfBuf(1024) });
  await expect(tid(kp, 'file-item')).toHaveCount(1);
  await tabTo(kp, 'to-payment-btn', bad); await kp.keyboard.press('Enter');
  await expect(tid(kp, 'create-qr-btn')).toBeVisible();
  expect(bad, 'องค์ประกอบที่โฟกัสต้องมี outline/ring').toEqual([]);
});

test('TC-NFR-03 · Health เวลาโหลด และผลซ้ำได้', async ({ browser }) => {
  const a = await reset(browser);
  const h = await a.api.get('/api/health');
  expect(h.status()).toBe(200);
  expect(await h.json()).toEqual({ status: 'ok' });
  // เวลาโหลด (วัดรอบที่ 2)
  const targets: [Sess, string][] = [
    [await loginCitizen(browser, CIT.somchai), '/login'], [await loginCitizen(browser, CIT.somchai), '/citizen'],
    [await loginStaff(browser, 'off.reg1'), '/officer/queue'], [await loginStaff(browser, 'exec1'), '/dashboard'], [await loginStaff(browser, 'audit1'), '/audit'],
  ];
  for (const [s, path] of targets) {
    const page = await s.newPage();
    await page.goto(path, { waitUntil: 'load' });
    const t0 = Date.now();
    await page.goto(path, { waitUntil: 'load' });
    expect(Date.now() - t0, `โหลด ${path}`).toBeLessThanOrEqual(3000);
  }
  // ผลซ้ำได้
  const snap = async () => {
    const an = await anon(browser);
    const clock = await json(await an.api.get('/api/test/clock'));
    const r1 = await loginStaff(browser, 'off.reg1');
    const q = (await json(await r1.api.get('/api/officer/queue?filter=all'))).items.map((i: any) => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner }));
    const ex = await loginStaff(browser, 'exec1');
    const d = await json(await ex.api.get('/api/dashboard?period=2026-12&service=ALL'));
    return { clock, q, d };
  };
  await reset(browser);
  const S1 = await snap();
  expect(S1.clock.now).toBe(NOW0);
  const ma = await anon(browser);
  await setClock(ma, '2026-12-10T12:00:00+07:00');
  const r1 = await loginStaff(browser, 'off.reg1');
  expect((await r1.api.post(`/api/officer/cases/${C(28)}/claim`)).status()).toBe(200);
  await newPaid(browser, { serviceId: 'SV-01', qty: 1 });
  await reset(browser);
  const S2 = await snap();
  expect(S2).toEqual(S1);
  expect(S2.clock.now).toBe(NOW0);
  // นาฬิกาไม่มี offset
  const bad = await (await anon(browser)).api.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } });
  await expectErr(bad, 400, 'INVALID_TIME');
  // เว็บที่ไม่ตั้ง TEST_MODE (ถ้ารันได้สองโหมด: ตั้ง NO_TEST_MODE_URL)
  if (process.env.NO_TEST_MODE_URL) {
    const r = await (await anon(browser)).api.post(`${process.env.NO_TEST_MODE_URL.replace(/\/$/, '')}/api/test/reset`);
    expect(r.status()).toBe(404);
  }
});

async function dbSearchText(): Promise<string> {
  const parts: string[] = [];
  if (process.env.DB_DUMP_CMD) {
    parts.push(execSync(process.env.DB_DUMP_CMD, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
  } else if (process.env.DATABASE_URL) {
    const mod: any = await import('pg');
    const Client = (mod.default ?? mod).Client;
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const t = await c.query("select table_schema, table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')");
      for (const { table_schema, table_name } of t.rows) {
        const r = await c.query(`select to_jsonb(x)::text as j from "${table_schema}"."${table_name}" x`);
        parts.push(r.rows.map((x: any) => x.j).join('\n'));
      }
    } finally { await c.end(); }
  } else if (process.env.DB_PATH && existsSync(process.env.DB_PATH)) {
    parts.push(readFileSync(process.env.DB_PATH).toString('latin1'));
  } else {
    throw new Error('ตั้ง DB_DUMP_CMD (คำสั่งที่พิมพ์ dump ของฐานข้อมูล) หรือ DATABASE_URL หรือ DB_PATH เพื่อตรวจ TC-NFR-04');
  }
  if (process.env.WEB_LOG_CMD) parts.push(execSync(process.env.WEB_LOG_CMD, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  if (process.env.WEB_LOG_FILE && existsSync(process.env.WEB_LOG_FILE)) parts.push(readFileSync(process.env.WEB_LOG_FILE, 'utf8'));
  return parts.join('\n');
}

test('TC-NFR-04 · เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ browser }) => {
  await reset(browser);
  // มานะลงทะเบียน (TC-AUTH-03)
  const mana = await loginCitizen(browser, CIT.mana);
  const reg = await mana.api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } });
  expect(reg.status()).toBe(201);
  // ตัวควบคุมบวก
  const sc = await loginCitizen(browser, CIT.somchai);
  expect((await json(await sc.api.get(`/api/cases/${C(5)}`))).idNo).toBe('1101700123456');
  // inspection
  const dump = await dbSearchText();
  expect(dump.length, 'ต้องอ่านฐานข้อมูลได้ (dump ว่าง)').toBeGreaterThan(1000);
  const needles = ['1101700123456', '3100600987659', '1909900555015', '5500400111221', '0812345678', '0823456789', '0834567890', '0845678901',
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1'];
  for (const n of needles) expect(dump.split(n).length - 1, `พบ ${n} ในฐานข้อมูล/log`).toBe(0);
  test.info().annotations.push({ type: 'วิธีเข้ารหัส', description: process.env.ENC_METHOD ?? 'ระบุในรายงาน (เช่น AES-256-GCM ตาม DECISIONS)' });
});
