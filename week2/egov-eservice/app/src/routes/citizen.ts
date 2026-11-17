// B05 · ประชาชน: ร่าง ยื่น อัปโหลด (CONTRACT §2.4–2.6 §5 §6.2 §6.7 · FR-04..07 FR-09 FR-10 FR-11 · BR-06..08 BR-22)
// หน้า: /citizen · /citizen/new/:service · /citizen/cases/:caseNo
// API: /api/fee · /api/drafts(/:id)(/files) · /api/cases(/:caseNo)(/cancel|/resubmit|/files) · /api/files/:fileId
// ส่วนชำระเงิน (POST /api/drafts/:id/payment · GET /api/payments/:ref · เลขคำขอ) เป็นของ B06
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { bkkDate, fmtBaht, fmtThai, now, toIso } from '../lib/clock.ts';
import { isBug } from '../lib/bugmode.ts';
import { decrypt } from '../lib/crypto.ts';
import { one, query, tx, nextNumber } from '../lib/db.ts';
import { onRequest } from '../lib/hooks.ts';
import { ah, apiError } from '../lib/http.ts';
import { requireAuth, requireCitizen } from '../lib/rbac.ts';
import {
  calcFee, extendDueAtForFix, fixDeadline, isFixWindowExpired, isServiceId, loadHolidays, loadServiceRules,
  pausedWorkingDays, SLA_LEVEL_TEXT, slaLevel, toInt,
} from '../rules/fee-sla.ts';
import {
  checkFile, cleanName, isDocKeyForService, MAX_FILES, SERVICE_DOCS, SERVICE_NAMES, singleFile,
  missingDocNames, UPLOAD_ERRORS, type DocKey,
} from '../lib/upload.ts';

const router = Router();

export const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const EVENT_TEXT: Record<string, string> = {
  SUBMIT: 'ยื่นคำขอ', CLAIM: 'เจ้าหน้าที่รับเรื่อง', RETURN: 'ตีกลับให้แก้ไขเอกสาร', RESUBMIT: 'ส่งแก้ไขเอกสาร',
  FORWARD: 'ส่งต่อ', APPROVE: 'อนุมัติ', ISSUE: 'ออกเอกสาร', REJECT: 'ไม่อนุมัติ', CANCEL: 'ยกเลิกคำขอ',
};
const STEP_TEXT: Record<number, string> = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const NOT_FOUND_MSG = 'ไม่พบคำขอ';

const d = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const iso = (v: unknown): string | null => (v == null ? null : toIso(d(v)));
const draftIdOf = (n: number) => `DR-${String(n).padStart(4, '0')}`;
const fmtIdNo = (s: string) => (s.length === 13 ? `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}` : s);
const notFound = (res: Response) => apiError(res, 404, 'NOT_FOUND', NOT_FOUND_MSG);

// ───────────────────────── ยกเลิกอัตโนมัติเมื่อพ้นเวลาแก้ไข 168 ชม. (A-46) ─────────────────────────

/** ยกเลิกคำขอ NEED_FIX ที่เลยเส้นตายแล้ว (idempotent) · เวลาที่ลงไทม์ไลน์ = เวลาตีกลับ + 168 ชม. */
async function cancelFixExpired(c: PoolClient, caseNo: string, returnedAt: Date): Promise<boolean> {
  const closedAt = fixDeadline(returnedAt);
  const r = await c.query(
    `UPDATE cases SET status='CANCELLED', closed_at=$2, close_reason='FIX_TIMEOUT'
      WHERE case_no=$1 AND status='NEED_FIX' RETURNING case_no`, [caseNo, toIso(closedAt)]);
  if (!r.rows[0]) return false;
  await c.query(
    `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,'system','CANCEL','NEED_FIX','CANCELLED',$3)`,
    [caseNo, toIso(closedAt), 'หมดเวลาแก้ไข 168 ชั่วโมง']);
  return true;
}
export async function autoCancelExpiredFix(): Promise<void> {
  const rows = await query<{ case_no: string; returned_at: Date }>(
    `SELECT case_no, returned_at FROM cases WHERE status='NEED_FIX' AND returned_at IS NOT NULL`);
  for (const r of rows) {
    if (!isFixWindowExpired(d(r.returned_at))) continue;
    await tx((c) => cancelFixExpired(c, r.case_no, d(r.returned_at)));
  }
}
onRequest(async () => { await autoCancelExpiredFix(); });

