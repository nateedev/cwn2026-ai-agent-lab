// สรุปผล JSON ของ Playwright: node scripts/summarize.mjs <result.json>
// พิมพ์: passed/failed และรายการ TC ที่ล้มพร้อมบรรทัดแรกของข้อความ assert
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
const walk = (s) => { for (const sp of s.specs ?? []) out.push(sp); for (const c of s.suites ?? []) walk(c); };
for (const s of r.suites) walk(s);
let pass = 0; const fail = [];
for (const sp of out) {
  const res = sp.tests.flatMap((t) => t.results);
  const ok = sp.ok && res.every((x) => x.status === 'passed');
  const id = (sp.title.match(/TC-[A-Z]+-\d+/) ?? [sp.title])[0];
  if (ok) pass++;
  else {
    const err = res.flatMap((x) => x.errors ?? []).map((e) => (e.message ?? '').replace(/\x1b\[[0-9;]*m/g, ''))[0] ?? res.map((x) => x.status).join(',');
    const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
    const brief = lines.filter((l) => /^(Error|Expected|Received|-|\+)/.test(l)).slice(0, 6).join(' | ') || lines.slice(0, 3).join(' | ');
    fail.push({ id, brief: brief.slice(0, 400) });
  }
}
console.log(JSON.stringify({ total: out.length, passed: pass, failed: fail.map((f) => f.id), details: fail }, null, 1));
