#!/usr/bin/env bash
set -euo pipefail

echo "== Local E2E Demo =="
echo
echo "Step 0: build+tests"
npm run test
echo

echo "Step 1: smoke checks"
npm run smoke
echo

echo "Step 1.1: readiness snapshot"
echo "  curl -s http://127.0.0.1:${ADMIN_PANEL_PORT:-8787}/health/ready"
echo "  Проверка: status=ready, panelEnabled=true/false, storage counters >= 0"
echo

echo "Step 2: generate signed admin URL for browser test"
bash scripts/admin-url.sh
echo

echo "Step 3: in MAX run"
echo "  /start"
echo "  /help"
echo "  /status"
echo "  /myrole"
echo "Then use buttons: 'Что дальше' -> 'Шаблоны' -> 'Конкурсы'."