// ───────────────────────── ร่าง ─────────────────────────

interface DraftRow {
  id: string; citizen_id: number; service_id: string; qty: number | null; area_sqm: number | null;
  fee: number; status: 'DRAFT' | 'PENDING_PAYMENT' | 'SUBMITTED'; case_no: string | null;
}
interface FileRow { file_id: string; name: string; doc_key: DocKey; size: number }

async function draftFiles(draftId: string, c: { query: PoolClient['query'] } | null = null): Promise<FileRow[]> {
  const sql = `SELECT file_id, name, doc_key, size FROM files WHERE draft_id=$1 ORDER BY created_at, file_id`;
  return c ? ((await c.query(sql, [draftId])).rows as FileRow[]) : query<FileRow>(sql, [draftId]);
}
const fileJson = (f: FileRow) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size });
async function draftJson(row: DraftRow) {
  const files = (await draftFiles(row.id)).map(fileJson);
  return {
    draftId: row.id, serviceId: row.service_id, status: row.status, fee: row.fee,
    qty: row.qty, areaSqm: row.area_sqm, caseNo: row.case_no, files, fileCount: files.length,
    missing: missingDocNames(row.service_id, files.map((f) => f.docKey)),
  };
}
async function myDraft(id: string, citizenId: number): Promise<DraftRow | null> {
  return one<DraftRow>(`SELECT id,citizen_id,service_id,qty,area_sqm,fee,status,case_no FROM drafts WHERE id=$1 AND citizen_id=$2`, [id, citizenId]);
}

/** คำนวณค่าธรรมเนียมจากกติกาปัจจุบันในฐานข้อมูล (admin แก้ได้) */
async function feeFor(serviceId: string, qty: unknown, area: unknown) {
  const rules = await loadServiceRules(serviceId);
  return calcFee(serviceId, { qty, area }, rules ?? undefined);
}

router.get('/api/fee', requireCitizen, ah(async (req, res) => {
  const serviceId = String(req.query.serviceId ?? '');
  const f = await feeFor(serviceId, req.query.qty, req.query.area);
  if (!f.ok) return void apiError(res, f.status, f.code, f.message);
  res.json({ fee: f.fee });
}));

router.post('/api/drafts', requireCitizen, ah(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const serviceId = String(b.serviceId ?? '');
  const f = await feeFor(serviceId, b.qty, b.areaSqm ?? b.area);
  if (!f.ok) return void apiError(res, f.status, f.code, f.message);
  const qty = serviceId === 'SV-01' ? toInt(b.qty) : null;
  const area = serviceId === 'SV-03' ? toInt(b.areaSqm ?? b.area) : null;
  const id = await tx(async (c) => {
    const id = draftIdOf(await nextNumber('draft', c));
    const t = toIso(now());
    await c.query(
      `INSERT INTO drafts(id,citizen_id,service_id,qty,area_sqm,fee,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$7)`,
      [id, req.user!.citizenId, serviceId, qty, area, f.fee, t]);
    return id;
  });
  res.status(201).json({ draftId: id, fee: f.fee });
}));

router.get('/api/drafts', requireCitizen, ah(async (req, res) => {
  const rows = await query<DraftRow>(
    `SELECT id,citizen_id,service_id,qty,area_sqm,fee,status,case_no FROM drafts
      WHERE citizen_id=$1 AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY id`, [req.user!.citizenId]);
  res.json({ items: await Promise.all(rows.map(draftJson)) });
}));

router.get('/api/drafts/:id', requireCitizen, ah(async (req, res) => {
  const row = await myDraft(String(req.params.id), req.user!.citizenId!);
  if (!row) return void notFound(res);
  res.json(await draftJson(row));
}));

