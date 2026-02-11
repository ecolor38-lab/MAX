#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

PORT="${ADMIN_PANEL_PORT:-8787}"
TOKEN="${NGROK_AUTHTOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "NGROK_AUTHTOKEN is empty."
  echo "Add it to .env as:"
  echo "NGROK_AUTHTOKEN=your_token"
  echo
  echo "Get token: https://dashboard.ngrok.com/get-started/your-authtoken"
  exit 1
fi

echo "Starting ngrok tunnel on port ${PORT}..."
ngrok http "http://127.0.0.1:${PORT}" --authtoken "$TOKEN" --log=stdout > .ngrok.log 2>&1 &
NGROK_PID=$!
echo "ngrok pid=${NGROK_PID}"

PUBLIC_URL=""
for _ in $(seq 1 25); do
  sleep 1
  API_JSON="$(curl -sS "http://127.0.0.1:4040/api/tunnels" || true)"
  if [[ -n "$API_JSON" ]]; then
    PUBLIC_URL="$(node -e "const d=JSON.parse(process.argv[1]||'{}');const t=(d.tunnels||[]).find(x=>typeof x.public_url==='string'&&x.public_url.startsWith('https://'));if(t)process.stdout.write(t.public_url);" "$API_JSON" || true)"
    if [[ -n "$PUBLIC_URL" ]]; then
      break
    fi
  fi
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "Could not get ngrok public URL."
  echo "Inspect logs: .ngrok.log"
  echo "Stop tunnel: kill ${NGROK_PID}"
  exit 1
fi

ADMIN_URL="${PUBLIC_URL}/adminpanel"
echo "Public admin URL: ${ADMIN_URL}"

node -e "
const fs=require('node:fs');
const path='.env';
let text=fs.readFileSync(path,'utf8');
const line='ADMIN_PANEL_URL=${ADMIN_URL}';
if(/^ADMIN_PANEL_URL=.*$/m.test(text)){text=text.replace(/^ADMIN_PANEL_URL=.*$/m,line);}
else{text=text.trimEnd()+'\\n'+line+'\\n';}
if(/^NGROK_AUTHTOKEN=.*$/m.test(text)){} else {text=text.trimEnd()+'\\nNGROK_AUTHTOKEN=${TOKEN}\\n';}
fs.writeFileSync(path,text,'utf8');
"

echo
echo "Updated .env:"
echo "ADMIN_PANEL_URL=${ADMIN_URL}"
echo
echo "Next:"
echo "1) Restart bot: npm run dev"
echo "2) In MAX press /adminpanel (button will open public URL)"
echo "3) Stop tunnel later: kill ${NGROK_PID}"
