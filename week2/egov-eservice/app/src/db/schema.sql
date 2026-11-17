-- schema ของ e-Service กลาง · idempotent (ใช้ซ้ำตอนบูต) · ห้ามบล็อกอื่นแก้ไฟล์นี้ ถ้าขาดให้จดใน NOTES-<บล็อก>.md ให้ B13 รวม
-- เวลาทุกคอลัมน์เป็น timestamptz (แสดงผลเป็น Asia/Bangkok ที่ชั้นแอป)
-- เลขบัตร/เบอร์เก็บเข้ารหัส AES-256-GCM (lib/crypto.ts) ห้ามเก็บตรง ๆ (NFR-04)

CREATE TABLE IF NOT EXISTS counters (
  name  text PRIMARY KEY,           -- case | receipt | doc | draft | payment | file | audit-ish
  value integer NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id          text PRIMARY KEY,     -- SV-01..03
  name        text NOT NULL,
  fee         integer NOT NULL DEFAULT 0,      -- SV-01 ต่อฉบับ · SV-02 เหมา · SV-03 = feeBase
  fee_per_sqm integer NOT NULL DEFAULT 0,      -- SV-03 เท่านั้น
  sla_days    integer NOT NULL                 -- วันทำการ
);

CREATE TABLE IF NOT EXISTS holidays (
  date date PRIMARY KEY,
  name text NOT NULL
);

-- ผู้ใช้ภายใน (เจ้าหน้าที่/หัวหน้า/ผู้บริหาร/ผู้ตรวจสอบ/แอดมิน)
CREATE TABLE IF NOT EXISTS staff_users (
  username      text PRIMARY KEY,
  password_hash text NOT NULL,                 -- scrypt (ดู lib/crypto.ts hashPassword)
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('officer','head','executive','auditor','admin')),
  dept          text NOT NULL DEFAULT '' CHECK (dept IN ('','registry','works'))
);

