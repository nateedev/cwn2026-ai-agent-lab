// B10 · Audit Trail + Admin (CONTRACT §2.10 §2.11 §6.4 §6.5 §6.8 · FR-24 · BR-27 BR-28)
// ไฟล์เดียวตามข้อกำหนดของงาน: รวม helper audit(), API, หน้า /audit และ /admin/* (เรนเดอร์จาก template ในไฟล์นี้)
import { Router, type Request, type Response } from 'express';
// @ts-ignore ไม่มี @types/ejs
import ejs from 'ejs';
import type { Queryable } from '../lib/db.ts';
import { one, query, tx } from '../lib/db.ts';
import { ah, apiError } from '../lib/http.ts';
import { bkkDateTime, fmtThai, now, toIso } from '../lib/clock.ts';
import { requireAdmin, requireAuditor } from '../lib/rbac.ts';

export const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'] as const;

export interface AuditEntry {
  username: string; role: string; event: (typeof AUDIT_EVENTS)[number];
  caseNo?: string | null; fromStatus?: string | null; toStatus?: string | null; detail?: string;
}
/** เพิ่มบันทึก Audit (append-only · เวลาจากนาฬิการะบบ) — บล็อกอื่น import จากไฟล์นี้ได้ */
export async function audit(e: AuditEntry, c: Queryable = { query } as unknown as Queryable): Promise<void> {
  await c.query(
    `INSERT INTO audit_log(at,username,role,event,case_no,from_status,to_status,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [toIso(now()), e.username, e.role, e.event, e.caseNo ?? null, e.fromStatus ?? null, e.toStatus ?? null, e.detail ?? '']);
}

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// ───────────── Audit: อ่านอย่างเดียว ─────────────
// PUT/PATCH/DELETE ทุกบทบาท (รวมไม่ล็อกอิน) → 405 แม้ :id ไม่มีจริง
router.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
  if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.set('Allow', 'GET');
    return void apiError(res, 405, 'METHOD_NOT_ALLOWED', 'ไม่อนุญาตให้แก้ไขหรือลบ Audit Trail');
  }
  next();
});

interface Row { id: number; at: Date; username: string; role: string; event: string; case_no: string | null; from_status: string | null; to_status: string | null; detail: string }

/** กรองตามผู้ทำ/เหตุการณ์/ช่วงวัน (รวมวันเริ่มและวันจบ ตามเวลาไทย) · null = พารามิเตอร์วันที่ไม่ถูกต้อง */
async function findAudit(q: Request['query']): Promise<Row[] | null> {
  const actor = str(q.actor), event = str(q.event), from = str(q.from), to = str(q.to);
  if ((from && !validDate(from)) || (to && !validDate(to))) return null;
  const where: string[] = []; const p: unknown[] = [];
  if (actor) { p.push(actor); where.push(`username = $${p.length}`); }
  if (event) { p.push(event); where.push(`event = $${p.length}`); }
  if (from) { p.push(bkkDateTime(from).toISOString()); where.push(`at >= $${p.length}::timestamptz`); }
  if (to) { // < 00:00 ของวันถัดจากวันจบ
    const next = new Date(bkkDateTime(to).getTime() + 24 * 3600 * 1000);
    p.push(next.toISOString()); where.push(`at < $${p.length}::timestamptz`);
  }
  return query<Row>(`SELECT id, at, username, role, event, case_no, from_status, to_status, detail FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC`, p);
}
const toItem = (r: Row) => ({ id: r.id, time: toIso(new Date(r.at)), username: r.username, role: r.role, event: r.event,
  caseNo: r.case_no, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail });

router.get('/api/audit', requireAuditor, ah(async (req, res) => {
  const rows = await findAudit(req.query);
  if (!rows) return void apiError(res, 400, 'INVALID_DATE', 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  res.json({ count: rows.length, items: rows.map(toItem) });
}));

const csvCell = (v: unknown): string => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // กัน CSV/formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/api/audit/export.csv', requireAuditor, ah(async (req, res) => {
  const rows = await findAudit(req.query);
  if (!rows) return void apiError(res, 400, 'INVALID_DATE', 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const lines = ['time,username,role,event,caseNo,fromStatus,toStatus,detail'];
  for (const r of rows) {
    lines.push([toIso(new Date(r.at)), r.username, r.role, r.event, r.case_no, r.from_status, r.to_status, r.detail].map(csvCell).join(','));
  }
  await audit({ username: req.user!.username, role: req.user!.role, event: 'EXPORT', detail: 'audit-csv' });
  res.status(200).set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="audit-trail.csv"',
  }).send(lines.join('\r\n') + '\r\n');
}));

// ───────────── หน้า ─────────────
async function renderPage(req: Request, res: Response, title: string, tpl: string, locals: Record<string, unknown>) {
  const data = { title, success: null, error: null, user: req.user ?? null, bellCount: 0, ...locals };
  const body = ejs.render(tpl, data);
  res.render('layout', { ...data, body });
}

const AUDIT_TPL = `
<h1>Audit Trail</h1>
<form method="get" action="/audit" class="filters" aria-label="ตัวกรอง Audit">
  <label>ผู้ทำ <input data-testid="audit-filter-actor" name="actor" value="<%= f.actor %>"></label>
  <label>เหตุการณ์ <select data-testid="audit-filter-event" name="event">
    <option value="">ทั้งหมด</option>
    <% events.forEach(function (e) { %><option value="<%= e %>"<%= f.event === e ? ' selected' : '' %>><%= e %></option><% }) %>
  </select></label>
  <label>ตั้งแต่ <input type="date" data-testid="audit-filter-from" name="from" value="<%= f.from %>"></label>
  <label>ถึง <input type="date" data-testid="audit-filter-to" name="to" value="<%= f.to %>"></label>
  <button type="submit" data-testid="audit-apply-btn">ค้นหา</button>
  <a data-testid="audit-export-csv-btn" role="button" class="btn" href="<%= csvHref %>" download="audit-trail.csv">ส่งออก CSV</a>
</form>
<% if (badDate) { %><p role="alert">รูปแบบวันที่ไม่ถูกต้อง</p><% } %>
<p>จำนวนรายการ: <strong data-testid="audit-count"><%= rows.length %></strong></p>
<table>
  <caption>บันทึกเหตุการณ์ (เรียงใหม่ → เก่า · อ่านอย่างเดียว)</caption>
  <thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">คำขอ</th><th scope="col">สถานะ</th><th scope="col">รายละเอียด</th></tr></thead>
  <tbody>
  <% rows.forEach(function (r) { %>
    <tr data-testid="audit-row" data-id="<%= r.id %>" data-event="<%= r.event %>" data-actor="<%= r.username %>" data-case-no="<%= r.caseNo || '' %>">
      <td data-testid="audit-time" data-iso="<%= r.iso %>"><%= r.thai %></td>
      <td data-testid="audit-actor"><%= r.username %></td>
      <td data-testid="audit-role"><%= r.role %></td>
      <td data-testid="audit-event"><%= r.event %></td>
      <td data-testid="audit-case-no"><%= r.caseNo || '–' %></td>
      <td data-testid="audit-transition"><%= (r.fromStatus && r.toStatus) ? (r.fromStatus + ' → ' + r.toStatus) : '–' %></td>
      <td data-testid="audit-detail"><%= r.detail %></td>
    </tr>
  <% }) %>
  </tbody>
</table>`;

router.get('/audit', requireAuditor, ah(async (req, res) => {
  const f = { actor: str(req.query.actor), event: str(req.query.event), from: str(req.query.from), to: str(req.query.to) };
  const found = await findAudit(req.query);
  const rows = (found ?? []).map((r) => ({ ...toItem(r), thai: fmtThai(new Date(r.at)), iso: toIso(new Date(r.at)) }));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  await renderPage(req, res, 'Audit Trail', AUDIT_TPL, {
    f, events: AUDIT_EVENTS, rows, badDate: found === null, csvHref: '/api/audit/export.csv' + (qs ? '?' + qs : ''),
  });
}));

// ───────────── Admin ─────────────
router.use(['/api/admin', '/admin'], requireAdmin);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const FEE_MAX = 100000, SLA_MIN = 1, SLA_MAX = 60;
const okFee = (v: unknown): v is number => isInt(v) && v >= 0 && v <= FEE_MAX;
const okSla = (v: unknown): v is number => isInt(v) && v >= SLA_MIN && v <= SLA_MAX;

interface Svc { id: string; fee: number; fee_per_sqm: number; sla_days: number }
const svcOut = (s: Svc) => ({ id: s.id, fee: s.fee, feePerSqm: s.fee_per_sqm, sla: s.sla_days });
const listServices = () => query<Svc>(`SELECT id, fee, fee_per_sqm, sla_days FROM services ORDER BY id`);

router.get('/api/admin/services', ah(async (_req, res) => { res.json({ items: (await listServices()).map(svcOut) }); }));

router.put('/api/admin/services/:id', ah(async (req, res) => {
  const cur = await one<Svc>(`SELECT id, fee, fee_per_sqm, sla_days FROM services WHERE id = $1`, [req.params.id]);
  if (!cur) return void apiError(res, 404, 'NOT_FOUND', 'ไม่พบบริการ');
  const b = req.body ?? {};
  const feeIn = cur.id === 'SV-03' ? (b.feeBase ?? b.fee) : b.fee;
  const sqmIn = cur.id === 'SV-03' ? b.feePerSqm : undefined;
  if (feeIn !== undefined && !okFee(feeIn)) return void apiError(res, 400, 'INVALID_FEE', 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท');
  if (sqmIn !== undefined && !okFee(sqmIn)) return void apiError(res, 400, 'INVALID_FEE', 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท');
  if (b.sla !== undefined && !okSla(b.sla)) return void apiError(res, 400, 'INVALID_SLA', 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ');
  if (feeIn === undefined && sqmIn === undefined && b.sla === undefined) return void apiError(res, 400, 'INVALID_FEE', 'ไม่มีค่าที่จะบันทึก');
  const fee = feeIn ?? cur.fee, sqm = sqmIn ?? cur.fee_per_sqm, sla = b.sla ?? cur.sla_days;
  const u = req.user!;
  const out = await tx(async (c) => {
    await c.query(`UPDATE services SET fee=$2, fee_per_sqm=$3, sla_days=$4 WHERE id=$1`, [cur.id, fee, sqm, sla]);
    const changes: string[] = [];
    if (fee !== cur.fee) changes.push(`${cur.id} fee ${cur.fee} → ${fee}`);
    if (sqm !== cur.fee_per_sqm) changes.push(`${cur.id} feePerSqm ${cur.fee_per_sqm} → ${sqm}`);
    if (sla !== cur.sla_days) changes.push(`${cur.id} sla ${cur.sla_days} → ${sla}`);
    for (const d of changes) await audit({ username: u.username, role: u.role, event: 'ADMIN_CHANGE', detail: d }, c);
    return svcOut({ id: cur.id, fee, fee_per_sqm: sqm, sla_days: sla });
  });
  res.json(out);
}));

// วันหยุด
const listHolidays = () => query<{ date: string; name: string }>(`SELECT date::text AS date, name FROM holidays ORDER BY date`);
router.get('/api/admin/holidays', ah(async (_req, res) => { res.json({ items: await listHolidays() }); }));
router.post('/api/admin/holidays', ah(async (req, res) => {
  const date = str(req.body?.date), name = str(req.body?.name);
  if (!validDate(date)) return void apiError(res, 400, 'INVALID_DATE', 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  if (!name) return void apiError(res, 400, 'INVALID_NAME', 'กรุณาระบุชื่อวันหยุด');
  const u = req.user!;
  const created = await tx(async (c) => {
    const r = await c.query(`INSERT INTO holidays(date,name) VALUES ($1,$2) ON CONFLICT (date) DO NOTHING`, [date, name]);
    if (!r.rowCount) return false;
    await audit({ username: u.username, role: u.role, event: 'ADMIN_CHANGE', detail: `holiday add ${date}` }, c);
    return true;
  });
  if (!created) return void apiError(res, 409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว');
  res.status(201).json({ date, name });
}));
router.delete('/api/admin/holidays/:date', ah(async (req, res) => {
  const date = String(req.params.date);
  if (!validDate(date)) return void apiError(res, 404, 'NOT_FOUND', 'ไม่พบวันหยุด');
  const u = req.user!;
  const done = await tx(async (c) => {
    const r = await c.query(`DELETE FROM holidays WHERE date = $1`, [date]);
    if (!r.rowCount) return false;
    await audit({ username: u.username, role: u.role, event: 'ADMIN_CHANGE', detail: `holiday delete ${date}` }, c);
    return true;
  });
  if (!done) return void apiError(res, 404, 'NOT_FOUND', 'ไม่พบวันหยุด');
  res.json({ ok: true, date });
}));

// ผู้ใช้
const STAFF_ROLES = ['officer', 'head', 'executive', 'auditor', 'admin'];
const DEPTS = ['', 'registry', 'works'];
const listUsers = () => query<{ username: string; name: string; role: string; dept: string }>(
  `SELECT username, display_name AS name, role, dept FROM staff_users ORDER BY username`);
router.get('/api/admin/users', ah(async (_req, res) => { res.json({ items: await listUsers() }); }));
router.put('/api/admin/users/:username', ah(async (req, res) => {
  const cur = await one<{ username: string; role: string; dept: string }>(
    `SELECT username, role, dept FROM staff_users WHERE username = $1`, [req.params.username]);
  if (!cur) return void apiError(res, 404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
  const u = req.user!;
  if (cur.username === u.username) return void apiError(res, 409, 'SELF_ROLE_CHANGE', 'ไม่สามารถแก้บทบาทของตนเองได้');
  const b = req.body ?? {};
  const role = b.role === undefined ? cur.role : b.role;
  const dept = b.dept === undefined || b.dept === null ? cur.dept : b.dept;
  if (typeof role !== 'string' || !STAFF_ROLES.includes(role)) return void apiError(res, 400, 'INVALID_ROLE', 'บทบาทไม่ถูกต้อง');
  if (typeof dept !== 'string' || !DEPTS.includes(dept)) return void apiError(res, 400, 'INVALID_DEPT', 'แผนกไม่ถูกต้อง');
  await tx(async (c) => {
    await c.query(`UPDATE staff_users SET role=$2, dept=$3 WHERE username=$1`, [cur.username, role, dept]);
    if (role !== cur.role) await audit({ username: u.username, role: u.role, event: 'ADMIN_CHANGE', detail: `${cur.username} role ${cur.role} → ${role}` }, c);
    if (dept !== cur.dept) await audit({ username: u.username, role: u.role, event: 'ADMIN_CHANGE', detail: `${cur.username} dept ${cur.dept || '-'} → ${dept || '-'}` }, c);
  });
  res.json({ username: cur.username, role, dept });
}));

// หน้า admin — ใช้ fetch เรียก API เดิม แล้วแสดง action-success / action-error
const ADMIN_JS = `
<script>
(function () {
  function toast(kind, msg) {
    var old = document.querySelector('[data-toast]'); if (old) old.remove();
    var d = document.createElement('div');
    d.setAttribute('data-toast', '1'); d.setAttribute('data-testid', kind === 'ok' ? 'action-success' : 'action-error');
    d.setAttribute('role', kind === 'ok' ? 'status' : 'alert'); d.className = 'toast ' + (kind === 'ok' ? 'ok' : 'err');
    d.textContent = msg; document.getElementById('main').prepend(d);
  }
  window.adminCall = function (method, url, body, okMsg, after) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok) { toast('ok', okMsg); if (after) after(); } else toast('err', x.j.message || x.j.code || 'เกิดข้อผิดพลาด'); });
  };
  window.num = function (id) { var v = document.getElementById(id).value.trim(); return /^-?\\d+$/.test(v) ? Number(v) : v === '' ? undefined : NaN; };
})();
</script>`;

const SERVICES_TPL = `
<h1>จัดการบริการ</h1>
<table>
  <caption>ค่าธรรมเนียมและ SLA (วันทำการ)</caption>
  <thead><tr><th scope="col">บริการ</th><th scope="col">ค่าธรรมเนียม (฿)</th><th scope="col">ต่อ ตร.ม. ส่วนเกิน 100 (฿)</th><th scope="col">SLA (วันทำการ)</th><th scope="col">บันทึก</th></tr></thead>
  <tbody>
  <% items.forEach(function (s) { %>
    <tr data-testid="service-row" data-service-id="<%= s.id %>">
      <td><%= s.id %> <%= names[s.id] || '' %></td>
      <td><input type="number" step="1" id="fee-<%= s.id %>" data-testid="svc-fee-<%= s.id %>" aria-label="ค่าธรรมเนียม <%= s.id %>" value="<%= s.fee %>"></td>
      <td><% if (s.id === 'SV-03') { %><input type="number" step="1" id="sqm-<%= s.id %>" data-testid="svc-fee-per-sqm-<%= s.id %>" aria-label="ค่าธรรมเนียมต่อตารางเมตร" value="<%= s.feePerSqm %>"><% } else { %>–<% } %></td>
      <td><input type="number" step="1" id="sla-<%= s.id %>" data-testid="svc-sla-<%= s.id %>" aria-label="SLA <%= s.id %>" value="<%= s.sla %>"></td>
      <td><button type="button" data-testid="svc-save-<%= s.id %>" data-id="<%= s.id %>" class="svc-save">บันทึก</button></td>
    </tr>
  <% }) %>
  </tbody>
