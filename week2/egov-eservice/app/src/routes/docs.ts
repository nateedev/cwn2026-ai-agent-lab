// B08 · ออกเอกสารดิจิทัล (HMAC-SHA256) + ตรวจเอกสาร /verify
// CONTRACT §2.13 §3 §6.3 (issue) §6.4 (verify) §8 (tamper) · FR-17 FR-18 · BR-23 · A-22 A-23 A-27 A-43 A-54 A-58 A-61 A-63
// ตามกฎ "เขียนเฉพาะ src/routes/docs.ts" ไฟล์นี้จึงรวม lib/sign.ts (ส่วน SIGN) และ views/verify.ejs (ตัวแปร VERIFY_TPL) ไว้ด้วยกัน
import { randomInt, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
// @ts-ignore ไม่มี @types/ejs
import ejs from 'ejs';
// @ts-ignore ไม่มี @types/qrcode · ใช้เฉพาะ QRCode.create (ตาราง module) แล้ววาดเป็นสี่เหลี่ยมใน PDF เอง
import QRCode from 'qrcode';
// @ts-ignore ไม่มี @types/pdfkit
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { bkkDate, bkkParts, fmtThai, fmtThaiDate, now, toIso } from '../lib/clock.ts';
import { hmacSign } from '../lib/crypto.ts';
import { nextNumber, one, query, tx } from '../lib/db.ts';
import { ah, apiError } from '../lib/http.ts';
import { requireAuth, requireRole } from '../lib/rbac.ts';
import { SERVICE_NAMES } from '../lib/upload.ts';
import { audit } from './audit-admin.ts';

const router = Router();

// ───────────────────────── SIGN (แทน lib/sign.ts) ─────────────────────────

export interface DocFields {
  docNo: string; caseNo: string; applicant: string; serviceId: string;
  issuedAt: string; validUntil: string; signer: string;
}
/** ลำดับฟิลด์คงที่ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer (CONTRACT §3 · ตรงกับ seed) */
export const signDoc = (f: DocFields): string =>
  hmacSign([f.docNo, f.caseNo, f.applicant, f.serviceId, f.issuedAt, f.validUntil, f.signer].join('|'));

export function signatureMatches(f: DocFields, stored: string): boolean {
  const a = Buffer.from(signDoc(f), 'utf8');
  const b = Buffer.from(String(stored), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const p2 = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${p2(m)}-${p2(d)}`;
const addDaysYmd = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

/** วันสุดท้ายที่ใช้ได้ (BR-23/A-43/A-61) · SV-01: ออก+89 วัน · SV-02/03: วันครบรอบปีถัดไป − 1 วัน (29 ก.พ. → ใช้ 28 ก.พ. เป็นวันครบรอบ) */
export function validUntilOf(serviceId: string, issued: Date): string {
  const t = bkkParts(issued);
  const today = ymd(t.year, t.month, t.day);
  if (serviceId === 'SV-01') return addDaysYmd(today, 89);
  const day = t.month === 2 && t.day === 29 ? 28 : t.day;
  return addDaysYmd(ymd(t.year + 1, t.month, day), -1);
}

/** ปิดบังชื่อ (A-54): ชื่อเต็ม + อักษรแรกของนามสกุล + *** · ไม่มีนามสกุล → ชื่อ + ` ***` */
export function maskApplicant(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return `${parts[0] ?? ''} ***`;
  const last = Array.from(parts[parts.length - 1])[0] ?? '';
  return `${parts.slice(0, -1).join(' ')} ${last}***`;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newVerifyCode = (): string => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

// ───────────────────────── ข้อมูลเอกสาร ─────────────────────────

interface DocRow {
  doc_no: string; case_no: string; applicant: string; service_id: string;
  issued_at: Date; valid_until: string; signer: string; verify_code: string; signature: string;
}
const fieldsOf = (d: DocRow): DocFields => ({
  docNo: d.doc_no, caseNo: d.case_no, applicant: d.applicant, serviceId: d.service_id,
  issuedAt: toIso(d.issued_at), validUntil: d.valid_until, signer: d.signer,
});

type VerifyResult = 'VALID' | 'EXPIRED' | 'TAMPERED';
/** TAMPERED มาก่อน EXPIRED (A-43) · หมดอายุตั้งแต่ 00:00 ของวันถัดจากวันสุดท้ายที่ใช้ได้ */
function judge(d: DocRow): VerifyResult {
  if (!signatureMatches(fieldsOf(d), d.signature)) return 'TAMPERED';
  return bkkDate(now()) > d.valid_until ? 'EXPIRED' : 'VALID';
}
const findByCode = (code: string) =>
  one<DocRow>(`SELECT * FROM documents WHERE verify_code = $1`, [code]);

// ───────────────────────── ออกเอกสาร ─────────────────────────

interface CaseRow {
  case_no: string; service_id: string; status: string; owner: string | null; issuer: string | null;
  approved_by: string | null; citizen_id: number; current_dept: string; doc_no: string | null;
}
const ERR = {
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบคำขอ',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้อง',
};

router.post('/api/officer/cases/:caseNo/issue', requireRole('officer'), ah(async (req, res) => {
  const u = req.user!;
  const out = await tx(async (c) => {
    const row = (await c.query<CaseRow>(
      `SELECT case_no,service_id,status,owner,issuer,approved_by,citizen_id,current_dept,doc_no
         FROM cases WHERE case_no = $1 FOR UPDATE`, [req.params.caseNo])).rows[0];
    if (!row) return { status: 404, code: 'NOT_FOUND', message: ERR.NOT_FOUND };
    // A-27: เฉพาะผู้ออกเอกสาร (ผู้อื่นแม้แผนกเดียวกัน → 403)
    if (row.issuer !== u.username) return { status: 403, code: 'FORBIDDEN', message: ERR.FORBIDDEN };
    if (row.status !== 'APPROVED') return { status: 409, code: 'INVALID_STATE', message: ERR.INVALID_STATE };

    const citizen = (await c.query<{ name: string }>(`SELECT name FROM citizens WHERE id = $1`, [row.citizen_id])).rows[0];
    const issued = now();
    const year = bkkParts(issued).year + 543;
    // เลขเอกสารเริ่มใหม่ทุกปี (A-48) · ตัวนับ 'doc' คือปี 2569 ตาม seed
    const seq = await nextNumber(year === 2569 ? 'doc' : `doc-${year}`, c);
    const docNo = `DOC-${year}-${String(seq).padStart(6, '0')}`;
    // ผู้ลงนาม = ผู้อนุมัติ: SV-01 = เจ้าหน้าที่ผู้ถือเรื่อง (issuer) · SV-02/03 = หัวหน้าที่อนุมัติ
    const signerUser = row.service_id === 'SV-01' ? row.issuer : (row.approved_by ?? row.issuer);
    const sn = (await c.query<{ display_name: string }>(`SELECT display_name FROM staff_users WHERE username = $1`, [signerUser])).rows[0];
    const fields: DocFields = {
      docNo, caseNo: row.case_no, applicant: citizen?.name ?? '', serviceId: row.service_id,
      issuedAt: toIso(issued), validUntil: validUntilOf(row.service_id, issued), signer: sn?.display_name ?? String(signerUser),
    };
    let code = newVerifyCode();
    while ((await c.query(`SELECT 1 FROM documents WHERE verify_code = $1`, [code])).rowCount) code = newVerifyCode();

    await c.query(
      `INSERT INTO documents(doc_no,case_no,applicant,service_id,issued_at,valid_until,signer,verify_code,signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docNo, fields.caseNo, fields.applicant, fields.serviceId, fields.issuedAt, fields.validUntil, fields.signer, code, signDoc(fields)]);
    await c.query(
      `UPDATE cases SET status='COMPLETED', doc_no=$2, verify_code=$3, closed_at=$4 WHERE case_no=$1`,
      [row.case_no, docNo, code, fields.issuedAt]);
    await c.query(
      `INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,'ISSUE','APPROVED','COMPLETED',$4)`,
      [row.case_no, fields.issuedAt, u.username, docNo]);
    await audit({ username: u.username, role: u.role, event: 'ISSUE', caseNo: row.case_no, fromStatus: 'APPROVED', toStatus: 'COMPLETED', detail: docNo }, c);
    return { status: 200, body: { docNo, verifyCode: code, status: 'COMPLETED' } };
  });
  if ('code' in out) return void apiError(res, out.status, out.code as string, out.message as string);
  res.status(200).json(out.body);
}));

