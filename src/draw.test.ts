import { describe, it } from "node:test";
import assert from "node:assert";

import { runDeterministicDraw } from "./draw";
import type { Contest } from "./types";

function mkContest(overrides: Partial<Contest> = {}): Contest {
  return {
    id: "c1",
    title: "Test",
    createdBy: "u0",
    createdAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 86400000).toISOString(),
    maxWinners: 1,
    status: "active",
    requiredChats: [],
    participants: [],
    winners: [],
    ...overrides,
  };
}

function mkParticipant(userId: string, tickets = 1, joinedAt?: string): Contest["participants"][0] {
  return {
    userId,
    joinedAt: joinedAt ?? new Date().toISOString(),
    tickets,
  };
}

describe("runDeterministicDraw", () => {
  it("returns empty when no participants", () => {
    const contest = mkContest();
    assert.deepStrictEqual(runDeterministicDraw(contest), { seed: "", winners: [] });
  });

  it("returns one winner when one participant", () => {
    const contest = mkContest({
      participants: [mkParticipant("u1")],
      maxWinners: 1,
    });
    const result = runDeterministicDraw(contest);
    assert.strictEqual(result.winners.length, 1);
    assert.strictEqual(result.winners[0], "u1");
    assert.ok(result.seed);
  });

  it("is deterministic for same input", () => {
    const contest = mkContest({
      participants: [
        mkParticipant("u1", 1, "2026-01-01T00:00:00Z"),
        mkParticipant("u2", 1, "2026-01-01T00:00:01Z"),
        mkParticipant("u3", 1, "2026-01-01T00:00:02Z"),
      ],
      maxWinners: 1,
    });
    const a = runDeterministicDraw(contest);
    const b = runDeterministicDraw(contest);
    assert.strictEqual(a.seed, b.seed);
    assert.deepStrictEqual(a.winners, b.winners);
  });

  it("returns unique winners when maxWinners < participants", () => {
    const contest = mkContest({
      participants: [
        mkParticipant("u1", 1, "2026-01-01T00:00:00Z"),
        mkParticipant("u2", 1, "2026-01-01T00:00:01Z"),
        mkParticipant("u3", 1, "2026-01-01T00:00:02Z"),
      ],
      maxWinners: 2,
    });
    const result = runDeterministicDraw(contest);
    assert.strictEqual(result.winners.length, 2);
    assert.strictEqual(new Set(result.winners).size, 2);
  });

  it("weights tickets correctly (more tickets = higher chance)", () => {
    const contest = mkContest({
      participants: [
        mkParticipant("u1", 10, "2026-01-01T00:00:00Z"),
        mkParticipant("u2", 1, "2026-01-01T00:00:01Z"),
      ],
      maxWinners: 1,
    });
    const winners: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = runDeterministicDraw({ ...contest, endsAt: new Date(Date.now() + i).toISOString() });
      winners.push(r.winners[0] ?? "");
    }
    const u1Wins = winners.filter((w) => w === "u1").length;
    assert.ok(u1Wins > 50, `u1 should win >50/100, got ${u1Wins}`);
  });
});
