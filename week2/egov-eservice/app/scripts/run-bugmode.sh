#!/bin/bash
# รันชุด Playwright เต็มกับเว็บใน docker compose ทีละ BUG_MODE
# ใช้: scripts/run-bugmode.sh "" B01 B02 ... "B03,B07"   (ค่าว่าง = เว็บถูกต้อง)
# ผล: test-runs/<mode>.json + test-runs/<mode>.summary.json
cd "$(dirname "$0")/.."
mkdir -p test-runs
export BASE_URL=${BASE_URL:-http://localhost:3000}
export DB_DUMP_CMD=${DB_DUMP_CMD:-"docker compose exec -T db pg_dump -U egov egov"}
export WEB_LOG_CMD=${WEB_LOG_CMD:-"docker compose logs --no-color web"}
for MODE in "$@"; do
  NAME=${MODE:-none}; NAME=${NAME//,/+}
  if [ "${NORESTART:-}" != "1" ]; then
    TEST_MODE=1 BUG_MODE="$MODE" docker compose up -d web >/dev/null 2>&1
    sleep 2
    for i in $(seq 1 120); do curl -sf "$BASE_URL/api/health" >/dev/null && break; sleep 1; done
  fi
  echo "== BUG_MODE=$MODE : $(docker compose logs --no-color web | grep 'listening' | tail -1)"
  PLAYWRIGHT_JSON_OUTPUT_NAME="test-runs/$NAME${SUFFIX:-}.json" npx playwright test --reporter=json >/dev/null 2>&1
  node scripts/summarize.mjs "test-runs/$NAME${SUFFIX:-}.json" > "test-runs/$NAME${SUFFIX:-}.summary.json"
  node -e "const s=require('./test-runs/$NAME${SUFFIX:-}.summary.json');console.log('   ',s.passed+'/'+s.total,'passed · failed:',s.failed.join(' ')||'-')"
done
