// B07 · เจ้าหน้าที่/หัวหน้า: คิว workflow แจ้งเตือน
// CONTRACT §2.6-2.8 §2.12 §6.3 · FR-12..16 FR-20 FR-21 · BR-15..19 BR-21 BR-24
// ตามกฎ "เขียนเฉพาะ src/routes/officer.ts" ไฟล์นี้จึงรวม workflow (แทน lib/workflow.ts) · แจ้งเตือน (แทน lib/notify.ts)
// · หน้า /head/approvals (แทน head.ts) และ template (แทน views/officer/* views/head/*) ไว้ด้วยกัน
// ไม่รวม: ออกเอกสาร (POST /api/officer/cases/:caseNo/issue) และ API ไฟล์แนบ (FR-29 อยู่ใน citizen.ts ของ B05)
// BUG_MODE ในไฟล์นี้: B07 (อนุมัติโดยไม่เช็กบทบาท SV-02/03) · B08 (รับเรื่องข้ามตรวจผู้ถือ) · B09 (คิวส่ง idNo) · B11 (unmask ไม่ลง Audit) · B12 (ตีกลับครั้งที่ 3)
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
// @ts-ignore ไม่มี @types/ejs
import ejs from 'ejs';
import { fmtBaht, fmtThai, now, toIso } from '../lib/clock.ts';
import { isBug } from '../lib/bugmode.ts';
import { decrypt } from '../lib/crypto.ts';
import { one, query, tx } from '../lib/db.ts';
import { onRequest } from '../lib/hooks.ts';
import { ah, apiError } from '../lib/http.ts';
import { requireRole } from '../lib/rbac.ts';
import { SERVICE_NAMES } from '../lib/upload.ts';
import { SLA_LEVEL_TEXT, fixDeadline, isAlertLevel, loadHolidays, slaLevel } from '../rules/fee-sla.ts';
import { audit } from './audit-admin.ts';
import { STATUS_TEXT } from './citizen.ts';

const router = Router();
const requireStaff = requireRole('officer', 'head');
const requireOfficerOnly = requireRole('officer');
const requireHeadOnly = requireRole('head');

const MAX_WORKLOAD = 10;
const MAX_RETURNS = 2;
const MIN_REASON = 10;
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];
const FILTERS = ['all', 'unclaimed', 'mine'] as const;
type Filter = (typeof FILTERS)[number];

const MSG = {
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบคำขอ',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
} as const;
type Fail = { fail: keyof typeof MSG; status: number };
const F = (fail: keyof typeof MSG, status: number): Fail => ({ fail, status });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'fail' in x;
const sendFail = (res: Response, f: Fail) => apiError(res, f.status, f.fail, MSG[f.fail]);

const EVENT_TEXT: Record<string, string> = {
  SUBMIT: 'ยื่นคำขอ', CLAIM: 'เจ้าหน้าที่รับเรื่อง', RETURN: 'ตีกลับให้แก้ไขเอกสาร', RESUBMIT: 'ส่งแก้ไขเอกสาร',
  FORWARD: 'ส่งต่อ', APPROVE: 'อนุมัติ', ISSUE: 'ออกเอกสาร', REJECT: 'ไม่อนุมัติ', CANCEL: 'ยกเลิกคำขอ',
};
const STEP_TEXT: Record<number, string> = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const DEPT_STEP: Record<string, number> = { registry: 1, works: 2, head: 3 };

const d = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const iso = (v: unknown): string | null => (v == null ? null : toIso(d(v)));
const fmtIdNo = (s: string) => (s.length === 13 ? `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}` : s);
const serviceText = (id: string) => `${id} ${SERVICE_NAMES[id] ?? ''}`.trim();
const reasonOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

interface CRow {
  case_no: string; service_id: string; citizen_id: number; status: string; step: number | null; current_dept: string;
  owner: string | null; issuer: string | null; fee: number; due_at: Date; return_count: number; closed_at: Date | null;
  doc_no: string | null; verify_code: string | null; applicant_name: string; id_masked: string; id_enc: string;
}
const CASE_SELECT = `SELECT c.case_no,c.service_id,c.citizen_id,c.status,c.step,c.current_dept,c.owner,c.issuer,c.fee,c.due_at,
    c.return_count,c.closed_at,c.doc_no,c.verify_code,z.name AS applicant_name,z.id_masked,z.id_enc
  FROM cases c JOIN citizens z ON z.id = c.citizen_id`;

const stepOf = (r: { service_id: string; step: number | null; current_dept: string }): number | null =>
  r.service_id === 'SV-03' ? (r.step ?? DEPT_STEP[r.current_dept] ?? null) : null;

// ───────────────────────── แจ้งเตือน (BR-15 · A-30 A-31) ─────────────────────────

const NOTIFY_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];

/**
 * ประเมินระดับเตือนของคำขอที่ยังเปิดอยู่ตามนาฬิกาปัจจุบัน แล้วสร้างแจ้งเตือน "ระดับปัจจุบัน" ให้ผู้รับ
 * 1 รายการต่อ (ผู้ใช้, คำขอ, ระดับ) — UNIQUE ใน DB กันซ้ำ แม้เรียกพร้อมกัน · ไม่ย้อนสร้างระดับที่ข้ามไปแล้ว
 */
