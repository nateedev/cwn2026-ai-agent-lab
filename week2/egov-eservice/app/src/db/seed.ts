// seed ตาม egov-brief/TEST-DATA.md (B02) · เรียกหลัง reset ล้างตารางแล้ว และตอนบูตเมื่อ services ว่าง
// ห้ามใช้ new Date()/Date.now() — ทุกเวลาเป็นค่าตายตัวตามตาราง (A-35)
import { tx } from '../lib/db.ts';
import { blindIndex, encrypt, hashPassword, hmacSign } from '../lib/crypto.ts';
import { toIso } from '../lib/clock.ts';

/** 'YYYY-MM-DD HH:mm[:ss]' (เวลาไทย) → Date */
const T = (s: string): Date => {
  const [d, t] = s.split(' ');
  return new Date(`${d}T${t.length === 5 ? t + ':00' : t}+07:00`);
};
const HOUR = 3600 * 1000;

/** PDF จริงขนาด n ไบต์ (หัว %PDF + เติมช่องว่าง + %%EOF) */
function pdf(n: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
}

const CITIZENS = [
  { key: 'sc', idNo: '1101700123456', masked: 'X-XXXX-XXXXX-45-6', name: 'สมชาย ใจดี', mobile: '0812345678' },
  { key: 'sy', idNo: '3100600987659', masked: 'X-XXXX-XXXXX-65-9', name: 'สมหญิง รักไทย', mobile: '0823456789' },
  { key: 'mn', idNo: '5500400111221', masked: 'X-XXXX-XXXXX-22-1', name: 'มานะ ตั้งใจ', mobile: null },
  { key: 'pt', idNo: '1909900555015', masked: 'X-XXXX-XXXXX-01-5', name: 'ปิติ มีสุข', mobile: '0834567890' },
] as const;

