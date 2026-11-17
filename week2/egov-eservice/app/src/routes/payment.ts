// B06 · ชำระเงิน PromptPay จำลอง + ออกเลขคำขอ (CONTRACT §6.2 §8 · FR-08 · BR-09..11 · A-14..16 A-47 A-48)
//  POST /api/drafts/:id/payment · GET /api/payments/:ref · POST /api/test/payments/:ref/pay (TEST_MODE · app.ts ปิดให้เอง)
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { isBug } from '../lib/bugmode.ts';
import { issueCaseNumbers } from '../lib/caseno.ts';
import { now, toIso } from '../lib/clock.ts';
import { nextNumber, one, tx } from '../lib/db.ts';
import { ah, apiError } from '../lib/http.ts';
import { requireCitizen } from '../lib/rbac.ts';
import { missingDocNames } from '../lib/upload.ts';
import { calcFee, computeDueAt, loadHolidays, loadServiceRules } from '../rules/fee-sla.ts';

const router = Router();

const QR_LIFETIME_MS = 15 * 60 * 1000;
const refOf = (n: number) => `PP-${String(n).padStart(4, '0')}`;
const d = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const notFound = (res: import('express').Response) => apiError(res, 404, 'NOT_FOUND', 'ไม่พบรายการ');

interface PayRow {
  ref: string; draft_id: string | null; amount: number; status: 'PENDING' | 'PAID' | 'EXPIRED';
  qr_created_at: Date; qr_expires_at: Date; paid_at: Date | null; case_no: string | null; receipt_no: string | null;
}

/** QR ใช้ได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 · B05: ใช้ ≤ */
function qrValid(p: PayRow, at: Date): boolean {
  const age = at.getTime() - d(p.qr_created_at).getTime();
  return isBug('B05') ? age <= QR_LIFETIME_MS : age < QR_LIFETIME_MS;
}
/** สถานะที่แสดง: PENDING ที่หมดอายุแล้ว = EXPIRED (อายุ ≥ 15:00) */
function shownStatus(p: PayRow, at: Date): 'PENDING' | 'PAID' | 'EXPIRED' {
  if (p.status !== 'PENDING') return p.status;
  return at.getTime() - d(p.qr_created_at).getTime() >= QR_LIFETIME_MS ? 'EXPIRED' : 'PENDING';
}
const payJson = (p: PayRow) => ({
  ref: p.ref, amount: p.amount, status: shownStatus(p, now()),
  qrCreatedAt: toIso(d(p.qr_created_at)), qrExpiresAt: toIso(d(p.qr_expires_at)),
  caseNo: p.case_no, receiptNo: p.receipt_no,
});

