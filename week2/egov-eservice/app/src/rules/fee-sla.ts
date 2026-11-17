// กฎค่าธรรมเนียม + SLA วันทำการ (B04)
// ที่มา: REQUIREMENTS BR-04 BR-05 BR-12 BR-13 BR-14 BR-20 BR-25 · DECISIONS ข้อ 0, 3, 8, 18 · CONTRACT §4.2 §5
// BUG_MODE ที่อยู่ในไฟล์นี้: B01 (SV-03 พื้นที่ 101) · B03 (ไม่ข้ามวันหยุดในตาราง) · B04 (ไม่หยุดนับระหว่าง NEED_FIX)
//
// ฟังก์ชันทั้งหมดเป็น pure (รับวันหยุดเป็นพารามิเตอร์) ยกเว้น loadHolidays/loadServiceRules ที่อ่าน DB
// วันที่ทุกตัวในไฟล์นี้ = สตริง 'YYYY-MM-DD' ตามเวลาไทย (Asia/Bangkok)
// ห้ามใช้ new Date()/Date.now() เป็น "ตอนนี้" → ผู้เรียกส่ง now() จาก lib/clock.ts เข้ามา (ค่าเริ่มต้นของพารามิเตอร์ใช้ now())

import { now as clockNow, bkkParts, bkkDate, bkkDateTime } from '../lib/clock.ts';
import { isBug } from '../lib/bugmode.ts';
import { pool, type Queryable } from '../lib/db.ts';

// ───────────────────────── ค่าคงที่ ─────────────────────────

export type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';
export const SERVICE_IDS: readonly ServiceId[] = ['SV-01', 'SV-02', 'SV-03'];
export const isServiceId = (s: unknown): s is ServiceId => typeof s === 'string' && (SERVICE_IDS as readonly string[]).includes(s);

/** ค่าตั้งต้นตาม seed (DECISIONS ข้อ 3) · ค่าจริงอ่านจากตาราง services (admin แก้ได้) */
export const DEFAULT_SERVICE_RULES: Record<ServiceId, ServiceRules> = {
  'SV-01': { fee: 20, feePerSqm: 0, slaDays: 3 },
  'SV-02': { fee: 500, feePerSqm: 0, slaDays: 10 },
  'SV-03': { fee: 1000, feePerSqm: 10, slaDays: 15 },
};

export const SV01_QTY_MIN = 1;
export const SV01_QTY_MAX = 5;
export const SV03_AREA_MIN = 1;
export const SV03_AREA_MAX = 500;
/** พื้นที่ ≤ ค่านี้คิดค่าฐาน · ตั้งแต่ +1 คิดเพิ่มต่อ ตร.ม. */
export const SV03_AREA_BASE = 100;

/** เวลาตัดรอบ 16:30:00 (ตั้งแต่ 16:30:00 นับเป็นวันทำการถัดไป) และเวลากำหนดเสร็จ */
export const CUTOFF_HOUR = 16;
export const CUTOFF_MINUTE = 30;

/** เวลาแก้ไขของประชาชน 168 ชม. นับจากตีกลับ (BR-20) */
export const FIX_WINDOW_MS = 168 * 3600 * 1000;

// ───────────────────────── ค่าธรรมเนียม (BR-04 BR-05) ─────────────────────────

export interface ServiceRules {
  /** SV-01 = ต่อฉบับ · SV-02 = เหมา · SV-03 = ค่าฐาน (1–100 ตร.ม.) */
  fee: number;
  /** SV-03 เท่านั้น: บาทต่อ ตร.ม. ที่เกิน 100 */
  feePerSqm: number;
  /** SLA วันทำการ */
  slaDays: number;
}

export type FeeErrorCode = 'INVALID_QTY' | 'INVALID_AREA' | 'AREA_TOO_LARGE' | 'INVALID_SERVICE';

/** ข้อความตรงตัวอักษรตาม CONTRACT §5 */
export const FEE_ERROR_MESSAGES: Record<FeeErrorCode, string> = {
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  INVALID_SERVICE: 'ไม่พบบริการ',
};

export type FeeResult =
  | { ok: true; fee: number }
  | { ok: false; status: 400; code: FeeErrorCode; message: string };

