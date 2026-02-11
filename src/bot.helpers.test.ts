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
  };
  return Object.assign(base, overrides);
}

describe("bot testable helpers", () => {
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
});

