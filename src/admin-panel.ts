import crypto from "node:crypto";
import http from "node:http";

import { runDeterministicDraw } from "./draw";
import type { AppConfig } from "./config";
import type { AppLogger } from "./logger";
import { ContestRepository } from "./repository";
import type { Contest, ContestAuditEntry } from "./types";

const TOKEN_TTL_MS = 10 * 60 * 1000;

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withAuditEntry(contest: Contest, entry: ContestAuditEntry): Contest {
  const current = contest.auditLog ?? [];
  return { ...contest, auditLog: [...current, entry] };
}

function buildAdminSignature(userId: string, ts: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${userId}:${ts}`).digest("hex");
}

function verifyAdminSignature(params: URLSearchParams, secret: string): { ok: true; userId: string } | { ok: false } {
  const userId = params.get("uid")?.trim() ?? "";
  const ts = params.get("ts")?.trim() ?? "";
  const sig = params.get("sig")?.trim() ?? "";
  if (!userId || !ts || !sig) {
    return { ok: false };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TOKEN_TTL_MS) {
    return { ok: false };
  }

  const expected = buildAdminSignature(userId, ts, secret);
  const left = Buffer.from(sig, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length === 0 || left.length !== right.length) {
    return { ok: false };
  }

  if (!crypto.timingSafeEqual(left, right)) {
    return { ok: false };
  }

  return { ok: true, userId };
}

async function readPostBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function renderPage(contests: Contest[], basePath: string, signedQuery: string, flashMessage?: string): string {
  const rows = contests
    .map((contest) => {
      const status = escapeHtml(contest.status);
      const title = escapeHtml(contest.title);
      const winners = escapeHtml(contest.winners.join(", ") || "-");
      return `
      <tr>
        <td><code>${escapeHtml(contest.id)}</code></td>
        <td>${title}</td>
        <td>${status}</td>
        <td>${contest.participants.length}</td>
        <td>${escapeHtml(contest.endsAt)}</td>
        <td>${winners}</td>
        <td>
          <form method="post" action="${basePath}/action?${signedQuery}" style="display:inline">
            <input type="hidden" name="contestId" value="${escapeHtml(contest.id)}" />
            <button name="action" value="draw">Draw</button>
            <button name="action" value="reroll">Reroll</button>
            <button name="action" value="close">Close</button>
          </form>
          <form method="post" action="${basePath}/action?${signedQuery}" style="display:inline">
            <input type="hidden" name="contestId" value="${escapeHtml(contest.id)}" />
            <input type="datetime-local" name="endsAt" required />
            <button name="action" value="reopen">Reopen</button>
          </form>
        </td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MAX Contest Admin</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 16px; background: #0f172a; color: #e2e8f0; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; background: #111827; }
      th, td { border: 1px solid #374151; padding: 8px; font-size: 14px; text-align: left; vertical-align: top; }
      code { color: #93c5fd; }
      button { margin-right: 6px; margin-top: 4px; }
      .flash { background: #1e293b; padding: 10px; border-left: 4px solid #22c55e; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <h1>MAX Contest Admin</h1>
    ${flashMessage ? `<div class="flash">${escapeHtml(flashMessage)}</div>` : ""}
    <p>Действия выполняются от имени пользователя, который открыл подписанную ссылку.</p>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Название</th><th>Статус</th><th>Участников</th><th>EndsAt</th><th>Победители</th><th>Действия</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7">Конкурсы отсутствуют</td></tr>'}
      </tbody>
    </table>
  </body>
</html>`;
}

function performAction(
  repository: ContestRepository,
  contestId: string,
  action: string,
  actorId: string,
  endsAtInput?: string,
): string {
  const contest = repository.get(contestId);
  if (!contest) {
    return "Конкурс не найден.";
  }

  if (action === "close") {
    if (contest.status === "completed") {
      return "Конкурс уже завершен.";
    }
    if (contest.participants.length === 0) {
      repository.update(contest.id, (prev) =>
        withAuditEntry(
          { ...prev, status: "completed" },
          { at: new Date().toISOString(), action: "closed", actorId, details: "Закрыт из web-панели без участников" },
        ),
      );
      return "Конкурс закрыт без участников.";
    }
    const result = runDeterministicDraw(contest);
    repository.update(contest.id, (prev) =>
      withAuditEntry(
        { ...prev, status: "completed", winners: result.winners, drawSeed: result.seed },
        { at: new Date().toISOString(), action: "closed", actorId, details: `Закрыт из web-панели, winners=${result.winners.join(",")}` },
      ),
    );
    return `Конкурс закрыт. Победители: ${result.winners.join(", ") || "-"}.`;
  }

  if (action === "draw") {
    if (contest.status !== "active") {
      return "Draw доступен только для active конкурса.";
    }
    if (contest.participants.length === 0) {
      return "В конкурсе нет участников.";
    }
    const result = runDeterministicDraw(contest);
    repository.update(contest.id, (prev) =>
      withAuditEntry(
        { ...prev, status: "completed", winners: result.winners, drawSeed: result.seed },
        { at: new Date().toISOString(), action: "draw", actorId, details: `draw из web-панели, winners=${result.winners.join(",")}` },
      ),
    );
    return `Draw выполнен. Победители: ${result.winners.join(", ") || "-"}.`;
  }

  if (action === "reroll") {
    if (contest.status !== "completed") {
      return "Reroll доступен только для completed конкурса.";
    }
    if (contest.participants.length === 0) {
      return "В конкурсе нет участников.";
    }
    const result = runDeterministicDraw({ ...contest, endsAt: new Date().toISOString() });
    repository.update(contest.id, (prev) =>
      withAuditEntry(
        { ...prev, status: "completed", winners: result.winners, drawSeed: result.seed },
        { at: new Date().toISOString(), action: "reroll", actorId, details: `reroll из web-панели, winners=${result.winners.join(",")}` },
      ),
    );
    return `Reroll выполнен. Победители: ${result.winners.join(", ") || "-"}.`;
  }

  if (action === "reopen") {
    const parsedDate = new Date(endsAtInput ?? "");
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() <= Date.now()) {
      return "Укажите корректную будущую дату для reopen.";
    }
    if (contest.status !== "completed") {
      return "Reopen доступен только для completed конкурса.";
    }
    repository.update(contest.id, (prev) => {
      const { drawSeed: _dropDrawSeed, ...withoutDrawSeed } = prev;
      return withAuditEntry(
        { ...withoutDrawSeed, status: "active", winners: [], endsAt: parsedDate.toISOString() },
        { at: new Date().toISOString(), action: "reopened", actorId, details: `reopen из web-панели, endsAt=${parsedDate.toISOString()}` },
      );
    });
    return "Конкурс переоткрыт.";
  }

  return "Неизвестное действие.";
}

export function createAdminPanelServer(
  config: AppConfig,
  repository: ContestRepository,
  logger: AppLogger,
): http.Server | null {
  if (!config.adminPanelUrl) {
    return null;
  }
  const panelUrl = new URL(config.adminPanelUrl);
  const basePath = panelUrl.pathname || "/adminpanel";
  const secret = config.adminPanelSecret || config.botToken;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const host = req.headers.host || "localhost";
    const requestUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathName = requestUrl.pathname;

    if (pathName === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (pathName !== basePath && pathName !== `${basePath}/action`) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const verification = verifyAdminSignature(requestUrl.searchParams, secret);
    if (!verification.ok) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("Unauthorized");
      return;
    }

    const signedQuery = new URLSearchParams({
      uid: requestUrl.searchParams.get("uid") ?? "",
      ts: requestUrl.searchParams.get("ts") ?? "",
      sig: requestUrl.searchParams.get("sig") ?? "",
    }).toString();

    if (method === "GET" && pathName === basePath) {
      const flash = requestUrl.searchParams.get("m") ?? undefined;
      const html = renderPage(repository.list(), basePath, signedQuery, flash);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "POST" && pathName === `${basePath}/action`) {
      const body = await readPostBody(req);
      const action = body.get("action") ?? "";
      const contestId = body.get("contestId") ?? "";
      const endsAt = body.get("endsAt") ?? undefined;
      const message = performAction(repository, contestId, action, verification.userId, endsAt);
      logger.info("admin_panel_action", { action, contestId, actorId: verification.userId, message });
      res.writeHead(302, { Location: `${basePath}?${signedQuery}&m=${encodeURIComponent(message)}` });
      res.end();
      return;
    }

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  });

  server.listen(config.adminPanelPort, "0.0.0.0", () => {
    logger.info("admin_panel_started", { url: config.adminPanelUrl, bindPort: config.adminPanelPort });
  });

  return server;
}

export const __adminPanelTestables = {
  buildAdminSignature,
  verifyAdminSignature,
  performAction,
};