export interface FeeInput {
  /** SV-01 จำนวนฉบับ (รับเป็นตัวเลขหรือสตริงจากฟอร์มได้) */
  qty?: unknown;
  /** SV-03 พื้นที่ ตร.ม. (จำนวนเต็ม) */
  area?: unknown;
}

const feeErr = (code: FeeErrorCode): FeeResult => ({ ok: false, status: 400, code, message: FEE_ERROR_MESSAGES[code] });

/** แปลงค่าจากฟอร์ม/JSON เป็นจำนวนเต็ม · ไม่ใช่จำนวนเต็ม (ว่าง, 1.5, "abc") → null */
export function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * คำนวณค่าธรรมเนียม (บาท จำนวนเต็ม)
 * - SV-01: fee × qty · qty จำนวนเต็ม 1–5 (นอกนั้น INVALID_QTY)
 * - SV-02: fee คงที่
 * - SV-03: area 1–100 → fee · 101–500 → fee + feePerSqm × (area − 100) · ≤0/ไม่ใช่จำนวนเต็ม → INVALID_AREA · >500 → AREA_TOO_LARGE
 * BUG_MODE=B01: SV-03 ใช้ `> 101` แทน `≥ 101` → พื้นที่ 101 ได้ค่าฐาน
 */
export function calcFee(serviceId: string, input: FeeInput, rules?: Partial<ServiceRules>): FeeResult {
  if (!isServiceId(serviceId)) return feeErr('INVALID_SERVICE');
  const r = { ...DEFAULT_SERVICE_RULES[serviceId], ...(rules ?? {}) };
  switch (serviceId) {
    case 'SV-01': {
      const qty = toInt(input.qty);
      if (qty === null || qty < SV01_QTY_MIN || qty > SV01_QTY_MAX) return feeErr('INVALID_QTY');
      return { ok: true, fee: r.fee * qty };
    }
    case 'SV-02':
      return { ok: true, fee: r.fee };
    case 'SV-03': {
      const area = toInt(input.area);
      if (area === null || area < SV03_AREA_MIN) return feeErr('INVALID_AREA');
      if (area > SV03_AREA_MAX) return feeErr('AREA_TOO_LARGE');
      const extraStarts = isBug('B01') ? area > SV03_AREA_BASE + 1 : area >= SV03_AREA_BASE + 1;
      return { ok: true, fee: extraStarts ? r.fee + r.feePerSqm * (area - SV03_AREA_BASE) : r.fee };
    }
  }
}

// ───────────────────────── ปฏิทินวันทำการ (BR-12) ─────────────────────────

/** ชุดวันหยุด 'YYYY-MM-DD' (จากตาราง holidays) */
export type Holidays = ReadonlySet<string> | Iterable<string>;

const asSet = (h: Holidays): ReadonlySet<string> => (h instanceof Set ? h : new Set(h));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateToUtcMs(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`วันที่ไม่ถูกต้อง: ${date}`);
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}
function utcMsToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** เลื่อนวันตามปฏิทิน (บวก/ลบ) */
export function addCalendarDays(date: string, n: number): string {
  return utcMsToDate(dateToUtcMs(date) + n * DAY_MS);
}
/** 0=อาทิตย์ … 6=เสาร์ */
export function weekdayOf(date: string): number {
  return new Date(dateToUtcMs(date)).getUTCDay();
}

/**
 * วันทำการ = จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด (A-02)
 * BUG_MODE=B03: ข้ามแค่เสาร์-อาทิตย์ ไม่สนตารางวันหยุด (กระทบทั้งกำหนดเสร็จ หยุดนับ และวันคงเหลือ)
 */
export function isWorkingDay(date: string, holidays: Holidays): boolean {
  const wd = weekdayOf(date);
  if (wd === 0 || wd === 6) return false;
  if (isBug('B03')) return true;
  return !asSet(holidays).has(date);
}

const MAX_SCAN_DAYS = 3660; // กันวนไม่รู้จบ (~10 ปี)

/** วันทำการถัดไป (หลัง date โดยไม่รวม date) */
export function nextWorkingDay(date: string, holidays: Holidays): string {
  return addWorkingDays(date, 1, holidays);
}