export async function evaluateNotifications(): Promise<void> {
  const at = now();
  const cases = await query<{ case_no: string; status: string; current_dept: string; owner: string | null; issuer: string | null; due_at: Date }>(
    `SELECT case_no,status,current_dept,owner,issuer,due_at FROM cases WHERE status = ANY($1) ORDER BY due_at, case_no`, [NOTIFY_STATUSES]);
  if (!cases.length) return;
  const holidays = await loadHolidays();
  const staff = await query<{ username: string; role: string; dept: string }>(
    `SELECT username, role, dept FROM staff_users WHERE role IN ('officer','head') ORDER BY username`);
  const heads = staff.filter((s) => s.role === 'head').map((s) => s.username);
  const us: string[] = [], cs: string[] = [], ls: string[] = [], ts: string[] = [];
  for (const c of cases) {
    const level = slaLevel({ status: c.status, dueAt: d(c.due_at) }, holidays, at);
    if (!isAlertLevel(level)) continue;
    const to = new Set<string>();
    if (c.status === 'PENDING_APPROVAL') heads.forEach((h) => to.add(h));
    else if (c.status === 'APPROVED') { const u = c.issuer ?? c.owner; if (u) to.add(u); }
    else if (c.owner) to.add(c.owner);
    else staff.filter((s) => s.role === 'officer' && s.dept === c.current_dept).forEach((s) => to.add(s.username));
    if (level === 'overdue') heads.forEach((h) => to.add(h));
    const text = `คำขอ ${c.case_no} ${level === 'near' ? 'ใกล้ครบกำหนด' : 'เกินกำหนด'}`;
    for (const u of to) { us.push(u); cs.push(c.case_no); ls.push(level); ts.push(text); }
  }
  if (!us.length) return;
  await query(
    `INSERT INTO notifications(username,case_no,level,text,created_at)
     SELECT x.u, x.c, x.l, x.t, $5::timestamptz FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS x(u,c,l,t)
     ON CONFLICT (username, case_no, level) DO NOTHING`, [us, cs, ls, ts, toIso(at)]);
}
onRequest(async () => { await evaluateNotifications(); });

// ───────────────────────── Workflow (รับเรื่อง ตีกลับ ส่งต่อ อนุมัติ ไม่อนุมัติ) ─────────────────────────

type Tx = PoolClient;
const lockCase = async (c: Tx, caseNo: string): Promise<CRow | null> =>
  (await c.query(`${CASE_SELECT} WHERE c.case_no = $1 FOR UPDATE OF c`, [caseNo])).rows[0] ?? null;

async function addEvent(c: Tx, caseNo: string, actor: string, event: string, from: string | null, to: string | null, note: string | null) {
  await c.query(
    `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [caseNo, toIso(now()), actor, event, from, to, note]);
}
const addTrail = (c: Tx, caseNo: string, dept: string) =>
  c.query(`INSERT INTO case_dept_trail(case_no,dept,entered_at) VALUES ($1,$2,$3)`, [caseNo, dept, toIso(now())]);
const auditTo = (c: Tx) => c as unknown as Parameters<typeof audit>[1];

/** งานในมือ = IN_REVIEW ที่ตัวเองถือ (BR-18) */
export async function workloadOf(username: string, c?: Tx): Promise<number> {
  const sql = `SELECT count(*)::int AS n FROM cases WHERE owner = $1 AND status = 'IN_REVIEW'`;
  const r = c ? (await c.query(sql, [username])).rows[0] : await one(sql, [username]);
  return r?.n ?? 0;
}

async function claimCase(u: Express.SessionUser, caseNo: string): Promise<{ owner: string } | Fail | 'notfound'> {
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workload:${u.username}`]);
    const row = await lockCase(c, caseNo);
    if (!row) return 'notfound' as const;
    // ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT
    if (u.role !== 'officer' || !u.dept || u.dept !== row.current_dept) return F('FORBIDDEN', 403);
    if (row.owner && !isBug('B08')) return F('ALREADY_CLAIMED', 409);
    if (row.status !== 'SUBMITTED' && row.status !== 'IN_REVIEW') return F('INVALID_STATE', 409);
    if ((await workloadOf(u.username, c)) >= MAX_WORKLOAD) return F('WORKLOAD_LIMIT', 409);
    await c.query(
      `UPDATE cases SET status='IN_REVIEW', owner=$2, issuer = CASE WHEN current_dept='registry' THEN COALESCE(issuer,$2) ELSE issuer END
        WHERE case_no=$1`, [caseNo, u.username]);
    await addEvent(c, caseNo, u.username, 'CLAIM', row.status, 'IN_REVIEW', null);
    await audit({ username: u.username, role: u.role, event: 'CLAIM', caseNo, fromStatus: row.status, toStatus: 'IN_REVIEW' }, auditTo(c));
    return { owner: u.username };
  });
}

