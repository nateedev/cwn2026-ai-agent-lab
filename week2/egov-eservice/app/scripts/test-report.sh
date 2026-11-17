#!/bin/bash
# ขั้น 4: รัน Playwright ชุดเต็ม (TEST_MODE=1, ไม่ตั้ง BUG_MODE) แล้วสร้าง test-report/
#   results.json · index.html (Playwright HTML report) · gif/<TC>.gif ของ TC ระดับ P1
# ใช้: scripts/test-report.sh   (ต้องมี docker compose และ Chromium ของ Playwright)
set -u
cd "$(dirname "$0")/.."
OUT=test-report
if [ "${GIFONLY:-}" != "1" ]; then
rm -rf "$OUT" test-results && mkdir -p "$OUT/gif"
export BASE_URL=${BASE_URL:-http://localhost:3000}
export DB_DUMP_CMD=${DB_DUMP_CMD:-"docker compose exec -T db pg_dump -U egov egov"}
export WEB_LOG_CMD=${WEB_LOG_CMD:-"docker compose logs --no-color web"}
export ENC_METHOD=${ENC_METHOD:-"AES-256-GCM (src/lib/crypto.ts)"}

TEST_MODE=1 BUG_MODE= docker compose up -d --build --wait >/dev/null
VIDEO=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/results.json" PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/html" PLAYWRIGHT_HTML_OPEN=never \
  npx playwright test --reporter=json,html,line
RC=$?
cp -r "$OUT/html/." "$OUT/" && rm -rf "$OUT/html"
else RC=0; mkdir -p "$OUT/gif"; fi

# GIF ของ TC ระดับ P1 (รายชื่อจากตารางสรุปใน TEST-PLAN.md) · ต้องมี ffmpeg (apt-get install -y ffmpeg) · NOGIF=1 = ข้าม
[ "${NOGIF:-}" = "1" ] && exit $RC
P1="${P1_LIST:-$(cat scripts/p1-list.txt)}"
for TC in $P1; do
  DIR=$(ls -d test-results/*-"$TC"-* 2>/dev/null | head -1)
  VID=$(ls -S "$DIR"/*.webm 2>/dev/null | head -1)   # หลาย context → ใช้วิดีโอที่ใหญ่สุด
  [ -z "$VID" ] && { echo "ไม่มีวิดีโอ $TC"; continue; }
  ffmpeg -loglevel error -y -i "$VID" \
    -vf "fps=4,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse" \
    "$OUT/gif/$TC.gif"
done
echo "GIF: $(ls $OUT/gif | wc -l) ไฟล์ · exit $RC"
exit $RC
