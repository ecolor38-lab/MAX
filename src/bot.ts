import crypto from "node:crypto";

import { Bot, Keyboard } from "@maxhub/max-bot-api";

import { buildAlertsReport } from "./admin-panel";
import type { AppConfig } from "./config";
import { runDeterministicDraw } from "./draw";
import { t, type SupportedLocale } from "./i18n";
import type { AppLogger } from "./logger";
import { ContestRepository } from "./repository";
import type { Contest, ContestAuditEntry, Participant } from "./types";

type Ctx = any;
const COMMAND_COOLDOWN_MS = 1500;
const DRAW_LOCK_TTL_MS = 10_000;
const SUSPICIOUS_WINDOW_MS = 5 * 60 * 1000;
const SUSPICIOUS_THRESHOLD = 3;
const SUSPICIOUS_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_ALERT_DIGEST_INTERVAL_MS = 60_000;

function extractUser(ctx: Ctx): { id: string; username?: string } | null {
  const userSource =
    typeof ctx?.user === "function"
      ? ctx.user()
      : (ctx?.user ?? ctx?.sender ?? ctx?.update?.user ?? ctx?.update?.sender ?? ctx?.message?.sender);
  const user = userSource ?? null;
  if (!user) {
    return null;
  }

  const id = String(user.userId ?? user.user_id ?? user.id ?? "");
  if (!id) {
    return null;
  }

  const nameFromParts =
    [user.first_name, user.last_name]
      .filter((value: unknown) => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .trim() || undefined;

  return {
    id,
    username: user.username ?? user.name ?? nameFromParts,
  };
}

function extractText(ctx: Ctx): string {
  const value =
    ctx?.message?.body?.text ??
    ctx?.message?.text ??
    ctx?.update?.message?.body?.text ??
    ctx?.update?.message?.text ??
    "";
  return typeof value === "string" ? value.trim() : "";
}

function extractChatId(ctx: Ctx): number | null {
  const raw =
    ctx?.chatId ??
    ctx?.message?.recipient?.chat_id ??
    ctx?.update?.message?.recipient?.chat_id ??
    ctx?.message?.chat_id ??
    ctx?.update?.chat_id;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseCommandArgs(fullText: string): string {
  const parts = fullText.split(" ");
  parts.shift();
  return parts.join(" ").trim();
}

function isAdmin(config: AppConfig, userId: string): boolean {
  return config.adminUserIds.has(userId);
}

function getUserRole(config: AppConfig, userId: string): "owner" | "admin" | "moderator" | "user" {
  if (config.ownerUserId && config.ownerUserId === userId) {
    return "owner";
  }
  if (isAdmin(config, userId)) {
    return "admin";
  }
  if (config.moderatorUserIds.has(userId)) {
    return "moderator";
  }
  return "user";
}

function canManageContest(config: AppConfig, userId: string): boolean {
  const role = getUserRole(config, userId);
  return role === "owner" || role === "admin";
}

function canModerateContest(config: AppConfig, userId: string): boolean {
  const role = getUserRole(config, userId);
  return role === "owner" || role === "admin" || role === "moderator";
}

function buildAdminPanelUrl(baseUrl: string, userId: string, secret: string): string {
  const ts = Date.now().toString();
  const signature = crypto.createHmac("sha256", secret).update(`${userId}:${ts}`).digest("hex");
  const url = new URL(baseUrl);
  url.searchParams.set("uid", userId);
  url.searchParams.set("ts", ts);
  url.searchParams.set("sig", signature);
  return url.toString();
}

function parseRequiredChatIds(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function parseJoinArgs(raw: string): { contestId: string; referrerId?: string } {
  const [contestId = "", referrerIdRaw] = raw.split(/\s+/).filter(Boolean);
  const referrerId = referrerIdRaw?.trim();
  if (!referrerId) {
    return { contestId };
  }
  return { contestId, referrerId };
}

function parseStartJoinPayload(raw: string): { contestId: string; referrerId?: string } | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("join:")) {
    const parts = normalized.split(":");
    const contestId = (parts[1] ?? "").trim();
    const referrerId = (parts[2] ?? "").trim();
    if (!contestId) {
      return null;
    }
    if (!referrerId) {
      return { contestId };
    }
    return { contestId, referrerId };
  }

  return parseJoinArgs(normalized);
}

function parseEditContestArgs(raw: string): {
  contestId: string;
  title?: string;
  endsAt?: string;
  maxWinners?: number;
} | null {
  const [contestIdRaw, titleRaw, endsAtRaw, winnersRaw] = raw.split("|").map((value) => value.trim());
  const contestId = contestIdRaw ?? "";
  if (!contestId) {
    return null;
  }

  const title = titleRaw && titleRaw !== "-" ? titleRaw : undefined;
  const endsAt = endsAtRaw && endsAtRaw !== "-" ? endsAtRaw : undefined;

  let maxWinners: number | undefined;
  if (winnersRaw && winnersRaw !== "-") {
    const parsed = Number(winnersRaw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return null;
    }
    maxWinners = Math.floor(parsed);
  }

  return {
    contestId,
    ...(title ? { title } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(maxWinners ? { maxWinners } : {}),
  };
}

function toContestLine(contest: Contest): string {
  return `#${contest.id} | ${contest.title} | status=${contest.status} | participants=${contest.participants.length} | winners=${contest.maxWinners} | requiredChats=${contest.requiredChats.length}`;
}

function buildHelpMessage(locale: SupportedLocale): string {
  const msg = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(locale, key, vars);
  return [
    msg("helpTitle"),
    "",
    locale === "ru"
      ? "Нажмите кнопки ниже: базовые команды выполняются сразу, сложные открывают шаблоны."
      : "Use buttons below: basic commands run instantly, advanced ones open templates.",
    "",
    msg("helpQuickStartLabel"),
    "1) /newcontest Название | 2026-12-31T20:00:00Z | 1",
    "2) /publish contest_id chat_id [текст]",
    "3) /join contest_id",
    "4) /draw contest_id",
    "",
    msg("helpPublicCommandsLabel"),
    "/start",
    "/help",
    "/whoami",
    "/myrole",
    "/contests",
    "/join contest_id [referrer_user_id]",
    "/myref contest_id",
    "/proof contest_id",
    "",
    msg("helpAdminCommandsLabel"),
    "/adminpanel",
    "/newcontest",
    "/setrequired contest_id chat_id[,chat_id2,...]",
    "/editcontest contest_id | title|- | endsAt|- | winners|-",
    "/closecontest contest_id",
    "/reopencontest contest_id ISO-дата",
    "/publish contest_id chat_id [текст_поста]",
    "/draw contest_id",
    "/reroll contest_id",
    "/contestaudit contest_id",
    "",
    msg("helpHint"),
  ].join("\n");
}

function buildCommandTemplates(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "Command templates:",
      "/newcontest Giveaway name | 2026-12-31T20:00:00Z | 1",
      "/setrequired contest_id chat_id[,chat_id2,...]",
      "/publish contest_id chat_id [post text]",
      "/join contest_id [referrer_user_id]",
      "/draw contest_id",
      "/reroll contest_id",
    ].join("\n");
  }
  return [
    "Шаблоны команд:",
    "/newcontest Название конкурса | 2026-12-31T20:00:00Z | 1",
    "/setrequired contest_id chat_id[,chat_id2,...]",
    "/publish contest_id chat_id [текст поста]",
    "/join contest_id [referrer_user_id]",
    "/draw contest_id",
    "/reroll contest_id",
  ].join("\n");
}

