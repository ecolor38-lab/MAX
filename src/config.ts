import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN is required"),
  ADMIN_USER_IDS: z.string().optional().default(""),
  STORAGE_PATH: z.string().optional().default("data/contests.json"),
});

export type AppConfig = {
  botToken: string;
  adminUserIds: Set<string>;
  storagePath: string;
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

  return {
    botToken: parsed.data.BOT_TOKEN,
    adminUserIds,
    storagePath: parsed.data.STORAGE_PATH,
  };
}