/** แก้ไขร่าง (บันทึกร่างซ้ำ) · เฉพาะ DRAFT */
router.put('/api/drafts/:id', requireCitizen, ah(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const out = await tx(async (c) => {
    const r = await c.query(
      `SELECT id,service_id,status FROM drafts WHERE id=$1 AND citizen_id=$2 FOR UPDATE`, [req.params.id, req.user!.citizenId]);
    const row = r.rows[0] as { id: string; service_id: string; status: string } | undefined;
    if (!row) return { s: 404 as const };
    if (row.status !== 'DRAFT') return { s: 409 as const };
    const rules = await loadServiceRules(row.service_id, c);
    const f = calcFee(row.service_id, { qty: b.qty, area: b.areaSqm ?? b.area }, rules ?? undefined);
    if (!f.ok) return { s: 400 as const, f };
    const qty = row.service_id === 'SV-01' ? toInt(b.qty) : null;
    const area = row.service_id === 'SV-03' ? toInt(b.areaSqm ?? b.area) : null;
    await c.query(`UPDATE drafts SET qty=$2, area_sqm=$3, fee=$4, updated_at=$5 WHERE id=$1`, [row.id, qty, area, f.fee, toIso(now())]);
    return { s: 200 as const, id: row.id, fee: f.fee };
  });
  if (out.s === 404) return void notFound(res);
  if (out.s === 409) return void apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  if (out.s === 400) return void apiError(res, 400, out.f.code, out.f.message);
  res.json({ draftId: out.id, fee: out.fee });
}));

router.delete('/api/drafts/:id', requireCitizen, ah(async (req, res) => {
  const out = await tx(async (c) => {
    const r = await c.query(`SELECT id,status FROM drafts WHERE id=$1 AND citizen_id=$2 FOR UPDATE`, [req.params.id, req.user!.citizenId]);
    const row = r.rows[0] as { id: string; status: string } | undefined;
    if (!row) return 404;
    if (row.status === 'SUBMITTED') return 409;
    const paid = await c.query(`SELECT 1 FROM payments WHERE draft_id=$1 AND status='PAID' LIMIT 1`, [row.id]);
    if (paid.rows[0]) return 409;
    await c.query(`DELETE FROM payments WHERE draft_id=$1`, [row.id]); // ref ชำระของร่างนี้ → 404
    await c.query(`DELETE FROM files WHERE draft_id=$1`, [row.id]);
    await c.query(`DELETE FROM drafts WHERE id=$1`, [row.id]);
    return 204;
  });
  if (out === 404) return void notFound(res);
  if (out === 409) return void apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  res.status(204).end();
}));

// ───────────────────────── อัปโหลดไฟล์ของร่าง ─────────────────────────

router.post('/api/drafts/:id/files', requireCitizen, singleFile, ah(async (req, res) => {
  const f = req.file;
  const docKey = String((req.body as Record<string, unknown> | undefined)?.docKey ?? 'extra');
  const draft = await myDraft(String(req.params.id), req.user!.citizenId!);
  if (!draft) return void notFound(res);
  if (draft.status === 'SUBMITTED') return void apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  if (!f) return void apiError(res, 400, 'FILE_REQUIRED', 'กรุณาเลือกไฟล์');
  if (!isDocKeyForService(draft.service_id, docKey)) return void apiError(res, 400, 'INVALID_DOC_KEY', 'ช่องแนบเอกสารไม่ถูกต้อง');
  const chk = checkFile(f.buffer, docKey);
  if (!chk.ok) return void apiError(res, 400, chk.code, chk.message);

  const out = await tx(async (c) => {
    // ล็อกร่างเพื่อให้การนับจำนวนไฟล์ไม่ชนกันเมื่ออัปโหลดพร้อมกัน
    const lk = await c.query(`SELECT status FROM drafts WHERE id=$1 FOR UPDATE`, [draft.id]);
    if (!lk.rows[0] || lk.rows[0].status === 'SUBMITTED') return { s: 409 as const };
    const have = (await draftFiles(draft.id, c));
    const replaced = docKey === 'extra' ? [] : have.filter((x) => x.doc_key === docKey);
    if (have.length - replaced.length >= MAX_FILES) return { s: 400 as const };
    if (replaced.length) await c.query(`DELETE FROM files WHERE draft_id=$1 AND doc_key=$2`, [draft.id, docKey]);
    const fileId = `FL-UP${String(await nextNumber('file', c)).padStart(6, '0')}-${docKey}`;
    const name = cleanName(f.originalname);
    await c.query(
      `INSERT INTO files(file_id,draft_id,case_no,citizen_id,doc_key,name,size,mime,content,created_at) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9)`,
      [fileId, draft.id, req.user!.citizenId, docKey, name, f.size, chk.mime, f.buffer, toIso(now())]);
    await c.query(`UPDATE drafts SET updated_at=$2 WHERE id=$1`, [draft.id, toIso(now())]);
    return { s: 201 as const, fileId, name };
  });
  if (out.s === 409) return void apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  if (out.s === 400) return void apiError(res, 400, 'FILE_COUNT', UPLOAD_ERRORS.FILE_COUNT);
  res.status(201).json({ fileId: out.fileId, name: out.name, docKey, size: f.size });
}));

