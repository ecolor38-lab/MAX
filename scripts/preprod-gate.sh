#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

BASE_URL="${1:-http://127.0.0.1:${ADMIN_PANEL_PORT:-8787}}"
REPORT_TS="$(date +%Y%m%d-%H%M%S)"
REPORT_PATH="data/preprod-gate-${REPORT_TS}.report.txt"
mkdir -p data

ok() {
  echo "[OK] $1"
}

fail() {
  echo "[FAIL] $1"
  echo "NO-GO"
  exit 1
}

step() {
  echo
  echo "== $1 =="
}

step "MAX Contest Bot — PRE-PROD GATE"
echo "Base URL: ${BASE_URL}"
echo "Report: ${REPORT_PATH}"

if [[ ! -f ".env" ]]; then
  fail ".env not found. Create it from .env.example first."
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

step "1) Required env and security policy"

[[ -n "${BOT_TOKEN:-}" ]] || fail "BOT_TOKEN is empty."
ok "BOT_TOKEN set"

[[ -n "${OWNER_USER_ID:-}" ]] || fail "OWNER_USER_ID is empty."
ok "OWNER_USER_ID set"

[[ -n "${ADMIN_USER_IDS:-}" ]] || fail "ADMIN_USER_IDS is empty."
ok "ADMIN_USER_IDS set"

[[ -n "${ADMIN_PANEL_SECRET:-}" ]] || fail "ADMIN_PANEL_SECRET is empty (must not fallback to BOT_TOKEN in pre-prod gate)."
ok "ADMIN_PANEL_SECRET set"

[[ -n "${ADMIN_PANEL_URL:-}" ]] || fail "ADMIN_PANEL_URL is empty."
ok "ADMIN_PANEL_URL set"

if [[ ! "${ADMIN_PANEL_URL}" =~ ^https:// ]]; then
  fail "ADMIN_PANEL_URL must be https:// for production UX in MAX."
fi
ok "ADMIN_PANEL_URL uses https"

if [[ "${ADMIN_PANEL_URL}" =~ localhost|127\.0\.0\.1|::1 ]]; then
  fail "ADMIN_PANEL_URL must be public, not localhost."
fi
ok "ADMIN_PANEL_URL looks public"

if [[ "${ADMIN_PANEL_TOKEN_TTL_MS:-0}" -lt 300000 || "${ADMIN_PANEL_TOKEN_TTL_MS:-0}" -gt 900000 ]]; then
  fail "ADMIN_PANEL_TOKEN_TTL_MS must be within 300000..900000 (5..15 minutes)."
fi
ok "ADMIN_PANEL_TOKEN_TTL_MS in secure range"

if [[ "${ADMIN_PANEL_RATE_LIMIT_WINDOW_MS:-0}" -le 0 || "${ADMIN_PANEL_RATE_LIMIT_MAX:-0}" -le 0 ]]; then
  fail "ADMIN_PANEL_RATE_LIMIT_WINDOW_MS and ADMIN_PANEL_RATE_LIMIT_MAX must be positive."
fi
ok "Rate-limit settings enabled"

step "2) Static checks"
npm run type-check >/dev/null
ok "type-check passed"

npm run test >/dev/null
ok "tests passed"

step "3) Runtime readiness"
health="$(curl -sS "${BASE_URL%/}/health" || true)"
[[ "${health}" == "ok" ]] || fail "Health endpoint failed at ${BASE_URL%/}/health. Start bot first (npm run dev or docker compose up -d)."
ok "/health is ok"

ready="$(curl -sS "${BASE_URL%/}/health/ready" || true)"
echo "${ready}" | rg -q '"status"\s*:\s*"ready"' || fail "/health/ready does not report status=ready."
ok "/health/ready is ready"

step "4) Smoke checks (signed endpoints included)"
bash scripts/smoke.sh "${BASE_URL}" >/dev/null
ok "smoke passed"

step "5) Documentation consistency checks"
if rg -n "/economics" README.md HOW_TO_USE_BOT_STEP_BY_STEP.md scripts/MAX-VISUAL-TESTS.md >/dev/null; then
  fail "Removed command /economics found in active user docs."
fi
ok "No stale /economics in active docs"

if ! rg -n "preprod:gate" README.md >/dev/null; then
  fail "README does not mention preprod gate command."
fi
ok "README references preprod gate"

step "6) Git cleanliness"
if [[ -n "$(git status --short)" ]]; then
  fail "Working tree is dirty. Commit all changes before deployment."
fi
ok "Working tree is clean"

{
  echo "PRE-PROD GATE REPORT"
  echo "timestamp=${REPORT_TS}"
  echo "base_url=${BASE_URL}"
  echo "result=GO"
} >"${REPORT_PATH}"

step "RESULT"
echo "GO"
echo "Pre-prod gate passed. Safe to deploy."
