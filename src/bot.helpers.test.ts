import { describe, it } from "node:test";
import assert from "node:assert";

import type { AppConfig } from "./config";
import { __testables } from "./bot";

function mkConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    botToken: "token-token-token",
    storagePath: "data/test.db",
    adminUserIds: new Set(["2"]),
    moderatorUserIds: new Set(["3"]),
    referralBonusTickets: 1,
    referralMaxBonusTickets: 5,
    logPath: "data/test.log",
    defaultLocale: "ru",
    adminPanelPort: 8787,
    adminPanelTokenTtlMs: 600_000,
    adminPanelRateLimitWindowMs: 60_000,
    adminPanelRateLimitMax: 120,
    adminPanelIpAllowlist: new Set(),
    adminAlertDigestIntervalMs: 300_000,
  };
  return Object.assign(base, overrides);
}

describe("bot testable helpers", () => {
  it("extracts user from both property and function context forms", () => {
    assert.deepStrictEqual(
      __testables.extractUser({
        user: {
          userId: 42,
          username: "alice",
        },
      }),
      { id: "42", username: "alice" },
    );

    assert.deepStrictEqual(
      __testables.extractUser({
        user: () => ({
          userId: 77,
          name: "bob",
        }),
      }),
      { id: "77", username: "bob" },
    );

    assert.deepStrictEqual(
      __testables.extractUser({
        update: {
          sender: {
            user_id: 99,
            first_name: "Andrey",
            last_name: "Max",
          },
        },
      }),
      { id: "99", username: "Andrey Max" },
    );
  });

  it("parses command args", () => {
    assert.strictEqual(__testables.parseCommandArgs("/join abc def"), "abc def");
    assert.strictEqual(__testables.parseCommandArgs("/start"), "");
  });

  it("parses required chat ids", () => {
    assert.deepStrictEqual(__testables.parseRequiredChatIds("1,2 3"), [1, 2, 3]);
    assert.deepStrictEqual(__testables.parseRequiredChatIds("a, 10"), [10]);
  });

  it("parses join and start payload", () => {
    assert.deepStrictEqual(__testables.parseJoinArgs("contest1 ref1"), {
      contestId: "contest1",
      referrerId: "ref1",
    });
    assert.deepStrictEqual(__testables.parseStartJoinPayload("join:c1:r1"), {
      contestId: "c1",
      referrerId: "r1",
    });
    assert.deepStrictEqual(__testables.parseStartJoinPayload("join:c1"), {
      contestId: "c1",
    });
  });

  it("parses edit contest args", () => {
    assert.deepStrictEqual(__testables.parseEditContestArgs("c1 | title | 2026-01-01T00:00:00Z | 2"), {
      contestId: "c1",
      title: "title",
      endsAt: "2026-01-01T00:00:00Z",
      maxWinners: 2,
    });
    assert.deepStrictEqual(__testables.parseEditContestArgs("c1 | - | - | -"), {
      contestId: "c1",
    });
    assert.strictEqual(__testables.parseEditContestArgs("c1 | t | e | 0"), null);
  });

  it("resolves roles and permissions", () => {
    const config = mkConfig({ ownerUserId: "1" });
    assert.strictEqual(__testables.getUserRole(config, "1"), "owner");
    assert.strictEqual(__testables.getUserRole(config, "2"), "admin");
    assert.strictEqual(__testables.getUserRole(config, "3"), "moderator");
    assert.strictEqual(__testables.getUserRole(config, "4"), "user");

    assert.strictEqual(__testables.canManageContest(config, "1"), true);
    assert.strictEqual(__testables.canManageContest(config, "2"), true);
    assert.strictEqual(__testables.canManageContest(config, "3"), false);

    assert.strictEqual(__testables.canModerateContest(config, "1"), true);
    assert.strictEqual(__testables.canModerateContest(config, "2"), true);
    assert.strictEqual(__testables.canModerateContest(config, "3"), true);
    assert.strictEqual(__testables.canModerateContest(config, "4"), false);

  });

  it("handles cooldown and suspicious counters", () => {
    const cooldowns = new Map<string, number>();
    const first = __testables.hitCooldown(cooldowns, "k", 10_000);
    assert.deepStrictEqual(first, { ok: true });
    const second = __testables.hitCooldown(cooldowns, "k", 10_000);
    assert.strictEqual(second.ok, false);

    const suspicious = new Map<string, { count: number; windowStart: number; lastAlertAt: number }>();
    const s1 = __testables.hitSuspiciousCounter(suspicious, "r:u1");
    const s2 = __testables.hitSuspiciousCounter(suspicious, "r:u1");
    const s3 = __testables.hitSuspiciousCounter(suspicious, "r:u1");
    assert.strictEqual(s1.shouldAlert, false);
    assert.strictEqual(s2.shouldAlert, false);
    assert.strictEqual(s3.shouldAlert, true);
  });

  it("builds signed admin panel url", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const url = __testables.buildAdminPanelUrl("https://example.com/panel", "42", "secret");
      const parsed = new URL(url);
      assert.strictEqual(parsed.origin, "https://example.com");
      assert.strictEqual(parsed.pathname, "/panel");
      assert.strictEqual(parsed.searchParams.get("uid"), "42");
      assert.strictEqual(parsed.searchParams.get("ts"), "1700000000000");
      assert.strictEqual(parsed.searchParams.get("sig")?.length, 64);
    } finally {
      Date.now = originalNow;
    }
  });

  it("builds and formats alert digest", () => {
    const alerts = [
      { code: "b", severity: "low", message: "B", value: 2 },
      { code: "a", severity: "high", message: "A", value: 1 },
    ];
    const sig = __testables.buildAlertDigestSignature(alerts);
    assert.strictEqual(sig, "a:high:1|b:low:2");
    const text = __testables.formatAlertDigestMessage(alerts);
    assert.match(text, /\[ALERT DIGEST\]/);
    assert.match(text, /a: A/);
  });

  it("builds help message with onboarding and help command", () => {
    const text = __testables.buildHelpMessage("ru");
    assert.match(text, /справка/);
    assert.match(text, /\/help/);
    assert.match(text, /Быстрый старт/);
    assert.match(text, /\/newcontest/);
  });

  it("builds onboarding welcome message and keyboard", () => {
    const message = __testables.buildOnboardingMessage("ru");
    assert.match(message, /Добро пожаловать/);
    assert.match(message, /Команды руками вводить не нужно/);

    const keyboard = __testables.buildOnboardingKeyboard("ru");
    const buttons = keyboard.payload.buttons.flat();
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "onboarding:how"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:guide_user"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:guide_admin"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "wizard:start"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "onboarding:help"));
  });

  it("builds interactive help keyboard and templates", () => {
    const keyboard = __testables.buildHelpKeyboard("ru", true);
    const buttons = keyboard.payload.buttons.flat();
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:guide_user"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:guide_admin"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:faq"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:post_template"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "wizard:start"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:nextsteps"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:whoami"));
    assert.ok(buttons.some((button) => button.type === "callback" && button.payload === "help:adminpanel"));

    const templates = __testables.buildCommandTemplates("ru");
    assert.match(templates, /Шаблоны команд/);
    assert.match(templates, /\/publish contest_id chat_id/);

    const steps = __testables.buildNextStepsMessage("ru");
    assert.match(steps, /Что делать дальше/);
    assert.match(steps, /\/draw contest_id/);

    const userGuide = __testables.buildSchoolUserGuideMessage("ru");
    assert.match(userGuide, /Инструкция для обычного пользователя/);
    assert.match(userGuide, /\/faq/);

    const adminGuide = __testables.buildAdminIntegrationGuideMessage("ru");
    assert.match(adminGuide, /Инструкция для администратора/);
    assert.match(adminGuide, /\/newcontest/);

    const faq = __testables.buildFaqMessage("ru");
    assert.match(faq, /FAQ/);

    const postTemplate = __testables.buildPostTemplateMessage("ru");
    assert.match(postTemplate, /Готовый шаблон поста/);

    const wizardText = __testables.buildWizardIntroMessage("ru");
    assert.match(wizardText, /Мастер-сценарий/);
    const wizardKeyboard = __testables.buildWizardKeyboard("ru");
    const wizardButtons = wizardKeyboard.payload.buttons.flat();
    assert.ok(wizardButtons.some((button) => button.type === "callback" && button.payload === "wizard:create_demo"));
    assert.ok(wizardButtons.some((button) => button.type === "callback" && button.payload === "wizard:publish_here"));
  });

  it("validates link button urls for MAX constraints", () => {
    assert.strictEqual(__testables.canUseLinkButtonUrl("http://localhost:8787/adminpanel"), false);
    assert.strictEqual(__testables.canUseLinkButtonUrl("https://example.com/adminpanel"), true);
  });

  it("builds status summary and admin panel mode", () => {
    assert.strictEqual(__testables.describeAdminPanelMode(undefined), "disabled");
    assert.strictEqual(__testables.describeAdminPanelMode("http://localhost:8787/adminpanel"), "local");
    assert.strictEqual(__testables.describeAdminPanelMode("https://example.com/adminpanel"), "public");

    const text = __testables.buildStatusMessage("ru", {
      role: "owner",
      contestsTotal: 5,
      activeCount: 2,
      completedCount: 3,
      draftCount: 0,
      adminPanelMode: "local",
    });
    assert.match(text, /Статус бота/);
    assert.match(text, /Роль: owner/);
    assert.match(text, /Конкурсы: всего=5/);
    assert.match(text, /локальная/);

    const textEn = __testables.buildStatusMessage("en", {
      role: "admin",
      contestsTotal: 2,
      activeCount: 1,
      completedCount: 1,
      draftCount: 0,
      adminPanelMode: "public",
    });
    assert.match(textEn, /Bot status/);
    assert.match(textEn, /Role: admin/);
    assert.match(textEn, /Admin panel: configured/);
  });

  it("extracts chat id from context", () => {
    assert.strictEqual(__testables.extractChatId({ chatId: 123 }), 123);
    assert.strictEqual(__testables.extractChatId({ message: { recipient: { chat_id: 456 } } }), 456);
    assert.strictEqual(__testables.extractChatId({}), null);
  });
});

