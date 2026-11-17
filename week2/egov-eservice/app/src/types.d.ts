// type กลางที่ใช้ร่วมกัน (B03 ตั้ง req.user / res.locals.user ให้ตรงรูปแบบนี้ — layout.ejs อ่านค่านี้)
declare global {
  namespace Express {
    interface SessionUser {
      username: string;          // officer: off.reg1 · citizen: เลขบัตรไม่ใส่ที่นี่ ใช้ id ภายใน
      name: string;              // user-name
      role: 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
      dept?: 'registry' | 'works' | '';
      citizenId?: number;
    }
    interface Request { user?: SessionUser }
    interface Response {
      /** เรนเดอร์ views/<view>.ejs ห่อด้วย layout.ejs */
      page(view: string, locals?: Record<string, unknown>): Promise<void>;
      /** 403 + forbidden-msg */
      forbidden(): Promise<void>;
      /** 404 + not-found-msg (ข้อความ `ไม่พบคำขอ`) */
      notFoundCase(): Promise<void>;
    }
  }
}
export {};