function buildHelpKeyboard(locale: SupportedLocale, canManage: boolean): ReturnType<typeof Keyboard.inlineKeyboard> {
  const L = locale === "en";
  const rows = [
    [
      Keyboard.button.callback(L ? "User guide" : "Инструкция для пользователя", "help:guide_user"),
      Keyboard.button.callback(L ? "Admin guide" : "Инструкция для администратора", "help:guide_admin"),
    ],
    [Keyboard.button.callback(L ? "Master scenario" : "Мастер-сценарий", "wizard:start")],
    [
      Keyboard.button.callback(L ? "What next" : "Что дальше", "help:nextsteps"),
      Keyboard.button.callback(L ? "Templates" : "Шаблоны", "help:templates"),
    ],
    [
      Keyboard.button.callback(L ? "FAQ" : "FAQ", "help:faq"),
      Keyboard.button.callback(L ? "Post template" : "Шаблон поста", "help:post_template"),
    ],
    [
      Keyboard.button.callback(L ? "Who am I" : "Кто я", "help:whoami"),
      Keyboard.button.callback(L ? "My role" : "Моя роль", "help:myrole"),
    ],
    [Keyboard.button.callback(L ? "Contests" : "Конкурсы", "help:contests")],
  ];
  if (canManage) {
    rows.push(
      [
        Keyboard.button.callback(L ? "Open admin panel" : "Открыть админку", "help:adminpanel"),
      ],
      [
        Keyboard.button.callback(L ? "Draw hint" : "Подсказка draw", "help:draw_hint"),
        Keyboard.button.callback(L ? "Reroll hint" : "Подсказка reroll", "help:reroll_hint"),
      ],
    );
  }
  return Keyboard.inlineKeyboard(rows);
}

function buildNextStepsMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "Next steps:",
      "1) Press Templates and copy /newcontest example.",
      "2) Create contest via /newcontest ...",
      "3) Check contest id in /contests.",
      "4) Publish via /publish contest_id chat_id [text].",
      "5) Run /draw contest_id when ready.",
    ].join("\n");
  }
  return [
    "Что делать дальше:",
    "1) Нажмите 'Шаблоны' и скопируйте пример /newcontest.",
    "2) Создайте конкурс: /newcontest ...",
    "3) Посмотрите contest_id через /contests.",
    "4) Опубликуйте: /publish contest_id chat_id [текст].",
    "5) Проведите розыгрыш: /draw contest_id.",
  ].join("\n");
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("127.")) {
    return true;
  }
  if (host.startsWith("172.")) {
    const second = Number(host.split(".")[1] ?? "");
    if (Number.isFinite(second) && second >= 16 && second <= 31) {
      return true;
    }
  }
  return false;
}

function canUseLinkButtonUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return !isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

function describeAdminPanelMode(adminPanelUrl?: string): "disabled" | "local" | "public" {
  if (!adminPanelUrl) {
    return "disabled";
  }
  return canUseLinkButtonUrl(adminPanelUrl) ? "public" : "local";
}

function buildStatusMessage(input: {
  role: "owner" | "admin" | "moderator" | "user";
  contestsTotal: number;
  activeCount: number;
  completedCount: number;
  draftCount: number;
  adminPanelMode: "disabled" | "local" | "public";
}): string {
  const panelLine =
    input.adminPanelMode === "public"
      ? "Админка: настроена (public URL, кнопка должна открываться в MAX)"
      : input.adminPanelMode === "local"
        ? "Админка: локальная (для MAX нужен публичный HTTPS URL)"
        : "Админка: выключена (не задан ADMIN_PANEL_URL)";
  return [
    "Статус бота:",
    `Роль: ${input.role}`,
    `Конкурсы: всего=${input.contestsTotal}, active=${input.activeCount}, completed=${input.completedCount}, draft=${input.draftCount}`,
    panelLine,
    "Следующий шаг: /help -> Что дальше",
  ].join("\n");
}

function buildSchoolUserGuideMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "User guide (simple):",
      "1) Press Join button under contest post OR send /join contest_id.",
      "2) Wait for draw time.",
      "3) Check winners in chat.",
      "4) Verify fairness using /proof contest_id.",
      "Rule: one real account per person.",
    ].join("\n");
  }
  return [
    "Инструкция для обычного пользователя (3 шага):",
    "1) Нажми кнопку 'Участвовать'.",
    "2) Жди время розыгрыша.",
    "3) Проверь победителей в чате.",
    "",
    "Если ошибка: открой /faq.",
    "Если хочешь проверить честность: /proof contest_id.",
  ].join("\n");
}

function buildAdminIntegrationGuideMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "Admin guide: how to integrate into groups/channels",
      "1) Add bot to your group/channel and grant needed rights.",
      "2) Create contest: /newcontest Name | 2026-12-31T20:00:00Z | 1",
      "3) (Optional) Required chats: /setrequired contest_id chat1,chat2",
      "4) Publish post: /publish contest_id chat_id [post text]",
      "5) Run draw: /draw contest_id",
      "6) Open web admin: /adminpanel",
    ].join("\n");
  }
  return [
    "Инструкция для администратора: кто и как использует бота",
    "Кто делает розыгрыши: owner/admin/moderator.",
    "Кто участвует: обычные пользователи (кнопка Join).",
    "",
    "Как подключить в группу/канал:",
    "1) Добавь бота в группу/канал и выдай нужные права.",
    "2) Создай конкурс: /newcontest Название | 2026-12-31T20:00:00Z | 1",
    "3) (Опционально) обязательные чаты: /setrequired contest_id chat1,chat2",
    "4) Опубликуй пост: /publish contest_id chat_id [текст]",
    "5) Проведи розыгрыш: /draw contest_id",
    "6) Открой web-админку: /adminpanel",
  ].join("\n");
}

function buildFaqMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "FAQ:",
      "Q: How to join?",
      "A: Press Join button or /join contest_id.",
      "Q: Why join failed?",
      "A: Usually missing required chats or contest already closed.",
      "Q: How to check fairness?",
      "A: Use /proof contest_id.",
      "Q: Who can run draw?",
      "A: owner/admin/moderator (by role config).",
    ].join("\n");
  }
  return [
    "FAQ (вопросы-ответы):",
    "В: Как участвовать?",
    "О: Нажми кнопку 'Участвовать' или /join contest_id.",
    "В: Почему не пускает в конкурс?",
    "О: Обычно не выполнены обязательные чаты или конкурс уже завершен.",
    "В: Как проверить честность?",
    "О: Используй /proof contest_id.",
    "В: Кто может делать draw?",
    "О: owner/admin/moderator (по ролям в конфиге).",
  ].join("\n");
}

function buildPostTemplateMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "Ready-to-use contest post template:",
      "🎁 Giveaway: <Prize>",
      "✅ How to participate: press Join button",
      "🕒 Draw time: <Date/Time>",
      "🔍 Fairness: /proof contest_id after draw",
      "👥 One account per person",
    ].join("\n");
  }
  return [
    "Готовый шаблон поста для розыгрыша:",
    "🎁 Разыгрываем: <Приз/сертификат>",
    "✅ Условие: нажмите кнопку 'Участвовать' (это 1 клик)",
    "🕒 Итоги: <Дата/время>",
    "🔍 Проверка честности: /proof contest_id после draw",
    "👥 Один аккаунт на человека",
    "📩 Победителю напишем в личку/публично в чате",
  ].join("\n");
}