/** วันทำการที่ n หลัง date (ไม่นับ date เอง) · n = 0 → date */
export function addWorkingDays(date: string, n: number, holidays: Holidays): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`จำนวนวันทำการไม่ถูกต้อง: ${n}`);
  const h = asSet(holidays);
  let d = date;
  let left = n;
  for (let i = 0; left > 0; i++) {
    if (i > MAX_SCAN_DAYS) throw new Error('หาวันทำการไม่พบ');
    d = addCalendarDays(d, 1);
    if (isWorkingDay(d, h)) left--;
  }
  return d;
}

/** จำนวนวันทำการในช่วง (from, to] (ไม่นับ from นับ to) · to ≤ from → 0 */
export function countWorkingDays(fromExclusive: string, toInclusive: string, holidays: Holidays): number {
  const h = asSet(holidays);
  const end = dateToUtcMs(toInclusive);
  let ms = dateToUtcMs(fromExclusive) + DAY_MS;
  let count = 0;
  for (; ms <= end; ms += DAY_MS) if (isWorkingDay(utcMsToDate(ms), h)) count++;
  return count;
}

/** ก่อนเวลาตัดรอบ 16:30:00 (16:29:59 = ก่อน · 16:30:00 = ไม่ก่อน) */
export function isBeforeCutoff(t: Date): boolean {
  const p = bkkParts(t);
  return p.hour * 60 + p.minute < CUTOFF_HOUR * 60 + CUTOFF_MINUTE;
}

/** D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 ไม่เช่นนั้นวันทำการถัดไป */
export function slaStartDay(paidAt: Date, holidays: Holidays): string {
  const h = asSet(holidays);
  const day = bkkDate(paidAt);
  return isWorkingDay(day, h) && isBeforeCutoff(paidAt) ? day : nextWorkingDay(day, h);
}

/** เวลา 16:30:00 (+07:00) ของวันนั้น */
export function cutoffOf(date: string): Date {
  return bkkDateTime(date, CUTOFF_HOUR, CUTOFF_MINUTE, 0);
}

/**
 * กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 (BR-12)
 * เรียกครั้งเดียวตอนชำระสำเร็จแล้วเก็บลง DB (ไม่คำนวณใหม่เมื่อวันหยุดเปลี่ยน · A-42)
 */
export function computeDueAt(paidAt: Date, slaDays: number, holidays: Holidays): Date {
  const h = asSet(holidays);
  return cutoffOf(addWorkingDays(slaStartDay(paidAt, h), slaDays, h));
}

// ───────────────────────── หยุดนับระหว่าง NEED_FIX (BR-13) ─────────────────────────

/** จำนวนวันทำการที่หยุดนับ = วันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] ตามวันที่ (ไม่ขึ้นกับเวลา) */
export function pausedWorkingDays(returnedAt: Date, resubmittedAt: Date, holidays: Holidays): number {
  return countWorkingDays(bkkDate(returnedAt), bkkDate(resubmittedAt), holidays);
}

/**
 * กำหนดเสร็จใหม่ตอนประชาชนส่งแก้ = กำหนดเดิม + วันทำการที่หยุดนับ (คงเวลาเดิม คือ 16:30)
 * holidays = ตารางวันหยุด ณ เวลาที่ส่งแก้ (A-42)
 * BUG_MODE=B04: ไม่หยุดนับ → คืนกำหนดเดิม
 */
export function extendDueAtForFix(dueAt: Date, returnedAt: Date, resubmittedAt: Date, holidays: Holidays): Date {
  if (isBug('B04')) return new Date(dueAt.getTime());
  const h = asSet(holidays);
  const paused = pausedWorkingDays(returnedAt, resubmittedAt, h);
  if (paused === 0) return new Date(dueAt.getTime());
  const p = bkkParts(dueAt);
  return bkkDateTime(addWorkingDays(bkkDate(dueAt), paused, h), p.hour, p.minute, p.second);
}

/** เส้นตายแก้ไขของประชาชน = ตีกลับ + 168 ชม. (BR-20 · `fix-deadline`) */
export function fixDeadline(returnedAt: Date): Date {
  return new Date(returnedAt.getTime() + FIX_WINDOW_MS);
}
/** หมดเวลาแก้ไขแล้ว ⇔ ตอนนี้ ≥ ตีกลับ + 168:00 (167:59 ยังส่งได้ · 168:00 ยกเลิก) */
export function isFixWindowExpired(returnedAt: Date, at: Date = clockNow()): boolean {
  return at.getTime() >= fixDeadline(returnedAt).getTime();
}

