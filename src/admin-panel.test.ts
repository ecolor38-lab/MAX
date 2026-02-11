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
});
