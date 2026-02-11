#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if [[ -z "${ADMIN_PANEL_URL:-}" ]]; then
  echo "ADMIN_PANEL_URL is empty. Set it in .env first."
  exit 1
fi

if [[ -z "${OWNER_USER_ID:-}" ]]; then
  echo "OWNER_USER_ID is empty. Set it in .env first."
  exit 1
fi

SECRET="${ADMIN_PANEL_SECRET:-${BOT_TOKEN:-}}"
if [[ -z "${SECRET}" ]]; then
  echo "Neither ADMIN_PANEL_SECRET nor BOT_TOKEN is set."
  exit 1
fi

SIGNED_URL="$(node -e "const crypto=require('node:crypto');const base=process.argv[1];const uid=process.argv[2];const secret=process.argv[3];const ts=Date.now().toString();const sig=crypto.createHmac('sha256',secret).update(uid+':'+ts).digest('hex');const u=new URL(base);u.searchParams.set('uid',uid);u.searchParams.set('ts',ts);u.searchParams.set('sig',sig);process.stdout.write(u.toString());" "${ADMIN_PANEL_URL}" "${OWNER_USER_ID}" "${SECRET}")"

echo "Signed admin URL:"
echo "${SIGNED_URL}"
echo
echo "Local browser test:"
echo "1) Ensure bot is running: npm run dev"
echo "2) Open URL above in your browser"
echo "3) Verify /health: curl -sS http://127.0.0.1:${ADMIN_PANEL_PORT:-8787}/health"
