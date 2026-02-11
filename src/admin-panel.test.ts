import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContestRepository } from "./repository";
import type { Contest } from "./types";
import { __adminPanelTestables } from "./admin-panel";

function mkRepo(): { repo: ContestRepository; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-admin-panel-"));
  const filePath = path.join(dir, "contests.json");
  const repo = new ContestRepository(filePath);
  return { repo, filePath };
}

function mkContest(overrides: Partial<Contest> = {}): Contest {
  return {
    id: "c1",
    title: "Test contest",
    createdBy: "1",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    endsAt: new Date("2026-12-31T00:00:00.000Z").toISOString(),
    maxWinners: 1,
    status: "active",
    requiredChats: [],
    participants: [{ userId: "u1", joinedAt: new Date().toISOString(), tickets: 1 }],
    winners: [],
    ...overrides,
  };
}

describe("admin panel helpers", () => {
  it("verifies valid signature", () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const ts = String(Date.now());
      const sig = __adminPanelTestables.buildAdminSignature("42", ts, "secret");
      const params = new URLSearchParams({ uid: "42", ts, sig });
      const check = __adminPanelTestables.verifyAdminSignature(params, "secret");
      assert.deepStrictEqual(check, { ok: true, userId: "42" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("rejects expired signature", () => {
    const ts = String(Date.now() - 1000 * 60 * 60);
    const sig = __adminPanelTestables.buildAdminSignature("42", ts, "secret");
    const params = new URLSearchParams({ uid: "42", ts, sig });
    const check = __adminPanelTestables.verifyAdminSignature(params, "secret");
    assert.deepStrictEqual(check, { ok: false });
  });

  it("supports configurable token ttl", () => {
    const originalNow = Date.now;
    Date.now = () => 2_000_000;
    try {
      const ts = String(1_000_000);
      const sig = __adminPanelTestables.buildAdminSignature("42", ts, "secret");
      const params = new URLSearchParams({ uid: "42", ts, sig });
      const strict = __adminPanelTestables.verifyAdminSignatureWithTtl(params, "secret", 100_000);
      const relaxed = __adminPanelTestables.verifyAdminSignatureWithTtl(params, "secret", 2_000_000);
      assert.deepStrictEqual(strict, { ok: false });
      assert.deepStrictEqual(relaxed, { ok: true, userId: "42" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("performs draw action and stores winners", () => {
    const { repo } = mkRepo();
    repo.create(mkContest());
    const message = __adminPanelTestables.performAction(repo, {
      contestId: "c1",
      action: "draw",
      actorId: "admin-1",
    });
    const updated = repo.get("c1");

    assert.match(message, /Draw выполнен/);
    assert.ok(updated);
    assert.strictEqual(updated?.status, "completed");
    assert.strictEqual(updated?.winners.length, 1);
    assert.ok(updated?.drawSeed);
  });

  it("creates contest from panel action", () => {
    const { repo } = mkRepo();
    const message = __adminPanelTestables.performAction(repo, {
      action: "create",
      actorId: "admin-1",
      titleInput: "Panel created",
      endsAtInput: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      maxWinnersInput: "2",
    });
    const contests = repo.list();
    assert.match(message, /Конкурс создан/);
    assert.strictEqual(contests.length, 1);
    assert.strictEqual(contests[0]?.title, "Panel created");
    assert.strictEqual(contests[0]?.maxWinners, 2);
  });

  it("edits existing contest from panel action", () => {
    const { repo } = mkRepo();
    repo.create(mkContest());
    const message = __adminPanelTestables.performAction(repo, {
      contestId: "c1",
      action: "edit",
      actorId: "admin-1",
      titleInput: "Edited title",
      endsAtInput: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      maxWinnersInput: "3",
    });
    const updated = repo.get("c1");
    assert.strictEqual(message, "Конкурс обновлен.");
    assert.strictEqual(updated?.title, "Edited title");
    assert.strictEqual(updated?.maxWinners, 3);
  });

  it("filters contests by query and status", () => {
    const contests: Contest[] = [
      mkContest({ id: "aa11", title: "Alpha", status: "active" }),
      mkContest({ id: "bb22", title: "Beta", status: "completed" }),
      mkContest({ id: "cc33", title: "Gamma", status: "active" }),
    ];
    const active = __adminPanelTestables.applyContestFilters(contests, "", "active");
    const byQuery = __adminPanelTestables.applyContestFilters(contests, "bb", "all");
    assert.strictEqual(active.length, 2);
    assert.strictEqual(byQuery.length, 1);
    assert.strictEqual(byQuery[0]?.id, "bb22");
  });

  it("supports pagination helper", () => {
    const contests: Contest[] = Array.from({ length: 23 }, (_, i) =>
      mkContest({ id: `c${i + 1}`, title: `Contest ${i + 1}` }),
    );
    const page = __adminPanelTestables.paginateContests(contests, "2", "10");
    assert.strictEqual(page.page, 2);
    assert.strictEqual(page.pageSize, 10);
    assert.strictEqual(page.totalPages, 3);
    assert.strictEqual(page.items.length, 10);
    assert.strictEqual(page.items[0]?.id, "c11");
  });

  it("exports contests to csv", () => {
    const csv = __adminPanelTestables.buildContestCsv([
      mkContest({ id: "x1", title: "A, B" }),
      mkContest({ id: "x2", title: 'Quote "title"' }),
    ]);
    assert.match(csv, /id,title,status/);
    assert.match(csv, /"x1","A, B"/);
    assert.match(csv, /"x2","Quote ""title"""/);
  });

  it("performs bulk close action", () => {
    const { repo } = mkRepo();
    repo.create(mkContest({ id: "a1", participants: [] }));
    repo.create(mkContest({ id: "a2", participants: [] }));
    const message = __adminPanelTestables.performBulkAction(repo, "admin-1", "bulk_close", ["a1", "a2"]);
    assert.match(message, /2 из 2/);
    assert.strictEqual(repo.get("a1")?.status, "completed");
    assert.strictEqual(repo.get("a2")?.status, "completed");
  });

  it("builds audit report summary", () => {
    const contests: Contest[] = [
      mkContest({
        id: "r1",
        status: "completed",
        participants: [{ userId: "u1", joinedAt: new Date().toISOString(), tickets: 1 }],
        auditLog: [
          { at: "2026-01-01T00:00:00.000Z", action: "created", actorId: "a1" },
          { at: "2026-01-02T00:00:00.000Z", action: "draw", actorId: "a1" },
        ],
      }),
      mkContest({
        id: "r2",
        status: "active",
        participants: [],
        auditLog: [{ at: "2026-01-03T00:00:00.000Z", action: "edited", actorId: "a2" }],
      }),
    ];
    const report = __adminPanelTestables.buildAuditReport(contests);
    assert.strictEqual(report.totals.contests, 2);
    assert.strictEqual(report.totals.completed, 1);
    assert.strictEqual(report.totals.participants, 1);
    assert.strictEqual(report.byAction.created, 1);
    assert.strictEqual(report.byAction.draw, 1);
    assert.strictEqual(report.byAction.edited, 1);
    assert.strictEqual(report.recent[0]?.contestId, "r2");
  });

  it("builds metrics report summary", () => {
    const contests: Contest[] = [
      mkContest({
        id: "m1",
        title: "Contest 1",
        status: "active",
        requiredChats: [1],
        participants: [
          { userId: "u1", joinedAt: new Date().toISOString(), tickets: 1, referredBy: "ref-1" },
          { userId: "u2", joinedAt: new Date().toISOString(), tickets: 1, referralsCount: 2 },
        ],
        winners: [],
        auditLog: [{ at: "2026-01-01T00:00:00.000Z", action: "draw", actorId: "a1" }],
      }),
      mkContest({
        id: "m2",
        title: "Contest 2",
        status: "completed",
        participants: [],
        winners: ["u1"],
        auditLog: [{ at: "2026-01-02T00:00:00.000Z", action: "reroll", actorId: "a2" }],
      }),
    ];
    const report = __adminPanelTestables.buildMetricsReport(contests);
    assert.strictEqual(report.totals.contests, 2);
    assert.strictEqual(report.totals.active, 1);
    assert.strictEqual(report.totals.completed, 1);
    assert.strictEqual(report.totals.participants, 2);
    assert.strictEqual(report.engagement.contestsWithRequiredChats, 1);
    assert.strictEqual(report.draws.drawActions, 1);
    assert.strictEqual(report.draws.rerollActions, 1);
    assert.strictEqual(report.referrals.participantsWithReferrer, 1);
    assert.strictEqual(report.referrals.sumReferralCounters, 2);
    assert.strictEqual(report.topContestsByParticipants[0]?.id, "m1");
  });

  it("exports metrics report to csv", () => {
    const report = __adminPanelTestables.buildMetricsReport([
      mkContest({
        id: "mc1",
        title: "Metrics Contest",
        status: "completed",
        participants: [{ userId: "u1", joinedAt: new Date().toISOString(), tickets: 1 }],
        winners: ["u1"],
        auditLog: [{ at: "2026-01-02T00:00:00.000Z", action: "draw", actorId: "a1" }],
      }),
    ]);
    const csv = __adminPanelTestables.buildMetricsCsv(report);
    assert.match(csv, /metric,value/);
    assert.match(csv, /"totals\.contests","1"/);
    assert.match(csv, /"draws\.drawActions","1"/);
    assert.match(csv, /"topContestsByParticipants\.0\.id","mc1"/);
  });

  it("normalizes ip and checks allowlist", () => {
    assert.strictEqual(__adminPanelTestables.normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
    assert.strictEqual(__adminPanelTestables.normalizeIp("127.0.0.1"), "127.0.0.1");
    assert.strictEqual(__adminPanelTestables.isIpAllowed("127.0.0.1", new Set()), true);
    assert.strictEqual(__adminPanelTestables.isIpAllowed("127.0.0.1", new Set(["1.1.1.1"])), false);
    assert.strictEqual(__adminPanelTestables.isIpAllowed("127.0.0.1", new Set(["127.0.0.1"])), true);
  });

  it("enforces sliding window rate limit", () => {
    const state = new Map<string, { count: number; windowStart: number }>();
    const key = "127.0.0.1:/adminpanel/audit";
    assert.strictEqual(__adminPanelTestables.hitRateLimit(state, key, 1000, 10_000, 2), true);
    assert.strictEqual(__adminPanelTestables.hitRateLimit(state, key, 1001, 10_000, 2), true);
    assert.strictEqual(__adminPanelTestables.hitRateLimit(state, key, 1002, 10_000, 2), false);
    assert.strictEqual(__adminPanelTestables.hitRateLimit(state, key, 20_000, 10_000, 2), true);
  });
});