async function returnCase(u: Express.SessionUser, caseNo: string, reasonRaw: unknown) {
  return tx(async (c) => {
    const row = await lockCase(c, caseNo);
    if (!row) return 'notfound' as const;
    if (u.role !== 'officer' || row.owner !== u.username) return F('FORBIDDEN', 403);
    if (row.status !== 'IN_REVIEW') return F('INVALID_STATE', 409);
    const reason = reasonOf(reasonRaw);
    if (reason.length < MIN_REASON) return F('REASON_TOO_SHORT', 400);
    if (row.return_count >= MAX_RETURNS && !isBug('B12')) return F('RETURN_LIMIT', 409);
    const t = now();
    const n = row.return_count + 1;
    await c.query(
      `UPDATE cases SET status='NEED_FIX', return_count=$2, returned_at=$3, fix_deadline=$4 WHERE case_no=$1`,
      [caseNo, n, toIso(t), toIso(fixDeadline(t))]);
    await c.query(
      `INSERT INTO case_returns(case_no,n,returned_at,reason,by_username) VALUES ($1,$2,$3,$4,$5)`, [caseNo, n, toIso(t), reason, u.username]);
    await addEvent(c, caseNo, u.username, 'RETURN', 'IN_REVIEW', 'NEED_FIX', reason);
    await audit({ username: u.username, role: u.role, event: 'RETURN', caseNo, fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: reason }, auditTo(c));
    return { status: 'NEED_FIX', returnCount: n };
  });
}

/** ส่งต่ออัตโนมัติ: SV-02 ทะเบียน→หัวหน้า · SV-03 ทะเบียน→โยธา→หัวหน้า · SV-01 ไม่มีส่งต่อ (ผู้ใช้เลือกปลายทางเองไม่ได้) */
async function forwardCase(u: Express.SessionUser, caseNo: string, noteRaw: unknown) {
  return tx(async (c) => {
    const row = await lockCase(c, caseNo);
    if (!row) return 'notfound' as const;
    if (u.role !== 'officer' || row.owner !== u.username) return F('FORBIDDEN', 403);
    if (row.status !== 'IN_REVIEW' || row.service_id === 'SV-01') return F('INVALID_STATE', 409);
    const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    let out: { status: string; step?: number };
    if (row.service_id === 'SV-03' && row.current_dept === 'registry') {
      await c.query(
        `UPDATE cases SET step=2, current_dept='works', owner=NULL, issuer=COALESCE(issuer,owner) WHERE case_no=$1`, [caseNo]);
      await addTrail(c, caseNo, 'works');
      out = { status: 'IN_REVIEW', step: 2 };
    } else {
      const sv3 = row.service_id === 'SV-03';
      await c.query(
        `UPDATE cases SET status='PENDING_APPROVAL', step=$2, current_dept='head', owner=NULL,
           issuer = CASE WHEN current_dept='registry' THEN COALESCE(issuer,owner) ELSE issuer END WHERE case_no=$1`,
        [caseNo, sv3 ? 3 : null]);
      await addTrail(c, caseNo, 'head');
      out = sv3 ? { status: 'PENDING_APPROVAL', step: 3 } : { status: 'PENDING_APPROVAL' };
    }
    await addEvent(c, caseNo, u.username, 'FORWARD', 'IN_REVIEW', out.status, note || null);
    await audit({ username: u.username, role: u.role, event: 'FORWARD', caseNo, fromStatus: 'IN_REVIEW', toStatus: out.status, detail: note }, auditTo(c));
    return out;
  });
}

/** อำนาจตัดสิน: SV-01 = ผู้ถือเรื่อง (IN_REVIEW) · SV-02/03 = head (PENDING_APPROVAL)
 *  B07: ไม่เช็กบทบาทที่ SV-02/03 **เฉพาะการอนุมัติ** (BUGS.md · กติกาข้อ 1 เปลี่ยนเฉพาะจุดที่ระบุ · reject ยังต้อง 403) */
function decisionGate(u: Express.SessionUser, row: CRow, action: 'approve' | 'reject'): Fail | null {
  if (row.service_id === 'SV-01') {
    if (u.role !== 'officer' || row.owner !== u.username) return F('FORBIDDEN', 403);
    return row.status === 'IN_REVIEW' ? null : F('INVALID_STATE', 409);
  }
  if (u.role !== 'head' && !(action === 'approve' && isBug('B07'))) return F('FORBIDDEN', 403);
  return row.status === 'PENDING_APPROVAL' ? null : F('INVALID_STATE', 409);
}

async function approveCase(u: Express.SessionUser, caseNo: string) {
  return tx(async (c) => {
    const row = await lockCase(c, caseNo);
    if (!row) return 'notfound' as const;
    const g = decisionGate(u, row, 'approve');
    if (g) return g;
    const t = toIso(now());
    if (row.service_id === 'SV-01') {
      // ผู้ออกเอกสาร SV-01 = ผู้ถือเรื่อง (A-27)
      await c.query(`UPDATE cases SET status='APPROVED', approved_at=$2, issuer=owner WHERE case_no=$1`, [caseNo, t]);
    } else {
      // กลับไปรอออกเอกสารที่แผนกทะเบียน (ผู้ออก = ผู้รับเรื่องขั้นแรก)
      await c.query(
        `UPDATE cases SET status='APPROVED', approved_by=$2, approved_at=$3, current_dept='registry', owner=NULL WHERE case_no=$1`,
        [caseNo, u.username, t]);
      await addTrail(c, caseNo, 'registry');
    }
    await addEvent(c, caseNo, u.username, 'APPROVE', row.status, 'APPROVED', null);
    await audit({ username: u.username, role: u.role, event: 'APPROVE', caseNo, fromStatus: row.status, toStatus: 'APPROVED' }, auditTo(c));
    return { status: 'APPROVED' };
  });
}

