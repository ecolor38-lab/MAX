# MAX Contest Bot - Task Board

Last updated: 2026-02-11 (referral scope started)

## Workflow (автоматический режим)

После каждого шага работы:
1. Пишем код
2. `npm run test` (type-check + build + tests)
3. Если тесты проходят → коммит автоматически, без запроса

## 0) Current Project State

- [x] Project bootstrap in `MAX` repo
- [x] Core contest flows: `/newcontest`, `/join`, `/publish`, `/contests`, `/draw`, `/reroll`
- [x] Deterministic draw with proof seed
- [x] Auto-finish expired contests
- [x] Required chat membership checks before join
- [x] Auto-publish results to contest chat (timer + manual draw/reroll)
- [~] Referral and bonus tickets system (core implemented, hardening pending)
- [ ] Anti-abuse layer and moderation controls
- [ ] Admin mini-app / advanced management UX

## 1) Active Sprint (Now)

### In Progress

- [~] Implement referral links and bonus tickets
  - [x] Add referral fields in participant storage model
  - [ ] Add `/start <payload>` referral entrypoint handling
  - [x] Add ticket rules (base + referral bonus, max cap)
  - [x] Update draw logic to support weighted tickets
  - [x] Update docs for referral mechanics

### Next

- [ ] Add anti-abuse protections
  - [ ] Idempotency and duplicate action protection
  - [ ] Cooldowns/rate limits for heavy commands
  - [ ] Basic suspicious activity signals for admins

- [ ] Improve admin operations
  - [ ] Contest edit command (title/end date/winner count)
  - [ ] Force close/reopen command
  - [ ] Detailed audit trail for draw/reroll

## 2) Backlog (Planned)

- [ ] Unit tests for draw/repository/bot command handlers
- [ ] Structured logging and error telemetry
- [ ] Better persistence backend (SQLite/Postgres) instead of JSON file
- [ ] Multi-admin role model (owner/admin/moderator)
- [ ] Localization support
- [ ] Public fairness verification command (`/proof contest_id`)

## 3) MAX Bot API Capabilities and Limits (Important)

This section is based on the installed SDK `@maxhub/max-bot-api` in this repo.

### What we can do

- Commands and handlers:
  - `bot.command(...)`
  - `bot.action(...)` for callback buttons
  - `bot.api.setMyCommands(...)`
- Messaging:
  - `sendMessageToChat(chatId, text, extra?)`
  - `sendMessageToUser(userId, text, extra?)`
  - edit/delete/pin/unpin messages
- Chat management:
  - `getChatMembers(chatId, { user_ids })`
  - `getChatAdmins(chatId)`
  - `addChatMembers`, `removeChatMember`, `leaveChat`
- Keyboards/buttons:
  - callback button
  - link button
  - request_contact button
  - request_geo_location button
  - chat button

### Important limits and caveats

- Membership check requirement:
  - To verify required chats, bot must be able to query chat members.
  - If bot lacks rights or cannot access chat, membership check fails.
- No explicit "channel subscriber" API concept in SDK:
  - We validate participation through `getChatMembers(...)`.
- IDs are numeric:
  - `chat_id` and `user_id` are numbers in API contracts.
  - Any non-numeric IDs should be rejected/normalized.
- Callback payload is string-based:
  - Keep callback payload compact and deterministic.
- No built-in contest scheduler:
  - Auto-finish is app-level logic (`setInterval`) and must run in a stable process.
- Command scope granularity is limited in current SDK surface:
  - We use global command registration.

## 4) Architecture Guardrails (Working Rules)

- Keep deterministic draw reproducible and auditable.
- Never register participant without passing required-chat checks.
- Any admin-only action must check admin ID first.
- Avoid silently swallowing API failures when they affect fairness.
- Store all critical contest state transitions in repository writes.

## 5) Definition of Done for Next Milestone

- [ ] Referral system is live and documented
- [ ] Weighted draw works and is test-covered
- [ ] Abuse protections exist for join/referral paths
- [ ] README updated with new commands and examples
- [ ] All checks pass (`type-check`, `build`)
