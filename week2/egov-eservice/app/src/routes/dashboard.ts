// B09 · Dashboard ผู้บริหาร + ส่งออก Excel/PDF
// ที่มา: REQUIREMENTS FR-22 FR-23 BR-24 BR-25 BR-26 · A-41 A-50 A-63 · CONTRACT §1 §2.9 §6.4 §6.8 §7 · TEST-PLAN TC-DASH-01..04 · BUGS B10
//
// ตามกฎ "เขียนเฉพาะ src/routes/dashboard.ts" ไฟล์นี้จึงรวมตัวคำนวณสถิติ (แทน lib/stats.ts) และ template หน้า (แทน views/dashboard.ejs) ไว้ด้วยกัน
// กฎเวลา/ทันกำหนด/% ใช้จาก rules/fee-sla.ts (B04) เท่านั้น ได้แก่ isOnTime, isOverdue, onTimePct, BACKLOG_STATUSES
// BUG_MODE ในไฟล์นี้: B10 (ทันกำหนด % หารด้วย "รับเรื่อง" แทน "ปิดงาน")
//
// Endpoint
//   GET /dashboard                                   (executive) หน้า Dashboard
//   GET /api/dashboard?period=2026-11&service=ALL    (executive) {"received","closed","onTime","ontimePct","backlog","overdue","workload":[{username,count}]}
//   GET /api/dashboard/export?format=xlsx|pdf&period=…&service=…  (executive) ไฟล์ตาม CONTRACT §7 + Audit EXPORT `<format> <period> <service>`

import { Router, type Request, type Response } from 'express';
// @ts-ignore ไม่มี @types/ejs
import ejs from 'ejs';
// @ts-ignore exceljs มี type ในแพ็กเกจ แต่ import แบบ default ผ่าน ESM
import ExcelJS from 'exceljs';
import { now, bkkParts } from '../lib/clock.ts';
import { isBug } from '../lib/bugmode.ts';
import { query } from '../lib/db.ts';
import { ah, apiError } from '../lib/http.ts';
import { requireExecutive } from '../lib/rbac.ts';
import { BACKLOG_STATUSES, SERVICE_IDS, isOnTime, isOverdue, isServiceId, onTimePct } from '../rules/fee-sla.ts';
import { audit } from './audit-admin.ts';

// ───────────────────────── ช่วงเวลา (A-41: `YYYY-MM` หรือ `YYYY` = ทั้งปี · ค.ศ.) ─────────────────────────

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const PERIOD_RE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;
const p2 = (n: number) => String(n).padStart(2, '0');

export type ServiceFilter = 'ALL' | (typeof SERVICE_IDS)[number];

export interface Period { key: string; from: Date; to: Date; label: string }

/** ช่วง [from, to) ตามเวลาไทย · ค่าไม่ถูกต้อง → null */
export function parsePeriod(s: unknown): Period | null {
  if (typeof s !== 'string') return null;
  const m = PERIOD_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 2000 || y > 2999) return null;
  if (!m[2]) {
    return { key: `${y}`, from: new Date(`${y}-01-01T00:00:00+07:00`), to: new Date(`${y + 1}-01-01T00:00:00+07:00`), label: `ทั้งปี ${y + 543}` };
  }
  const mo = Number(m[2]);
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return {
    key: `${y}-${p2(mo)}`,
    from: new Date(`${y}-${p2(mo)}-01T00:00:00+07:00`),
    to: new Date(`${ny}-${p2(nm)}-01T00:00:00+07:00`),
    label: `${TH_MONTHS[mo - 1]} ${y + 543}`,
  };
}

/** ค่าเริ่มต้น = เดือนของนาฬิการะบบ (CONTRACT §2.9) */
export function currentPeriodKey(at: Date = now()): string {
  const x = bkkParts(at);
  return `${x.year}-${p2(x.month)}`;
}

