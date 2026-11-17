# NOTES-B02 · seed
- `src/db/seed.ts`: ทำงานใน transaction เดียว ใช้ได้บนฐานว่าง/หลัง TRUNCATE · ตรวจกับ PostgreSQL 16 จริง: cases 30 (IN_REVIEW 13: reg1=3 reg2=9, SUBMITTED 4, NEED_FIX 1, PENDING_APPROVAL 2, APPROVED 1, COMPLETED 7, REJECTED 1, CANCELLED 1) · files 50 · case_returns 4 · drafts 2 · payments 1
- `fixtures/make-testfiles.mjs [outDir]` สร้างไฟล์ทดสอบอัปโหลดข้อ 11 (ค่าเริ่มต้น `fixtures/testfiles/`, สร้างไว้แล้ว)
- ลายเซ็นเอกสาร DOC-2569-000001 = hmacSign(`docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer`) โดย issuedAt = `toIso()` (`2026-11-05T10:00:00+07:00`), validUntil = `2027-02-02`, signer = `เจ้าหน้าที่ทะเบียน 1` (display name) · B ที่ออก/ตรวจเอกสารต้องใช้รูปแบบเดียวกัน
- file_id ของ seed: `FL-<6หลัก>-<docKey>` (คำขอ) · `FL-DR0002-<docKey>` (ร่าง) · counter 'file' ไม่ได้ตั้ง
- case_events ใช้ชื่อ: SUBMIT CLAIM RETURN RESUBMIT FORWARD APPROVE ISSUE REJECT CANCEL · COMPLETED/APPROVED ที่ approved_by = head1 (SV-02/03) · SV-01 ไม่มี approved_by
- head1/exec1/audit1/admin1 dept = '' · Audit ว่าง · notifications ว่าง · ไม่มี schema ที่ขาด
