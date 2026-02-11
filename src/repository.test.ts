import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { ContestRepository } from "./repository";
import type { Contest } from "./types";

const TEST_STORAGE = path.join(process.cwd(), "data", "test-contests.json");

function mkContest(id: string): Contest {
  return {
    id,
    title: `Contest ${id}`,
    createdBy: "u0",
    createdAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 86400000).toISOString(),
    maxWinners: 1,
    status: "active",
    requiredChats: [],
    participants: [],
    winners: [],
  };
}

describe("ContestRepository", () => {
  it("creates and lists contests", () => {
    if (fs.existsSync(TEST_STORAGE)) fs.unlinkSync(TEST_STORAGE);
    const repo = new ContestRepository(TEST_STORAGE);
    assert.strictEqual(repo.list().length, 0);

    repo.create(mkContest("c1"));
    repo.create(mkContest("c2"));
    assert.strictEqual(repo.list().length, 2);
    assert.strictEqual(repo.get("c1")?.title, "Contest c1");
    assert.strictEqual(repo.get("c99"), undefined);
  });

  it("adds participant and updates contest", () => {
    if (fs.existsSync(TEST_STORAGE)) fs.unlinkSync(TEST_STORAGE);
    const repo = new ContestRepository(TEST_STORAGE);
    repo.create(mkContest("c1"));

    const updated = repo.addParticipant("c1", {
      userId: "u1",
      joinedAt: new Date().toISOString(),
      tickets: 1,
    });
    assert.strictEqual(updated?.participants.length, 1);
    assert.strictEqual(updated?.participants[0]?.userId, "u1");

    const dup = repo.addParticipant("c1", {
      userId: "u1",
      joinedAt: new Date().toISOString(),
      tickets: 1,
    });
    assert.strictEqual(dup?.participants.length, 1);
  });

  it("update returns undefined for missing contest", () => {
    if (fs.existsSync(TEST_STORAGE)) fs.unlinkSync(TEST_STORAGE);
    const repo = new ContestRepository(TEST_STORAGE);
    const result = repo.update("missing", (c) => c);
    assert.strictEqual(result, undefined);
  });
});
