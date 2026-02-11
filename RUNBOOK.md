# RUNBOOK — MAX Contest Bot

Короткий операционный гайд для поддержки продового инстанса.

## 1) Старт и проверка

1. Убедитесь, что `.env` заполнен (`BOT_TOKEN`, `OWNER_USER_ID`).
2. Запустите сервис:
   - локально: `npm run dev`
   - docker: `docker compose up -d --build`
3. Проверьте живость:
   - `curl -sS http://127.0.0.1:8787/health`
   - ожидаемый ответ: `ok`
4. Проверьте в MAX:
   - `/start`
   - `/myrole`

## 2) Логи и диагностика

- Файл логов: `data/bot.log` (JSONL).
- Docker-логи: `docker compose logs -f`.
- Базовые события:
  - `bot_started`
  - `admin_panel_started`
  - `shutdown_started` / `shutdown_completed`
  - `admin_panel_server_error`

## 3) Частые проблемы

- **Бот не отвечает на `/start`**
  - проверьте, что процесс запущен;
  - проверьте токен `BOT_TOKEN`;
  - проверьте runtime-ошибки в логах.

- **Админ-команды не работают**
  - проверьте `OWNER_USER_ID` и `ADMIN_USER_IDS`;
  - убедитесь, что ID совпадает с вашим `user_id` в MAX.

- **Падает при старте с `EADDRINUSE`**
  - занятый порт `ADMIN_PANEL_PORT`;
  - освободите порт или смените порт в `.env`.

## 4) Рестарт/остановка

- Локально: `Ctrl+C` (включен graceful shutdown).
- Docker:
  - мягкий рестарт: `docker compose restart`
  - полная перезагрузка: `docker compose down && docker compose up -d --build`

## 5) Бэкап

- SQLite: `data/contests.db`
- JSON (legacy): `data/*.json`
- Рекомендуется регулярный snapshot каталога `data/`.

## 6) Мини smoke-checklist

- [ ] `npm run test` проходит
- [ ] `/health` возвращает `ok`
- [ ] `/start` отвечает
- [ ] `/myrole` корректен
- [ ] `/adminpanel` открывается для owner/admin
