// สร้างไฟล์ทดสอบอัปโหลดตาม TEST-DATA ข้อ 11 → fixtures/testfiles/  (รัน: node fixtures/make-testfiles.mjs [outDir])
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import zlib from 'node:zlib';

const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'testfiles');
mkdirSync(out, { recursive: true });
const crc = crc32 ?? ((b) => { let c, t = [], r = 0xffffffff; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; });

const pdf = (n) => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
};
const chunk = (t, d) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td) >>> 0);
  return Buffer.concat([len, td, c]);
};
const png = (n) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0])))]);
  const iend = chunk('IEND', Buffer.alloc(0));
  const pad = n - head.length - iend.length - 12;
  return Buffer.concat([head, chunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(pad - 2, 0x78)])), iend]);
};
const jpg = (n) => {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const com = Buffer.alloc(4); com[0] = 0xff; com[1] = 0xfe; com.writeUInt16BE(pad + 2, 2);
  return Buffer.concat([soi, app0, com, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
};
const w = (name, data) => writeFileSync(join(out, name), data);

for (const n of ['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf', ...[1, 2, 3, 4, 5, 6].map((i) => `multi-${i}.pdf`)]) w(n, pdf(1024));
w('real.jpg', jpg(1024)); w('real.png', png(1024)); w('plan-as-jpg.jpg', jpg(1024));
for (const n of [5242879, 5242880, 5242881]) w(`size-${n}.pdf`, pdf(n));
w('fake-text.pdf', 'hello'); w('fake-text.jpg', 'hello'); w('notes.txt', 'hello');
w('exe-as.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1022)]));
for (const f of readdirSync(out).sort()) console.log(f, statSync(join(out, f)).size);
