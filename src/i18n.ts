export type SupportedLocale = "ru" | "en";

type I18nKey =
  | "userNotDetected"
  | "adminOnly"
  | "tooFrequent"
  | "contestNotFound"
  | "startTitle"
  | "startCommandsLabel"
  | "helpTitle"
  | "helpQuickStartLabel"
  | "helpPublicCommandsLabel"
  | "helpAdminCommandsLabel"
  | "helpHint"
  | "whoami"
  | "myRole";

const DICT: Record<SupportedLocale, Record<I18nKey, string>> = {
  ru: {
    userNotDetected: "Не удалось определить пользователя.",
    adminOnly: "Эта команда доступна только администраторам.",
    tooFrequent: "Слишком часто. Повторите через {{seconds}} сек.",
    contestNotFound: "Конкурс не найден.",
    startTitle: "MAX Contest Bot запущен.",
    startCommandsLabel: "Команды:",
    helpTitle: "MAX Contest Bot — справка",
    helpQuickStartLabel: "Быстрый старт:",
    helpPublicCommandsLabel: "Публичные команды:",
    helpAdminCommandsLabel: "Админ-команды:",
    helpHint: "Подсказка: сначала создайте конкурс, затем публикуйте и проводите draw.",
    whoami: "Ваш user ID: {{userId}}",
    myRole: "Ваша роль: {{role}}",
  },
  en: {
    userNotDetected: "Could not detect user.",
    adminOnly: "This command is available to admins only.",
    tooFrequent: "Too frequent. Try again in {{seconds}} sec.",
    contestNotFound: "Contest not found.",
    startTitle: "MAX Contest Bot started.",
    startCommandsLabel: "Commands:",
    helpTitle: "MAX Contest Bot — help",
    helpQuickStartLabel: "Quick start:",
    helpPublicCommandsLabel: "Public commands:",
    helpAdminCommandsLabel: "Admin commands:",
    helpHint: "Tip: create contest first, then publish and run draw.",
    whoami: "Your user ID: {{userId}}",
    myRole: "Your role: {{role}}",
  },
};

export function t(
  locale: SupportedLocale,
  key: I18nKey,
  vars?: Record<string, string | number>,
): string {
  const template = DICT[locale]?.[key] ?? DICT.ru[key];
  if (!vars) {
    return template;
  }
  return Object.entries(vars).reduce(
    (acc, [varName, value]) => acc.replaceAll(`{{${varName}}}`, String(value)),
    template,
  );
}