async function rejectCase(u: Express.SessionUser, caseNo: string, reasonRaw: unknown) {
  return tx(async (c) => {
    const row = await lockCase(c, caseNo);
    if (!row) return 'notfound' as const;
    const g = decisionGate(u, row, 'reject');
    if (g) return g;
    const reason = reasonOf(reasonRaw);
    if (reason.length < MIN_REASON) return F('REASON_TOO_SHORT', 400);
    const t = toIso(now());
    await c.query(
      `UPDATE cases SET status='REJECTED', closed_at=$2, close_reason='ไม่อนุมัติ', approved_by=$3 WHERE case_no=$1`, [caseNo, t, u.username]);
    await addEvent(c, caseNo, u.username, 'REJECT', row.status, 'REJECTED', reason);
    await audit({ username: u.username, role: u.role, event: 'REJECT', caseNo, fromStatus: row.status, toStatus: 'REJECTED', detail: reason }, auditTo(c));
    return { status: 'REJECTED', closedAt: t };
  });
}

// ───────────────────────── API ─────────────────────────

const notFound = (res: Response) => apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
const reply = (res: Response, r: unknown) => {
  if (r === 'notfound') return void notFound(res);
  if (isFail(r)) return void sendFail(res, r);
  res.json(r);
};

interface QueueItem {
  caseNo: string; serviceId: string; applicantName: string; idMasked: string; status: string; step: number | null;
  owner: string | null; dueAt: string; slaLevel: string | null; dept: string;
}

async function loadQueue(u: Express.SessionUser, filter: Filter): Promise<{ items: QueueItem[]; rows: CRow[] }> {
  const params: unknown[] = [QUEUE_STATUSES];
  let where = `c.status = ANY($1)`;
  if (u.role === 'officer') { params.push(u.dept ?? ''); where += ` AND c.current_dept = $2`; }
  const rows = (await query<CRow>(`${CASE_SELECT} WHERE ${where} ORDER BY c.due_at, c.case_no`, params))
    .filter((r) => filter === 'all'
      || (filter === 'unclaimed' && !r.owner && r.status !== 'APPROVED')
      || (filter === 'mine' && r.status === 'IN_REVIEW' && r.owner === u.username));
  const holidays = await loadHolidays();
  const items = rows.map((r) => ({
    caseNo: r.case_no, serviceId: r.service_id, applicantName: r.applicant_name, idMasked: r.id_masked, status: r.status,
    step: stepOf(r), owner: r.owner, dueAt: toIso(d(r.due_at)),
    slaLevel: slaLevel({ status: r.status, dueAt: d(r.due_at) }, holidays), dept: r.current_dept,
  }));
  return { items, rows };
}
const parseFilter = (v: unknown): Filter => (FILTERS as readonly string[]).includes(String(v)) ? (v as Filter) : 'all';

router.get('/api/officer/queue', requireStaff, ah(async (req, res) => {
  const { items, rows } = await loadQueue(req.user!, parseFilter(req.query.filter));
  res.json({
    items: items.map(({ dept: _d, ...it }, i) => (isBug('B09') ? { ...it, idNo: decrypt(rows[i].id_enc) } : it)),
  });
}));

router.post('/api/officer/cases/:caseNo/claim', requireOfficerOnly, ah(async (req, res) => {
  reply(res, await claimCase(req.user!, String(req.params.caseNo)));
}));
router.post('/api/officer/cases/:caseNo/return', requireOfficerOnly, ah(async (req, res) => {
  reply(res, await returnCase(req.user!, String(req.params.caseNo), req.body?.reason));
}));
router.post('/api/officer/cases/:caseNo/forward', requireOfficerOnly, ah(async (req, res) => {
  reply(res, await forwardCase(req.user!, String(req.params.caseNo), req.body?.note));
}));
router.post('/api/cases/:caseNo/approve', requireStaff, ah(async (req, res) => {
  reply(res, await approveCase(req.user!, String(req.params.caseNo)));
}));
router.post('/api/cases/:caseNo/reject', requireStaff, ah(async (req, res) => {
  reply(res, await rejectCase(req.user!, String(req.params.caseNo), req.body?.reason));
}));

router.post('/api/officer/cases/:caseNo/unmask', requireStaff, ah(async (req, res) => {
  const caseNo = String(req.params.caseNo);
  const row = await one<{ id_enc: string }>(
    `SELECT z.id_enc FROM cases c JOIN citizens z ON z.id = c.citizen_id WHERE c.case_no = $1`, [caseNo]);
  if (!row) return void notFound(res);
  const reason = reasonOf(req.body?.reason);
  if (!reason) return void apiError(res, 400, 'REASON_REQUIRED', MSG.REASON_REQUIRED);
  if (!isBug('B11')) {
    const u = req.user!;
    await audit({ username: u.username, role: u.role, event: 'UNMASK', caseNo, detail: reason });
  }
  res.json({ idNo: decrypt(row.id_enc) });
}));

const notiJson = (r: { id: number; case_no: string; level: string; text: string; created_at: Date }) =>
  ({ id: r.id, caseNo: r.case_no, level: r.level, text: r.text, createdAt: toIso(d(r.created_at)) });