// ───────────────────────── PDF ─────────────────────────

/** QR (DECISIONS §10: "QR ไป /verify/<รหัส>") วาดเป็นสี่เหลี่ยมดำ รวม module ติดกันในแถวเป็นแท่งเดียว */
function drawQr(doc: any, text: string, x0: number, y0: number, mod: number): number {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n: number = q.modules.size;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.modules.get(r, c)) continue;
      let e = c; while (e + 1 < n && q.modules.get(r, e + 1)) e++;
      doc.rect(x0 + c * mod, y0 + r * mod, (e - c + 1) * mod, mod);
      c = e;
    }
  }
  doc.fill('#000');
  return n * mod;
}

/** ต้นทาง URL ของ QR: PUBLIC_BASE_URL (ถ้าตั้ง) ไม่งั้นใช้ origin ของคำขอ (= BASE_URL ที่ผู้ใช้เปิด) */
const baseUrlOf = (req: Request): string =>
  (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** ฟอนต์ไทย Sarabun (SIL OFL 1.1 · ใบอนุญาตอยู่ที่ assets/fonts/Sarabun-OFL.txt) */
const THAI_FONT = fileURLToPath(new URL('../../assets/fonts/Sarabun-Regular.ttf', import.meta.url));

/**
 * PDF เอกสาร (pdfkit + ฟอนต์ไทยฝังในไฟล์) · DECISIONS §10: เลขเอกสาร เลขคำขอ ชื่อผู้ยื่น บริการ วันออก วันหมดอายุ ผู้ลงนาม รหัสตรวจสอบ และ QR
 * ชื่อผู้ยื่น/ผู้ลงนามมาจากแถว documents ของฉบับนั้น (ฟิลด์เดียวกับที่ลงลายเซ็น HMAC)
 * บรรทัดอ่านด้วยเครื่อง (CONTRACT §3 · A-63) อยู่ใน stream ของตัวเองแบบไม่บีบอัด (compress: false) จึงค้นจากไบต์ดิบได้
 */
function buildPdf(d: DocRow, baseUrl: string): Promise<Buffer> {
  const machine = `docNo=${d.doc_no} caseNo=${d.case_no} verify=${d.verify_code} validUntil=${d.valid_until}`;
  const doc = new PDFDocument({
    size: 'A4', margin: 50, compress: false,
    info: { Title: d.doc_no, Producer: 'e-Service (test)', Creator: 'e-Service (test)', CreationDate: now() },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });

  doc.registerFont('th', THAI_FONT);
  doc.font('th').fontSize(18).text('เอกสารดิจิทัล / Digital Document · e-Service', 50, 50);
  doc.moveDown(0.6).fontSize(13);
  const rows: [string, string][] = [
    ['เลขเอกสาร / Document No', d.doc_no],
    ['เลขคำขอ / Case No', d.case_no],
    ['ชื่อผู้ยื่น / Applicant', d.applicant],
    ['บริการ / Service', `${d.service_id} ${SERVICE_NAMES[d.service_id as keyof typeof SERVICE_NAMES] ?? ''}`.trim()],
    ['วันออก / Issued', toIso(d.issued_at)],
    ['ใช้ได้ถึง / Valid until', d.valid_until],
    ['ผู้ลงนาม / Signer', d.signer],
    ['รหัสตรวจสอบ / Verify code', d.verify_code],
    ['ตรวจเอกสาร / Verify URL', `${baseUrl}/verify/${d.verify_code}`],
  ];
  for (const [k, v] of rows) doc.text(`${k}: ${v}`, { lineGap: 4 });
  const qrTop = Math.ceil(doc.y) + 24;
  const size = drawQr(doc, `${baseUrl}/verify/${d.verify_code}`, 50, qrTop, 4);
  doc.font('th').fontSize(10).fillColor('#000').text('สแกนเพื่อตรวจสอบเอกสาร / Scan to verify', 50, qrTop + size + 8);

  const m = doc.ref({});
  m.end(machine);
  doc.end();
  return done;
}

router.get('/api/documents/:docNo/pdf', requireAuth, ah(async (req, res) => {
  const u = req.user!;
  const notFound = () => apiError(res, 404, 'NOT_FOUND', 'ไม่พบเอกสาร');
  if (u.role !== 'citizen' && u.role !== 'officer' && u.role !== 'head') return void notFound();
  const d = await one<DocRow>(`SELECT * FROM documents WHERE doc_no = $1`, [req.params.docNo]);
  if (!d) return void notFound();
  if (u.role === 'citizen') {
    const own = await one(`SELECT 1 FROM cases WHERE case_no = $1 AND citizen_id = $2`, [d.case_no, u.citizenId]);
    if (!own) return void notFound();
  }
  const buf = await buildPdf(d, baseUrlOf(req));
  res.status(200).set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${d.doc_no}.pdf"`,
    'Content-Length': String(buf.length),
  }).send(buf);
}));