function buildWizardIntroMessage(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "Master scenario (one-tap):",
      "Step 1: create demo contest",
      "Step 2: publish in current chat",
      "Step 3: check status",
      "Step 4: run draw and proof",
    ].join("\n");
  }
  return [
    "Мастер-сценарий (one-tap):",
    "Шаг 1: создать демо-конкурс",
    "Шаг 2: опубликовать в текущий чат",
    "Шаг 3: проверить статус",
    "Шаг 4: провести draw и посмотреть proof",
  ].join("\n");
}

function buildWizardKeyboard(locale: SupportedLocale): ReturnType<typeof Keyboard.inlineKeyboard> {
  const L = locale === "en";
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback(L ? "1) Create demo" : "1) Создать демо", "wizard:create_demo")],
    [Keyboard.button.callback(L ? "2) Publish here" : "2) Опубликовать сюда", "wizard:publish_here")],
    [
      Keyboard.button.callback(L ? "3) Status" : "3) Статус", "wizard:status"),
      Keyboard.button.callback(L ? "4) Draw" : "4) Draw", "wizard:draw"),
    ],
    [Keyboard.button.callback(L ? "5) Proof" : "5) Proof", "wizard:proof")],
  ]);
}

function withAuditEntry(contest: Contest, entry: ContestAuditEntry): Contest {
  const current = contest.auditLog ?? [];
  return { ...contest, auditLog: [...current, entry] };
}

function hitCooldown(
  state: Map<string, number>,
  key: string,
  cooldownMs: number,
): { ok: true } | { ok: false; waitSeconds: number } {
  const now = Date.now();
  const nextAllowedAt = state.get(key) ?? 0;
  if (nextAllowedAt > now) {
    return {
      ok: false,
      waitSeconds: Math.max(1, Math.ceil((nextAllowedAt - now) / 1000)),
    };
  }
  state.set(key, now + cooldownMs);
  return { ok: true };
}

function hitSuspiciousCounter(
  state: Map<string, { count: number; windowStart: number; lastAlertAt: number }>,
  key: string,
): { shouldAlert: boolean; count: number } {
  const now = Date.now();
  const current = state.get(key);
  if (!current || now - current.windowStart > SUSPICIOUS_WINDOW_MS) {
    state.set(key, { count: 1, windowStart: now, lastAlertAt: 0 });
    return { shouldAlert: false, count: 1 };
  }

  const next = { ...current, count: current.count + 1 };
  state.set(key, next);
  const shouldAlert =
    next.count >= SUSPICIOUS_THRESHOLD && now - next.lastAlertAt > SUSPICIOUS_ALERT_COOLDOWN_MS;
  if (shouldAlert) {
    state.set(key, { ...next, lastAlertAt: now });
  }
  return { shouldAlert, count: next.count };
}

async function notifyAdmins(bot: Bot, config: AppConfig, message: string): Promise<void> {
  const adminIds = new Set<number>();
  if (config.ownerUserId) {
    const ownerId = Number(config.ownerUserId);
    if (Number.isFinite(ownerId)) {
      adminIds.add(ownerId);
    }
  }
  for (const value of config.adminUserIds) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      adminIds.add(parsed);
    }
  }
  if (adminIds.size === 0) {
    return;
  }

  await Promise.all(
    [...adminIds].map(async (adminId) => {
      try {
        await bot.api.sendMessageToUser(adminId, message);
      } catch {
        // Ignore admin notification delivery failures.
      }
    }),
  );
}

function notifySuspiciousIfNeeded(
  bot: Bot,
  config: AppConfig,
  logger: AppLogger,
  suspiciousState: Map<string, { count: number; windowStart: number; lastAlertAt: number }>,
  reason: string,
  userId: string,
): void {
  const signal = hitSuspiciousCounter(suspiciousState, `${reason}:${userId}`);
  if (!signal.shouldAlert) {
    return;
  }

  void notifyAdmins(
    bot,
    config,
    `Антифрод сигнал: ${reason}\nuser_id=${userId}\nповторов за окно=${signal.count}`,
  );
  logger.warn("suspicious_activity", { reason, userId, count: signal.count });
}

function buildAlertDigestSignature(
  alerts: Array<{ code: string; severity: string; message: string; value: number }>,
): string {
  return alerts.map((alert) => `${alert.code}:${alert.severity}:${alert.value}`).sort().join("|");
}

function formatAlertDigestMessage(
  alerts: Array<{ code: string; severity: string; message: string; value: number }>,
): string {
  const lines = alerts.map((alert) => `- [${alert.severity}] ${alert.code}: ${alert.message} (value=${alert.value})`);
  return ["[ALERT DIGEST] Обнаружены аномалии конкурсов:", ...lines].join("\n");
}

async function notifyAlertDigestIfNeeded(
  bot: Bot,
  config: AppConfig,
  logger: AppLogger,
  repository: ContestRepository,
  state: { lastSignature: string; lastSentAt: number },
): Promise<void> {
  const report = buildAlertsReport(repository.list());
  if (report.alerts.length === 0) {
    return;
  }
  const signature = buildAlertDigestSignature(report.alerts);
  if (signature === state.lastSignature) {
    return;
  }
  if (Date.now() - state.lastSentAt < MIN_ALERT_DIGEST_INTERVAL_MS) {
    return;
  }
  const message = formatAlertDigestMessage(report.alerts);
  await notifyAdmins(bot, config, message);
  state.lastSignature = signature;
  state.lastSentAt = Date.now();
  logger.warn("alert_digest_sent", {
    alerts: report.alerts.map((alert) => ({ code: alert.code, severity: alert.severity, value: alert.value })),
  });
}

async function findMissingRequiredChats(
  bot: Bot,
  requiredChats: number[],
  userId: number,
): Promise<number[]> {
  const checks = await Promise.all(
    requiredChats.map(async (chatId) => {
      try {
        const response = await bot.api.getChatMembers(chatId, { user_ids: [userId] });
        const members = Array.isArray((response as { members?: unknown[] }).members)
          ? ((response as { members?: unknown[] }).members ?? [])
          : [];

        const isMember = members.some((member) => {
          const candidateId = Number((member as { user_id?: number }).user_id);
          return Number.isFinite(candidateId) && candidateId === userId;
        });

        return isMember ? null : chatId;
      } catch {
        return chatId;
      }
    }),
  );

  return checks.filter((chatId): chatId is number => chatId !== null);
}