/** ตัวเลือกใน period-select: 12 เดือนล่าสุด (ใหม่ → เก่า) แล้วตามด้วยทั้งปีปัจจุบันและปีก่อน */
function periodOptions(selected: string, at: Date = now()): Period[] {
  const x = bkkParts(at);
  const keys: string[] = [];
  let y = x.year, m = x.month;
  for (let i = 0; i < 12; i++) {
    keys.push(`${y}-${p2(m)}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  keys.push(`${x.year}`, `${x.year - 1}`);
  if (!keys.includes(selected)) keys.push(selected);
  return keys.map((k) => parsePeriod(k)!).filter(Boolean);
}

const SERVICE_LABEL: Record<ServiceFilter, string> = {
  ALL: 'ทุกบริการ',
  'SV-01': 'SV-01 ขอหนังสือรับรอง',
  'SV-02': 'SV-02 ขออนุญาตประกอบกิจการ',
  'SV-03': 'SV-03 ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
};
const SERVICE_FILTERS: ServiceFilter[] = ['ALL', ...SERVICE_IDS];
const parseService = (s: unknown): ServiceFilter | null =>
  s === 'ALL' ? 'ALL' : isServiceId(s) ? s : null;

// ───────────────────────── ตัวชี้วัด (BR-25 BR-26 · แทน lib/stats.ts) ─────────────────────────

export interface DashboardStats {
  received: number;
  closed: number;
  onTime: number;
  /** ข้อความตามจอ: `85.7%` · ปิดงาน 0 → `–` */
  ontimeText: string;
  /** ตัวเลขสำหรับ API · ปิดงาน 0 → null */
  ontimePct: number | null;
  backlog: number;
  overdue: number;
  workload: { username: string; name: string; count: number }[];
}

interface CaseRow { service_id: string; status: string; paid_at: Date; closed_at: Date | null; due_at: Date }

const inRange = (d: Date | null, p: Period) => d != null && d.getTime() >= p.from.getTime() && d.getTime() < p.to.getTime();

/**
 * - รับเรื่อง = ชำระสำเร็จ (paid_at) ในช่วง รวม CANCELLED ที่เคยชำระ
 * - ปิดงาน = COMPLETED + REJECTED ที่ closed_at ในช่วง (CANCELLED ไม่นับ)
 * - ทันกำหนด = ปิดงานที่ closed_at ≤ due_at (รวม 16:30:00) · % = ทัน ÷ ปิดงาน (รายปีคิดจากยอดรวม ไม่เฉลี่ยรายเดือน)
 * - งานคงค้าง / เกินกำหนดคงค้าง = ณ ตอนนี้ ไม่ขึ้นกับช่วง แต่ขึ้นกับบริการ (A-41)
 * - งานในมือรายเจ้าหน้าที่ = IN_REVIEW ที่ถือ ไม่ขึ้นกับตัวกรอง · แสดงเจ้าหน้าที่ทุกคนแม้ 0
 */
export async function computeStats(period: Period, service: ServiceFilter, at: Date = now()): Promise<DashboardStats> {
  const rows = await query<CaseRow>(
    `SELECT service_id, status, paid_at, closed_at, due_at FROM cases WHERE ($1::text = 'ALL' OR service_id = $1)`,
    [service]);

  let received = 0, closed = 0, onTime = 0, backlog = 0, overdue = 0;
  for (const r of rows) {
    if (inRange(r.paid_at, period)) received++;
    if ((r.status === 'COMPLETED' || r.status === 'REJECTED') && inRange(r.closed_at, period)) {
      closed++;
      if (isOnTime(r.closed_at!, r.due_at)) onTime++;
    }
    if (BACKLOG_STATUSES.includes(r.status)) {
      backlog++;
      if (r.status !== 'NEED_FIX' && isOverdue(r.due_at, at)) overdue++;
    }
  }

  // B10: หารด้วย "รับเรื่อง" แทน "ปิดงาน" (ธ.ค. 0 ÷ 3 = 0.0% · รับเรื่อง 0 ยังเป็น –)
  const denominator = isBug('B10') ? received : closed;
  const ontimeText = onTimePct(onTime, denominator);
  const ontimePct = ontimeText === '–' ? null : Number.parseFloat(ontimeText);

  const wl = await query<{ username: string; name: string; count: number }>(
    `SELECT u.username, u.display_name AS name,
            (SELECT count(*)::int FROM cases c WHERE c.owner = u.username AND c.status = 'IN_REVIEW') AS count
       FROM staff_users u WHERE u.role = 'officer' ORDER BY u.username`);

  return { received, closed, onTime, ontimeText, ontimePct, backlog, overdue, workload: wl };
}

/** 5 ช่องตามจอ (ใช้ร่วมกันทั้งหน้า xlsx และ pdf → "เท่าจอทุกช่อง") */
function kpiCells(s: DashboardStats): [string, string][] {
  return [
    ['รับเรื่อง', String(s.received)],
    ['ปิดงาน', String(s.closed)],
    ['ทันกำหนด %', s.ontimeText],
    ['งานคงค้าง', String(s.backlog)],
    ['เกินกำหนดคงค้าง', String(s.overdue)],
  ];
}

// ───────────────────────── ไฟล์ส่งออก (CONTRACT §7 · A-50) ─────────────────────────

async function buildXlsx(s: DashboardStats, period: Period, service: ServiceFilter): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Service';
  const ws = wb.addWorksheet('Dashboard');
  ws.columns = [{ width: 22 }, { width: 14 }];
  ws.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
  for (const [label, value] of kpiCells(s)) ws.addRow([label, value]); // ค่าเป็นข้อความตามจอ
  // ข้อมูลประกอบอยู่ชีตที่ 2 เพื่อให้ชีตแรกตรงรูปแบบ CONTRACT §7 พอดี
  const info = wb.addWorksheet('ข้อมูลประกอบ');
  info.columns = [{ width: 28 }, { width: 36 }];
  info.addRow(['ช่วงเวลา', period.label]);
  info.addRow(['บริการ', SERVICE_LABEL[service]]);
  info.addRow([]);
  info.addRow(['งานในมือรายเจ้าหน้าที่', 'จำนวน']).font = { bold: true };
  for (const w of s.workload) info.addRow([w.username, String(w.count)]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * PDF 1 หน้า (Helvetica · ASCII) มีบรรทัด `kpi received=… closed=… ontime=…% backlog=… overdue=…` (ปิดงาน 0 → `ontime=-`)
 * ใช้ cross-reference stream แบบไบนารี (PDF 1.5) แทนตาราง xref ข้อความ เพื่อไม่ให้มีตัวเลข 10 หลักขึ้นต้นด้วย 0
 * (ตัวตรวจ BR-24 สำรองอ่านไบต์ดิบด้วย regex `0\d{9}`) · ไม่มีวันที่ใน metadata
 */
function buildPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const content = ['BT', '/F1 12 Tf', '16 TL', '50 790 Td',
    ...lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'].join('\n');

  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    parts.push(b);
    pos += b.length;
  });
  // xref stream = วัตถุที่ 6 · W [1 2 1] (ชนิด · offset 2 ไบต์ · gen)
  const xrefNo = objs.length + 1;
  offsets.push(pos);
  const entries = Buffer.alloc(4 * (xrefNo + 1));
  entries.writeUInt8(0, 0); entries.writeUInt16BE(0, 1); entries.writeUInt8(0xff, 3);
  offsets.forEach((off, i) => {
    const at = 4 * (i + 1);
    entries.writeUInt8(1, at); entries.writeUInt16BE(off, at + 1); entries.writeUInt8(0, at + 3);
  });
  parts.push(Buffer.from(`${xrefNo} 0 obj\n<< /Type /XRef /Size ${xrefNo + 1} /W [1 2 1] /Index [0 ${xrefNo + 1}] /Root 1 0 R /Length ${entries.length} >>\nstream\n`, 'latin1'));
  parts.push(entries);
  parts.push(Buffer.from(`\nendstream\nendobj\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

function pdfLines(s: DashboardStats, period: Period, service: ServiceFilter): string[] {
  const ontime = s.ontimeText === '–' ? '-' : s.ontimeText;
  return [
    'e-Service Dashboard report',
    `period=${period.key} service=${service}`,
    `kpi received=${s.received} closed=${s.closed} ontime=${ontime} backlog=${s.backlog} overdue=${s.overdue}`,
    `workload ${s.workload.map((w) => `${w.username}=${w.count}`).join(' ')}`,
  ];
}

// ───────────────────────── หน้า (แทน views/dashboard.ejs) ─────────────────────────

const DASHBOARD_TPL = `
<h1>Dashboard ผู้บริหาร</h1>
<form id="dash-filter" method="get" action="/dashboard" class="filters" aria-label="ตัวกรอง Dashboard">
  <label for="period-select">เดือน/ปี</label>
  <select id="period-select" name="period" data-testid="period-select">
    <% periods.forEach(function (p) { %><option value="<%= p.key %>"<%= p.key === period.key ? ' selected' : '' %>><%= p.label %></option><% }) %>
  </select>
  <label for="service-select">บริการ</label>
  <select id="service-select" name="service" data-testid="service-select">
    <% services.forEach(function (s) { %><option value="<%= s.id %>"<%= s.id === service ? ' selected' : '' %>><%= s.label %></option><% }) %>
  </select>
  <button type="submit" id="dash-apply">แสดงผล</button>
</form>

<section aria-labelledby="kpi-heading">
  <h2 id="kpi-heading">ตัวชี้วัด <span id="dash-scope"><%= period.label %> · <%= serviceLabel %></span></h2>
  <dl class="kpis" aria-live="polite">
    <div class="kpi"><dt>รับเรื่อง</dt><dd data-testid="kpi-received"><%= s.received %></dd></div>
    <div class="kpi"><dt>ปิดงาน</dt><dd data-testid="kpi-closed"><%= s.closed %></dd></div>
    <div class="kpi"><dt>ทันกำหนด %</dt><dd data-testid="kpi-ontime-pct"><%= s.ontimeText %></dd></div>
    <div class="kpi"><dt>งานคงค้าง (ณ ตอนนี้)</dt><dd data-testid="kpi-backlog"><%= s.backlog %></dd></div>
    <div class="kpi"><dt>เกินกำหนดคงค้าง (ณ ตอนนี้)</dt><dd data-testid="kpi-overdue"><%= s.overdue %></dd></div>
  </dl>
  <p class="note">ทันกำหนด % = ปิดงานที่ทันกำหนด ÷ ปิดงาน · งานคงค้างและเกินกำหนดคงค้างคิด ณ ตอนนี้ ไม่ขึ้นกับเดือน/ปีที่เลือก</p>
</section>

<section aria-labelledby="export-heading">
  <h2 id="export-heading">ส่งออกรายงาน</h2>
  <p>
    <a class="btn" role="button" data-testid="export-xlsx-btn" id="export-xlsx-btn" href="<%= xlsxHref %>" download>ส่งออก Excel</a>
    <a class="btn" role="button" data-testid="export-pdf-btn" id="export-pdf-btn" href="<%= pdfHref %>" download>ส่งออก PDF</a>
  </p>
</section>

<section aria-labelledby="workload-heading">
  <h2 id="workload-heading">งานในมือรายเจ้าหน้าที่</h2>
  <table>
    <caption>จำนวนคำขอที่กำลังตรวจสอบ (ไม่ขึ้นกับตัวกรอง)</caption>
    <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">งานในมือ</th></tr></thead>
    <tbody>
    <% s.workload.forEach(function (w) { %>
      <tr data-testid="workload-row" data-username="<%= w.username %>">
        <th scope="row"><%= w.name %> (<%= w.username %>)</th>
        <td data-testid="workload-value"><%= w.count %></td>
      </tr>
    <% }) %>
    </tbody>
  </table>
</section>

<script>
(function () {
  var form = document.getElementById('dash-filter');
  var ps = document.getElementById('period-select');
  var ss = document.getElementById('service-select');
  var xl = document.getElementById('export-xlsx-btn');
  var pd = document.getElementById('export-pdf-btn');
  var scope = document.getElementById('dash-scope');
  var seq = 0;
  function q() { return 'period=' + encodeURIComponent(ps.value) + '&service=' + encodeURIComponent(ss.value); }
  function set(id, v) { var el = document.querySelector('[data-testid="' + id + '"]'); if (el) el.textContent = String(v); }
  function load() {
    var qs = q();
    xl.href = '/api/dashboard/export?format=xlsx&' + qs;
    pd.href = '/api/dashboard/export?format=pdf&' + qs;
    if (window.history && history.replaceState) history.replaceState(null, '', '/dashboard?' + qs);
    scope.textContent = ps.options[ps.selectedIndex].text + ' · ' + ss.options[ss.selectedIndex].text;
    var my = ++seq;
    fetch('/api/dashboard?' + qs, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (my !== seq) return;
        set('kpi-received', d.received);
        set('kpi-closed', d.closed);
        set('kpi-ontime-pct', d.ontimePct == null ? '\\u2013' : Number(d.ontimePct).toFixed(1) + '%');
        set('kpi-backlog', d.backlog);
        set('kpi-overdue', d.overdue);
        (d.workload || []).forEach(function (w) {
          var row = document.querySelector('[data-testid="workload-row"][data-username="' + w.username + '"] [data-testid="workload-value"]');
          if (row) row.textContent = String(w.count);
        });
      })
      .catch(function () { if (my === seq) form.submit(); });
  }
  ps.addEventListener('change', load);
  ss.addEventListener('change', load);
  form.addEventListener('submit', function (e) { e.preventDefault(); load(); });
})();
</script>`;

async function renderPage(req: Request, res: Response, title: string, tpl: string, locals: Record<string, unknown>) {
  const data = { title, success: null, error: null, ...res.locals, user: req.user ?? null, bellCount: 0, ...locals };
  const body = ejs.render(tpl, data);
  res.render('layout', { ...data, body });
}

const exportHref = (format: 'xlsx' | 'pdf', period: string, service: string) =>
  `/api/dashboard/export?format=${format}&period=${encodeURIComponent(period)}&service=${encodeURIComponent(service)}`;

// ───────────────────────── Routes ─────────────────────────

const router = Router();

router.get('/dashboard', requireExecutive, ah(async (req, res) => {
  const at = now();
  const period = parsePeriod(req.query.period) ?? parsePeriod(currentPeriodKey(at))!;
  const service = parseService(req.query.service) ?? 'ALL';
  const s = await computeStats(period, service, at);
  await renderPage(req, res, 'Dashboard', DASHBOARD_TPL, {
    s, period, service,
    serviceLabel: SERVICE_LABEL[service],
    periods: periodOptions(period.key, at),
    services: SERVICE_FILTERS.map((id) => ({ id, label: SERVICE_LABEL[id] })),
    xlsxHref: exportHref('xlsx', period.key, service),
    pdfHref: exportHref('pdf', period.key, service),
  });
}));

/** อ่าน period/service จาก query · ไม่ระบุ period = เดือนปัจจุบัน · ไม่ระบุ service = ALL · ค่าผิด → 400 */
function readFilters(req: Request, res: Response): { period: Period; service: ServiceFilter } | null {
  const rawP = req.query.period;
  const period = rawP === undefined || rawP === '' ? parsePeriod(currentPeriodKey()) : parsePeriod(rawP);
  if (!period) { apiError(res, 400, 'INVALID_PERIOD', 'ช่วงเวลาไม่ถูกต้อง (YYYY-MM หรือ YYYY)'); return null; }
  const rawS = req.query.service;
  const service = rawS === undefined || rawS === '' ? 'ALL' : parseService(rawS);
  if (!service) { apiError(res, 400, 'INVALID_SERVICE', 'บริการไม่ถูกต้อง'); return null; }
  return { period, service };
}

router.get('/api/dashboard', requireExecutive, ah(async (req, res) => {
  const f = readFilters(req, res);
  if (!f) return;
  const s = await computeStats(f.period, f.service);
  res.json({
    received: s.received, closed: s.closed, onTime: s.onTime, ontimePct: s.ontimePct,
    backlog: s.backlog, overdue: s.overdue,
    workload: s.workload.map((w) => ({ username: w.username, count: w.count })),
  });
}));

router.get('/api/dashboard/export', requireExecutive, ah(async (req, res) => {
  const format = req.query.format;
  if (format !== 'xlsx' && format !== 'pdf') return void apiError(res, 400, 'INVALID_FORMAT', 'รูปแบบไฟล์ต้องเป็น xlsx หรือ pdf');
  const f = readFilters(req, res);
  if (!f) return;
  const s = await computeStats(f.period, f.service);
  const name = `dashboard-${f.period.key}-${f.service}.${format}`;
  const body = format === 'xlsx' ? await buildXlsx(s, f.period, f.service) : buildPdf(pdfLines(s, f.period, f.service));
  await audit({ username: req.user!.username, role: req.user!.role, event: 'EXPORT', detail: `${format} ${f.period.key} ${f.service}` });
  res.status(200).set({
    'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  }).send(body);
}));

export default router;

// ใช้ใน test หน่วย/บล็อกอื่นได้ (ไม่มี state)
export const _internal = { buildPdf, pdfLines, kpiCells, periodOptions };
