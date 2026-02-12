import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContestRepository } from "./repository";
import type { Contest } from "./types";

function mkTempStoragePaths(): { dir: string; json: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-repo-test-"));
  return {
    dir,
    json: path.join(dir, "test-contests.json"),
    db: path.join(dir, "test-contests.db"),
  };
}

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
    const paths = mkTempStoragePaths();
    const repo = new ContestRepository(paths.json);
    assert.strictEqual(repo.list().length, 0);

    repo.create(mkContest("c1"));
    repo.create(mkContest("c2"));
    assert.strictEqual(repo.list().length, 2);
    assert.strictEqual(repo.get("c1")?.title, "Contest c1");
    assert.strictEqual(repo.get("c99"), undefined);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it("adds participant and updates contest", () => {
    const paths = mkTempStoragePaths();
    const repo = new ContestRepository(paths.json);
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
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it("update returns undefined for missing contest", () => {
    const paths = mkTempStoragePaths();
    const repo = new ContestRepository(paths.json);
    const result = repo.update("missing", (c) => c);
    assert.strictEqual(result, undefined);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it("works with sqlite backend", () => {
    const paths = mkTempStoragePaths();
    const repo = new ContestRepository(paths.db);
    repo.create(mkContest("c_sql_1"));
    repo.create(mkContest("c_sql_2"));

    const all = repo.list();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(repo.get("c_sql_1")?.title, "Contest c_sql_1");

    const updated = repo.addParticipant("c_sql_1", {
      userId: "u_sql",
      joinedAt: new Date().toISOString(),
      tickets: 1,
    });
    assert.strictEqual(updated?.participants.length, 1);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });

  it("falls back to empty state when json is malformed", () => {
    const paths = mkTempStoragePaths();
    fs.writeFileSync(paths.json, "{broken-json", "utf8");
    const repo = new ContestRepository(paths.json);
    assert.deepStrictEqual(repo.list(), []);
    fs.rmSync(paths.dir, { recursive: true, force: true });
  });
});
