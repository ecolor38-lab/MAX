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
    adminAlertDigestIntervalMs: 300_000,
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

  it("responds to readiness endpoint with json", async () => {
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/health/ready`);
    const payload = (await response.json()) as {
      status: string;
      panelEnabled: boolean;
      storage: { contests: number; completed: number };
    };
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.status, "ready");
    assert.strictEqual(payload.panelEnabled, true);
    assert.strictEqual(payload.storage.contests, 1);
    assert.strictEqual(payload.storage.completed, 1);
  });

  it("rejects unsigned audit request", async () => {
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/audit`);
    assert.strictEqual(response.status, 401);
  });

  it("rejects signed request for non-admin user id", async () => {
    const query = buildSignedQuery("999", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/audit?${query}`);
    assert.strictEqual(response.status, 403);
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

  it("returns metrics report for signed metrics request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/metrics?${query}`);
    const payload = (await response.json()) as {
      totals: { contests: number; participants: number };
      draws: { drawActions: number };
    };
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.totals.contests, 1);
    assert.strictEqual(payload.totals.participants, 1);
    assert.strictEqual(payload.draws.drawActions, 1);
  });

  it("returns metrics csv for signed request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/metrics.csv?${query}`);
    const text = await response.text();
    assert.strictEqual(response.status, 200);
    assert.match(text, /metric,value/);
    assert.match(text, /"totals\.contests","1"/);
  });

  it("returns alerts report for signed request", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const response = await fetch(`${url}/adminpanel/alerts?${query}`);
    const payload = (await response.json()) as {
      totals: { contests: number };
      alerts: Array<{ code: string }>;
    };
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.totals.contests, 1);
    assert.ok(Array.isArray(payload.alerts));
  });

  it("rejects oversized action body with 413", async () => {
    const query = buildSignedQuery("1", config.adminPanelSecret || config.botToken);
    const url = await getServerBaseUrl(server);
    const body = `action=create&title=${"x".repeat(300_000)}&endsAt=2030-01-01T00:00&maxWinners=1`;
    const response = await fetch(`${url}/adminpanel/action?${query}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    assert.strictEqual(response.status, 413);
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
      adminAlertDigestIntervalMs: 300_000,
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
      adminAlertDigestIntervalMs: 300_000,
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

describe("admin panel server when disabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-admin-server-disabled-"));
  const storagePath = path.join(dir, "contests.json");
  const logPath = path.join(dir, "bot.log");
  const repository = new ContestRepository(storagePath);
  const logger = new AppLogger({ logPath });

  it("keeps health endpoint available and blocks panel routes", async () => {
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
      adminPanelPort: 0,
      adminPanelTokenTtlMs: 600_000,
      adminPanelRateLimitWindowMs: 60_000,
      adminPanelRateLimitMax: 120,
      adminPanelIpAllowlist: new Set(),
      adminAlertDigestIntervalMs: 300_000,
    };
    const maybeServer = createAdminPanelServer(config, repository, logger);
    if (!maybeServer) {
      throw new Error("Server must be created for tests.");
    }
    const server = maybeServer;
    try {
      const url = await getServerBaseUrl(server);
      const health = await fetch(`${url}/health`);
      const healthText = await health.text();
      const ready = await fetch(`${url}/health/ready`);
      const readyPayload = (await ready.json()) as { status: string; panelEnabled: boolean };
      const panel = await fetch(`${url}/adminpanel`);
      const panelText = await panel.text();
      assert.strictEqual(health.status, 200);
      assert.strictEqual(healthText, "ok");
      assert.strictEqual(ready.status, 200);
      assert.strictEqual(readyPayload.status, "ready");
      assert.strictEqual(readyPayload.panelEnabled, false);
      assert.strictEqual(panel.status, 404);
      assert.match(panelText, /Admin panel is disabled/);
    } finally {
      server.close();
    }
  });
});
