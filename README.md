# MAX Contest Bot

Contest-бот для MAX с механикой розыгрышей.

## Реализовано в MVP

- Создание конкурса командой `/newcontest`.
- Вступление участника командой `/join`.
- Вступление через inline-кнопку "Участвовать".
- Проверка участия в обязательных чатах перед регистрацией.
- Реферальные бонусные билеты и взвешенная жеребьевка.
- Публикация конкурсного поста командой `/publish`.
- Список конкурсов `/contests`.
- Детерминированная жеребьевка `/draw`.
- Повторная жеребьевка `/reroll`.
- Автозавершение просроченных конкурсов.
- Хранение в SQLite (и совместимость с JSON-хранилищем по пути `*.json`).

## Быстрый старт

```bash
npm install
cp .env.example .env
npm run dev
```

Быстрый smoke-check после запуска:

```bash
npm run smoke
```

Полный локальный demo-check:

```bash
npm run local:e2e
```

Сгенерировать подписанную ссылку админки вручную:

```bash
npm run admin:url
```

## Как посмотреть готовый результат

1. Запустите бота: `npm run dev`.
2. В MAX откройте бота и выполните:
   - `/start`
   - `/newcontest ...`
   - `/publish ...`
   - `/draw ...`
3. Для web-админки используйте `/adminpanel` и кнопку "Открыть панель".
4. Для аналитики откройте подписанные endpoint’ы панели:
   - `/export`
   - `/audit`
   - `/metrics`
   - `/metrics.csv`
   - `/alerts`

Операционная поддержка и troubleshooting: `RUNBOOK.md`.

## Запуск в Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Логи контейнера:

```bash
docker compose logs -f
```

Заполните в `.env`:

- `BOT_TOKEN` - токен бота MAX.
- `OWNER_USER_ID` - владелец бота (самая высокая роль).
- `ADMIN_USER_IDS` - ID админов через запятую.
- `MODERATOR_USER_IDS` - ID модераторов через запятую.
- `STORAGE_PATH` - путь к хранилищу (по умолчанию `data/contests.db`).
- `LOG_PATH` - путь до JSONL логов бота (по умолчанию `data/bot.log`).
- `DEFAULT_LOCALE` - язык ответов бота (`ru` или `en`).
- `ADMIN_PANEL_URL` - URL вашей веб-админки (опционально).
- `ADMIN_PANEL_SECRET` - секрет подписи ссылок в админку (опционально, иначе используется `BOT_TOKEN`).
- `ADMIN_PANEL_PORT` - порт встроенной web mini-app панели (по умолчанию `8787`).
- `ADMIN_PANEL_TOKEN_TTL_MS` - TTL подписанного URL админки в миллисекундах.
- `ADMIN_PANEL_RATE_LIMIT_WINDOW_MS` - окно rate-limit для mini-app endpoint’ов.
- `ADMIN_PANEL_RATE_LIMIT_MAX` - максимум запросов за окно на IP+route.
- `ADMIN_PANEL_IP_ALLOWLIST` - allowlist IP через запятую (опционально).
- `ADMIN_ALERT_DIGEST_INTERVAL_MS` - период авто-рассылки alert digest админам (0 = выключить).

## Формат создания конкурса

```text
/newcontest Название конкурса | 2026-12-31T20:00:00Z | 3
```

## Публикация конкурсного поста

```text
/publish contest_id chat_id [текст поста]
```

## Админ-управление конкурсом

```text
/editcontest contest_id | title|- | endsAt|- | winners|-
/closecontest contest_id
/reopencontest contest_id 2026-12-31T20:00:00Z
/contestaudit contest_id
/adminpanel
/help
```

- `editcontest` меняет параметры существующего конкурса.
- `closecontest` принудительно завершает конкурс (с розыгрышем, если есть участники).
- `reopencontest` открывает завершенный конкурс заново с новой датой окончания.
- `contestaudit` показывает последние записи журнала действий по конкурсу.
- `adminpanel` открывает ссылку на мини-админку (только owner/admin) с подписью `uid/ts/sig`.
- `help` показывает структурированный onboarding по командам и быстрому старту.
- В `/start` и `/help` есть интерактивные inline-кнопки:
  - быстрые действия (`Что дальше`, `Кто я`, `Моя роль`, `Конкурсы`);
  - шаблоны команд;
  - быстрый переход в админ-панель (для owner/admin).
  - если `ADMIN_PANEL_URL` локальный (`localhost`, `127.0.0.1`), бот покажет понятную инструкцию, почему кнопка админки не открывается в MAX, и подскажет про публичный HTTPS URL (tunnel/домен).

