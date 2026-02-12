# CHANGELOG

Все заметные изменения проекта фиксируются в этом файле.

## [Unreleased]

### Added
- `SECURITY_CHECKLIST.md` для pre-release и production-check.
- `CHANGELOG.md` как единая лента релизных изменений.

### Changed
- Унифицированы ключевые сообщения в `bot` через i18n (`userNotDetected`, `adminOnly`, `contestNotFound`, `tooFrequent`).
- `/economics` теперь локализован (ru/en) через `buildEconomicsSummary(locale)`.
- Вынесены UI/helper блоки в `src/bot-ui.ts` для лучшей поддерживаемости.
- Вынесен общий helper аудита в `src/audit.ts`.
- Уточнен shutdown-контур: очистка таймеров и явное закрытие SQLite.

### Fixed
- Исключены unhandled rejections в фоновых async-потоках.
- Добавлен лимит размера POST body в admin-panel (`413 Payload Too Large`).
- Добавлен readiness endpoint `/health/ready` для более точной проверки готовности.

## [2026-02-12]

### Added
- Команда `/economics` и entry в help-клавиатуре.
- Readiness endpoint `GET /health/ready`.
- Дополнительные smoke/integration проверки admin-панели.

### Changed
- Улучшен onboarding (`/guide`, `/faq`, `/posttemplate`, `/wizard`, `/status`).
- Повышена устойчивость runtime и операционный контроль.
