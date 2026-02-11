#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:${ADMIN_PANEL_PORT:-8787}}"
HEALTH_URL="${BASE_URL%/}/health"

echo "== MAX Contest Bot smoke check =="
echo "Base URL: ${BASE_URL}"

health_code="$(curl -sS -o /tmp/max-bot-health.txt -w "%{http_code}" "${HEALTH_URL}" || true)"
health_body="$(cat /tmp/max-bot-health.txt 2>/dev/null || true)"
rm -f /tmp/max-bot-health.txt
if [[ "${health_code}" != "200" || "${health_body}" != "ok" ]]; then
  echo "[FAIL] /health expected 200 + body 'ok', got code=${health_code}, body='${health_body}'"
  exit 1
fi
echo "[OK] /health"

if [[ -z "${ADMIN_PANEL_URL:-}" ]]; then
  echo "[SKIP] Signed admin endpoints: ADMIN_PANEL_URL is empty (panel disabled)"
  echo "Smoke check completed."
  exit 0
fi

if [[ -z "${OWNER_USER_ID:-}" ]]; then
  echo "[SKIP] Signed admin endpoints: OWNER_USER_ID is empty"
  echo "Smoke check completed."
  exit 0
fi

SECRET="${ADMIN_PANEL_SECRET:-${BOT_TOKEN:-}}"
if [[ -z "${SECRET}" ]]; then
  echo "[SKIP] Signed admin endpoints: neither ADMIN_PANEL_SECRET nor BOT_TOKEN set"
  echo "Smoke check completed."
  exit 0
fi

SIGNED_QUERY="$(node -e "const crypto=require('node:crypto');const uid=process.argv[1];const secret=process.argv[2];const ts=Date.now().toString();const sig=crypto.createHmac('sha256',secret).update(uid+':'+ts).digest('hex');process.stdout.write(new URLSearchParams({uid,ts,sig}).toString());" "${OWNER_USER_ID}" "${SECRET}")"

for endpoint in "/adminpanel/audit" "/adminpanel/metrics" "/adminpanel/alerts"; do
  code="$(curl -sS -o /tmp/max-bot-endpoint.txt -w "%{http_code}" "${BASE_URL%/}${endpoint}?${SIGNED_QUERY}" || true)"
  rm -f /tmp/max-bot-endpoint.txt
  if [[ "${code}" != "200" ]]; then
    echo "[FAIL] ${endpoint} expected 200, got ${code}"
    exit 1
  fi
  echo "[OK] ${endpoint}"
done

echo "Smoke check completed."