// ───────────────────────── ตรวจเอกสาร ─────────────────────────

router.get('/api/verify/:code', ah(async (req, res) => {
  const d = await findByCode(req.params.code);
  if (!d) return void res.status(404).json({ result: 'NOT_FOUND' });
  const result = judge(d);
  if (result === 'TAMPERED') return void res.status(200).json({ result });
  res.status(200).json({
    result, docNo: d.doc_no, applicantMasked: maskApplicant(d.applicant), serviceId: d.service_id,
    issuedAt: toIso(d.issued_at), validUntil: d.valid_until, signer: d.signer,
  });
}));

const VERIFY_TPL = `<main>
  <h1>ตรวจสอบเอกสาร</h1>
  <p data-testid="verify-result" data-result="<%= v.result %>" role="status"><%= v.label %></p>
  <% if (v.doc) { %>
  <dl>
    <dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no"><%= v.doc.docNo %></dd>
    <dt>ชื่อผู้ยื่น</dt><dd data-testid="verify-applicant"><%= v.doc.applicant %></dd>
    <dt>บริการ</dt><dd data-testid="verify-service"><%= v.doc.service %></dd>
    <dt>วันที่ออก</dt><dd data-testid="verify-issued" data-iso="<%= v.doc.issuedIso %>"><%= v.doc.issued %></dd>
    <dt>ผู้ลงนาม</dt><dd data-testid="verify-signer"><%= v.doc.signer %></dd>
    <dt>ใช้ได้ถึง</dt><dd data-testid="verify-expires" data-iso="<%= v.doc.validUntil %>"><%= v.doc.expires %></dd>
  </dl>
  <% } %>
</main>`;

