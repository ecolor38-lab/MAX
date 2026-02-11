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
```

- `editcontest` меняет параметры существующего конкурса.
- `closecontest` принудительно завершает конкурс (с розыгрышем, если есть участники).
- `reopencontest` открывает завершенный конкурс заново с новой датой окончания.
- `contestaudit` показывает последние записи журнала действий по конкурсу.
- `adminpanel` открывает ссылку на мини-админку (только owner/admin) с подписью `uid/ts/sig`.

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
- В проекте есть smoke/integration тесты для endpoint’ов панели (`/health`, `/audit`, `/export`).

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
