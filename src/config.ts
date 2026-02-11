import { z } from "zod";
import type { SupportedLocale } from "./i18n";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN is required"),
  OWNER_USER_ID: z.string().optional().default(""),
  ADMIN_USER_IDS: z.string().optional().default(""),
  MODERATOR_USER_IDS: z.string().optional().default(""),
  STORAGE_PATH: z.string().optional().default("data/contests.db"),
  REFERRAL_BONUS_TICKETS: z.coerce.number().int().min(0).default(1),
  REFERRAL_MAX_BONUS_TICKETS: z.coerce.number().int().min(0).default(5),
  LOG_PATH: z.string().optional().default("data/bot.log"),
  DEFAULT_LOCALE: z.enum(["ru", "en"]).default("ru"),
  ADMIN_PANEL_URL: z.string().optional().default(""),
  ADMIN_PANEL_SECRET: z.string().optional().default(""),
  ADMIN_PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export type AppConfig = {
  botToken: string;
  ownerUserId?: string;
  adminUserIds: Set<string>;
  moderatorUserIds: Set<string>;
  storagePath: string;
  referralBonusTickets: number;
  referralMaxBonusTickets: number;
  logPath: string;
  defaultLocale: SupportedLocale;
  adminPanelUrl?: string;
  adminPanelSecret?: string;
  adminPanelPort: number;
};

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }

  const adminUserIds = new Set(
    parsed.data.ADMIN_USER_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const moderatorUserIds = new Set(
    parsed.data.MODERATOR_USER_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const ownerUserId = parsed.data.OWNER_USER_ID.trim() || undefined;
  const adminPanelUrl = parsed.data.ADMIN_PANEL_URL.trim() || undefined;
  const adminPanelSecret = parsed.data.ADMIN_PANEL_SECRET.trim() || undefined;

  return {
    botToken: parsed.data.BOT_TOKEN,
    ...(ownerUserId ? { ownerUserId } : {}),
    adminUserIds,
    moderatorUserIds,
    storagePath: parsed.data.STORAGE_PATH,
    referralBonusTickets: parsed.data.REFERRAL_BONUS_TICKETS,
    referralMaxBonusTickets: parsed.data.REFERRAL_MAX_BONUS_TICKETS,
    logPath: parsed.data.LOG_PATH,
    defaultLocale: parsed.data.DEFAULT_LOCALE,
    adminPanelPort: parsed.data.ADMIN_PANEL_PORT,
    ...(adminPanelUrl ? { adminPanelUrl } : {}),
    ...(adminPanelSecret ? { adminPanelSecret } : {}),
  };
}