router.delete('/api/drafts/:id/files/:fileId', requireCitizen, ah(async (req, res) => {
  const draft = await myDraft(String(req.params.id), req.user!.citizenId!);
  if (!draft) return void notFound(res);
  if (draft.status === 'SUBMITTED') return void apiError(res, 409, 'INVALID_STATE', 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  const r = await query(`DELETE FROM files WHERE file_id=$1 AND draft_id=$2 RETURNING file_id`, [req.params.fileId, draft.id]);
  if (!r[0]) return void notFound(res);
  await query(`UPDATE drafts SET updated_at=$2 WHERE id=$1`, [draft.id, toIso(now())]);
  res.status(204).end();
}));

// ───────────────────────── คำขอ (API) ─────────────────────────

interface CaseRow {
  case_no: string; service_id: string; citizen_id: number; status: string; step: number | null; fee: number;
  paid_at: Date; due_at: Date; owner: string | null; return_count: number; returned_at: Date | null;
  fix_deadline: Date | null; closed_at: Date | null; doc_no: string | null; verify_code: string | null;
  current_dept: string; receipt_no: string; area_sqm: number | null; qty: number | null;
  applicant_name: string; id_masked: string; id_enc: string;
}
const CASE_SQL = `SELECT c.case_no,c.service_id,c.citizen_id,c.status,c.step,c.fee,c.paid_at,c.due_at,c.owner,c.return_count,
    c.returned_at,c.fix_deadline,c.closed_at,c.doc_no,c.verify_code,c.current_dept,c.receipt_no,c.area_sqm,c.qty,
    z.name AS applicant_name, z.id_masked, z.id_enc
  FROM cases c JOIN citizens z ON z.id = c.citizen_id`;

async function loadCase(caseNo: string): Promise<CaseRow | null> {
  return one<CaseRow>(`${CASE_SQL} WHERE c.case_no=$1`, [caseNo]);
}
/** คำขอที่ผู้ใช้ปัจจุบันเปิดดูได้ (citizen = เจ้าของ · officer/head = ทุกใบ) · ไม่ใช่ → null */
async function viewableCase(req: Request, caseNo: string): Promise<CaseRow | null> {
  const row = await loadCase(caseNo);
  if (!row) return null;
  const u = req.user!;
  if (u.role === 'citizen') {
    // BUG_MODE=B06: ไม่ตรวจเจ้าของ (IDOR)
    if (!isBug('B06') && row.citizen_id !== u.citizenId) return null;
  }
  return row;
}
const levelOf = (row: { status: string; due_at: Date }, holidays: Set<string>) =>
  slaLevel({ status: row.status, dueAt: d(row.due_at) }, holidays);

function caseJson(row: CaseRow, holidays: Set<string>, role: string) {
  const o: Record<string, unknown> = {
    caseNo: row.case_no, serviceId: row.service_id, status: row.status,
    step: row.service_id === 'SV-03' ? (row.step ?? null) : null,
    fee: row.fee, paidAt: iso(row.paid_at), dueAt: iso(row.due_at), slaLevel: levelOf(row, holidays),
    owner: row.owner, returnCount: row.return_count, closedAt: iso(row.closed_at),
    applicantName: row.applicant_name,
    fixDeadline: row.status === 'NEED_FIX' ? iso(row.fix_deadline ?? (row.returned_at ? fixDeadline(d(row.returned_at)) : null)) : null,
    docNo: row.doc_no, verifyCode: row.verify_code,
  };
  if (role === 'citizen') o.idNo = decrypt(row.id_enc); else o.idMasked = row.id_masked;
  return o;
}

router.get('/api/cases', requireCitizen, ah(async (req, res) => {
  const rows = await query<CaseRow>(`${CASE_SQL} WHERE c.citizen_id=$1 ORDER BY c.case_no DESC`, [req.user!.citizenId]);
  const h = await loadHolidays();
  res.json({ items: rows.map((r) => ({ caseNo: r.case_no, serviceId: r.service_id, status: r.status, dueAt: iso(r.due_at), slaLevel: levelOf(r, h) })) });
}));

router.get('/api/cases/:caseNo', requireAuth, ah(async (req, res) => {
  const role = req.user!.role;
  if (role !== 'citizen' && role !== 'officer' && role !== 'head') {
    return void apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
  }
  const row = await viewableCase(req, String(req.params.caseNo));
  if (!row) return void notFound(res);
  res.json(caseJson(row, await loadHolidays(), role));
}));

router.post('/api/cases/:caseNo/cancel', requireCitizen, ah(async (req, res) => {
  const out = await tx(async (c) => {
    const r = await c.query(
      `SELECT case_no,status,owner FROM cases WHERE case_no=$1 AND citizen_id=$2 FOR UPDATE`, [req.params.caseNo, req.user!.citizenId]);
    const row = r.rows[0] as { case_no: string; status: string; owner: string | null } | undefined;
    if (!row) return 404;
    if (row.status !== 'SUBMITTED' || row.owner) return 409;
    const t = toIso(now());
    await c.query(`UPDATE cases SET status='CANCELLED', closed_at=$2, close_reason='CITIZEN_CANCEL', owner=NULL WHERE case_no=$1`, [row.case_no, t]);
    await c.query(
      `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,'CANCEL','SUBMITTED','CANCELLED',$4)`,
      [row.case_no, t, req.user!.username, 'ประชาชนยกเลิกคำขอ']);
    return 200;
  });
  if (out === 404) return void notFound(res);
  if (out === 409) return void apiError(res, 409, 'CANNOT_CANCEL', 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');
  res.json({ status: 'CANCELLED' });
}));

router.post('/api/cases/:caseNo/resubmit', requireCitizen, singleFile, ah(async (req, res) => {
  const f = req.file;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const out = await tx(async (c) => {
    const r = await c.query(
      `SELECT case_no,service_id,status,due_at,returned_at FROM cases WHERE case_no=$1 AND citizen_id=$2 FOR UPDATE`,
      [req.params.caseNo, req.user!.citizenId]);
    const row = r.rows[0] as { case_no: string; service_id: string; status: string; due_at: Date; returned_at: Date | null } | undefined;
    if (!row) return { s: 404 as const };
    if (row.status !== 'NEED_FIX' || !row.returned_at) return { s: 409 as const, code: 'INVALID_STATE' as const };
    const returnedAt = d(row.returned_at);
    const t = now();
    if (isFixWindowExpired(returnedAt, t)) {
      await cancelFixExpired(c, row.case_no, returnedAt);
      return { s: 409 as const, code: 'FIX_WINDOW_EXPIRED' as const };
    }
    // ไฟล์ใหม่ (ไม่บังคับ) · ใช้กติกาเดียวกับตอนยื่น
    let ins: { docKey: DocKey; mime: string } | null = null;
    if (f) {
      const docKey = String(body.docKey ?? 'extra');
      if (!isDocKeyForService(row.service_id, docKey)) return { s: 400 as const, code: 'INVALID_DOC_KEY', message: 'ช่องแนบเอกสารไม่ถูกต้อง' };
      const chk = checkFile(f.buffer, docKey);
      if (!chk.ok) return { s: 400 as const, code: chk.code, message: chk.message };
      const have = (await c.query(`SELECT doc_key FROM files WHERE case_no=$1`, [row.case_no])).rows as { doc_key: string }[];
      const replaced = docKey === 'extra' ? 0 : have.filter((x) => x.doc_key === docKey).length;
      if (have.length - replaced >= MAX_FILES) return { s: 400 as const, code: 'FILE_COUNT', message: UPLOAD_ERRORS.FILE_COUNT };
      ins = { docKey, mime: chk.mime };
    }
    const holidays = await loadHolidays(c);
    const newDue = extendDueAtForFix(d(row.due_at), returnedAt, t, holidays);
    if (f && ins) {
      if (ins.docKey !== 'extra') await c.query(`DELETE FROM files WHERE case_no=$1 AND doc_key=$2`, [row.case_no, ins.docKey]);
      const fileId = `FL-UP${String(await nextNumber('file', c)).padStart(6, '0')}-${ins.docKey}`;
      await c.query(
        `INSERT INTO files(file_id,draft_id,case_no,citizen_id,doc_key,name,size,mime,content,created_at) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, row.case_no, req.user!.citizenId, ins.docKey, cleanName(f.originalname), f.size, ins.mime, f.buffer, toIso(t)]);
    }
    await c.query(`UPDATE cases SET status='IN_REVIEW', due_at=$2, fix_deadline=NULL WHERE case_no=$1`, [row.case_no, toIso(newDue)]);
    await c.query(
      `UPDATE case_returns SET resubmitted_at=$2, paused_workdays=$3
        WHERE id = (SELECT id FROM case_returns WHERE case_no=$1 AND resubmitted_at IS NULL ORDER BY n DESC LIMIT 1)`,
      [row.case_no, toIso(t), pausedWorkingDays(returnedAt, t, holidays)]);
    await c.query(
      `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,'RESUBMIT','NEED_FIX','IN_REVIEW',NULL)`,
      [row.case_no, toIso(t), req.user!.username]);
    return { s: 200 as const, dueAt: toIso(newDue) };
  });
  if (out.s === 404) return void notFound(res);
  if (out.s === 400) return void apiError(res, 400, out.code, out.message);
  if (out.s === 409) {
    return void apiError(res, 409, out.code, out.code === 'FIX_WINDOW_EXPIRED' ? 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก' : 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้');
  }
  res.json({ status: 'IN_REVIEW', dueAt: out.dueAt });
}));

// ───────────────────────── ไฟล์แนบของคำขอ (A-59 · FR-29) ─────────────────────────

/** สิทธิ์ดูไฟล์ของคำขอ: 'ok' | 'notfound' (ประชาชนไม่ใช่เจ้าของ) | 'forbidden' (เจ้าหน้าที่นอกขอบเขต/บทบาทอื่น) */
async function caseFileAccess(req: Request, caseNo: string): Promise<'ok' | 'notfound' | 'forbidden'> {
  const u = req.user!;
  const row = await one<{ citizen_id: number; current_dept: string }>(`SELECT citizen_id, current_dept FROM cases WHERE case_no=$1`, [caseNo]);
  if (u.role === 'citizen') return row && row.citizen_id === u.citizenId ? 'ok' : 'notfound';
  if (u.role === 'head') return row ? 'ok' : 'notfound';
  if (u.role === 'officer') {
    if (!row) return 'notfound';
    const seen = await one(
      `SELECT 1 AS x FROM case_dept_trail WHERE case_no=$1 AND dept=$2 LIMIT 1`, [caseNo, u.dept ?? '']);
    return seen || row.current_dept === u.dept ? 'ok' : 'forbidden';
  }
  return 'forbidden';
}

router.get('/api/cases/:caseNo/files', requireAuth, ah(async (req, res) => {
  const caseNo = String(req.params.caseNo);
  const a = await caseFileAccess(req, caseNo);
  if (a === 'forbidden') return void apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
  if (a === 'notfound') return void notFound(res);
  const rows = await query<FileRow>(`SELECT file_id, name, doc_key, size FROM files WHERE case_no=$1 ORDER BY created_at, file_id`, [caseNo]);
  res.json({ items: rows.map(fileJson) });
}));

router.get('/api/files/:fileId', requireAuth, ah(async (req, res) => {
  const f = await one<{ file_id: string; draft_id: string | null; case_no: string | null; citizen_id: number; name: string; mime: string; content: Buffer }>(
    `SELECT file_id, draft_id, case_no, citizen_id, name, mime, content FROM files WHERE file_id=$1`, [req.params.fileId]);
  const u = req.user!;
  if (u.role !== 'citizen' && u.role !== 'officer' && u.role !== 'head') {
    return void apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
  }
  if (!f) return void notFound(res);
  if (f.case_no) {
    const a = await caseFileAccess(req, f.case_no);
    if (a === 'forbidden') return void apiError(res, 403, 'FORBIDDEN', 'ไม่มีสิทธิ์ทำรายการนี้');
    if (a === 'notfound') return void notFound(res);
  } else if (u.role !== 'citizen' || f.citizen_id !== u.citizenId) {
    return void notFound(res); // ไฟล์ของร่าง: เฉพาะเจ้าของ
  }
  res.set({
    'Content-Type': f.mime,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.send(f.content);
}));

// ───────────────────────── หน้า ─────────────────────────

router.get('/citizen', requireCitizen, ah(async (req, res) => {
  const cid = req.user!.citizenId!;
  const h = await loadHolidays();
  const cases = (await query<CaseRow>(`${CASE_SQL} WHERE c.citizen_id=$1 ORDER BY c.case_no DESC`, [cid])).map((r) => ({
    caseNo: r.case_no, service: `${r.service_id} ${SERVICE_NAMES[r.service_id] ?? ''}`.trim(), status: r.status,
    statusText: STATUS_TEXT[r.status] ?? r.status, dueIso: iso(r.due_at)!, dueText: fmtThai(d(r.due_at)),
    level: levelOf(r, h) ?? 'normal',
  }));
  const drafts = (await query<DraftRow>(
    `SELECT id,citizen_id,service_id,qty,area_sqm,fee,status,case_no FROM drafts
      WHERE citizen_id=$1 AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY id`, [cid])).map((r) => ({
    id: r.id, serviceId: r.service_id, service: `${r.service_id} ${SERVICE_NAMES[r.service_id] ?? ''}`.trim(),
    status: r.status, statusText: STATUS_TEXT[r.status] ?? r.status,
  }));
  await res.page('citizen/index', { title: 'คำขอของฉัน', cases, drafts, SERVICE_NAMES, SLA_LEVEL_TEXT, welcome: req.user!.name });
}));

router.get('/citizen/new/:service', requireCitizen, ah(async (req, res) => {
  const serviceId = String(req.params.service);
  if (!isServiceId(serviceId)) return void res.notFoundCase();
  const cid = req.user!.citizenId!;
  let draft: DraftRow | null = null;
  let files: FileRow[] = [];
  let payment: { ref: string; status: string; qrExpiresAt: string } | null = null;
  if (typeof req.query.draft === 'string' && req.query.draft) {
    draft = await myDraft(req.query.draft, cid);
    if (!draft || draft.service_id !== serviceId || draft.status === 'SUBMITTED') return void res.notFoundCase();
    files = await draftFiles(draft.id);
    const p = await one<{ ref: string; status: string; qr_expires_at: Date }>(
      `SELECT ref,status,qr_expires_at FROM payments WHERE draft_id=$1 ORDER BY qr_created_at DESC, ref DESC LIMIT 1`, [draft.id]);
    if (p) payment = { ref: p.ref, status: p.status, qrExpiresAt: toIso(d(p.qr_expires_at)) };
  }
  const qty = draft ? draft.qty : serviceId === 'SV-01' ? 1 : null;
  const area = draft ? draft.area_sqm : null;
  const f = await feeFor(serviceId, qty, area);
  const boot = {
    serviceId, serviceName: SERVICE_NAMES[serviceId],
    docs: SERVICE_DOCS[serviceId],
    draft: draft ? { id: draft.id, status: draft.status, fee: draft.fee, files: files.map(fileJson) } : null,
    payment, maxFiles: MAX_FILES,
    initial: { qty, area, fee: f.ok ? f.fee : null, error: f.ok ? null : f.message },
  };
  await res.page('citizen/new', {
    title: SERVICE_NAMES[serviceId], serviceId, serviceName: SERVICE_NAMES[serviceId], qty, area,
    feeText: f.ok ? fmtBaht(f.fee) : '–', feeError: f.ok ? '' : f.message, draftId: draft?.id ?? '',
    boot: JSON.stringify(boot).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, ''),
    locked: draft?.status === 'PENDING_PAYMENT',
  });
}));

router.get('/citizen/cases/:caseNo', requireCitizen, ah(async (req, res) => {
  const row = await viewableCase(req, String(req.params.caseNo));
  if (!row) return void res.notFoundCase();
  let status = row.status;
  if (status === 'NEED_FIX' && row.returned_at && isFixWindowExpired(d(row.returned_at))) {
    await tx((c) => cancelFixExpired(c, row.case_no, d(row.returned_at!)));
    const again = await loadCase(row.case_no);
    if (again) { Object.assign(row, again); status = again.status; }
  }
  const h = await loadHolidays();
  const level = levelOf(row, h) ?? 'normal';
  const events = (await query<{ at: Date; event: string; note: string | null; to_status: string | null }>(
    `SELECT at, event, note, to_status FROM case_events WHERE case_no=$1 ORDER BY at, id`, [row.case_no])).map((e) => ({
    iso: toIso(d(e.at)), text: fmtThai(d(e.at)), label: EVENT_TEXT[e.event] ?? e.event, note: e.note ?? '',
  }));
  const files = await query<FileRow>(`SELECT file_id, name, doc_key, size FROM files WHERE case_no=$1 ORDER BY created_at, file_id`, [row.case_no]);
  const lastReturn = await one<{ reason: string }>(
    `SELECT reason FROM case_returns WHERE case_no=$1 ORDER BY n DESC LIMIT 1`, [row.case_no]);
  const step = row.service_id === 'SV-03' ? (row.step ?? (status === 'PENDING_APPROVAL' ? 3 : null)) : null;
  const fixDl = status === 'NEED_FIX'
    ? (row.fix_deadline ? d(row.fix_deadline) : row.returned_at ? fixDeadline(d(row.returned_at)) : null) : null;
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  await res.page('citizen/case', {
    title: row.case_no,
    c: {
      caseNo: row.case_no, serviceText: `${row.service_id} ${SERVICE_NAMES[row.service_id] ?? ''}`.trim(),
      status, statusText: STATUS_TEXT[status] ?? status, stepText: step ? STEP_TEXT[step] : '',
      feeText: fmtBaht(row.fee), dueIso: iso(row.due_at), dueText: fmtThai(d(row.due_at)),
      level, levelText: SLA_LEVEL_TEXT[level as keyof typeof SLA_LEVEL_TEXT] ?? level,
      closedIso: iso(row.closed_at), closedText: row.closed_at ? fmtThai(d(row.closed_at)) : '',
      idFull: fmtIdNo(decrypt(row.id_enc)), docNo: row.doc_no, verifyCode: row.verify_code,
      verifyUrl: row.verify_code ? `${base}/verify/${row.verify_code}` : '',
      reason: lastReturn?.reason ?? '', fixIso: fixDl ? toIso(fixDl) : null, fixText: fixDl ? fmtThai(fixDl) : '',
      today: bkkDate(now()),
    },
    events,
    files: files.map((f) => ({ id: f.file_id, name: f.name })),
  });
}));

export default router;
