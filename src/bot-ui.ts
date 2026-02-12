import { Keyboard } from "@maxhub/max-bot-api";

import { t, type SupportedLocale } from "./i18n";

export function buildHelpMessage(locale: SupportedLocale): string {
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

export function buildCommandTemplates(locale: SupportedLocale): string {
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

export function buildHelpKeyboard(locale: SupportedLocale, canManage: boolean): ReturnType<typeof Keyboard.inlineKeyboard> {
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
      [Keyboard.button.callback(L ? "Open admin panel" : "Открыть админку", "help:adminpanel")],
      [
        Keyboard.button.callback(L ? "Draw hint" : "Подсказка draw", "help:draw_hint"),
        Keyboard.button.callback(L ? "Reroll hint" : "Подсказка reroll", "help:reroll_hint"),
      ],
    );
  }
  return Keyboard.inlineKeyboard(rows);
}

export function buildNextStepsMessage(locale: SupportedLocale): string {
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

export function canUseLinkButtonUrl(rawUrl: string): boolean {
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

export function describeAdminPanelMode(adminPanelUrl?: string): "disabled" | "local" | "public" {
  if (!adminPanelUrl) {
    return "disabled";
  }
  return canUseLinkButtonUrl(adminPanelUrl) ? "public" : "local";
}

export function buildStatusMessage(input: {
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

export function buildSchoolUserGuideMessage(locale: SupportedLocale): string {
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

export function buildAdminIntegrationGuideMessage(locale: SupportedLocale): string {
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

export function buildFaqMessage(locale: SupportedLocale): string {
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

export function buildPostTemplateMessage(locale: SupportedLocale): string {
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

export function buildWizardIntroMessage(locale: SupportedLocale): string {
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

export function buildWizardKeyboard(locale: SupportedLocale): ReturnType<typeof Keyboard.inlineKeyboard> {
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

