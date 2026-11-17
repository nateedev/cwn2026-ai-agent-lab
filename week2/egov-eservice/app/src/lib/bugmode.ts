// BUG_MODE=B03,B07 → isBug('B03') === true (ไม่ตั้ง = เว็บถูกต้อง 100%) · อ่านทุกครั้ง ไม่ cache
export function activeBugs(): string[] {
  return (process.env.BUG_MODE ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
export function isBug(code: string): boolean {
  return activeBugs().includes(code.toUpperCase());
}