// ── สร้าง QR (ซ้ำได้ ได้ ref ใหม่) ──
router.post('/api/drafts/:id/payment', requireCitizen, ah(async (req, res) => {
  const out = await tx(async (c) => {
    const dr = (await c.query(
      `SELECT id,service_id,qty,area_sqm,fee,status FROM drafts WHERE id=$1 AND citizen_id=$2 FOR UPDATE`,
      [req.params.id, req.user!.citizenId])).rows[0];
    if (!dr) return { err: 404 as const };
    if (dr.status === 'SUBMITTED') return { err: 409 as const, code: 'INVALID_STATE', msg: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้' };
    const files = (await c.query(`SELECT doc_key FROM files WHERE draft_id=$1`, [dr.id])).rows.map((r: { doc_key: string }) => r.doc_key);
    const missing = missingDocNames(dr.service_id, files);
    if (missing.length) return { err: 409 as const, code: 'MISSING_DOCS', msg: `ยังขาดเอกสาร: ${missing.join(', ')}`, missing };

    let amount: number = dr.fee;
    if (dr.status === 'DRAFT') { // ยอดถูกล็อกตอนเข้า PENDING_PAYMENT (BR-11): คำนวณจากกฎปัจจุบัน ณ จุดนี้
      const rules = await loadServiceRules(dr.service_id, c);
      const f = calcFee(dr.service_id, { qty: dr.qty ?? undefined, area: dr.area_sqm ?? undefined }, rules ?? undefined);
      if (f.ok) amount = f.fee;
    }
    const at = now();
    const ref = refOf(await nextNumber('payment', c));
    await c.query(
      `INSERT INTO payments(ref,draft_id,amount,status,qr_created_at,qr_expires_at) VALUES ($1,$2,$3,'PENDING',$4,$5)`,
      [ref, dr.id, amount, toIso(at), toIso(new Date(at.getTime() + QR_LIFETIME_MS))]);
    await c.query(`UPDATE drafts SET status='PENDING_PAYMENT', fee=$2, updated_at=$3 WHERE id=$1`, [dr.id, amount, toIso(at)]);
    return { ok: { ref, amount, qrCreatedAt: toIso(at), qrExpiresAt: toIso(new Date(at.getTime() + QR_LIFETIME_MS)) } };
  });
  if ('ok' in out && out.ok) return void res.status(201).json(out.ok);
  if (out.err === 404) return void notFound(res);
  const e = out as { code: string; msg: string; missing?: string[] };
  return void apiError(res, 409, e.code, e.msg, e.missing ? { missing: e.missing } : {});
}));

// ── อ่านสถานะ (เจ้าของร่างเท่านั้น) ──
router.get('/api/payments/:ref', requireCitizen, ah(async (req, res) => {
  const p = await one<PayRow>(
    `SELECT p.* FROM payments p
       LEFT JOIN drafts dr ON dr.id = p.draft_id
       LEFT JOIN cases cs ON cs.case_no = p.case_no
      WHERE p.ref=$1 AND COALESCE(dr.citizen_id, cs.citizen_id) = $2`, [req.params.ref, req.user!.citizenId]);
  if (!p) return void notFound(res);
  if (p.status === 'PENDING' && shownStatus(p, now()) === 'EXPIRED') {
    await one(`UPDATE payments SET status='EXPIRED' WHERE ref=$1 AND status='PENDING'`, [p.ref]);
    p.status = 'EXPIRED';
  }
  res.json(payJson(p));
}));

// ── ธนาคารจำลองยิง callback (TEST_MODE) ──
type PayResult =
  | { http: 200; body: Record<string, unknown> }
  | { http: number; code: string; msg: string };

async function settle(c: PoolClient, ref: string, amount: unknown): Promise<PayResult> {
  const p = (await c.query(`SELECT * FROM payments WHERE ref=$1 FOR UPDATE`, [ref])).rows[0] as PayRow | undefined;
  if (!p) return { http: 404, code: 'NOT_FOUND', msg: 'ไม่พบรายการ' };
  if (p.status === 'PAID') // callback ซ้ำ: idempotent ไม่เปลี่ยนเลข ไม่สร้างรายการใหม่
    return { http: 200, body: { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true } };

  const at = now();
  if (p.status === 'EXPIRED' || !qrValid(p, at)) {
    await c.query(`UPDATE payments SET status='EXPIRED' WHERE ref=$1`, [ref]);
    return { http: 410, code: 'QR_EXPIRED', msg: 'QR หมดอายุ กรุณาสร้าง QR ใหม่' };
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount !== p.amount)
    return { http: 422, code: 'AMOUNT_MISMATCH', msg: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม' };

  const dr = p.draft_id ? (await c.query(
    `SELECT id,citizen_id,service_id,qty,area_sqm,status FROM drafts WHERE id=$1 FOR UPDATE`, [p.draft_id])).rows[0] : null;
  if (!dr) return { http: 404, code: 'NOT_FOUND', msg: 'ไม่พบรายการ' };
  if (dr.status === 'SUBMITTED') return { http: 409, code: 'INVALID_STATE', msg: 'ร่างนี้ชำระแล้วด้วยรายการอื่น' };
  const files = (await c.query(`SELECT doc_key FROM files WHERE draft_id=$1`, [dr.id])).rows.map((r: { doc_key: string }) => r.doc_key);
  const missing = missingDocNames(dr.service_id, files);
  if (missing.length) return { http: 409, code: 'MISSING_DOCS', msg: `ยังขาดเอกสาร: ${missing.join(', ')}` };

  const rules = await loadServiceRules(dr.service_id, c);
  const holidays = await loadHolidays(c);
  const { caseNo, receiptNo } = await issueCaseNumbers(c, at);
  const paidIso = toIso(at);
  const dueAt = computeDueAt(at, rules?.slaDays ?? 3, holidays); // คำนวณครั้งเดียวตอนชำระ (BR-12)

  await c.query(
    `INSERT INTO cases(case_no,service_id,citizen_id,draft_id,qty,area_sqm,fee,status,step,current_dept,owner,
        paid_at,receipt_no,due_at,return_count,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SUBMITTED',$8,'registry',NULL,$9,$10,$11,0,$9)`,
    [caseNo, dr.service_id, dr.citizen_id, dr.id, dr.qty, dr.area_sqm, p.amount,
     dr.service_id === 'SV-03' ? 1 : null, paidIso, receiptNo, toIso(dueAt)]);
  await c.query(`UPDATE files SET case_no=$2, draft_id=NULL WHERE draft_id=$1`, [dr.id, caseNo]);
  await c.query(`INSERT INTO case_dept_trail(case_no,dept,entered_at) VALUES ($1,'registry',$2)`, [caseNo, paidIso]);
  await c.query(
    `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,'SUBMIT',NULL,'SUBMITTED',$4)`,
    [caseNo, paidIso, `citizen-${dr.citizen_id}`, `ชำระเงิน ${receiptNo}`]);
  await c.query(`UPDATE drafts SET status='SUBMITTED', case_no=$2, updated_at=$3 WHERE id=$1`, [dr.id, caseNo, paidIso]);
  await c.query(`UPDATE payments SET status='PAID', paid_at=$2, case_no=$3, receipt_no=$4 WHERE ref=$1`, [ref, paidIso, caseNo, receiptNo]);
  return { http: 200, body: { status: 'PAID', caseNo, receiptNo, duplicate: false } };
}

router.post('/api/test/payments/:ref/pay', ah(async (req, res) => {
  const out = await tx((c) => settle(c, String(req.params.ref), req.body?.amount)); // EXPIRED/ไม่ผ่าน ไม่ throw → commit สถานะ EXPIRED ได้
  if (out.http === 200) return void res.status(200).json((out as { body: object }).body);
  const e = out as { http: number; code: string; msg: string };
  return void apiError(res, e.http, e.code, e.msg);
}));

export default router;
