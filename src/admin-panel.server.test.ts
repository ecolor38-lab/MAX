import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { __adminPanelTestables, createAdminPanelServer } from "./admin-panel";
import type { AppConfig } from "./config";
import { AppLogger } from "./logger";
import { ContestRepository } from "./repository";
import type { Contest } from "./types";

function mkContest(overrides: Partial<Contest> = {}): Contest {
  return {
    id: "srv1",
    title: "Server test contest",
    createdBy: "1",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    endsAt: new Date("2026-12-31T00:00:00.000Z").toISOString(),
    maxWinners: 1,
    status: "completed",
    requiredChats: [],
    participants: [{ userId: "u1", joinedAt: new Date().toISOString(), tickets: 1 }],
    winners: ["u1"],
    auditLog: [{ at: "2026-01-02T00:00:00.000Z", action: "draw", actorId: "admin-1" }],
    ...overrides,
  };
}

function buildSignedQuery(userId: string, secret: string): string {
  const ts = String(Date.now());
  const sig = __adminPanelTestables.buildAdminSignature(userId, ts, secret);
  return new URLSearchParams({ uid: userId, ts, sig }).toString();
}

describe("admin panel server endpoints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-admin-server-"));
  const storagePath = path.join(dir, "contests.json");
  const logPath = path.join(dir, "bot.log");

  const repository = new ContestRepository(storagePath);
  repository.create(mkContest());

  const config: AppConfig = {
    botToken: "token-token-token",
    ownerUserId: "1",
    adminUserIds: new Set(["1"]),
    moderatorUserIds: new Set(),
    storagePath,
    referralBonusTickets: 1,
    referralMaxBonusTickets: 5,
    logPath,
    defaultLocale: "ru",
    adminPanelUrl: "http://127.0.0.1/adminpanel",
    adminPanelSecret: "test-secret",
    adminPanelPort: 0,
  };

  const logger = new AppLogger({ logPath: config.logPath });
  const maybeServer = createAdminPanelServer(config, repository, logger);
  if (!maybeServer) {
    throw new Error("Server must be created for tests.");
  }
  const server = maybeServer;

  after(() => {
    server.close();
  });

  function baseUrl(): string {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address is not available.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("responds to health endpoint", async () => {
    const response = await fetch(`${baseUrl()}/health`);
    const text = await response.text();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(text, "ok");
  });

  it("rejects unsigned audit request", async () => {
    const response = await fetch(`${baseUrl()}/adminpanel/audit`);
    assert.strictEqual(response.status, 401);
  });

  it("returns json report for signed audit request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const response = await fetch(`${baseUrl()}/adminpanel/audit?${query}`);
    const payload = (await response.json()) as {
      totals: { contests: number; completed: number };
      byAction: Record<string, number>;
    };

    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.totals.contests, 1);
    assert.strictEqual(payload.totals.completed, 1);
    assert.strictEqual(payload.byAction.draw, 1);
  });

  it("returns csv for signed export request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const response = await fetch(`${baseUrl()}/adminpanel/export?${query}`);
    const text = await response.text();
    assert.strictEqual(response.status, 200);
    assert.match(text, /id,title,status/);
    assert.match(text, /"srv1","Server test contest","completed"/);
  });
});