</table>
` + ADMIN_JS + `
<script>
document.querySelectorAll('.svc-save').forEach(function (b) {
  b.addEventListener('click', function () {
    var id = b.getAttribute('data-id'), body = { sla: num('sla-' + id) };
    if (id === 'SV-03') { body.feeBase = num('fee-' + id); body.feePerSqm = num('sqm-' + id); } else body.fee = num('fee-' + id);
    adminCall('PUT', '/api/admin/services/' + id, body, 'บันทึกบริการ ' + id + ' แล้ว');
  });
});
</script>`;

const HOLIDAYS_TPL = `
<h1>วันหยุด</h1>
<form id="holiday-form" aria-label="เพิ่มวันหยุด">
  <label>วันที่ (YYYY-MM-DD) <input data-testid="holiday-date-input" id="h-date" placeholder="2026-12-02" inputmode="numeric"></label>
  <label>ชื่อวันหยุด <input data-testid="holiday-name-input" id="h-name"></label>
  <button type="submit" data-testid="holiday-add-btn">เพิ่ม</button>
</form>
<table>
  <caption>วันหยุดที่กำหนด</caption>
  <thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อ</th><th scope="col">ลบ</th></tr></thead>
  <tbody>
  <% items.forEach(function (h) { %>
    <tr data-testid="holiday-row" data-date="<%= h.date %>">
      <td><%= h.date %></td><td><%= h.name %></td>
      <td><button type="button" data-testid="holiday-delete-btn" data-date="<%= h.date %>" class="h-del">ลบ</button></td>
    </tr>
  <% }) %>
  </tbody>
