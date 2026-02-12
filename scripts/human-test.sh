#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:${ADMIN_PANEL_PORT:-8787}}"
HEALTH_URL="${BASE_URL%/}/health"

echo "== MAX Human Test Prep =="
echo
echo "0) Preflight"
if ! curl -sS --connect-timeout 2 "${HEALTH_URL}" >/dev/null 2>&1; then
  echo "[FAIL] Бот не отвечает на ${HEALTH_URL}"
  echo "Запусти сначала: npm run dev"
  exit 1
fi
echo "[OK] Бот доступен: ${HEALTH_URL}"
echo

echo "1) Быстрые автопроверки"
npm run smoke
echo
echo "2) Готовим ссылку админки (если настроена)"
bash scripts/admin-url.sh || true
echo
echo "3) Визуальный чеклист"
echo "Открой файл: scripts/MAX-VISUAL-TESTS.md"
echo
echo "4) Runtime snapshot"
echo "curl -s ${BASE_URL%/}/health"
echo "curl -s ${BASE_URL%/}/health/ready"
echo
echo "5) Короткий маршрут в MAX"
echo "  /start"
echo "  /help"
echo "  /wizard"
echo "  /status"
echo
echo "Done. Переходи к ручному кликовому прогону."