async function tryJoinContest(
  bot: Bot,
  config: AppConfig,
  repository: ContestRepository,
  contestId: string,
  user: { id: string; username?: string },
  referrerId?: string,
): Promise<{ ok: true; contest: Contest; already: boolean } | { ok: false; message: string }> {
  const contest = repository.get(contestId);
  if (!contest) {
    return { ok: false, message: "Конкурс не найден." };
  }
  if (contest.status !== "active") {
    return { ok: false, message: "Этот конкурс уже завершен." };
  }
  if (new Date(contest.endsAt).getTime() < Date.now()) {
    return { ok: false, message: "Срок участия в этом конкурсе уже вышел." };
  }

  if (contest.requiredChats.length > 0) {
    const userId = Number(user.id);
    if (!Number.isFinite(userId)) {
      return {
        ok: false,
        message: "Не удалось проверить подписки для участия. Попробуйте позже.",
      };
    }

    const missingChats = await findMissingRequiredChats(bot, contest.requiredChats, userId);
    if (missingChats.length > 0) {
      return {
        ok: false,
        message: `Для участия подпишитесь на обязательные чаты: ${missingChats.join(", ")}`,
      };
    }
  }

  const already = contest.participants.some((participant) => participant.userId === user.id);
  if (already) {
    return { ok: true, contest, already: true };
  }

  const updated = repository.update(contestId, (currentContest) => {
    const currentAlready = currentContest.participants.some((p) => p.userId === user.id);
    if (currentAlready) {
      return currentContest;
    }

    const participant: Participant = {
      userId: user.id,
      joinedAt: new Date().toISOString(),
      tickets: 1,
      ...(user.username ? { username: user.username } : {}),
    };

    const participants = [...currentContest.participants, participant];
    if (!referrerId || referrerId === user.id) {
      return withAuditEntry(
        { ...currentContest, participants },
        {
          at: new Date().toISOString(),
          action: "join",
          actorId: user.id,
          details: "join",
        },
      );
    }

    const referrerIndex = participants.findIndex((p) => p.userId === referrerId);
    if (referrerIndex < 0) {
      return withAuditEntry(
        { ...currentContest, participants },
        {
          at: new Date().toISOString(),
          action: "join",
          actorId: user.id,
          details: `join (referrer not found=${referrerId})`,
        },
      );
    }

    const referrer = participants[referrerIndex];
    if (!referrer) {
      return withAuditEntry(
        { ...currentContest, participants },
        {
          at: new Date().toISOString(),
          action: "join",
          actorId: user.id,
          details: `join (invalid referrer=${referrerId})`,
        },
      );
    }

    const currentBonus = Math.max(0, (referrer.tickets ?? 1) - 1);
    const bonusLeft = Math.max(0, config.referralMaxBonusTickets - currentBonus);
    const addBonus = Math.min(config.referralBonusTickets, bonusLeft);
    if (addBonus <= 0) {
      participants[participants.length - 1] = {
        ...participant,
        referredBy: referrerId,
      };
      return withAuditEntry(
        { ...currentContest, participants },
        {
          at: new Date().toISOString(),
          action: "join",
          actorId: user.id,
          details: `join с реферером=${referrerId} (лимит бонуса достигнут)`,
        },
      );
    }

    participants[referrerIndex] = {
      ...referrer,
      tickets: referrer.tickets + addBonus,
      referralsCount: (referrer.referralsCount ?? 0) + 1,
    };
    participants[participants.length - 1] = {
      ...participant,
      referredBy: referrerId,
    };

    return withAuditEntry(
      { ...currentContest, participants },
      {
        at: new Date().toISOString(),
        action: "join",
        actorId: user.id,
        details: `join с реферером=${referrerId}, бонус=${addBonus}`,
      },
    );
  });
  if (!updated) {
    return { ok: false, message: "Не удалось зарегистрировать участие." };
  }

  return { ok: true, contest: updated, already: false };
}

async function autoFinishExpiredContests(bot: Bot, repository: ContestRepository): Promise<void> {
  const now = Date.now();
  const expiredActive = repository
    .list()
    .filter((contest) => contest.status === "active" && new Date(contest.endsAt).getTime() <= now);

  for (const contest of expiredActive) {
    if (contest.participants.length === 0) {
      repository.update(contest.id, (prev) =>
        withAuditEntry(
          { ...prev, status: "completed" },
          {
            at: new Date().toISOString(),
            action: "autofinish",
            actorId: "system",
            details: "Автозавершение без участников",
          },
        ),
      );
      continue;
    }

    const result = runDeterministicDraw(contest);
    const updated = repository.update(contest.id, (prev) =>
      withAuditEntry(
        {
          ...prev,
          status: "completed",
          winners: result.winners,
          drawSeed: result.seed,
        },
        {
          at: new Date().toISOString(),
          action: "autofinish",
          actorId: "system",
          details: `Автозавершение, winners=${result.winners.join(",") || "none"}`,
        },
      ),
    );
    if (!updated) {
      continue;
    }

    await publishContestResults(bot, updated);
  }
}

async function publishContestResults(bot: Bot, contest: Contest): Promise<void> {
  if (!contest.publishChatId) {
    return;
  }

  await bot.api.sendMessageToChat(
    contest.publishChatId,
    [
      `Итоги конкурса: ${contest.title}`,
      `Победители: ${contest.winners.join(", ") || "нет победителей"}`,
      `Proof seed: ${contest.drawSeed ?? "-"}`,
    ].join("\n"),
  );
}