</table>
` + ADMIN_JS + `
<script>
document.getElementById('holiday-form').addEventListener('submit', function (e) {
  e.preventDefault();
  adminCall('POST', '/api/admin/holidays', { date: document.getElementById('h-date').value.trim(), name: document.getElementById('h-name').value.trim() },
    'เพิ่มวันหยุดแล้ว', function () { setTimeout(function () { location.reload(); }, 0); });
});
document.querySelectorAll('.h-del').forEach(function (b) {
  b.addEventListener('click', function () {
    adminCall('DELETE', '/api/admin/holidays/' + b.getAttribute('data-date'), null, 'ลบวันหยุดแล้ว', function () { b.closest('tr').remove(); });
  });
});
</script>`;

const USERS_TPL = `
<h1>ผู้ใช้และบทบาท</h1>
<p>การเปลี่ยนบทบาทมีผลกับการล็อกอินครั้งถัดไป</p>
<table>
  <caption>ผู้ใช้ภายใน</caption>
  <thead><tr><th scope="col">ชื่อผู้ใช้</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">แผนก</th><th scope="col">บันทึก</th></tr></thead>
  <tbody>
  <% items.forEach(function (u) { %>
    <tr data-testid="user-row" data-username="<%= u.username %>">
      <td><%= u.username %></td><td><%= u.name %></td>
      <td><select data-testid="user-role-select" aria-label="บทบาทของ <%= u.username %>">
        <% roles.forEach(function (r) { %><option value="<%= r %>"<%= u.role === r ? ' selected' : '' %>><%= r %></option><% }) %>
      </select></td>
      <td><select data-testid="user-dept-select" aria-label="แผนกของ <%= u.username %>">
        <% [['', '(ไม่มี)'], ['registry', 'registry'], ['works', 'works']].forEach(function (d) { %><option value="<%= d[0] %>"<%= u.dept === d[0] ? ' selected' : '' %>><%= d[1] %></option><% }) %>
      </select></td>
      <td><button type="button" data-testid="user-save-btn" class="u-save">บันทึก</button></td>
    </tr>
  <% }) %>
  </tbody>
