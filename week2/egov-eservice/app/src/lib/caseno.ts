// เลขคำขอ EG-<พ.ศ.>-<6 หลัก> และใบเสร็จ RC-<พ.ศ.>-<6 หลัก> (BR-09 · A-14 A-16 A-48)
// ลำดับเริ่มใหม่ทุกปี พ.ศ. ของ "เวลาชำระ" · 1 ชำระสำเร็จ = 1 เลขคำขอ = 1 ใบเสร็จ (ลำดับตรงกัน)
// ออกเลขจาก MAX ของตาราง cases ภายใต้ advisory lock ใน transaction เดียวกับการสร้างคำขอ → ไม่ซ้ำ ไม่มีช่องว่างเมื่อ rollback
import type { PoolClient } from 'pg';
import { buddhistYear } from './clock.ts';

const ISSUE_LOCK_KEY = 90061; // ใช้กับ pg_advisory_xact_lock เท่านั้น

export const fmtSeq = (n: number) => String(n).padStart(6, '0');
export const caseNoOf = (year: number, seq: number) => `EG-${year}-${fmtSeq(seq)}`;
export const receiptNoOf = (year: number, seq: number) => `RC-${year}-${fmtSeq(seq)}`;

/** ต้องเรียกใน transaction ที่จะ INSERT cases ทันที (lock ปล่อยตอน COMMIT/ROLLBACK) */
export async function issueCaseNumbers(c: PoolClient, paidAt: Date): Promise<{ caseNo: string; receiptNo: string; year: number; seq: number }> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [ISSUE_LOCK_KEY]);
  const year = buddhistYear(paidAt);
  const r = await c.query(
    `SELECT COALESCE(MAX(CAST(substring(case_no from 9) AS integer)), 0) AS m1,
            COALESCE(MAX(CAST(substring(receipt_no from 9) AS integer)), 0) AS m2
       FROM cases WHERE case_no LIKE $1`, [`EG-${year}-%`]);
  const r2 = await c.query(
    `SELECT COALESCE(MAX(CAST(substring(receipt_no from 9) AS integer)), 0) AS m FROM cases WHERE receipt_no LIKE $1`, [`RC-${year}-%`]);
  const seq = Math.max(Number(r.rows[0].m1), Number(r2.rows[0].m)) + 1;
  return { caseNo: caseNoOf(year, seq), receiptNo: receiptNoOf(year, seq), year, seq };
}
