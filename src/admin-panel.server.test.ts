import assert from "node:assert";
import fs from "node:fs";
import type http from "node:http";
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

async function getServerBaseUrl(server: http.Server): Promise<string> {
  const existing = server.address();
  if (existing && typeof existing !== "string") {
    return `http://127.0.0.1:${existing.port}`;
  }
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server address is not available.");
  }
  return `http://127.0.0.1:${address.port}`;
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
    adminPanelTokenTtlMs: 600_000,
    adminPanelRateLimitWindowMs: 60_000,
    adminPanelRateLimitMax: 120,
    adminPanelIpAllowlist: new Set(),
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
      return "http://127.0.0.1:0";
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("responds to health endpoint", async () => {
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/health`);
    const text = await response.text();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(text, "ok");
  });

  it("rejects unsigned audit request", async () => {
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/audit`);
    assert.strictEqual(response.status, 401);
  });

  it("returns json report for signed audit request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/audit?${query}`);
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
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/export?${query}`);
    const text = await response.text();
    assert.strictEqual(response.status, 200);
    assert.match(text, /id,title,status/);
    assert.match(text, /"srv1","Server test contest","completed"/);
  });
});

describe("admin panel server hardening", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-admin-server-hardening-"));
  const storagePath = path.join(dir, "contests.json");
  const logPath = path.join(dir, "bot.log");
  const repository = new ContestRepository(storagePath);
  repository.create(mkContest({ id: "srv-hard" }));
  const logger = new AppLogger({ logPath });

  it("returns 403 when ip is not in allowlist", async () => {
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
      adminPanelTokenTtlMs: 600_000,
      adminPanelRateLimitWindowMs: 60_000,
      adminPanelRateLimitMax: 120,
      adminPanelIpAllowlist: new Set(["10.10.10.10"]),
    };
    const maybeServer = createAdminPanelServer(config, repository, logger);
    if (!maybeServer) {
      throw new Error("Server must be created for tests.");
    }
    const server = maybeServer;
    try {
      const url = await getServerBaseUrl(server);
      const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
      const response = await fetch(`${url}/adminpanel/audit?${query}`);
      assert.strictEqual(response.status, 403);
    } finally {
      server.close();
    }
  });

  it("returns 429 when rate limit exceeded", async () => {
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
      adminPanelTokenTtlMs: 600_000,
      adminPanelRateLimitWindowMs: 120_000,
      adminPanelRateLimitMax: 1,
      adminPanelIpAllowlist: new Set(),
    };
    const maybeServer = createAdminPanelServer(config, repository, logger);
    if (!maybeServer) {
      throw new Error("Server must be created for tests.");
    }
    const server = maybeServer;
    try {
      const url = await getServerBaseUrl(server);
      const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
      const first = await fetch(`${url}/adminpanel/audit?${query}`);
      const second = await fetch(`${url}/adminpanel/audit?${query}`);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 429);
    } finally {
      server.close();
    }
  });
});
