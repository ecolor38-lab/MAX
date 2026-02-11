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
    const message = __adminPanelTestables.performAction(repo, "c1", "draw", "admin-1");
    const updated = repo.get("c1");

    assert.match(message, /Draw выполнен/);
    assert.ok(updated);
    assert.strictEqual(updated?.status, "completed");
    assert.strictEqual(updated?.winners.length, 1);
    assert.ok(updated?.drawSeed);
  });
});
