// นาฬิกาทดสอบ (Asia/Bangkok) · ห้ามเรียก Date.now()/new Date() ในกฎธุรกิจ ให้ใช้ now() จากไฟล์นี้เท่านั้น
// TEST_MODE=1 → นาฬิกาแช่แข็งที่ค่าเริ่มต้น/ค่าที่ PUT /api/test/clock ตั้ง (A-37)
// ไม่ตั้ง TEST_MODE → ใช้เวลาเครื่อง (ที่เดียวที่อนุญาตให้อ่านเวลาเครื่อง)

export const DEFAULT_NOW_ISO = '2026-12-01T09:00:00+07:00';
export const TZ = 'Asia/Bangkok';
const OFFSET_MS = 7 * 3600 * 1000;

let frozen: Date = new Date(DEFAULT_NOW_ISO);

export const isTestMode = (): boolean => process.env.TEST_MODE === '1';

export function now(): Date {
  return isTestMode() ? new Date(frozen.getTime()) : new Date(Date.now());
}
export function setNow(d: Date): void { frozen = new Date(d.getTime()); }
export function resetClock(): void { frozen = new Date(DEFAULT_NOW_ISO); }

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** แปลง ISO ที่ "ต้องมี offset"; ไม่ถูกต้อง → null */
export function parseIso(s: unknown): Date | null {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** ส่วนประกอบของเวลาเป็นเวลาไทย */
export function bkkParts(d: Date) {
  const t = new Date(d.getTime() + OFFSET_MS);
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(),
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(),
    weekday: t.getUTCDay(), // 0=อาทิตย์ … 6=เสาร์
  };
}
/** ISO +07:00 เช่น 2026-12-04T16:30:00+07:00 (data-iso, API) */
export function toIso(d: Date): string {
  const x = bkkParts(d);
  return `${x.year}-${p2(x.month)}-${p2(x.day)}T${p2(x.hour)}:${p2(x.minute)}:${p2(x.second)}+07:00`;
}
/** วันที่ท้องถิ่น YYYY-MM-DD */
export function bkkDate(d: Date): string {
  const x = bkkParts(d);
  return `${x.year}-${p2(x.month)}-${p2(x.day)}`;
}
/** เวลาไทยจากวัน (ค.ศ. YYYY-MM-DD) + ชั่วโมง:นาที:วินาที → Date */
export function bkkDateTime(date: string, hh = 0, mm = 0, ss = 0): Date {
  return new Date(`${date}T${p2(hh)}:${p2(mm)}:${p2(ss)}+07:00`);
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** `4 ธ.ค. 2569 16:30` (A-04) */
export function fmtThai(d: Date): string {
  const x = bkkParts(d);
  return `${x.day} ${TH_MONTHS[x.month - 1]} ${x.year + 543} ${p2(x.hour)}:${p2(x.minute)}`;
}
/** `4 ธ.ค. 2569` */
export function fmtThaiDate(d: Date): string {
  const x = bkkParts(d);
  return `${x.day} ${TH_MONTHS[x.month - 1]} ${x.year + 543}`;
}
/** เงิน `฿1,010` (A-04) */
export function fmtBaht(n: number): string {
  return '฿' + Math.round(n).toLocaleString('en-US');
}
/** ปี พ.ศ. ของเวลาที่ให้ (ค่าเริ่มต้น now()) */
export function buddhistYear(d: Date = now()): number { return bkkParts(d).year + 543; }