const STAFF = [
  ['off.reg1', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'],
  ['off.reg2', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
  ['off.works1', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'],
  ['head1', 'หัวหน้าฝ่าย', 'head', ''],
  ['exec1', 'ผู้บริหาร', 'executive', ''],
  ['audit1', 'ผู้ตรวจสอบภายใน', 'auditor', ''],
  ['admin1', 'ผู้ดูแลระบบ', 'admin', ''],
] as const;

const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
] as const;

const DOCS: Record<string, string[]> = {
  'SV-01': ['id-card'],
  'SV-02': ['id-card', 'map'],
  'SV-03': ['id-card', 'plan', 'deed'],
};

type St = 'SUBMITTED' | 'IN_REVIEW' | 'NEED_FIX' | 'PENDING_APPROVAL' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
interface C {
  n: number; sv: 'SV-01' | 'SV-02' | 'SV-03'; qty?: number; area?: number; fee: number; who: 'sc' | 'sy' | 'pt';
  st: St; step?: number; dept: 'registry' | 'works' | 'head'; owner?: string; issuer?: string;
  paid: string; due: string; closed?: string; path: string[];
}
const REG = ['registry'], SV2_PATH = ['registry', 'head'], SV3_PATH = ['registry', 'works', 'head'];
// path = แผนกที่เรื่องเคยผ่านตามลำดับ
const CASES: C[] = [
  { n: 1, sv: 'SV-01', qty: 1, fee: 20, who: 'sy', st: 'COMPLETED', dept: 'registry', issuer: 'off.reg1', paid: '2026-10-14 10:00', due: '2026-10-19 16:30', closed: '2026-10-16 14:00', path: REG },
  { n: 2, sv: 'SV-03', area: 120, fee: 1200, who: 'pt', st: 'COMPLETED', step: 3, dept: 'head', issuer: 'off.reg1', paid: '2026-11-02 09:00', due: '2026-11-23 16:30', closed: '2026-11-20 11:00', path: SV3_PATH },
  { n: 3, sv: 'SV-01', qty: 2, fee: 40, who: 'pt', st: 'COMPLETED', dept: 'registry', issuer: 'off.reg1', paid: '2026-11-02 09:30', due: '2026-11-05 16:30', closed: '2026-11-04 15:00', path: REG },
  { n: 4, sv: 'SV-02', fee: 500, who: 'sc', st: 'COMPLETED', dept: 'head', issuer: 'off.reg1', paid: '2026-11-02 14:00', due: '2026-11-16 16:30', closed: '2026-11-13 15:00', path: SV2_PATH },
  { n: 5, sv: 'SV-01', qty: 1, fee: 20, who: 'sc', st: 'COMPLETED', dept: 'registry', issuer: 'off.reg1', paid: '2026-11-03 11:00', due: '2026-11-06 16:30', closed: '2026-11-05 10:00', path: REG },
  { n: 6, sv: 'SV-02', fee: 500, who: 'pt', st: 'COMPLETED', dept: 'head', issuer: 'off.reg1', paid: '2026-11-03 15:00', due: '2026-11-17 16:30', closed: '2026-11-19 10:00', path: SV2_PATH },
  { n: 7, sv: 'SV-02', fee: 500, who: 'sy', st: 'COMPLETED', dept: 'head', issuer: 'off.reg1', paid: '2026-11-04 10:00', due: '2026-11-18 16:30', closed: '2026-11-18 16:00', path: SV2_PATH },
  { n: 8, sv: 'SV-01', qty: 1, fee: 20, who: 'sy', st: 'REJECTED', dept: 'registry', paid: '2026-11-09 10:00', due: '2026-11-12 16:30', closed: '2026-11-11 09:00', path: REG },
  { n: 9, sv: 'SV-01', qty: 1, fee: 20, who: 'sc', st: 'CANCELLED', dept: 'registry', paid: '2026-11-09 14:30', due: '2026-11-12 16:30', closed: '2026-11-09 15:00', path: REG },
  { n: 10, sv: 'SV-03', area: 80, fee: 1000, who: 'sy', st: 'IN_REVIEW', step: 2, dept: 'works', issuer: 'off.reg1', paid: '2026-11-12 10:00', due: '2026-12-03 16:30', path: ['registry', 'works'] },
  { n: 11, sv: 'SV-03', area: 150, fee: 1500, who: 'sc', st: 'PENDING_APPROVAL', step: 3, dept: 'head', owner: 'head1', issuer: 'off.reg1', paid: '2026-11-16 10:00', due: '2026-12-08 16:30', path: SV3_PATH },
  { n: 12, sv: 'SV-03', area: 101, fee: 1010, who: 'pt', st: 'IN_REVIEW', step: 1, dept: 'registry', owner: 'off.reg2', paid: '2026-11-18 10:00', due: '2026-12-11 16:30', path: REG },
  { n: 13, sv: 'SV-02', fee: 500, who: 'sc', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-20 10:00', due: '2026-12-04 16:30', path: REG },
  { n: 14, sv: 'SV-02', fee: 500, who: 'pt', st: 'PENDING_APPROVAL', dept: 'head', owner: 'head1', issuer: 'off.reg1', paid: '2026-11-20 11:00', due: '2026-12-04 16:30', path: SV2_PATH },
  { n: 15, sv: 'SV-02', fee: 500, who: 'sy', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-20 15:00', due: '2026-12-04 16:30', path: REG },
  { n: 16, sv: 'SV-02', fee: 500, who: 'pt', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-23 09:00', due: '2026-12-08 16:30', path: REG },
  { n: 17, sv: 'SV-01', qty: 1, fee: 20, who: 'sc', st: 'NEED_FIX', dept: 'registry', owner: 'off.reg1', paid: '2026-11-23 10:00', due: '2026-11-27 16:30', path: REG },
  { n: 18, sv: 'SV-02', fee: 500, who: 'sc', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-24 10:00', due: '2026-12-09 16:30', path: REG },
  { n: 19, sv: 'SV-02', fee: 500, who: 'sy', st: 'APPROVED', dept: 'registry', issuer: 'off.reg1', paid: '2026-11-24 14:00', due: '2026-12-09 16:30', path: ['registry', 'head', 'registry'] },
  { n: 20, sv: 'SV-01', qty: 1, fee: 20, who: 'sc', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', paid: '2026-11-25 10:00', due: '2026-11-30 16:30', path: REG },
  { n: 21, sv: 'SV-02', fee: 500, who: 'sy', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-25 12:00', due: '2026-12-11 16:30', path: REG },
  { n: 22, sv: 'SV-01', qty: 2, fee: 40, who: 'sy', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', paid: '2026-11-26 10:00', due: '2026-12-01 16:30', path: REG },
  { n: 23, sv: 'SV-01', qty: 1, fee: 20, who: 'sy', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1', paid: '2026-11-26 10:30', due: '2026-12-03 16:30', path: REG },
  { n: 24, sv: 'SV-01', qty: 1, fee: 20, who: 'pt', st: 'SUBMITTED', dept: 'registry', paid: '2026-11-27 11:00', due: '2026-12-02 16:30', path: REG },
  { n: 25, sv: 'SV-01', qty: 3, fee: 60, who: 'sy', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-30 10:00', due: '2026-12-03 16:30', path: REG },
  { n: 26, sv: 'SV-01', qty: 5, fee: 100, who: 'sc', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-30 16:29', due: '2026-12-03 16:30', path: REG },
  { n: 27, sv: 'SV-01', qty: 1, fee: 20, who: 'pt', st: 'IN_REVIEW', dept: 'registry', owner: 'off.reg2', paid: '2026-11-30 16:30', due: '2026-12-04 16:30', path: REG },
  { n: 28, sv: 'SV-01', qty: 1, fee: 20, who: 'sy', st: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:10', due: '2026-12-04 16:30', path: REG },
  { n: 29, sv: 'SV-01', qty: 1, fee: 20, who: 'pt', st: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:20', due: '2026-12-04 16:30', path: REG },
  { n: 30, sv: 'SV-01', qty: 1, fee: 20, who: 'sc', st: 'SUBMITTED', dept: 'registry', paid: '2026-12-01 08:30', due: '2026-12-04 16:30', path: REG },
];

const RETURNS = [
  { n: 17, k: 1, at: '2026-11-24 11:00', re: '2026-11-25 10:00', paused: 1, reason: 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่', by: 'off.reg1' },
  { n: 17, k: 2, at: '2026-11-27 14:00', re: null, paused: null, reason: 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข', by: 'off.reg1' },
  { n: 23, k: 1, at: '2026-11-27 10:00', re: '2026-11-30 10:00', paused: 1, reason: 'ภาพเอกสารเบลอ อ่านเลขไม่ได้', by: 'off.reg1' },
  { n: 23, k: 2, at: '2026-11-30 14:00', re: '2026-12-01 08:30', paused: 1, reason: 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน', by: 'off.reg1' },
] as const;

const no = (n: number) => String(n).padStart(6, '0');
const caseNo = (n: number) => `EG-2569-${no(n)}`;

export async function seed(): Promise<void> {
  await tx(async (c) => {
    // counters: เลขถัดไป EG-…000031 · RC-…000031 · DOC-…000002 · DR-0003 · PP-0002
    await c.query(
      `INSERT INTO counters(name,value) VALUES ('case',30),('receipt',30),('doc',1),('draft',2),('payment',1)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`);

    await c.query(
      `INSERT INTO services(id,name,fee,fee_per_sqm,sla_days) VALUES
        ('SV-01','ขอหนังสือรับรอง',20,0,3),
        ('SV-02','ขออนุญาตประกอบกิจการ',500,0,10),
        ('SV-03','ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',1000,10,15)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, fee=EXCLUDED.fee, fee_per_sqm=EXCLUDED.fee_per_sqm, sla_days=EXCLUDED.sla_days`);

    for (const [d, name] of HOLIDAYS)
      await c.query(`INSERT INTO holidays(date,name) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET name=EXCLUDED.name`, [d, name]);

    for (const [u, name, role, dept] of STAFF)
      await c.query(
        `INSERT INTO staff_users(username,password_hash,display_name,role,dept) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, display_name=EXCLUDED.display_name, role=EXCLUDED.role, dept=EXCLUDED.dept`,
        [u, hashPassword('Test@1234'), name, role, dept]);

    const cid: Record<string, number> = {};
    const cname: Record<string, string> = {};
    for (const p of CITIZENS) {
      const r = await c.query(
        `INSERT INTO citizens(id_hash,id_enc,id_masked,name,mobile_enc,email,registered,consent,created_at)
         VALUES ($1,$2,$3,$4,$5,'',$6,$6,$7)
         ON CONFLICT (id_hash) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [blindIndex(p.idNo), encrypt(p.idNo), p.masked, p.name, p.mobile ? encrypt(p.mobile) : null, !!p.mobile, T('2026-10-01 09:00')]);
      cid[p.key] = r.rows[0].id;
      cname[p.key] = p.name;
    }

    // คำขอ 30 ใบ
    for (const k of CASES) {
      const paid = T(k.paid);
      const closed = k.closed ? T(k.closed) : null;
      const ret = RETURNS.filter((r) => r.n === k.n);
      const last = ret[ret.length - 1];
      const approvedBy = k.sv !== 'SV-01' && ['COMPLETED', 'PENDING_APPROVAL', 'APPROVED'].includes(k.st) && k.n !== 11 && k.n !== 14 ? 'head1' : null;
      const hasDoc = k.n === 5;
      let approvedAt: Date | null = null;
      if (k.n === 19) approvedAt = T('2026-11-30 15:00');
      else if (approvedBy && closed) approvedAt = new Date(closed.getTime() - HOUR);
      await c.query(
        `INSERT INTO cases(case_no,service_id,citizen_id,draft_id,qty,area_sqm,fee,status,step,current_dept,owner,issuer,approved_by,approved_at,
           paid_at,receipt_no,due_at,return_count,returned_at,fix_deadline,closed_at,close_reason,doc_no,verify_code,created_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$14)`,
        [caseNo(k.n), k.sv, cid[k.who], k.qty ?? null, k.area ?? null, k.fee, k.st, k.step ?? null, k.dept, k.owner ?? null, k.issuer ?? null,
         approvedBy, approvedAt, paid, `RC-2569-${no(k.n)}`, T(k.due), ret.length, last ? T(last.at) : null,
         k.st === 'NEED_FIX' ? new Date(T(last!.at).getTime() + 168 * HOUR) : null,
         closed, k.st === 'CANCELLED' ? 'ยกเลิกโดยผู้ยื่น' : k.st === 'REJECTED' ? 'ไม่อนุมัติ' : k.st === 'COMPLETED' ? 'ออกเอกสารแล้ว' : null,
         hasDoc ? 'DOC-2569-000001' : null, hasDoc ? 'K7M2Q9XA' : null]);

      // เส้นทางแผนก
      for (let i = 0; i < k.path.length; i++)
        await c.query(`INSERT INTO case_dept_trail(case_no,dept,entered_at) VALUES ($1,$2,$3)`,
          [caseNo(k.n), k.path[i], new Date(paid.getTime() + i * HOUR)]);

      // ไทม์ไลน์
      const ev = (at: Date, actor: string | null, event: string, from: string | null, to: string | null, note: string | null = null) =>
        c.query(`INSERT INTO case_events(case_no,at,actor,event,from_status,to_status,note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [caseNo(k.n), at, actor, event, from, to, note]);
      await ev(paid, k.who, 'SUBMIT', null, 'SUBMITTED', `ชำระเงิน RC-2569-${no(k.n)}`);
      if (k.st !== 'SUBMITTED' && k.st !== 'CANCELLED') {
        const claimer = k.owner && k.owner.startsWith('off.') ? k.owner : 'off.reg1';
        await ev(new Date(paid.getTime() + HOUR / 2), claimer, 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
      }
      for (const r of ret) {
        await ev(T(r.at), r.by, 'RETURN', 'IN_REVIEW', 'NEED_FIX', r.reason);
        if (r.re) await ev(T(r.re), cname[k.who] ? k.who : null, 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW');
      }
      if (k.st === 'COMPLETED' || k.st === 'REJECTED') {
        if (approvedAt) await ev(approvedAt, 'head1', 'APPROVE', 'PENDING_APPROVAL', 'APPROVED');
        await ev(closed!, 'off.reg1', k.st === 'COMPLETED' ? 'ISSUE' : 'REJECT', k.st === 'COMPLETED' ? 'APPROVED' : 'IN_REVIEW', k.st,
          k.st === 'COMPLETED' ? (hasDoc ? 'DOC-2569-000001' : null) : 'ไม่อนุมัติ');
      } else if (k.st === 'CANCELLED') {
        await ev(closed!, k.who, 'CANCEL', 'SUBMITTED', 'CANCELLED');
      } else if (k.st === 'APPROVED') {
        await ev(approvedAt!, 'head1', 'APPROVE', 'PENDING_APPROVAL', 'APPROVED');
      } else if (k.st === 'PENDING_APPROVAL') {
        await ev(new Date(paid.getTime() + 2 * HOUR), 'off.reg1', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL');
      } else if (k.n === 10) {
        await ev(new Date(paid.getTime() + HOUR), 'off.reg1', 'FORWARD', 'IN_REVIEW', 'IN_REVIEW', 'ส่งต่อฝ่ายโยธา');
      }

      // ไฟล์แนบตามเอกสารบังคับ
      for (const dk of DOCS[k.sv])
        await c.query(
          `INSERT INTO files(file_id,draft_id,case_no,citizen_id,doc_key,name,size,mime,content,created_at)
           VALUES ($1,NULL,$2,$3,$4,$5,$6,'application/pdf',$7,$8)`,
          [`FL-${no(k.n)}-${dk}`, caseNo(k.n), cid[k.who], dk, `${dk}.pdf`, 1024, pdf(1024), paid]);
    }

    for (const r of RETURNS)
      await c.query(
        `INSERT INTO case_returns(case_no,n,returned_at,resubmitted_at,paused_workdays,reason,by_username) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [caseNo(r.n), r.k, T(r.at), r.re ? T(r.re) : null, r.paused, r.reason, r.by]);

    // เอกสารที่ออกแล้ว DOC-2569-000001 (ลายเซ็น = HMAC ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer)
    const issued = T('2026-11-05 10:00');
    const doc = {
      docNo: 'DOC-2569-000001', caseNo: caseNo(5), applicant: 'สมชาย ใจดี', serviceId: 'SV-01',
      issuedAt: toIso(issued), validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
    };
    await c.query(
      `INSERT INTO documents(doc_no,case_no,applicant,service_id,issued_at,valid_until,signer,verify_code,signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'K7M2Q9XA',$8)`,
      [doc.docNo, doc.caseNo, doc.applicant, doc.serviceId, issued, doc.validUntil, doc.signer,
       hmacSign([doc.docNo, doc.caseNo, doc.applicant, doc.serviceId, doc.issuedAt, doc.validUntil, doc.signer].join('|'))]);

    // ร่างและรอชำระของสมชาย
    await c.query(
      `INSERT INTO drafts(id,citizen_id,service_id,qty,area_sqm,fee,status,created_at,updated_at) VALUES
        ('DR-0001',$1,'SV-01',2,NULL,40,'DRAFT',$2,$2),
        ('DR-0002',$1,'SV-02',NULL,NULL,500,'PENDING_PAYMENT',$3,$3)`,
      [cid.sc, T('2026-11-30 10:00'), T('2026-12-01 08:55')]);
    await c.query(
      `INSERT INTO payments(ref,draft_id,amount,status,qr_created_at,qr_expires_at) VALUES ('PP-0001','DR-0002',500,'PENDING',$1,$2)`,
      [T('2026-12-01 08:55'), T('2026-12-01 09:10')]);
    for (const dk of ['id-card', 'map'])
      await c.query(
        `INSERT INTO files(file_id,draft_id,case_no,citizen_id,doc_key,name,size,mime,content,created_at)
         VALUES ($1,'DR-0002',NULL,$2,$3,$4,1024,'application/pdf',$5,$6)`,
        [`FL-DR0002-${dk}`, cid.sc, dk, `${dk}.pdf`, pdf(1024), T('2026-12-01 08:55')]);
  });
}
