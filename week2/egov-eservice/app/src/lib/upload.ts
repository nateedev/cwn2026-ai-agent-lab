// อัปโหลดไฟล์แนบ (B05) · CONTRACT §5 §6.2 · A-10 A-49
//  - ชนิดไฟล์ตรวจจาก magic bytes เท่านั้น (ไม่ดูนามสกุล/Content-Type)
//  - ขนาด ≤ 5,242,880 ไบต์ · รวมไม่เกิน 5 ไฟล์ต่อคำขอ · แบบแปลน (SV-03) ต้องเป็น PDF
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { isBug } from './bugmode.ts';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5,242,880
export const MAX_FILES = 5;

export type DocKey = 'id-card' | 'map' | 'site-photo' | 'plan' | 'deed' | 'extra';
export type MimeKind = 'application/pdf' | 'image/jpeg' | 'image/png';

export const UPLOAD_ERRORS = {
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
} as const;
export type UploadErrorCode = keyof typeof UPLOAD_ERRORS;

export interface DocDef { key: DocKey; name: string; required: boolean }

/** เอกสารของแต่ละบริการ (ลำดับตามตาราง 4.3 — ใช้ใน missing-docs) · `extra` ใช้ได้ทุกบริการ */
export const SERVICE_DOCS: Record<string, DocDef[]> = {
  'SV-01': [{ key: 'id-card', name: 'บัตรประชาชน', required: true }],
  'SV-02': [
    { key: 'id-card', name: 'บัตรประชาชน', required: true },
    { key: 'map', name: 'แผนที่ตั้ง', required: true },
    { key: 'site-photo', name: 'ภาพสถานที่', required: false },
  ],
  'SV-03': [
    { key: 'id-card', name: 'บัตรประชาชน', required: true },
    { key: 'plan', name: 'แบบแปลน', required: true },
    { key: 'deed', name: 'โฉนด', required: true },
  ],
};
export const SERVICE_NAMES: Record<string, string> = {
  'SV-01': 'ขอหนังสือรับรอง',
  'SV-02': 'ขออนุญาตประกอบกิจการ',
  'SV-03': 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
};

export const isDocKeyForService = (serviceId: string, key: string): key is DocKey =>
  key === 'extra' || (SERVICE_DOCS[serviceId] ?? []).some((d) => d.key === key);

/** ชื่อเอกสารบังคับที่ยังขาด (เรียงตามตาราง 4.3) · แบบแปลน/ทุกช่อง "ขาด" = ไม่มีไฟล์ docKey นั้น */
export function missingDocNames(serviceId: string, presentKeys: Iterable<string>): string[] {
  const have = new Set(presentKeys);
  return (SERVICE_DOCS[serviceId] ?? []).filter((d) => d.required && !have.has(d.key)).map((d) => d.name);
}

/** ตรวจชนิดจากไบต์แรกของไฟล์ · ไม่ใช่ PDF/JPEG/PNG → null */
export function sniffType(buf: Buffer): MimeKind | null {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

/** ไฟล์ใหญ่เกินกำหนดหรือไม่ · BUG_MODE=B02: ใช้ `>=` ทำให้ 5,242,880 พอดีถูกปฏิเสธ */
export function isTooLarge(size: number): boolean {
  return isBug('B02') ? size >= MAX_FILE_BYTES : size > MAX_FILE_BYTES;
}

export type UploadCheck =
  | { ok: true; mime: MimeKind }
  | { ok: false; code: UploadErrorCode; message: string };

const bad = (code: UploadErrorCode): UploadCheck => ({ ok: false, code, message: UPLOAD_ERRORS[code] });

/**
 * ตรวจไฟล์เดี่ยว (ลำดับ: ชนิด → แบบแปลนต้อง PDF → ขนาด) · การนับจำนวน (FILE_COUNT) ทำที่ผู้เรียกในธุรกรรม
 */
export function checkFile(buf: Buffer, docKey: DocKey): UploadCheck {
  const mime = sniffType(buf);
  if (!mime) return bad('FILE_TYPE');
  if (docKey === 'plan' && mime !== 'application/pdf') return bad('PLAN_NOT_PDF');
  if (isTooLarge(buf.length)) return bad('FILE_TOO_LARGE');
  return { ok: true, mime };
}

/** ชื่อไฟล์ที่ปลอดภัยสำหรับเก็บ/แสดง (multer ส่งชื่อแบบ latin1 ต้องแปลงเป็น utf8) */
export function cleanName(original: string): string {
  let n = original;
  try {
    const u = Buffer.from(original, 'latin1').toString('utf8');
    if (!u.includes('�')) n = u;
  } catch { /* ใช้ชื่อเดิม */ }
  n = n.replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return (n || 'file').slice(0, 200);
}

// รับ body ได้ถึง 8 MB (> 6 MB ตาม CONTRACT 0.10) แล้วให้ checkFile ตัดสินขนาดเอง
// เกิน 8 MB จริง ๆ → LIMIT_FILE_SIZE ก็ตอบ FILE_TOO_LARGE เช่นกัน (ไม่ใช่ 413)
const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10, fields: 20 } });

/** middleware: รับไฟล์เดียวชื่อฟิลด์ `file` (ไม่บังคับมีไฟล์) แล้วแปลง error ของ multer เป็นรูปแบบ CONTRACT */
export function singleFile(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('multipart/form-data')) return next();
  mem.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    if (e.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ code: 'FILE_TOO_LARGE', message: UPLOAD_ERRORS.FILE_TOO_LARGE });
      return;
    }
    res.status(400).json({ code: 'BAD_REQUEST', message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
  });
}