const LABEL = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' } as const;

/** เรนเดอร์หน้า verify ห่อ layout (ไม่ต้องล็อกอิน · ถ้าล็อกอินอยู่ layout แสดง header ตามปกติ) */
async function renderVerify(req: Request, res: Response, status: number, view: Record<string, unknown>) {
  const user = (res.locals.user ?? req.user ?? null) as Express.SessionUser | null;
  let bellCount = 0;
  if (user && (user.role === 'officer' || user.role === 'head')) {
    bellCount = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE username = $1`, [user.username]))?.n ?? 0;
  }
  const data = { title: 'ตรวจสอบเอกสาร', success: null, error: null, ...res.locals, user, bellCount };
  const body = ejs.render(VERIFY_TPL, { ...data, v: view });
  res.status(status).render('layout', { ...data, body });
}

router.get('/verify/:code', ah(async (req, res) => {
  const d = await findByCode(req.params.code);
  if (!d) return void (await renderVerify(req, res, 404, { result: 'NOT_FOUND', label: LABEL.NOT_FOUND, doc: null }));
  const result = judge(d);
  const doc = result === 'TAMPERED' ? null : {
    docNo: d.doc_no, applicant: maskApplicant(d.applicant), service: `${d.service_id} ${SERVICE_NAMES[d.service_id] ?? ""}`.trim(),
    issuedIso: toIso(d.issued_at), issued: fmtThai(d.issued_at), signer: d.signer,
    validUntil: d.valid_until, expires: fmtThaiDate(new Date(`${d.valid_until}T12:00:00+07:00`)),
  };
  await renderVerify(req, res, 200, { result, label: LABEL[result], doc });
}));

// ───────────────────────── test hook ─────────────────────────

/** CONTRACT §8: แก้ข้อมูลที่เก็บ (applicant) โดยไม่คำนวณลายเซ็นใหม่ · /api/test/* ถูกปิดโดย app.ts เมื่อไม่ได้ TEST_MODE=1 */
router.post('/api/test/documents/:docNo/tamper', ah(async (req, res) => {
  const r = await query(`UPDATE documents SET applicant = applicant || ' (แก้ไข)' WHERE doc_no = $1 RETURNING doc_no`, [req.params.docNo]);
  if (!r.length) return void apiError(res, 404, 'NOT_FOUND', 'ไม่พบเอกสาร');
  res.json({ ok: true });
}));

export default router;
