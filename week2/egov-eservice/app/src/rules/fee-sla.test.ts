// unit test ของ src/rules/fee-sla.ts · รัน: npx tsx --test src/rules/fee-sla.test.ts
// ค่าขอบทั้งหมดมาจาก REQUIREMENTS BR-04/05/12/13/14/20/25 · DECISIONS ข้อ 8 · TEST-PLAN TC-FEE-01 TC-SLA-01..03 TC-DASH-04 · BUGS B01 B03 B04
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toIso } from '../lib/clock.ts';
import {
  calcFee, computeDueAt, slaStartDay, extendDueAtForFix, pausedWorkingDays, remainingWorkingDays,
  slaLevel, isOnTime, onTimePct, isWorkingDay, addWorkingDays, countWorkingDays, fixDeadline,
  isFixWindowExpired, SLA_LEVEL_TEXT, toInt,
} from './fee-sla.ts';

const HOL = new Set(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
const t = (s: string) => new Date(s.length === 16 ? `${s}:00+07:00` : `${s}+07:00`); // 'YYYY-MM-DDTHH:MM[:SS]'
const iso = (d: Date) => toIso(d);
const withBug = (code: string, fn: () => void) => {
  const prev = process.env.BUG_MODE;
  process.env.BUG_MODE = code;
  try { fn(); } finally { if (prev === undefined) delete process.env.BUG_MODE; else process.env.BUG_MODE = prev; }
};
afterEach(() => { delete process.env.BUG_MODE; });

describe('BR-04 SV-01 ค่าธรรมเนียม ฿20 ต่อฉบับ 1–5', () => {
  test('ค่าขอบ 0/1/5/6', () => {
    assert.deepEqual(calcFee('SV-01', { qty: 0 }), { ok: false, status: 400, code: 'INVALID_QTY', message: 'จำนวนฉบับต้อง 1–5 ฉบับ' });
    assert.deepEqual(calcFee('SV-01', { qty: 1 }), { ok: true, fee: 20 });
    assert.deepEqual(calcFee('SV-01', { qty: 5 }), { ok: true, fee: 100 });
    assert.equal(calcFee('SV-01', { qty: 6 }).ok, false);
    assert.equal((calcFee('SV-01', { qty: 6 }) as any).message, 'จำนวนฉบับต้อง 1–5 ฉบับ');
  });
  test('ค่าจากฟอร์มเป็นสตริง / ไม่ใช่จำนวนเต็ม', () => {
    assert.deepEqual(calcFee('SV-01', { qty: '3' }), { ok: true, fee: 60 });
    for (const q of ['', 'abc', '1.5', 2.5, null, undefined, -1]) assert.equal((calcFee('SV-01', { qty: q }) as any).code, 'INVALID_QTY');
  });
  test('admin แก้ค่าธรรมเนียม', () => {
    assert.deepEqual(calcFee('SV-01', { qty: 2 }, { fee: 30 }), { ok: true, fee: 60 });
  });
});

describe('BR-05 SV-02 ฿500 คงที่ · SV-03 ตามพื้นที่', () => {
  test('SV-02', () => {
    assert.deepEqual(calcFee('SV-02', {}), { ok: true, fee: 500 });
    assert.deepEqual(calcFee('SV-02', {}, { fee: 600 }), { ok: true, fee: 600 });
  });
  test('SV-03 ตาราง TC-FEE-01', () => {
    const ok: [number, number][] = [[1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500], [300, 3000], [499, 4990], [500, 5000]];
    for (const [a, fee] of ok) assert.deepEqual(calcFee('SV-03', { area: a }), { ok: true, fee }, `area ${a}`);
    for (const a of [0, -1, '', 'x', 100.5]) {
      assert.deepEqual(calcFee('SV-03', { area: a }), { ok: false, status: 400, code: 'INVALID_AREA', message: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' }, `area ${a}`);
    }
    assert.deepEqual(calcFee('SV-03', { area: 501 }), { ok: false, status: 400, code: 'AREA_TOO_LARGE', message: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' });
    assert.deepEqual(calcFee('SV-03', { area: '101' }), { ok: true, fee: 1010 });
  });
  test('บริการไม่รู้จัก', () => {
    assert.equal((calcFee('SV-09', {}) as any).code, 'INVALID_SERVICE');
  });
  test('BUG_MODE=B01: 101 → ฿1,000 · 102 ยัง ฿1,020', () => withBug('B01', () => {
    assert.deepEqual(calcFee('SV-03', { area: 101 }), { ok: true, fee: 1000 });
    assert.deepEqual(calcFee('SV-03', { area: 102 }), { ok: true, fee: 1020 });
    assert.deepEqual(calcFee('SV-03', { area: 100 }), { ok: true, fee: 1000 });
  }));
  test('toInt', () => {
    assert.equal(toInt(' 12 '), 12);
    assert.equal(toInt('1e2'), null);
    assert.equal(toInt(true), null);
  });
});

describe('ปฏิทินวันทำการ', () => {
  test('เสาร์-อาทิตย์และวันหยุดไม่ใช่วันทำการ', () => {
    assert.equal(isWorkingDay('2026-12-01', HOL), true);
    assert.equal(isWorkingDay('2026-12-05', HOL), false);
    assert.equal(isWorkingDay('2026-12-06', HOL), false);
    assert.equal(isWorkingDay('2026-12-07', HOL), false);
    assert.equal(isWorkingDay('2026-12-07', []), true);
  });
  test('addWorkingDays / countWorkingDays', () => {
    assert.equal(addWorkingDays('2026-12-04', 1, HOL), '2026-12-08');
    assert.equal(addWorkingDays('2026-12-04', 0, HOL), '2026-12-04');
    assert.equal(countWorkingDays('2026-12-04', '2026-12-08', HOL), 1);
    assert.equal(countWorkingDays('2026-12-02', '2026-12-02', HOL), 0);
    assert.equal(countWorkingDays('2026-12-08', '2026-12-04', HOL), 0);
  });
});

describe('BR-12 กำหนดเสร็จ (TC-SLA-01)', () => {
  const rows: [string, string, number, string][] = [
    ['a', '2026-12-01T09:00', 3, '2026-12-04T16:30:00+07:00'],
    ['b', '2026-12-01T16:29', 3, '2026-12-04T16:30:00+07:00'],
    ['b2', '2026-12-01T16:29:59', 3, '2026-12-04T16:30:00+07:00'],
    ['c', '2026-12-01T16:30', 3, '2026-12-08T16:30:00+07:00'],
    ['c2', '2026-12-01T16:30:00', 3, '2026-12-08T16:30:00+07:00'],
    ['d', '2026-12-04T10:00', 3, '2026-12-11T16:30:00+07:00'],
    ['e', '2026-12-05T10:00', 3, '2026-12-14T16:30:00+07:00'],
    ['f', '2026-12-01T09:00', 10, '2026-12-17T16:30:00+07:00'],
    ['g', '2026-12-01T09:00', 15, '2026-12-24T16:30:00+07:00'],
    ['h', '2026-12-29T10:00', 3, '2027-01-05T16:30:00+07:00'],
    ['i', '2026-12-31T23:59', 3, '2027-01-07T16:30:00+07:00'],
  ];
  for (const [name, paid, n, due] of rows) {
    test(`แถว ${name}: ชำระ ${paid} SLA ${n} → ${due}`, () => assert.equal(iso(computeDueAt(t(paid), n, HOL)), due));
  }
  test('D0', () => {
    assert.equal(slaStartDay(t('2026-12-01T16:29:59'), HOL), '2026-12-01');
    assert.equal(slaStartDay(t('2026-12-01T16:30:00'), HOL), '2026-12-02');
    assert.equal(slaStartDay(t('2026-12-05T10:00'), HOL), '2026-12-08');
    assert.equal(slaStartDay(t('2026-12-31T23:59'), HOL), '2027-01-04');
    assert.equal(slaStartDay(t('2026-12-07T09:00'), HOL), '2026-12-08'); // วันหยุด ก่อนตัดรอบ
  });
  test('ใช้ตารางวันหยุดที่ส่งเข้ามา (เพิ่มวันหยุด 2 ธ.ค.)', () => {
    const h = new Set([...HOL, '2026-12-02']);
    assert.equal(iso(computeDueAt(t('2026-12-01T09:00'), 3, h)), '2026-12-08T16:30:00+07:00');
  });
  test('BUG_MODE=B03: ข้ามแค่ ส-อา (ตาราง BUGS)', () => withBug('B03', () => {
    assert.equal(iso(computeDueAt(t('2026-12-01T16:30'), 3, HOL)), '2026-12-07T16:30:00+07:00');
    assert.equal(iso(computeDueAt(t('2026-12-04T10:00'), 3, HOL)), '2026-12-09T16:30:00+07:00');
    assert.equal(iso(computeDueAt(t('2026-12-05T10:00'), 3, HOL)), '2026-12-10T16:30:00+07:00');
    assert.equal(iso(computeDueAt(t('2026-12-29T10:00'), 3, HOL)), '2027-01-01T16:30:00+07:00');
    assert.equal(iso(computeDueAt(t('2026-12-31T23:59'), 3, HOL)), '2027-01-06T16:30:00+07:00');
    assert.equal(iso(computeDueAt(t('2026-12-01T09:00'), 3, HOL)), '2026-12-04T16:30:00+07:00'); // ไม่คร่อมวันหยุด ยังถูก
  }));
});

describe('BR-13 หยุดนับระหว่าง NEED_FIX (TC-SLA-02)', () => {
  const due4 = t('2026-12-04T16:30');
  test('ส่วน 1: ตีกลับ พ.2 11:00 ส่งแก้ พฤ.3 10:00 → อ.8', () => {
    assert.equal(pausedWorkingDays(t('2026-12-02T11:00'), t('2026-12-03T10:00'), HOL), 1);
    assert.equal(iso(extendDueAtForFix(due4, t('2026-12-02T11:00'), t('2026-12-03T10:00'), HOL)), '2026-12-08T16:30:00+07:00');
  });
  test('ส่วน 2/3: seed …000017 กำหนด 27 พ.ย. ตีกลับ 27 พ.ย.', () => {
    const due = t('2026-11-27T16:30');
    const ret = t('2026-11-27T10:00');
    assert.equal(iso(extendDueAtForFix(due, ret, t('2026-12-01T09:00'), HOL)), '2026-12-01T16:30:00+07:00');
    assert.equal(iso(extendDueAtForFix(due, ret, t('2026-12-04T10:00'), HOL)), '2026-12-04T16:30:00+07:00');
  });
  test('ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน → หยุด 0', () => {
    assert.equal(iso(extendDueAtForFix(due4, t('2026-12-02T09:00'), t('2026-12-02T15:00'), HOL)), '2026-12-04T16:30:00+07:00');
  });
  test('ส่วน 5: ตีกลับ ศ.4 ส่งแก้ อ.8 17:00 → หยุด 1 → อ.8 16:30 และเกินกำหนดทันที', () => {
    const at = t('2026-12-08T17:00');
    assert.equal(pausedWorkingDays(t('2026-12-04T10:00'), at, HOL), 1);
    const nd = extendDueAtForFix(due4, t('2026-12-04T10:00'), at, HOL);
    assert.equal(iso(nd), '2026-12-08T16:30:00+07:00');
    assert.equal(slaLevel({ status: 'IN_REVIEW', dueAt: nd }, HOL, at), 'overdue');
  });
  test('BUG_MODE=B04: ไม่หยุดนับ', () => withBug('B04', () => {
    assert.equal(iso(extendDueAtForFix(due4, t('2026-12-02T11:00'), t('2026-12-03T10:00'), HOL)), '2026-12-04T16:30:00+07:00');
    assert.equal(iso(extendDueAtForFix(t('2026-11-27T16:30'), t('2026-11-27T10:00'), t('2026-12-01T09:00'), HOL)), '2026-11-27T16:30:00+07:00');
  }));
  test('BUG_MODE=B03: หยุดนับแถว 6 ได้ 7 ธ.ค.', () => withBug('B03', () => {
    assert.equal(iso(extendDueAtForFix(due4, t('2026-12-02T11:00'), t('2026-12-03T10:00'), HOL)), '2026-12-07T16:30:00+07:00');
  }));
});

describe('BR-20 เวลาแก้ไข 168 ชม.', () => {
  test('167:59 ส่งได้ · 168:00 หมดเวลา', () => {
    const ret = t('2026-11-27T14:00');
    assert.equal(iso(fixDeadline(ret)), '2026-12-04T14:00:00+07:00');
    assert.equal(isFixWindowExpired(ret, t('2026-12-04T13:59')), false);
    assert.equal(isFixWindowExpired(ret, t('2026-12-04T14:00')), true);
    assert.equal(iso(fixDeadline(t('2026-12-02T11:00'))), '2026-12-09T11:00:00+07:00');
  });
});

describe('BR-14 ระดับเตือน (TC-SLA-03)', () => {
  const lvl = (due: string, at: string, status = 'IN_REVIEW') => slaLevel({ status, dueAt: t(due) }, HOL, t(at));
  test('ส่วน A: กำหนด ศ.4 16:30', () => {
    const due = '2026-12-04T16:30';
    assert.equal(remainingWorkingDays(t(due), HOL, t('2026-12-01T09:00')), 3);
    assert.equal(lvl(due, '2026-12-01T09:00'), 'normal');
    assert.equal(remainingWorkingDays(t(due), HOL, t('2026-12-02T09:00')), 2);
    assert.equal(lvl(due, '2026-12-02T09:00'), 'normal');
    assert.equal(lvl(due, '2026-12-03T09:00'), 'near');
    assert.equal(remainingWorkingDays(t(due), HOL, t('2026-12-04T16:30:00')), 0);
    assert.equal(lvl(due, '2026-12-04T16:30:00'), 'near');
    assert.equal(lvl(due, '2026-12-04T16:30:01'), 'overdue');
    assert.equal(lvl(due, '2026-12-04T16:31'), 'overdue');
    assert.equal(lvl(due, '2026-12-05T10:00'), 'overdue');
  });
  test('ส่วน B: กำหนด อ.8 16:30 (คร่อม ส-อา และ จ.7)', () => {
    const due = '2026-12-08T16:30';
    assert.equal(remainingWorkingDays(t(due), HOL, t('2026-12-03T09:00')), 2);
    assert.equal(lvl(due, '2026-12-03T09:00'), 'normal');
    assert.equal(lvl(due, '2026-12-04T09:00'), 'near');
    assert.equal(lvl(due, '2026-12-08T16:30:00'), 'near');
    assert.equal(lvl(due, '2026-12-08T16:31'), 'overdue');
  });
  test('ส่วน C: seed ที่ 1 ธ.ค. 09:00', () => {
    const at = '2026-12-01T09:00';
    assert.equal(lvl('2026-11-30T16:30', at), 'overdue');
    assert.equal(lvl('2026-12-01T16:30', at), 'near');
    assert.equal(lvl('2026-12-02T16:30', at), 'near');
    assert.equal(lvl('2026-12-03T16:30', at), 'normal');
    assert.equal(lvl('2026-11-27T16:30', at, 'NEED_FIX'), 'paused');
    for (const s of ['COMPLETED', 'REJECTED', 'CANCELLED']) assert.equal(lvl('2026-11-27T16:30', at, s), 'closed');
  });
  test('ข้อความ CONTRACT §4.2 และ dueAt เป็นสตริง/null', () => {
    assert.deepEqual(SLA_LEVEL_TEXT, { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' });
    assert.equal(slaLevel({ status: 'SUBMITTED', dueAt: '2026-12-04T16:30:00+07:00' }, HOL, t('2026-12-03T09:00')), 'near');
    assert.equal(slaLevel({ status: 'SUBMITTED', dueAt: null }, HOL, t('2026-12-03T09:00')), null);
  });
  test('BUG_MODE=B03: ศ.4 09:00 กำหนด อ.8 → ปกติ (นับ จ.7)', () => withBug('B03', () => {
    assert.equal(lvl('2026-12-08T16:30', '2026-12-04T09:00'), 'normal');
  }));
});

describe('BR-25 ทันกำหนด (TC-DASH-04)', () => {
  test('16:29:59 ทัน · 16:30:00 ทัน · 16:30:01 ไม่ทัน · 16:31 ไม่ทัน', () => {
    const due = t('2026-12-03T16:30');
    assert.equal(isOnTime(t('2026-12-03T16:29:59'), due), true);
    assert.equal(isOnTime(t('2026-12-03T16:30:00'), due), true);
    assert.equal(isOnTime(t('2026-12-03T16:30:01'), due), false);
    assert.equal(isOnTime('2026-12-03T16:31:00+07:00', '2026-12-03T16:30:00+07:00'), false);
  });
  test('ทันกำหนด % ปัดครึ่งขึ้น', () => {
    assert.equal(onTimePct(0, 0), '–');
    assert.equal(onTimePct(6, 7), '85.7%');
    assert.equal(onTimePct(2, 3), '66.7%');
    assert.equal(onTimePct(1, 1), '100.0%');
    assert.equal(onTimePct(7, 8), '87.5%');
    assert.equal(onTimePct(1, 16), '6.3%'); // 6.25 → 6.3 (ครึ่งขึ้น)
    assert.equal(onTimePct(0, 3), '0.0%');
  });
});
