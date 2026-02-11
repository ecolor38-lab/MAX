import assert from "node:assert";
import { afterEach, describe, it } from "node:test";

import { loadConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function withEnv(values: Record<string, string | undefined>): void {
  process.env = {
    ...ORIGINAL_ENV,
    ...values,
  };
}

describe("loadConfig", () => {
  it("parses explicit env values", () => {
    withEnv({
      BOT_TOKEN: "token-token-token",
      OWNER_USER_ID: "10",
      ADMIN_USER_IDS: "10, 11,12",
      MODERATOR_USER_IDS: "20, 21",
      STORAGE_PATH: "data/custom.db",
      REFERRAL_BONUS_TICKETS: "2",
      REFERRAL_MAX_BONUS_TICKETS: "9",
      LOG_PATH: "data/custom.log",
      DEFAULT_LOCALE: "en",
      ADMIN_PANEL_URL: "http://localhost:8787/adminpanel",
      ADMIN_PANEL_SECRET: "secret",
      ADMIN_PANEL_PORT: "8788",
      ADMIN_PANEL_TOKEN_TTL_MS: "120000",
      ADMIN_PANEL_RATE_LIMIT_WINDOW_MS: "30000",
      ADMIN_PANEL_RATE_LIMIT_MAX: "77",
      ADMIN_PANEL_IP_ALLOWLIST: "127.0.0.1, ::1",
      ADMIN_ALERT_DIGEST_INTERVAL_MS: "61000",
    });

    const config = loadConfig();
    assert.strictEqual(config.botToken, "token-token-token");
    assert.strictEqual(config.ownerUserId, "10");
    assert.deepStrictEqual([...config.adminUserIds], ["10", "11", "12"]);
    assert.deepStrictEqual([...config.moderatorUserIds], ["20", "21"]);
    assert.strictEqual(config.storagePath, "data/custom.db");
    assert.strictEqual(config.referralBonusTickets, 2);
    assert.strictEqual(config.referralMaxBonusTickets, 9);
    assert.strictEqual(config.logPath, "data/custom.log");
    assert.strictEqual(config.defaultLocale, "en");
    assert.strictEqual(config.adminPanelUrl, "http://localhost:8787/adminpanel");
    assert.strictEqual(config.adminPanelSecret, "secret");
    assert.strictEqual(config.adminPanelPort, 8788);
    assert.strictEqual(config.adminPanelTokenTtlMs, 120000);
    assert.strictEqual(config.adminPanelRateLimitWindowMs, 30000);
    assert.strictEqual(config.adminPanelRateLimitMax, 77);
    assert.deepStrictEqual([...config.adminPanelIpAllowlist], ["127.0.0.1", "::1"]);
    assert.strictEqual(config.adminAlertDigestIntervalMs, 61000);
  });

  it("applies defaults for optional values", () => {
    withEnv({
      BOT_TOKEN: "token-token-token",
      OWNER_USER_ID: "",
      ADMIN_USER_IDS: "",
      MODERATOR_USER_IDS: "",
      ADMIN_PANEL_URL: "",
      ADMIN_PANEL_SECRET: "",
      ADMIN_PANEL_IP_ALLOWLIST: "",
    });

    const config = loadConfig();
    assert.strictEqual(config.ownerUserId, undefined);
    assert.strictEqual(config.adminPanelUrl, undefined);
    assert.strictEqual(config.adminPanelSecret, undefined);
    assert.strictEqual(config.storagePath, "data/contests.db");
    assert.strictEqual(config.referralBonusTickets, 1);
    assert.strictEqual(config.referralMaxBonusTickets, 5);
    assert.strictEqual(config.logPath, "data/bot.log");
    assert.strictEqual(config.defaultLocale, "ru");
    assert.strictEqual(config.adminPanelPort, 8787);
    assert.strictEqual(config.adminPanelTokenTtlMs, 10 * 60 * 1000);
    assert.strictEqual(config.adminPanelRateLimitWindowMs, 60_000);
    assert.strictEqual(config.adminPanelRateLimitMax, 120);
    assert.strictEqual(config.adminAlertDigestIntervalMs, 300_000);
    assert.deepStrictEqual([...config.adminUserIds], []);
    assert.deepStrictEqual([...config.moderatorUserIds], []);
    assert.deepStrictEqual([...config.adminPanelIpAllowlist], []);
  });

  it("throws on invalid token", () => {
    withEnv({
      BOT_TOKEN: "short",
    });
    assert.throws(() => loadConfig(), /Invalid environment/);
  });
});