### Быстрый сценарий (без боли)

1. В боте: `/start`
2. Нажмите кнопку `Шаблоны` и скопируйте шаблон создания.
3. Создайте конкурс: `/newcontest ...`
4. Проверьте список: кнопка `Конкурсы` или `/contests`
5. Опубликуйте: `/publish contest_id chat_id [текст]`
6. Проведите розыгрыш: `/draw contest_id`

### Что уже готово (на сейчас)

- Конкурсы: создание, участие, публикация, draw, reroll, proof, аудит.
- Роли: owner/admin/moderator/user.
- Админка: web mini-app с фильтрами, bulk-действиями, отчетами и метриками.
- Мониторинг: `/health`, alerts, alert-digest, structured logs.
- UX-онбординг: `/start`, `/help`, `/status` + интерактивные кнопки.

### Web mini-app админка (встроенная)

- Включается, если задан `ADMIN_PANEL_URL`.
- Бот формирует подписанный URL (`uid`, `ts`, `sig`) для команды `/adminpanel`.
- Встроенная панель запускается в том же процессе на `ADMIN_PANEL_PORT`.
- В панели есть фильтры (поиск + статус), карточки метрик и формы `create/edit`.
- Доступные действия в UI: `create`, `edit`, `draw`, `reroll`, `close`, `reopen` (с новой датой).
- Добавлены `v2` инструменты: пагинация, массовые действия (`bulk close/draw/reroll`) и экспорт CSV по текущим фильтрам.
- API-эндпоинты панели:
  - `${ADMIN_PANEL_URL}/export` — CSV отчет по фильтрам (`q`, `status`).
  - `${ADMIN_PANEL_URL}/audit` — JSON сводка аудита по фильтрам (`q`, `status`).
  - `${ADMIN_PANEL_URL}/metrics` — JSON метрики продукта/операций по фильтрам (`q`, `status`).
  - `${ADMIN_PANEL_URL}/metrics.csv` — CSV с агрегированными KPI для BI/Sheets.
  - `${ADMIN_PANEL_URL}/alerts` — JSON алерты/аномалии (reroll, просроченные active, referral outliers).
- Health endpoint доступен всегда: `GET /health` (`ok`) — удобно для uptime-monitoring и Docker healthcheck.
- В проекте есть smoke/integration тесты для endpoint’ов панели (`/health`, `/audit`, `/export`).
- Security hardening панели:
  - configurable TTL подписи (`ADMIN_PANEL_TOKEN_TTL_MS`);
  - IP allowlist (`ADMIN_PANEL_IP_ALLOWLIST`);
  - rate-limit на endpoint’ы (`ADMIN_PANEL_RATE_LIMIT_WINDOW_MS` + `ADMIN_PANEL_RATE_LIMIT_MAX`).
- Alert digest:
  - бот автоматически отправляет owner/admin сводку аномалий из `/alerts` с периодом `ADMIN_ALERT_DIGEST_INTERVAL_MS`.
- Smoke сценарии:
  - `scripts/smoke.sh` — автоматическая проверка `/health` и подписанных admin endpoint'ов.
  - `scripts/SMOKE-CHECKLIST.md` — ручной чеклист E2E в MAX.

## Роли и доступы

```text
/myrole
```

- `owner` и `admin`: полный доступ к управлению конкурсами.
- `moderator`: доступ к `draw`, `reroll`, `contestaudit`.
- `user`: участие в конкурсах и публичные команды.

## Прозрачность жеребьевки

```text
/proof contest_id
```

Команда возвращает seed и ключевые параметры конкурса для публичной проверки честности.

## Настройка обязательных чатов

```text
/setrequired contest_id chat_id[,chat_id2,...]
```

После установки бот проверяет членство пользователя в этих чатах при `/join` и по кнопке участия.

## Рефералка и бонусные билеты

```text
/myref contest_id
/join contest_id referrer_user_id
/start join:contest_id:referrer_user_id
```

- Базово у каждого участника 1 билет.
- За валидного приглашенного участника рефереру добавляется бонус:
  - `REFERRAL_BONUS_TICKETS` за каждого приглашенного.
  - Но не больше `REFERRAL_MAX_BONUS_TICKETS` суммарно на одного пользователя.
- Жеребьевка учитывает число билетов (weighted draw), при этом победители уникальны.
- `/start` поддерживает payload для участия через реферальную ссылку/формат.
- Встроены базовые анти-абьюз механики: cooldown на частые команды и защита от дублей draw/reroll.
