# Smoke Checklist (manual + script)

## Pre-check

- [ ] `.env` содержит `BOT_TOKEN`, `OWNER_USER_ID`
- [ ] бот запущен (`npm run dev` или docker compose)
- [ ] `npm run test` проходит

## Automated check

- [ ] `npm run smoke` завершился без ошибок

## Manual MAX check

- [ ] `/start` отвечает
- [ ] `/help` показывает онбординг
- [ ] `/myrole` показывает корректную роль
- [ ] `/newcontest ...` создает конкурс
- [ ] `/draw contest_id` работает для owner/admin
- [ ] `/adminpanel` открывает подписанную ссылку для owner/admin