</table>
` + ADMIN_JS + `
<script>
document.querySelectorAll('.u-save').forEach(function (b) {
  b.addEventListener('click', function () {
    var tr = b.closest('tr'), name = tr.getAttribute('data-username');
    adminCall('PUT', '/api/admin/users/' + encodeURIComponent(name),
      { role: tr.querySelector('[data-testid=user-role-select]').value, dept: tr.querySelector('[data-testid=user-dept-select]').value },
      'บันทึกผู้ใช้ ' + name + ' แล้ว');
  });
});
</script>`;

router.get('/admin', (_req, res) => { res.redirect('/admin/services'); });
router.get('/admin/services', ah(async (req, res) => {
  const names = Object.fromEntries((await query<{ id: string; name: string }>(`SELECT id, name FROM services`)).map((s) => [s.id, s.name]));
  await renderPage(req, res, 'จัดการบริการ', SERVICES_TPL, { items: (await listServices()).map(svcOut), names });
}));
router.get('/admin/holidays', ah(async (req, res) => {
  await renderPage(req, res, 'วันหยุด', HOLIDAYS_TPL, { items: await listHolidays() });
}));
router.get('/admin/users', ah(async (req, res) => {
  await renderPage(req, res, 'ผู้ใช้และบทบาท', USERS_TPL, { items: await listUsers(), roles: STAFF_ROLES });
}));

export default router;
