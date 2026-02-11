export type SupportedLocale = "ru" | "en";

type I18nKey =
  | "userNotDetected"
  | "adminOnly"
  | "tooFrequent"
  | "contestNotFound"
  | "startTitle"
  | "startCommandsLabel"
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