-- ประชาชน
CREATE TABLE IF NOT EXISTS citizens (
  id            serial PRIMARY KEY,
  id_hash       text NOT NULL UNIQUE,          -- HMAC-SHA256(เลขบัตร) ไว้ค้นหา
  id_enc        text NOT NULL,                 -- AES-256-GCM (เลขบัตร 13 หลัก)
  id_masked     text NOT NULL,                 -- X-XXXX-XXXXX-45-6
  name          text NOT NULL,
  mobile_enc    text,                          -- AES-256-GCM (null = ยังไม่ลงทะเบียน)
  email         text NOT NULL DEFAULT '',
  registered    boolean NOT NULL DEFAULT false,
  consent       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ตัวนับ OTP ผิด/ล็อก (ต่อเลขบัตร)
CREATE TABLE IF NOT EXISTS otp_state (
  id_hash      text PRIMARY KEY,
  fail_count   integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_fail_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  kind       text NOT NULL,                    -- citizen | staff | pending-register
  citizen_id integer,
  username   text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

-- ร่าง / รอชำระ (ยังไม่มีเลขคำขอ)
CREATE TABLE IF NOT EXISTS drafts (
  id          text PRIMARY KEY,                -- DR-0001
  citizen_id  integer NOT NULL REFERENCES citizens(id),
  service_id  text NOT NULL REFERENCES services(id),
  qty         integer,
  area_sqm    integer,
  fee         integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_PAYMENT','SUBMITTED')),
  case_no     text,                            -- เมื่อชำระแล้วกลายเป็นคำขอ
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  ref           text PRIMARY KEY,              -- PP-0001
  draft_id      text,                          -- ไม่ FK: ลบร่าง → ref เป็น 404 ตาม CONTRACT
  amount        integer NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','EXPIRED')),
  qr_created_at timestamptz NOT NULL,
  qr_expires_at timestamptz NOT NULL,
  paid_at       timestamptz,
  case_no       text,
  receipt_no    text
);
CREATE INDEX IF NOT EXISTS payments_draft_idx ON payments(draft_id);

CREATE TABLE IF NOT EXISTS cases (
  case_no        text PRIMARY KEY,             -- EG-2569-000001
  service_id     text NOT NULL REFERENCES services(id),
  citizen_id     integer NOT NULL REFERENCES citizens(id),
  draft_id       text,
  qty            integer,
  area_sqm       integer,
  fee            integer NOT NULL,
  status         text NOT NULL CHECK (status IN ('SUBMITTED','IN_REVIEW','NEED_FIX','PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  step           integer,                      -- SV-03 1..3 (อื่น null)
  current_dept   text NOT NULL DEFAULT 'registry', -- แผนกที่ถือเรื่องอยู่ (registry|works|head)
  owner          text,                         -- username ผู้ถือเรื่อง
  issuer         text,                         -- ผู้ออกเอกสาร (A-27)
  approved_by    text,
  approved_at    timestamptz,
  paid_at        timestamptz NOT NULL,
  receipt_no     text NOT NULL,
  due_at         timestamptz NOT NULL,         -- กำหนดเสร็จ (seed ตายตัว)
  return_count   integer NOT NULL DEFAULT 0,
  returned_at    timestamptz,                  -- ตีกลับล่าสุด (NEED_FIX)
  fix_deadline   timestamptz,
  closed_at      timestamptz,
  close_reason   text,
  doc_no         text,
  verify_code    text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_citizen_idx ON cases(citizen_id);
CREATE INDEX IF NOT EXISTS cases_status_idx  ON cases(status);
CREATE INDEX IF NOT EXISTS cases_paid_idx    ON cases(paid_at);

-- ประวัติตีกลับ (F01/F02) ไว้คำนวณหยุดนับ SLA
CREATE TABLE IF NOT EXISTS case_returns (
  id              serial PRIMARY KEY,
  case_no         text NOT NULL REFERENCES cases(case_no) ON DELETE CASCADE,
  n               integer NOT NULL,
  returned_at     timestamptz NOT NULL,
  resubmitted_at  timestamptz,
  paused_workdays integer,
  reason          text NOT NULL,
  by_username     text
);

-- เส้นทางแผนกที่เรื่องเคยผ่าน (ใช้ตรวจสิทธิ์ดูไฟล์: ขั้นปัจจุบันหรือเคยผ่าน)
CREATE TABLE IF NOT EXISTS case_dept_trail (
  id         serial PRIMARY KEY,
  case_no    text NOT NULL REFERENCES cases(case_no) ON DELETE CASCADE,
  dept       text NOT NULL,
  entered_at timestamptz NOT NULL
);

-- ไทม์ไลน์ของคำขอ (แสดงในหน้ารายละเอียด)
CREATE TABLE IF NOT EXISTS case_events (
  id          serial PRIMARY KEY,
  case_no     text NOT NULL REFERENCES cases(case_no) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  actor       text,
  event       text NOT NULL,
  from_status text,
  to_status   text,
  note        text
);

-- ไฟล์แนบ (เก็บในฐานข้อมูล) · ผูกร่างก่อน แล้วย้ายมาผูกคำขอเมื่อชำระ
CREATE TABLE IF NOT EXISTS files (
  file_id    text PRIMARY KEY,
  draft_id   text,
  case_no    text,
  citizen_id integer NOT NULL,
  doc_key    text NOT NULL CHECK (doc_key IN ('id-card','map','site-photo','plan','deed','extra')),
  name       text NOT NULL,
  size       integer NOT NULL,
  mime       text NOT NULL,
  content    bytea NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS files_draft_idx ON files(draft_id);
CREATE INDEX IF NOT EXISTS files_case_idx  ON files(case_no);

-- เอกสารดิจิทัลที่ออกแล้ว
CREATE TABLE IF NOT EXISTS documents (
  doc_no       text PRIMARY KEY,               -- DOC-2569-000001
  case_no      text NOT NULL,
  applicant    text NOT NULL,
  service_id   text NOT NULL,
  issued_at    timestamptz NOT NULL,
  valid_until  date NOT NULL,                  -- วันสุดท้ายที่ใช้ได้
  signer       text NOT NULL,
  verify_code  text NOT NULL UNIQUE,
  signature    text NOT NULL                   -- HMAC-SHA256 (A-22)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         serial PRIMARY KEY,
  username   text NOT NULL,
  case_no    text NOT NULL,
  level      text NOT NULL CHECK (level IN ('near','overdue')),
  text       text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (username, case_no, level)
);

-- Audit Trail: เพิ่มได้อย่างเดียว (trigger กัน UPDATE/DELETE · TRUNCATE ตอน reset ไม่ติด trigger)
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  username    text NOT NULL,
  role        text NOT NULL,
  event       text NOT NULL,
  case_no     text,
  from_status text,
  to_status   text,
  detail      text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_update') THEN
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
  END IF;
END $$;