export function createContestBot(config: AppConfig, logger: AppLogger, repository?: ContestRepository): Bot {
  const storage = repository ?? new ContestRepository(config.storagePath);
  const bot = new Bot(config.botToken);
  const commandCooldowns = new Map<string, number>();
  const drawLocks = new Map<string, number>();
  const suspiciousActivity = new Map<string, { count: number; windowStart: number; lastAlertAt: number }>();
  const alertDigestState = { lastSignature: "", lastSentAt: 0 };
  const wizardState = new Map<string, string>();
  const msg = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    t(config.defaultLocale, key, vars);
  const sendAdminPanelEntry = async (ctx: Ctx, userId: string): Promise<void> => {
    if (!config.adminPanelUrl) {
      await ctx.reply("Админ-панель не настроена: задайте ADMIN_PANEL_URL в .env.");
      return;
    }
    const secret = config.adminPanelSecret || config.botToken;
    const url = buildAdminPanelUrl(config.adminPanelUrl, userId, secret);

    if (!canUseLinkButtonUrl(config.adminPanelUrl)) {
      await ctx.reply(
        [
          "Открыть админку кнопкой не получится: сейчас указан локальный/private URL.",
          `Текущее значение ADMIN_PANEL_URL: ${config.adminPanelUrl}`,
          "Нужен публичный URL (https) через tunnel/домен (например Cloudflare Tunnel или ngrok).",
          "После этого кнопка 'Открыть панель' заработает.",
          "",
          `Временная ссылка (для проверки): ${url}`,
        ].join("\n"),
      );
      return;
    }

    try {
      await ctx.reply("Открыть админ-панель:", {
        attachments: [Keyboard.inlineKeyboard([[Keyboard.button.link("Открыть панель", url)]])],
      });
    } catch (error) {
      logger.warn("admin_panel_link_button_failed", { message: error instanceof Error ? error.message : String(error) });
      await ctx.reply(
        [
          "Не удалось отправить кнопку-ссылку админки.",
          "Отправляю прямую ссылку текстом:",
          url,
        ].join("\n"),
      );
    }
  };

  const resolveWizardContest = (userId: string): Contest | null => {
    const preferredId = wizardState.get(userId);
    if (preferredId) {
      const byId = storage.get(preferredId);
      if (byId) {
        return byId;
      }
    }
    const latestByUser = storage
      .list()
      .filter((contest) => contest.createdBy === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latestByUser ?? null;
  };

  bot.catch((error: unknown, _ctx: Ctx) => {
    logger.error("bot_handler_error", { message: error instanceof Error ? error.message : String(error) });
  });

  bot.api.setMyCommands([
    { name: "start", description: "Помощь и команды" },
    { name: "guide", description: "Инструкция для новичков и админов" },
    { name: "wizard", description: "Мастер-сценарий one-tap (создать -> publish -> draw)" },
    { name: "help", description: "Онбординг и полный список команд" },
    { name: "faq", description: "Вопросы и ответы по боту" },
    { name: "posttemplate", description: "Готовый шаблон поста розыгрыша" },
    { name: "status", description: "Текущий статус бота и админки" },
    { name: "myrole", description: "Показать роль: /myrole" },
    { name: "adminpanel", description: "Открыть админ-панель: /adminpanel" },
    { name: "whoami", description: "Показать ваш user ID" },
    {
      name: "newcontest",
      description: "Создать конкурс: /newcontest Название | 2026-12-31T20:00:00Z | 3",
    },
    { name: "contests", description: "Показать конкурсы" },
    { name: "setrequired", description: "Обязательные чаты: /setrequired contest_id chat1,chat2" },
    { name: "myref", description: "Рефкод: /myref contest_id" },
    { name: "join", description: "Участвовать: /join contest_id" },
    { name: "proof", description: "Пруф жеребьевки: /proof contest_id" },
    { name: "contestaudit", description: "Аудит конкурса: /contestaudit contest_id" },
    {
      name: "editcontest",
      description: "Изменить конкурс: /editcontest id | title|- | endsAt|- | winners|-",
    },
    { name: "closecontest", description: "Закрыть конкурс: /closecontest contest_id" },
    { name: "reopencontest", description: "Переоткрыть: /reopencontest contest_id ISO_endsAt" },
    { name: "publish", description: "Опубликовать конкурс: /publish contest_id chat_id [текст]" },
    { name: "draw", description: "Выбрать победителей: /draw contest_id" },
    { name: "reroll", description: "Перевыбрать победителей: /reroll contest_id" },
  ]);

  bot.command("start", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }

    const startPayload = typeof ctx?.startPayload === "string" ? ctx.startPayload.trim() : "";
    const messagePayload = parseCommandArgs(extractText(ctx));
    const payloadRaw = startPayload || messagePayload;

    if (payloadRaw) {
      const parsedPayload = parseStartJoinPayload(payloadRaw);
      if (parsedPayload?.contestId) {
        const result = await tryJoinContest(
          bot,
          config,
          storage,
          parsedPayload.contestId,
          user,
          parsedPayload.referrerId,
        );
        if (!result.ok) {
          return ctx.reply(result.message);
        }
        if (result.already) {
          return ctx.reply(
            `Вы уже участвуете в конкурсе "${result.contest.title}". Участников: ${result.contest.participants.length}`,
          );
        }
        return ctx.reply(
          `Участие подтверждено через /start для "${result.contest.title}". Всего участников: ${result.contest.participants.length}`,
        );
      }
    }

    return ctx.reply([msg("startTitle"), "👉 Сначала открой: /guide", "", buildHelpMessage(config.defaultLocale)].join("\n"), {
      attachments: [buildHelpKeyboard(config.defaultLocale, canManageContest(config, user.id))],
    });
  });

  bot.command("help", (ctx: Ctx) => {
    const user = extractUser(ctx);
    const canManage = user ? canManageContest(config, user.id) : false;
    return ctx.reply(buildHelpMessage(config.defaultLocale), {
      attachments: [buildHelpKeyboard(config.defaultLocale, canManage)],
    });
  });

  bot.command("guide", (ctx: Ctx) => {
    const user = extractUser(ctx);
    const canManage = user ? canManageContest(config, user.id) : false;
    return ctx.reply(
      [buildSchoolUserGuideMessage(config.defaultLocale), "", buildAdminIntegrationGuideMessage(config.defaultLocale)].join(
        "\n",
      ),
      {
        attachments: [buildHelpKeyboard(config.defaultLocale, canManage)],
      },
    );
  });

  bot.command("wizard", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Мастер-сценарий доступен owner/admin.");
    }
    return ctx.reply(buildWizardIntroMessage(config.defaultLocale), {
      attachments: [buildWizardKeyboard(config.defaultLocale)],
    });
  });

  bot.command("faq", (ctx: Ctx) => {
    return ctx.reply(buildFaqMessage(config.defaultLocale));
  });

  bot.command("posttemplate", (ctx: Ctx) => {
    return ctx.reply(buildPostTemplateMessage(config.defaultLocale));
  });

  bot.command("status", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }
    const role = getUserRole(config, user.id);
    const contests = storage.list();
    const activeCount = contests.filter((contest) => contest.status === "active").length;
    const completedCount = contests.filter((contest) => contest.status === "completed").length;
    const draftCount = contests.filter((contest) => contest.status === "draft").length;
    return ctx.reply(
      buildStatusMessage({
        role,
        contestsTotal: contests.length,
        activeCount,
        completedCount,
        draftCount,
        adminPanelMode: describeAdminPanelMode(config.adminPanelUrl),
      }),
    );
  });

  bot.command("whoami", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }
    return ctx.reply(msg("whoami", { userId: user.id }));
  });

  bot.command("myrole", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }
    return ctx.reply(msg("myRole", { role: getUserRole(config, user.id) }));
  });

  bot.command("adminpanel", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply(msg("userNotDetected"));
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply(msg("adminOnly"));
    }
    await sendAdminPanelEntry(ctx, user.id);
  });

  bot.command("newcontest", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `newcontest:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "newcontest_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const payload = parseCommandArgs(extractText(ctx));
    const [titleRaw, endsAtRaw, winnersRaw] = payload.split("|").map((item) => item?.trim());
    const title = titleRaw ?? "";
    const endsAt = endsAtRaw ?? "";
    const maxWinners = Number(winnersRaw ?? "1");

    if (!title || !endsAt || !Number.isFinite(maxWinners) || maxWinners < 1) {
      return ctx.reply(
        "Неверный формат.\nПример:\n/newcontest iPhone giveaway | 2026-12-31T20:00:00Z | 3",
      );
    }

    const parsedDate = new Date(endsAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return ctx.reply("Дата окончания некорректна. Используйте ISO формат.");
    }

    const contest: Contest = {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      endsAt: parsedDate.toISOString(),
      maxWinners: Math.floor(maxWinners),
      status: "active",
      requiredChats: [],
      participants: [],
      winners: [],
      auditLog: [
        {
          at: new Date().toISOString(),
          action: "created",
          actorId: user.id,
          details: `Создан конкурс "${title}"`,
        },
      ],
    };

    storage.create(contest);
    logger.info("contest_created", { contestId: contest.id, actorId: user.id });
    return ctx.reply(
      `Конкурс создан.\nID: ${contest.id}\nНазвание: ${contest.title}\nЗавершение: ${contest.endsAt}\nПобедителей: ${contest.maxWinners}`,
    );
  });

  bot.command("contests", (ctx: Ctx) => {
    const contests = storage.list();
    if (contests.length === 0) {
      return ctx.reply("Пока нет созданных конкурсов.");
    }
    return ctx.reply(["Текущие конкурсы:", ...contests.map(toContestLine)].join("\n"));
  });

  bot.command("setrequired", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `setrequired:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "setrequired_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const argsRaw = parseCommandArgs(extractText(ctx));
    const [contestId, ...rawChatParts] = argsRaw.split(" ").filter(Boolean);
    if (!contestId || rawChatParts.length === 0) {
      return ctx.reply("Формат: /setrequired contest_id chat_id[,chat_id2,...]");
    }

    const requiredChats = parseRequiredChatIds(rawChatParts.join(" "));
    const uniqueRequiredChats = [...new Set(requiredChats)];
    if (uniqueRequiredChats.length === 0) {
      return ctx.reply("Нужно передать хотя бы один валидный числовой chat_id.");
    }

    const updated = storage.update(contestId, (contest) => ({
      ...contest,
      requiredChats: uniqueRequiredChats,
    }));
    if (!updated) {
      return ctx.reply("Конкурс не найден.");
    }

    return ctx.reply(
      `Обязательные чаты для конкурса "${updated.title}" обновлены: ${updated.requiredChats.join(", ")}`,
    );
  });

  bot.command("join", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const cooldown = hitCooldown(commandCooldowns, `join:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "join_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const { contestId, referrerId } = parseJoinArgs(parseCommandArgs(extractText(ctx)));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /join contest_id [referrer_user_id]");
    }

    const result = await tryJoinContest(bot, config, storage, contestId, user, referrerId);
    if (!result.ok) {
      return ctx.reply(result.message);
    }
    if (result.already) {
      logger.info("contest_join_duplicate", { contestId, userId: user.id });
      return ctx.reply(
        `Вы уже участвуете в конкурсе "${result.contest.title}". Участников: ${result.contest.participants.length}`,
      );
    }

    logger.info("contest_join", { contestId, userId: user.id });
    return ctx.reply(
      `Вы участвуете в конкурсе "${result.contest.title}". Всего участников: ${result.contest.participants.length}`,
    );
  });

  bot.command("proof", (ctx: Ctx) => {
    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Формат: /proof contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (!contest.drawSeed) {
      return ctx.reply("Для этого конкурса пока нет proof seed (жеребьевка еще не выполнена).");
    }

    return ctx.reply(
      [
        `Proof конкурса #${contest.id}`,
        `Название: ${contest.title}`,
        `Статус: ${contest.status}`,
        `Participants: ${contest.participants.length}`,
        `Winners: ${contest.winners.join(", ") || "-"}`,
        `Seed: ${contest.drawSeed}`,
        `Формула seed: sha256(contest.id|endsAt|participants.length)`,
      ].join("\n"),
    );
  });

  bot.command("contestaudit", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Формат: /contestaudit contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    const entries = contest.auditLog ?? [];
    if (entries.length === 0) {
      return ctx.reply("Аудит пуст.");
    }

    const tail = entries.slice(-10);
    const lines = tail.map(
      (entry) =>
        `${entry.at} | ${entry.action} | actor=${entry.actorId}${entry.details ? ` | ${entry.details}` : ""}`,
    );
    return ctx.reply([`Аудит конкурса ${contest.id} (последние ${tail.length}):`, ...lines].join("\n"));
  });

  bot.command("editcontest", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `editcontest:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "editcontest_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const parsed = parseEditContestArgs(parseCommandArgs(extractText(ctx)));
    if (!parsed) {
      return ctx.reply("Формат: /editcontest contest_id | title|- | endsAt|- | winners|-");
    }

    const updated = storage.update(parsed.contestId, (contest) => {
      let nextEndsAt = contest.endsAt;
      if (parsed.endsAt) {
        const date = new Date(parsed.endsAt);
        if (!Number.isNaN(date.getTime())) {
          nextEndsAt = date.toISOString();
        }
      }

      return withAuditEntry(
        {
          ...contest,
          ...(parsed.title ? { title: parsed.title } : {}),
          ...(parsed.maxWinners ? { maxWinners: parsed.maxWinners } : {}),
          endsAt: nextEndsAt,
        },
        {
          at: new Date().toISOString(),
          action: "edited",
          actorId: user.id,
          details: `title=${parsed.title ?? "-"}, endsAt=${parsed.endsAt ?? "-"}, maxWinners=${parsed.maxWinners ?? "-"}`,
        },
      );
    });
    if (!updated) {
      return ctx.reply("Конкурс не найден.");
    }

    if (parsed.endsAt) {
      const date = new Date(parsed.endsAt);
      if (Number.isNaN(date.getTime())) {
        return ctx.reply("Конкурс обновлен, но endsAt проигнорирован: передана некорректная дата.");
      }
    }

    logger.info("contest_edited", { contestId: updated.id, actorId: user.id });
    return ctx.reply(
      `Конкурс обновлен: ${updated.title}\nID: ${updated.id}\nendsAt: ${updated.endsAt}\nmaxWinners: ${updated.maxWinners}`,
    );
  });

  bot.command("closecontest", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canModerateContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `closecontest:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "closecontest_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Формат: /closecontest contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status === "completed") {
      return ctx.reply("Конкурс уже завершен.");
    }

    let updated: Contest | undefined;
    if (contest.participants.length === 0) {
      updated = storage.update(contest.id, (prev) =>
        withAuditEntry(
          { ...prev, status: "completed" },
          {
            at: new Date().toISOString(),
            action: "closed",
            actorId: user.id,
            details: "Принудительное закрытие без участников",
          },
        ),
      );
    } else {
      const result = runDeterministicDraw(contest);
      updated = storage.update(contest.id, (prev) =>
        withAuditEntry(
          {
            ...prev,
            status: "completed",
            winners: result.winners,
            drawSeed: result.seed,
          },
          {
            at: new Date().toISOString(),
            action: "closed",
            actorId: user.id,
            details: `Принудительное закрытие, winners=${result.winners.join(",") || "none"}`,
          },
        ),
      );
    }

    if (!updated) {
      return ctx.reply("Не удалось закрыть конкурс.");
    }

    logger.warn("contest_closed_forced", { contestId: updated.id, actorId: user.id });
    await publishContestResults(bot, updated);
    return ctx.reply(
      `Конкурс принудительно закрыт: ${updated.title}\nПобедители: ${updated.winners.join(", ") || "нет"}`,
    );
  });

  bot.command("reopencontest", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `reopencontest:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "reopencontest_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const args = parseCommandArgs(extractText(ctx)).split(" ").filter(Boolean);
    const contestId = args[0];
    const endsAtRaw = args[1];
    if (!contestId || !endsAtRaw) {
      return ctx.reply("Формат: /reopencontest contest_id ISO_endsAt");
    }

    const parsedDate = new Date(endsAtRaw);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() <= Date.now()) {
      return ctx.reply("Укажите корректную будущую ISO-дату.");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status !== "completed") {
      return ctx.reply("Переоткрыть можно только завершенный конкурс.");
    }

    const updated = storage.update(contestId, (prev) => {
      const { drawSeed: _dropDrawSeed, ...withoutDrawSeed } = prev;
      return withAuditEntry(
        {
          ...withoutDrawSeed,
          status: "active",
          endsAt: parsedDate.toISOString(),
          winners: [],
        },
        {
          at: new Date().toISOString(),
          action: "reopened",
          actorId: user.id,
          details: `Новая дата окончания=${parsedDate.toISOString()}`,
        },
      );
    });
    if (!updated) {
      return ctx.reply("Не удалось переоткрыть конкурс.");
    }

    logger.warn("contest_reopened", { contestId: updated.id, actorId: user.id });
    return ctx.reply(`Конкурс переоткрыт: ${updated.title}\nНовая дата: ${updated.endsAt}`);
  });

  bot.command("myref", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Формат: /myref contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }

    return ctx.reply(
      [
        `Ваш ref ID: ${user.id}`,
        `Приглашайте так: /join ${contestId} ${user.id}`,
        `Быстрый формат через start: /start join:${contestId}:${user.id}`,
        `Бонус за реферала: +${config.referralBonusTickets} бил.`,
        `Макс бонус на пользователя: +${config.referralMaxBonusTickets} бил.`,
      ].join("\n"),
    );
  });

  bot.command("publish", async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canManageContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const cooldown = hitCooldown(commandCooldowns, `publish:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "publish_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`);
    }

    const argsRaw = parseCommandArgs(extractText(ctx));
    const [contestId, chatIdRaw, ...textParts] = argsRaw.split(" ").filter(Boolean);
    if (!contestId || !chatIdRaw) {
      return ctx.reply("Формат: /publish contest_id chat_id [текст_поста]");
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isFinite(chatId)) {
      return ctx.reply("chat_id должен быть числом.");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }

    const postText =
      textParts.join(" ").trim() ||
      [
        `Конкурс: ${contest.title}`,
        'Условия: нажать кнопку "Участвовать"',
        `Окончание: ${contest.endsAt}`,
        `Рефералка: /myref ${contest.id} (бонус +${config.referralBonusTickets}, лимит +${config.referralMaxBonusTickets})`,
        contest.requiredChats.length > 0
          ? `Обязательные чаты: ${contest.requiredChats.join(", ")}`
          : "Обязательных чатов нет",
      ].join("\n");

    const message = await bot.api.sendMessageToChat(chatId, postText, {
      attachments: [
        Keyboard.inlineKeyboard([[Keyboard.button.callback("Участвовать", `join:${contest.id}`)]]),
      ],
    });

    storage.update(contest.id, (prev) => ({
      ...prev,
      publishChatId: chatId,
      publishMessageId: message.body?.mid ?? undefined,
    }));

    logger.info("contest_published", { contestId: contest.id, chatId, actorId: user.id });
    return ctx.reply(`Конкурс опубликован в chat_id=${chatId}.`);
  });

  bot.action(/^join:(.+)$/, async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      await ctx.answerOnCallback({ notification: "Не удалось определить пользователя." });
      return;
    }

    const cooldown = hitCooldown(commandCooldowns, `join_callback:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!cooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "join_callback_cooldown", user.id);
      await ctx.answerOnCallback({
        notification: `Слишком часто. Повторите через ${cooldown.waitSeconds} сек.`,
      });
      return;
    }

    const payload = ctx.callback?.payload ?? "";
    const contestId = String(payload).replace(/^join:/, "");
    if (!contestId) {
      await ctx.answerOnCallback({ notification: "Некорректный payload." });
      return;
    }

    const result = await tryJoinContest(bot, config, storage, contestId, user);
    if (!result.ok) {
      await ctx.answerOnCallback({ notification: result.message });
      return;
    }

    if (!result.already) {
      logger.info("contest_join_callback", { contestId, userId: user.id });
    }
    await ctx.answerOnCallback({
      notification: result.already
        ? `Вы уже участвуете. Участников: ${result.contest.participants.length}`
        : `Участие принято. Участников: ${result.contest.participants.length}`,
    });
  });

  bot.action(/^wizard:(.+)$/, async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      await ctx.answerOnCallback({ notification: msg("userNotDetected") });
      return;
    }
    if (!canManageContest(config, user.id)) {
      await ctx.answerOnCallback({ notification: "Только owner/admin." });
      return;
    }
    const payload = String(ctx.callback?.payload ?? "");
    const action = payload.replace(/^wizard:/, "");

    if (action === "start") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildWizardIntroMessage(config.defaultLocale), {
        attachments: [buildWizardKeyboard(config.defaultLocale)],
      });
      return;
    }

    if (action === "create_demo") {
      const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const contest: Contest = {
        id: crypto.randomBytes(4).toString("hex"),
        title: `DEMO Розыгрыш ${new Date().toLocaleDateString("ru-RU")}`,
        createdBy: user.id,
        createdAt: new Date().toISOString(),
        endsAt,
        maxWinners: 1,
        status: "active",
        requiredChats: [],
        participants: [],
        winners: [],
        auditLog: [
          {
            at: new Date().toISOString(),
            action: "created",
            actorId: user.id,
            details: "Создан через wizard",
          },
        ],
      };
      storage.create(contest);
      wizardState.set(user.id, contest.id);
      await ctx.answerOnCallback({ notification: "Создано" });
      await ctx.reply(
        [
          `Демо-конкурс создан: ${contest.id}`,
          "Следующий шаг: нажмите кнопку '2) Опубликовать сюда'.",
          `Или вручную: /publish ${contest.id} chat_id`,
        ].join("\n"),
        { attachments: [buildWizardKeyboard(config.defaultLocale)] },
      );
      return;
    }

    const contest = resolveWizardContest(user.id);
    if (!contest) {
      await ctx.answerOnCallback({ notification: "Сначала создайте демо-конкурс (шаг 1)." });
      return;
    }

    if (action === "publish_here") {
      const chatId = extractChatId(ctx);
      if (!chatId) {
        await ctx.answerOnCallback({ notification: "Не удалось определить текущий чат." });
        return;
      }
      const postText = [
        `🎁 ${contest.title}`,
        "Нажмите кнопку 'Участвовать' ниже.",
        `Окончание: ${contest.endsAt}`,
        `Проверка честности: /proof ${contest.id}`,
      ].join("\n");

      const message = await bot.api.sendMessageToChat(chatId, postText, {
        attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback("Участвовать", `join:${contest.id}`)]])],
      });
      storage.update(contest.id, (prev) => ({
        ...prev,
        publishChatId: chatId,
        publishMessageId: message.body?.mid ?? undefined,
      }));
      await ctx.answerOnCallback({ notification: "Опубликовано" });
      await ctx.reply("Пост опубликован в текущий чат. Далее нажмите '3) Статус'.", {
        attachments: [buildWizardKeyboard(config.defaultLocale)],
      });
      return;
    }

    if (action === "status") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(
        [
          `Contest: ${contest.id}`,
          `Статус: ${contest.status}`,
          `Участников: ${contest.participants.length}`,
          `Победители: ${contest.winners.join(", ") || "-"}`,
        ].join("\n"),
        { attachments: [buildWizardKeyboard(config.defaultLocale)] },
      );
      return;
    }

    if (action === "draw") {
      if (contest.status !== "active") {
        await ctx.answerOnCallback({ notification: "Конкурс уже завершен." });
        return;
      }
      if (contest.participants.length === 0) {
        await ctx.answerOnCallback({ notification: "Нет участников. Сначала пусть нажмут Join." });
        return;
      }
      const result = runDeterministicDraw(contest);
      const updated = storage.update(contest.id, (prev) =>
        withAuditEntry(
          {
            ...prev,
            status: "completed",
            winners: result.winners,
            drawSeed: result.seed,
          },
          {
            at: new Date().toISOString(),
            action: "draw",
            actorId: user.id,
            details: "draw через wizard",
          },
        ),
      );
      if (!updated) {
        await ctx.answerOnCallback({ notification: "Ошибка draw." });
        return;
      }
      await ctx.answerOnCallback({ notification: "Draw выполнен" });
      await ctx.reply(
        [`Победители: ${updated.winners.join(", ")}`, `Proof seed: ${updated.drawSeed ?? "-"}`].join("\n"),
        { attachments: [buildWizardKeyboard(config.defaultLocale)] },
      );
      return;
    }

    if (action === "proof") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(
        [
          `Contest: ${contest.id}`,
          `Status: ${contest.status}`,
          `Seed: ${contest.drawSeed ?? "еще не сгенерирован (сначала draw)"}`,
          `Winners: ${contest.winners.join(", ") || "-"}`,
        ].join("\n"),
      );
      return;
    }

    await ctx.answerOnCallback({ notification: "Неизвестное действие wizard." });
  });

  bot.action(/^help:(.+)$/, async (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      await ctx.answerOnCallback({ notification: msg("userNotDetected") });
      return;
    }
    const payload = String(ctx.callback?.payload ?? "");
    const action = payload.replace(/^help:/, "");

    if (action === "whoami") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(msg("whoami", { userId: user.id }));
      return;
    }
    if (action === "myrole") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(msg("myRole", { role: getUserRole(config, user.id) }));
      return;
    }
    if (action === "contests") {
      await ctx.answerOnCallback({ notification: "OK" });
      const contests = storage.list();
      await ctx.reply(
        contests.length === 0 ? "Пока нет созданных конкурсов." : ["Текущие конкурсы:", ...contests.map(toContestLine)].join("\n"),
      );
      return;
    }
    if (action === "templates") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildCommandTemplates(config.defaultLocale));
      return;
    }
    if (action === "guide_user") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildSchoolUserGuideMessage(config.defaultLocale));
      return;
    }
    if (action === "guide_admin") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildAdminIntegrationGuideMessage(config.defaultLocale));
      return;
    }
    if (action === "faq") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildFaqMessage(config.defaultLocale));
      return;
    }
    if (action === "post_template") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildPostTemplateMessage(config.defaultLocale));
      return;
    }
    if (action === "nextsteps") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply(buildNextStepsMessage(config.defaultLocale));
      return;
    }
    if (action === "adminpanel") {
      if (!canManageContest(config, user.id)) {
        await ctx.answerOnCallback({ notification: msg("adminOnly") });
        return;
      }
      await ctx.answerOnCallback({ notification: "Открываю админку..." });
      await sendAdminPanelEntry(ctx, user.id);
      return;
    }
    if (action === "draw_hint") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply("Подсказка: сначала /contests, затем /draw contest_id.");
      return;
    }
    if (action === "reroll_hint") {
      await ctx.answerOnCallback({ notification: "OK" });
      await ctx.reply("Подсказка: reroll доступен после завершения конкурса: /reroll contest_id.");
      return;
    }

    await ctx.answerOnCallback({ notification: "Неизвестное действие." });
  });

  bot.command("draw", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canModerateContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const userCooldown = hitCooldown(commandCooldowns, `draw:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!userCooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "draw_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${userCooldown.waitSeconds} сек.`);
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /draw contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status !== "active") {
      return ctx.reply("Конкурс уже завершен. Используйте /reroll для перевыбора.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
    }
    const lock = hitCooldown(drawLocks, `draw:${contest.id}`, DRAW_LOCK_TTL_MS);
    if (!lock.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "draw_lock", user.id);
      return ctx.reply(`Жеребьевка уже выполняется. Повторите через ${lock.waitSeconds} сек.`);
    }

    const result = runDeterministicDraw(contest);
    const updated = storage.update(contest.id, (prev) =>
      withAuditEntry(
        {
          ...prev,
          status: "completed",
          winners: result.winners,
          drawSeed: result.seed,
        },
        {
          at: new Date().toISOString(),
          action: "draw",
          actorId: user.id,
          details: `winners=${result.winners.join(",") || "none"}`,
        },
      ),
    );

    if (!updated) {
      return ctx.reply("Не удалось завершить конкурс.");
    }

    logger.info("contest_draw", { contestId: updated.id, actorId: user.id, winners: updated.winners });
    void publishContestResults(bot, updated);

    return ctx.reply(
      [
        `Конкурс завершен: ${updated.title}`,
        `Winners: ${updated.winners.join(", ")}`,
        `Proof seed: ${updated.drawSeed}`,
      ].join("\n"),
    );
  });

  bot.command("reroll", (ctx: Ctx) => {
    const user = extractUser(ctx);
    if (!user) {
      return ctx.reply("Не удалось определить пользователя.");
    }
    if (!canModerateContest(config, user.id)) {
      return ctx.reply("Эта команда доступна только администраторам.");
    }
    const userCooldown = hitCooldown(commandCooldowns, `reroll:${user.id}`, COMMAND_COOLDOWN_MS);
    if (!userCooldown.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "reroll_cooldown", user.id);
      return ctx.reply(`Слишком часто. Повторите через ${userCooldown.waitSeconds} сек.`);
    }

    const contestId = parseCommandArgs(extractText(ctx));
    if (!contestId) {
      return ctx.reply("Укажите ID конкурса: /reroll contest_id");
    }

    const contest = storage.get(contestId);
    if (!contest) {
      return ctx.reply("Конкурс не найден.");
    }
    if (contest.status !== "completed") {
      return ctx.reply("Reroll доступен только после завершения конкурса.");
    }
    if (contest.participants.length === 0) {
      return ctx.reply("В конкурсе нет участников.");
    }
    const lock = hitCooldown(drawLocks, `reroll:${contest.id}`, DRAW_LOCK_TTL_MS);
    if (!lock.ok) {
      notifySuspiciousIfNeeded(bot, config, logger, suspiciousActivity, "reroll_lock", user.id);
      return ctx.reply(`Reroll уже выполняется. Повторите через ${lock.waitSeconds} сек.`);
    }

    const result = runDeterministicDraw({
      ...contest,
      endsAt: new Date().toISOString(),
    });

    const updated = storage.update(contest.id, (prev) =>
      withAuditEntry(
        {
          ...prev,
          status: "completed",
          winners: result.winners,
          drawSeed: result.seed,
        },
        {
          at: new Date().toISOString(),
          action: "reroll",
          actorId: user.id,
          details: `winners=${result.winners.join(",") || "none"}`,
        },
      ),
    );

    if (!updated) {
      return ctx.reply("Не удалось выполнить reroll.");
    }

    logger.info("contest_reroll", { contestId: updated.id, actorId: user.id, winners: updated.winners });
    void publishContestResults(bot, updated);

    return ctx.reply(
      [
        `Reroll выполнен: ${updated.title}`,
        `Новые победители: ${updated.winners.join(", ")}`,
        `Proof seed: ${updated.drawSeed}`,
      ].join("\n"),
    );
  });

  setInterval(() => {
    void autoFinishExpiredContests(bot, storage);
  }, 15000);

  if (config.adminAlertDigestIntervalMs > 0) {
    setInterval(() => {
      void notifyAlertDigestIfNeeded(bot, config, logger, storage, alertDigestState);
    }, config.adminAlertDigestIntervalMs);
  }

  return bot;
}

export const __testables = {
  extractUser,
  extractChatId,
  buildHelpMessage,
  buildHelpKeyboard,
  buildCommandTemplates,
  buildNextStepsMessage,
  canUseLinkButtonUrl,
  describeAdminPanelMode,
  buildStatusMessage,
  buildSchoolUserGuideMessage,
  buildAdminIntegrationGuideMessage,
  buildFaqMessage,
  buildPostTemplateMessage,
  buildWizardIntroMessage,
  buildWizardKeyboard,
  buildAlertDigestSignature,
  formatAlertDigestMessage,
  buildAdminPanelUrl,
  parseCommandArgs,
  parseRequiredChatIds,
  parseJoinArgs,
  parseStartJoinPayload,
  parseEditContestArgs,
  getUserRole,
  canManageContest,
  canModerateContest,
  hitCooldown,
  hitSuspiciousCounter,
};