// ───────────────────────── ระดับเตือน (BR-14 · CONTRACT §4.2) ─────────────────────────

export type SlaLevel = 'normal' | 'near' | 'overdue' | 'paused' | 'closed';

export const SLA_LEVEL_TEXT: Record<SlaLevel, string> = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

export const CLOSED_STATUSES: readonly string[] = ['COMPLETED', 'REJECTED', 'CANCELLED'];
/** งานคงค้าง (BR-25) */
export const BACKLOG_STATUSES: readonly string[] = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];

/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนดเสร็จ (รวมวันกำหนด) · กำหนด ≤ วันนี้ → 0 */
export function remainingWorkingDays(dueAt: Date, holidays: Holidays, at: Date = clockNow()): number {
  return countWorkingDays(bkkDate(at), bkkDate(dueAt), holidays);
}

/** เกินกำหนด ⇔ ตอนนี้ > กำหนดเสร็จ (16:30:00 พอดียังไม่เกิน · 16:30:01 เกิน) */
export function isOverdue(dueAt: Date, at: Date = clockNow()): boolean {
  return at.getTime() > dueAt.getTime();
}

/**
 * ระดับเตือนของคำขอ
 * - COMPLETED/REJECTED/CANCELLED → closed · NEED_FIX → paused
 * - ตอนนี้ > กำหนด → overdue · วันคงเหลือ ≤ 1 → near · ≥ 2 → normal
 * dueAt = null (ยังไม่ชำระ) → null
 */
export function slaLevel(
  c: { status: string; dueAt: Date | string | null },
  holidays: Holidays,
  at: Date = clockNow(),
): SlaLevel | null {
  if (CLOSED_STATUSES.includes(c.status)) return 'closed';
  if (c.status === 'NEED_FIX') return 'paused';
  if (c.dueAt == null) return null;
  const due = c.dueAt instanceof Date ? c.dueAt : new Date(c.dueAt);
  if (isOverdue(due, at)) return 'overdue';
  return remainingWorkingDays(due, holidays, at) <= 1 ? 'near' : 'normal';
}

/** ระดับที่ต้องแจ้งเตือนในกระดิ่ง (BR-15) → near/overdue เท่านั้น */
export const isAlertLevel = (l: SlaLevel | null): l is 'near' | 'overdue' => l === 'near' || l === 'overdue';

// ───────────────────────── ทันกำหนด (BR-25 · TC-DASH-04) ─────────────────────────

/** ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (รวมวินาที 16:30:00) */
export function isOnTime(closedAt: Date | string, dueAt: Date | string): boolean {
  const c = closedAt instanceof Date ? closedAt : new Date(closedAt);
  const d = dueAt instanceof Date ? dueAt : new Date(dueAt);
  return c.getTime() <= d.getTime();
}

/**
 * ทันกำหนด % = onTime ÷ closed × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (คำนวณด้วยจำนวนเต็ม ไม่มีปัญหา floating)
 * closed = 0 → '–' · ตัวอย่าง 6/7 → '85.7%' · 2/3 → '66.7%' · 1/1 → '100.0%'
 */
export function onTimePct(onTime: number, closed: number): string {
  if (!closed) return '–';
  const tenths = Math.floor((2 * onTime * 1000 + closed) / (2 * closed)); // round(onTime*1000/closed) แบบครึ่งขึ้น
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

// ───────────────────────── อ่านจาก DB ─────────────────────────

/** ตารางวันหยุดปัจจุบัน → Set<'YYYY-MM-DD'> */
export async function loadHolidays(c: Queryable = pool): Promise<Set<string>> {
  const r = await c.query(`SELECT to_char(date, 'YYYY-MM-DD') AS d FROM holidays`);
  return new Set(r.rows.map((x: { d: string }) => x.d));
}

/** ค่าธรรมเนียม/SLA ปัจจุบันของบริการ (admin แก้ได้) · ไม่พบ → null */
export async function loadServiceRules(serviceId: string, c: Queryable = pool): Promise<ServiceRules | null> {
  const r = await c.query(`SELECT fee, fee_per_sqm, sla_days FROM services WHERE id = $1`, [serviceId]);
  const row = r.rows[0];
  return row ? { fee: Number(row.fee), feePerSqm: Number(row.fee_per_sqm), slaDays: Number(row.sla_days) } : null;
}