const myNotifications = (username: string) => query<{ id: number; case_no: string; level: string; text: string; created_at: Date }>(
  `SELECT id,case_no,level,text,created_at FROM notifications WHERE username = $1 ORDER BY id`, [username]);

router.get('/api/notifications', requireStaff, ah(async (req, res) => {
  res.json({ items: (await myNotifications(req.user!.username)).map(notiJson) });
}));

// ───────────────────────── หน้า ─────────────────────────

async function renderPage(req: Request, res: Response, title: string, tpl: string, locals: Record<string, unknown>) {
  const u = req.user!;
  const bell = await one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE username = $1`, [u.username]);
  const data = { title, success: null, error: null, ...res.locals, user: u, bellCount: bell?.n ?? 0, ...locals };
  const body = ejs.render(tpl, data);
  res.render('layout', { ...data, body });
}

const STYLE = `<style>.err-text{color:#8a1111}.muted{color:#555}.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end}
.facts dt{font-weight:700}.facts dd{margin:0 0 .5rem}.btn,.link-btn{display:inline-block;padding:.4rem .8rem;border:1px solid #0b3d6b;border-radius:4px;background:#fff;color:#0b3d6b;text-decoration:none}
fieldset{margin:1rem 0;border:1px solid #d5d9df;border-radius:4px}textarea,input[type=text]{width:100%;max-width:32rem}</style>`;

const ROWS_TPL = `<% if (workload !== null) { %><p>งานในมือของฉัน: <strong data-testid="workload-count"><%= workload %></strong> เรื่อง (สูงสุด 10)</p><% } %>
<% if (!items.length) { %><p data-testid="queue-empty">ไม่มีงานในคิว</p><% } %>
<table data-testid="queue-table"<% if (!items.length) { %> hidden<% } %>>
  <caption>รายการคำขอ เรียงตามกำหนดเสร็จ</caption>
  <thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr></thead>
  <tbody>
  <% items.forEach(function (r) { %>
    <tr data-testid="queue-row" data-case-no="<%= r.caseNo %>" data-owner="<%= r.owner || '' %>" data-status="<%= r.status %>" data-sla-level="<%= r.slaLevel %>">
      <td><a data-testid="row-case-no" href="/officer/cases/<%= r.caseNo %>"><%= r.caseNo %></a></td>
      <td data-testid="row-service"><%= r.serviceText %></td>
      <td data-testid="row-applicant"><%= r.applicantName %></td>
      <td data-testid="row-id-masked"><%= r.idMasked %></td>
      <td data-testid="row-status" data-status="<%= r.status %>"><%= r.statusText %></td>
      <td data-testid="row-due" data-iso="<%= r.dueIso %>"><%= r.dueText %></td>
      <td data-testid="row-sla-level" data-level="<%= r.slaLevel %>"><%= r.levelText %></td>
      <td data-testid="row-owner"><%= r.owner || '' %></td>
      <td><% if (r.canClaim) { %><button type="button" data-testid="claim-btn" data-case-no="<%= r.caseNo %>">รับเรื่อง</button><% } %></td>
    </tr>
  <% }) %>
  </tbody>
</table>`;

const QUEUE_TPL = `${STYLE}
<h1>คิวงาน</h1>
<div class="actions">
  <label for="queue-filter">กรองรายการ
    <select id="queue-filter" data-testid="queue-filter">
      <option value="all"<% if (filter === 'all') { %> selected<% } %>>ทั้งหมด</option>
      <option value="unclaimed"<% if (filter === 'unclaimed') { %> selected<% } %>>ยังไม่มีผู้รับ</option>
      <option value="mine"<% if (filter === 'mine') { %> selected<% } %>>ของฉัน</option>
    </select>
  </label>
</div>
<div data-testid="action-error" role="alert" class="toast err" hidden></div>
<div id="queue-region"><%- region %></div>
<script>
(function () {
  var region = document.getElementById('queue-region'), sel = document.getElementById('queue-filter');
  var err = document.querySelector('[data-testid="action-error"]');
  function load() {
    return fetch('/officer/queue/fragment?filter=' + encodeURIComponent(sel.value), { credentials: 'same-origin' })
      .then(function (r) { return r.text(); }).then(function (h) { region.innerHTML = h; });
  }
  sel.addEventListener('change', function () { history.replaceState(null, '', '?filter=' + encodeURIComponent(sel.value)); load(); });
  region.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-testid="claim-btn"]') : null;
    if (!b) return;
    b.disabled = true;
    fetch('/api/officer/cases/' + encodeURIComponent(b.getAttribute('data-case-no')) + '/claim', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok) { err.hidden = true; err.textContent = ''; } else { err.textContent = x.j.message || 'เกิดข้อผิดพลาด'; err.hidden = false; }
        return load();
      });
  });
})();
</script>`;

async function queueRegion(u: Express.SessionUser, filter: Filter): Promise<string> {
  const { items } = await loadQueue(u, filter);
  const view = items.map((r) => ({
    ...r, serviceText: serviceText(r.serviceId), statusText: STATUS_TEXT[r.status] ?? r.status,
    dueIso: r.dueAt, dueText: fmtThai(new Date(r.dueAt)),
    levelText: SLA_LEVEL_TEXT[r.slaLevel as keyof typeof SLA_LEVEL_TEXT] ?? '',
    canClaim: u.role === 'officer' && r.dept === u.dept && !r.owner && (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW'),
  }));
  return ejs.render(ROWS_TPL, { items: view, workload: u.role === 'officer' ? await workloadOf(u.username) : null });
}

router.get('/officer/queue/fragment', requireStaff, ah(async (req, res) => {
  res.type('html').send(await queueRegion(req.user!, parseFilter(req.query.filter)));
}));
router.get('/officer/queue', requireStaff, ah(async (req, res) => {
  const filter = parseFilter(req.query.filter);
  await renderPage(req, res, 'คิวงาน', QUEUE_TPL, { filter, region: await queueRegion(req.user!, filter) });
}));

// ── หัวหน้า: รออนุมัติ ──
const APPROVALS_TPL = `${STYLE}
<h1>รายการรออนุมัติ</h1>
<% if (!items.length) { %><p data-testid="approval-empty">ไม่มีรายการรออนุมัติ</p><% } else { %>
<table>
  <caption>คำขอที่รออนุมัติ เรียงตามกำหนดเสร็จ</caption>
  <thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ดำเนินการ</th></tr></thead>
  <tbody>
  <% items.forEach(function (r) { %>
    <tr data-testid="approval-row" data-case-no="<%= r.caseNo %>">
      <td data-testid="row-case-no"><%= r.caseNo %></td>
      <td data-testid="row-service"><%= r.serviceText %></td>
      <td data-testid="row-applicant"><%= r.applicant %></td>
      <td data-testid="row-due" data-iso="<%= r.dueIso %>"><%= r.dueText %></td>
      <td><a class="link-btn" data-testid="approval-open" href="/officer/cases/<%= r.caseNo %>">เปิดคำขอ</a></td>
    </tr>
  <% }) %>
  </tbody>
</table><% } %>`;

router.get('/head/approvals', requireHeadOnly, ah(async (req, res) => {
  const rows = await query<CRow>(`${CASE_SELECT} WHERE c.status = 'PENDING_APPROVAL' ORDER BY c.due_at, c.case_no`);
  const items = rows.map((r) => ({
    caseNo: r.case_no, serviceText: serviceText(r.service_id), applicant: r.applicant_name,
    dueIso: toIso(d(r.due_at)), dueText: fmtThai(d(r.due_at)),
  }));
  await renderPage(req, res, 'รายการรออนุมัติ', APPROVALS_TPL, { items });
}));

// ── แจ้งเตือน ──
const NOTI_TPL = `${STYLE}
<h1>แจ้งเตือน</h1>
<% if (!items.length) { %><p data-testid="noti-empty">ไม่มีแจ้งเตือน</p><% } else { %>
<ul>
  <% items.forEach(function (n) { %>
    <li><a data-testid="noti-item" data-case-no="<%= n.caseNo %>" data-level="<%= n.level %>" href="/officer/cases/<%= n.caseNo %>"><%= n.text %></a>
      <span class="muted" data-iso="<%= n.createdAt %>"><%= n.createdText %></span></li>
  <% }) %>
</ul><% } %>`;

router.get('/notifications', requireStaff, ah(async (req, res) => {
  const items = (await myNotifications(req.user!.username)).map((r) => ({ ...notiJson(r), createdText: fmtThai(d(r.created_at)) }));
  await renderPage(req, res, 'แจ้งเตือน', NOTI_TPL, { items });
}));

// ── รายละเอียดคำขอ (เจ้าหน้าที่/หัวหน้า) ──
const CASE_TPL = `${STYLE}
<h1>คำขอ <span data-testid="case-no"><%= c.caseNo %></span></h1>
<% if (workload !== null) { %><p>งานในมือของฉัน: <strong data-testid="workload-count"><%= workload %></strong> เรื่อง (สูงสุด 10)</p><% } %>
<div data-testid="action-error" role="alert" class="toast err" hidden></div>
<dl class="facts">
  <dt>สถานะ</dt><dd data-testid="case-status" data-status="<%= c.status %>"><%= c.statusText %></dd>
  <dt>บริการ</dt><dd data-testid="case-service"><%= c.serviceText %></dd>
  <% if (c.stepText) { %><dt>ขั้นตอน</dt><dd data-testid="case-step"><%= c.stepText %></dd><% } %>
  <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee"><%= c.feeText %></dd>
  <dt>ผู้ยื่น</dt><dd data-testid="applicant-name"><%= c.applicant %></dd>
  <dt>เลขบัตรประชาชน</dt><dd data-testid="applicant-id"><%= c.idMasked %></dd>
  <dt>กำหนดเสร็จ</dt><dd data-testid="sla-due" data-iso="<%= c.dueIso %>"><%= c.dueText %></dd>
  <dt>ระดับเตือน</dt><dd data-testid="sla-level" data-level="<%= c.level %>"><%= c.levelText %></dd>
  <% if (c.closedIso && (c.status === 'COMPLETED' || c.status === 'REJECTED')) { %>
    <dt>ปิดงานเมื่อ</dt><dd data-testid="closed-at" data-iso="<%= c.closedIso %>"><%= c.closedText %></dd>
  <% } %>
  <dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner"><%= c.owner || 'ยังไม่มีผู้รับ' %></dd>
  <dt>ตีกลับแล้ว (ครั้ง)</dt><dd data-testid="return-count"><%= c.returnCount %></dd>
  <% if (c.docNo) { %>
    <dt>เลขเอกสาร</dt><dd data-testid="doc-no"><%= c.docNo %></dd>
    <% if (c.verifyCode) { %>
    <dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code"><%= c.verifyCode %></dd>
    <dt>QR ตรวจสอบเอกสาร</dt><dd data-testid="doc-qr" data-url="<%= c.verifyUrl %>"><a href="<%= c.verifyUrl %>"><%= c.verifyUrl %></a></dd>
    <% } %>
  <% } %>
</dl>

<section aria-labelledby="unmask-h">
  <h2 id="unmask-h">เลขบัตรประชาชนเต็ม</h2>
  <p><button type="button" data-testid="show-full-id-btn" id="show-full-id">แสดงเลขเต็ม</button></p>
  <p><label for="unmask-reason">เหตุผลที่ขอดูเลขเต็ม</label><br><input type="text" id="unmask-reason" data-testid="unmask-reason" autocomplete="off"></p>
  <p><button type="button" data-testid="unmask-submit" id="unmask-submit">ยืนยันการแสดงเลขเต็ม</button></p>
  <p class="err-text" role="alert" data-testid="unmask-error" id="unmask-error" hidden></p>
  <p id="full-id-box"></p>
</section>

<section aria-labelledby="actions-h">
  <h2 id="actions-h">ดำเนินการ</h2>
  <div class="actions">
    <% if (c.canClaim) { %><button type="button" data-testid="claim-btn" id="claim-btn">รับเรื่อง</button><% } %>
    <% if (c.canApprove) { %><button type="button" data-testid="approve-btn" id="approve-btn">อนุมัติ</button><% } %>
    <% if (c.canIssue) { %><button type="button" data-testid="issue-btn" id="issue-btn">ออกเอกสาร</button><% } %>
  </div>
  <% if (c.canForward) { %>
  <fieldset><legend>ส่งต่อ</legend>
    <p><label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label><br><textarea id="forward-note" data-testid="forward-note" rows="2"></textarea></p>
    <button type="button" data-testid="forward-btn" id="forward-btn">ผ่าน/ส่งต่อ</button>
  </fieldset>
  <% } %>
  <% if (c.canReturn) { %>
  <fieldset><legend>ตีกลับให้แก้ไขเอกสาร</legend>
    <button type="button" data-testid="return-btn" id="return-btn">ตีกลับ</button>
    <p><label for="return-reason">เหตุผลที่ตีกลับ (อย่างน้อย 10 ตัวอักษร)</label><br><input type="text" id="return-reason" data-testid="return-reason" autocomplete="off"></p>
    <button type="button" data-testid="return-submit" id="return-submit">ยืนยันตีกลับ</button>
    <p class="err-text" role="alert" data-testid="return-reason-error" id="return-reason-error" hidden></p>
  </fieldset>
  <% } %>
  <% if (c.canReject) { %>
  <fieldset><legend>ไม่อนุมัติ</legend>
    <button type="button" data-testid="reject-btn" id="reject-btn">ไม่อนุมัติ</button>
    <p><label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)</label><br><input type="text" id="reject-reason" data-testid="reject-reason" autocomplete="off"></p>
    <button type="button" data-testid="reject-submit" id="reject-submit">ยืนยันไม่อนุมัติ</button>
    <p class="err-text" role="alert" data-testid="reject-reason-error" id="reject-reason-error" hidden></p>
  </fieldset>
  <% } %>
</section>

<section aria-labelledby="files-h">
  <h2 id="files-h">เอกสารแนบ</h2>
  <% if (!c.filesAllowed) { %><p class="muted">ไม่มีสิทธิ์เปิดเอกสารแนบของคำขอนี้</p>
  <% } else if (!files.length) { %><p class="muted">ไม่มีเอกสารแนบ</p>
  <% } else { %>
  <ul>
    <% files.forEach(function (f) { %>
    <li data-testid="doc-item" data-name="<%= f.name %>" data-file-id="<%= f.id %>">
      <%= f.name %> <a data-testid="doc-download-link" href="/api/files/<%= f.id %>" download="<%= f.name %>">ดาวน์โหลด <span class="muted"><%= f.name %></span></a>
    </li>
    <% }) %>
  </ul>
  <% } %>
</section>

<section aria-labelledby="tl-h">
  <h2 id="tl-h">ไทม์ไลน์</h2>
  <ol data-testid="case-timeline">
    <% events.forEach(function (e) { %>
    <li data-testid="timeline-item" data-iso="<%= e.iso %>"><%= e.text %> · <%= e.label %><% if (e.note) { %> · <%= e.note %><% } %></li>
    <% }) %>
  </ol>
</section>

<script>
(function () {
  var CASE_NO = <%- JSON.stringify(c.caseNo) %>;
  var err = document.querySelector('[data-testid="action-error"]');
  function $(id) { return document.getElementById(id); }
  function call(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
  function hideErr(el) { if (el) { el.textContent = ''; el.hidden = true; } }
  function act(url, body, fieldErr) {
    hideErr(err); hideErr(fieldErr);
    return call(url, body).then(function (x) {
      if (x.ok) { location.reload(); return; }
      var code = x.j.code, msg = x.j.message || 'เกิดข้อผิดพลาด';
      if (fieldErr && code === 'REASON_TOO_SHORT') showErr(fieldErr, msg); else showErr(err, msg);
    });
  }
  function on(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
  on('claim-btn', function () { act('/api/officer/cases/' + CASE_NO + '/claim'); });
  on('approve-btn', function () { act('/api/cases/' + CASE_NO + '/approve'); });
  on('issue-btn', function () { act('/api/officer/cases/' + CASE_NO + '/issue'); });
  on('forward-btn', function () { act('/api/officer/cases/' + CASE_NO + '/forward', { note: $('forward-note').value }); });
  on('return-btn', function () { $('return-reason').focus(); });
  on('return-submit', function () { act('/api/officer/cases/' + CASE_NO + '/return', { reason: $('return-reason').value }, $('return-reason-error')); });
  on('reject-btn', function () { $('reject-reason').focus(); });
  on('reject-submit', function () { act('/api/cases/' + CASE_NO + '/reject', { reason: $('reject-reason').value }, $('reject-reason-error')); });
  on('show-full-id', function () { $('unmask-reason').focus(); });
  on('unmask-submit', function () {
    var e = $('unmask-error'); hideErr(e);
    call('/api/officer/cases/' + CASE_NO + '/unmask', { reason: $('unmask-reason').value }).then(function (x) {
      if (!x.ok) { showErr(e, x.j.message || 'เกิดข้อผิดพลาด'); return; }
      var s = String(x.j.idNo || '');
      var f = s.length === 13 ? s[0] + '-' + s.slice(1, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 12) + '-' + s[12] : s;
      var box = $('full-id-box'); box.textContent = '';
      var span = document.createElement('span'); span.setAttribute('data-testid', 'full-id'); span.textContent = f;
      box.appendChild(span);
    });
  });
})();
</script>`;

router.get('/officer/cases/:caseNo', requireStaff, ah(async (req, res) => {
  const u = req.user!;
  const caseNo = String(req.params.caseNo);
  const row = (await query<CRow>(`${CASE_SELECT} WHERE c.case_no = $1`, [caseNo]))[0];
  if (!row) return void res.notFoundCase();
  const holidays = await loadHolidays();
  const level = slaLevel({ status: row.status, dueAt: d(row.due_at) }, holidays) ?? 'normal';
  const isOwner = u.role === 'officer' && row.owner === u.username;
  const st = row.status;
  const isSv01 = row.service_id === 'SV-01';
  const canDecide = isSv01 ? isOwner && st === 'IN_REVIEW' : u.role === 'head' && st === 'PENDING_APPROVAL';
  // สิทธิ์ไฟล์ (A-59): head ทุกแผนก · officer แผนกตนเองขั้นปัจจุบันหรือเคยผ่าน
  let filesAllowed = u.role === 'head';
  if (u.role === 'officer') {
    filesAllowed = row.current_dept === u.dept || !!(await one(
      `SELECT 1 AS x FROM case_dept_trail WHERE case_no=$1 AND dept=$2 LIMIT 1`, [caseNo, u.dept ?? '']));
  }
  const files = filesAllowed
    ? (await query<{ file_id: string; name: string }>(`SELECT file_id, name FROM files WHERE case_no=$1 ORDER BY created_at, file_id`, [caseNo]))
      .map((f) => ({ id: f.file_id, name: f.name }))
    : [];
  const events = (await query<{ at: Date; event: string; note: string | null }>(
    `SELECT at, event, note FROM case_events WHERE case_no=$1 ORDER BY at, id`, [caseNo])).map((e) => ({
    iso: toIso(d(e.at)), text: fmtThai(d(e.at)), label: EVENT_TEXT[e.event] ?? e.event, note: e.note ?? '',
  }));
  const step = stepOf(row);
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  await renderPage(req, res, row.case_no, CASE_TPL, {
    workload: u.role === 'officer' ? await workloadOf(u.username) : null,
    c: {
      caseNo: row.case_no, status: st, statusText: STATUS_TEXT[st] ?? st, serviceText: serviceText(row.service_id),
      stepText: step ? STEP_TEXT[step] : '', feeText: fmtBaht(row.fee), applicant: row.applicant_name, idMasked: row.id_masked,
      dueIso: toIso(d(row.due_at)), dueText: fmtThai(d(row.due_at)),
      level, levelText: SLA_LEVEL_TEXT[level as keyof typeof SLA_LEVEL_TEXT] ?? level,
      closedIso: iso(row.closed_at), closedText: row.closed_at ? fmtThai(d(row.closed_at)) : '',
      owner: row.owner, returnCount: row.return_count, docNo: row.doc_no, verifyCode: row.verify_code,
      verifyUrl: row.verify_code ? `${base}/verify/${row.verify_code}` : '', filesAllowed,
      canClaim: u.role === 'officer' && !!u.dept && u.dept === row.current_dept && !row.owner && (st === 'SUBMITTED' || st === 'IN_REVIEW'),
      canReturn: isOwner && st === 'IN_REVIEW' && (row.return_count < MAX_RETURNS || isBug('B12')),
      canForward: isOwner && st === 'IN_REVIEW' && !isSv01,
      canApprove: canDecide, canReject: canDecide,
      canIssue: u.role === 'officer' && st === 'APPROVED' && row.issuer === u.username,
    },
    files, events,
  });
}));

export default router;
