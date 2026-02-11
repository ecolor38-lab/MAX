import crypto from "node:crypto";
import http from "node:http";

import type { AppConfig } from "./config";
import { runDeterministicDraw } from "./draw";
import type { AppLogger } from "./logger";
import { ContestRepository } from "./repository";
import type { Contest, ContestAuditEntry } from "./types";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const FILTER_ALL = "all";
type StatusFilter = Contest["status"] | typeof FILTER_ALL;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
type BulkAction = "bulk_close" | "bulk_draw" | "bulk_reroll";
type RateLimitState = { count: number; windowStart: number };

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

function toDatetimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
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

function verifyAdminSignatureWithTtl(
  params: URLSearchParams,
  secret: string,
  ttlMs: number,
): { ok: true; userId: string } | { ok: false } {
  const userId = params.get("uid")?.trim() ?? "";
  const ts = params.get("ts")?.trim() ?? "";
  const sig = params.get("sig")?.trim() ?? "";
  if (!userId || !ts || !sig) {
    return { ok: false };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > ttlMs) {
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

function normalizeIp(rawIp?: string): string {
  if (!rawIp) {
    return "";
  }
  const v = rawIp.trim();
  if (v.startsWith("::ffff:")) {
    return v.slice("::ffff:".length);
  }
  return v;
}

function isIpAllowed(ip: string, allowlist: Set<string>): boolean {
  if (allowlist.size === 0) {
    return true;
  }
  return allowlist.has(ip);
}

function hitRateLimit(
  state: Map<string, RateLimitState>,
  key: string,
  now: number,
  windowMs: number,
  maxRequests: number,
): boolean {
  const current = state.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    state.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (current.count >= maxRequests) {
    return false;
  }
  state.set(key, { count: current.count + 1, windowStart: current.windowStart });
  return true;
}

async function readPostBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function parseStatusFilter(value: string | null): StatusFilter {
  if (value === "active" || value === "completed" || value === "draft") {
    return value;
  }
  return FILTER_ALL;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (normalized < 1) {
    return fallback;
  }
  return normalized;
}

function applyContestFilters(contests: Contest[], query: string, status: StatusFilter): Contest[] {
  const q = query.trim().toLowerCase();
  return contests.filter((contest) => {
    if (status !== FILTER_ALL && contest.status !== status) {
      return false;
    }
    if (!q) {
      return true;
    }
    return contest.id.toLowerCase().includes(q) || contest.title.toLowerCase().includes(q);
  });
}

function paginateContests(
  contests: Contest[],
  pageRaw: string | null,
  pageSizeRaw: string | null,
): { items: Contest[]; page: number; pageSize: number; totalPages: number } {
  const pageSize = Math.min(parsePositiveInt(pageSizeRaw, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(contests.length / pageSize));
  const page = Math.min(parsePositiveInt(pageRaw, 1), totalPages);
  const start = (page - 1) * pageSize;
  const items = contests.slice(start, start + pageSize);
  return { items, page, pageSize, totalPages };
}

function toCsvValue(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

function buildContestCsv(contests: Contest[]): string {
  const header = [
    "id",
    "title",
    "status",
    "participants",
    "maxWinners",
    "winners",
    "endsAt",
    "createdAt",
  ].join(",");
  const rows = contests.map((contest) =>
    [
      toCsvValue(contest.id),
      toCsvValue(contest.title),
      toCsvValue(contest.status),
      String(contest.participants.length),
      String(contest.maxWinners),
      toCsvValue(contest.winners.join("|")),
      toCsvValue(contest.endsAt),
      toCsvValue(contest.createdAt),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function buildAuditReport(contests: Contest[]): {
  totals: { contests: number; participants: number; completed: number };
  byAction: Record<string, number>;
  recent: Array<{ contestId: string; at: string; action: string; actorId: string }>;
} {
  const byAction: Record<string, number> = {};
  const recent = contests
    .flatMap((contest) =>
      (contest.auditLog ?? []).map((entry) => ({
        contestId: contest.id,
        at: entry.at,
        action: entry.action,
        actorId: entry.actorId,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 50);

  for (const row of recent) {
    byAction[row.action] = (byAction[row.action] ?? 0) + 1;
  }

  return {
    totals: {
      contests: contests.length,
      participants: contests.reduce((acc, contest) => acc + contest.participants.length, 0),
      completed: contests.filter((contest) => contest.status === "completed").length,
    },
    byAction,
    recent,
  };
}

function buildMetricsReport(contests: Contest[]): {
  totals: {
    contests: number;
    active: number;
    completed: number;
    draft: number;
    participants: number;
  };
  engagement: {
    contestsWithParticipants: number;
    participationRatePct: number;
    avgParticipantsPerContest: number;
    contestsWithRequiredChats: number;
  };
  draws: {
    drawActions: number;
    rerollActions: number;
    totalWinners: number;
  };
  referrals: {
    participantsWithReferrer: number;
    sumReferralCounters: number;
  };
  topContestsByParticipants: Array<{
    id: string;
    title: string;
    participants: number;
    status: Contest["status"];
  }>;
} {
  const participants = contests.reduce((acc, contest) => acc + contest.participants.length, 0);
  const contestsWithParticipants = contests.filter((contest) => contest.participants.length > 0).length;
  const active = contests.filter((contest) => contest.status === "active").length;
  const completed = contests.filter((contest) => contest.status === "completed").length;
  const draft = contests.filter((contest) => contest.status === "draft").length;
  const contestsWithRequiredChats = contests.filter((contest) => contest.requiredChats.length > 0).length;

  const drawActions = contests.reduce(
    (acc, contest) => acc + (contest.auditLog?.filter((entry) => entry.action === "draw").length ?? 0),
    0,
  );
  const rerollActions = contests.reduce(
    (acc, contest) => acc + (contest.auditLog?.filter((entry) => entry.action === "reroll").length ?? 0),
    0,
  );
  const totalWinners = contests.reduce((acc, contest) => acc + contest.winners.length, 0);

  const participantsWithReferrer = contests.reduce(
    (acc, contest) => acc + contest.participants.filter((participant) => Boolean(participant.referredBy)).length,
    0,
  );
  const sumReferralCounters = contests.reduce(
    (acc, contest) =>
      acc + contest.participants.reduce((sum, participant) => sum + (participant.referralsCount ?? 0), 0),
    0,
  );

  const topContestsByParticipants = [...contests]
    .sort((a, b) => b.participants.length - a.participants.length)
    .slice(0, 5)
    .map((contest) => ({
      id: contest.id,
      title: contest.title,
      participants: contest.participants.length,
      status: contest.status,
    }));

  return {
    totals: {
      contests: contests.length,
      active,
      completed,
      draft,
      participants,
    },
    engagement: {
      contestsWithParticipants,
      participationRatePct: contests.length > 0 ? Math.round((contestsWithParticipants / contests.length) * 100) : 0,
      avgParticipantsPerContest: contests.length > 0 ? Number((participants / contests.length).toFixed(2)) : 0,
      contestsWithRequiredChats,
    },
    draws: {
      drawActions,
      rerollActions,
      totalWinners,
    },
    referrals: {
      participantsWithReferrer,
      sumReferralCounters,
    },
    topContestsByParticipants,
  };
}

function buildMetricsCsv(report: ReturnType<typeof buildMetricsReport>): string {
  const rows: Array<[string, string]> = [
    ["totals.contests", String(report.totals.contests)],
    ["totals.active", String(report.totals.active)],
    ["totals.completed", String(report.totals.completed)],
    ["totals.draft", String(report.totals.draft)],
    ["totals.participants", String(report.totals.participants)],
    ["engagement.contestsWithParticipants", String(report.engagement.contestsWithParticipants)],
    ["engagement.participationRatePct", String(report.engagement.participationRatePct)],
    ["engagement.avgParticipantsPerContest", String(report.engagement.avgParticipantsPerContest)],
    ["engagement.contestsWithRequiredChats", String(report.engagement.contestsWithRequiredChats)],
    ["draws.drawActions", String(report.draws.drawActions)],
    ["draws.rerollActions", String(report.draws.rerollActions)],
    ["draws.totalWinners", String(report.draws.totalWinners)],
    ["referrals.participantsWithReferrer", String(report.referrals.participantsWithReferrer)],
    ["referrals.sumReferralCounters", String(report.referrals.sumReferralCounters)],
  ];

  for (const [index, item] of report.topContestsByParticipants.entries()) {
    const prefix = `topContestsByParticipants.${index}`;
    rows.push([`${prefix}.id`, item.id]);
    rows.push([`${prefix}.title`, item.title]);
    rows.push([`${prefix}.participants`, String(item.participants)]);
    rows.push([`${prefix}.status`, item.status]);
  }

  return ["metric,value", ...rows.map(([metric, value]) => `${toCsvValue(metric)},${toCsvValue(value)}`)].join("\n");
}

type AlertSeverity = "low" | "medium" | "high";
type AdminAlert = {
  code: string;
  severity: AlertSeverity;
  message: string;
  value: number;
};

export function buildAlertsReport(contests: Contest[]): {
  generatedAt: string;
  totals: { contests: number; active: number; completed: number };
  alerts: AdminAlert[];
} {
  const generatedAt = new Date().toISOString();
  const activeContests = contests.filter((contest) => contest.status === "active");
  const completedContests = contests.filter((contest) => contest.status === "completed");

  const drawActions = contests.reduce(
    (acc, contest) => acc + (contest.auditLog?.filter((entry) => entry.action === "draw").length ?? 0),
    0,
  );
  const rerollActions = contests.reduce(
    (acc, contest) => acc + (contest.auditLog?.filter((entry) => entry.action === "reroll").length ?? 0),
    0,
  );
  const pastDueActive = activeContests.filter((contest) => new Date(contest.endsAt).getTime() < Date.now()).length;
  const maxReferralCounter = contests.reduce((acc, contest) => {
    const contestMax = contest.participants.reduce(
      (inner, participant) => Math.max(inner, participant.referralsCount ?? 0),
      0,
    );
    return Math.max(acc, contestMax);
  }, 0);
  const completedWithoutParticipants = completedContests.filter(
    (contest) => contest.participants.length === 0,
  ).length;

  const alerts: AdminAlert[] = [];
  if (rerollActions >= 3 && rerollActions > drawActions) {
    alerts.push({
      code: "high_reroll_activity",
      severity: "high",
      value: rerollActions,
      message: "Reroll действий больше draw. Проверьте качество условий конкурса и риск абьюза.",
    });
  } else if (rerollActions >= 2) {
    alerts.push({
      code: "elevated_reroll_activity",
      severity: "medium",
      value: rerollActions,
      message: "Наблюдается повышенное число reroll.",
    });
  }

  if (pastDueActive > 0) {
    alerts.push({
      code: "past_due_active_contests",
      severity: pastDueActive > 3 ? "high" : "medium",
      value: pastDueActive,
      message: "Есть active конкурсы с прошедшей датой окончания. Проверьте автофиниш.",
    });
  }

  if (maxReferralCounter >= 10) {
    alerts.push({
      code: "referral_outlier",
      severity: "medium",
      value: maxReferralCounter,
      message: "Найден участник с очень высоким referral count. Проверьте источник трафика.",
    });
  }

  if (completedContests.length >= 5) {
    const pct = Math.round((completedWithoutParticipants / completedContests.length) * 100);
    if (pct >= 40) {
      alerts.push({
        code: "low_completion_quality",
        severity: "low",
        value: pct,
        message: "Большая доля завершенных конкурсов без участников.",
      });
    }
  }

  return {
    generatedAt,
    totals: {
      contests: contests.length,
      active: activeContests.length,
      completed: completedContests.length,
    },
    alerts,
  };
}

function renderPage(
  contests: Contest[],
  basePath: string,
  signedParams: URLSearchParams,
  filters: { query: string; status: StatusFilter; page: number; pageSize: number },
  flashMessage?: string,
): string {
  const filteredContests = applyContestFilters(contests, filters.query, filters.status);
  const paging = paginateContests(filteredContests, String(filters.page), String(filters.pageSize));
  const totalParticipants = filteredContests.reduce((acc, contest) => acc + contest.participants.length, 0);
  const activeCount = filteredContests.filter((contest) => contest.status === "active").length;
  const completedCount = filteredContests.filter((contest) => contest.status === "completed").length;
  const avgParticipants = filteredContests.length > 0 ? (totalParticipants / filteredContests.length).toFixed(1) : "0.0";
  const totalDrawOps = filteredContests.reduce(
    (acc, contest) =>
      acc +
      (contest.auditLog?.filter((entry) => entry.action === "draw" || entry.action === "reroll").length ?? 0),
    0,
  );
  const completionRate = filteredContests.length > 0 ? Math.round((completedCount / filteredContests.length) * 100) : 0;
  const signedQuery = signedParams.toString();
  const pageBaseParams = `${signedQuery}&q=${encodeURIComponent(filters.query)}&status=${encodeURIComponent(filters.status)}&pageSize=${filters.pageSize}`;
  const prevPage = Math.max(1, paging.page - 1);
  const nextPage = Math.min(paging.totalPages, paging.page + 1);

  const rows = paging.items
    .map((contest) => {
      const status = escapeHtml(contest.status);
      const title = escapeHtml(contest.title);
      const winners = escapeHtml(contest.winners.join(", ") || "-");
      const endsAtLocal = escapeHtml(toDatetimeLocalValue(contest.endsAt));
      return `
      <tr>
        <td><input type="checkbox" name="contestIds" value="${escapeHtml(contest.id)}" form="bulk-form" /></td>
        <td><code>${escapeHtml(contest.id)}</code></td>
        <td>${title}</td>
        <td>${status}</td>
        <td>${contest.participants.length}</td>
        <td>${escapeHtml(contest.endsAt)}</td>
        <td>${winners}</td>
        <td>
          <form method="post" action="${basePath}/action?${pageBaseParams}&page=${paging.page}" class="inline">
            <input type="hidden" name="contestId" value="${escapeHtml(contest.id)}" />
            <button name="action" value="draw">Draw</button>
            <button name="action" value="reroll">Reroll</button>
            <button name="action" value="close">Close</button>
          </form>
          <form method="post" action="${basePath}/action?${pageBaseParams}&page=${paging.page}" class="inline">
            <input type="hidden" name="contestId" value="${escapeHtml(contest.id)}" />
            <input type="datetime-local" name="endsAt" required />
            <button name="action" value="reopen">Reopen</button>
          </form>
          <form method="post" action="${basePath}/action?${pageBaseParams}&page=${paging.page}" class="inline">
            <input type="hidden" name="contestId" value="${escapeHtml(contest.id)}" />
            <input type="text" name="title" value="${title}" required />
            <input type="datetime-local" name="endsAt" value="${endsAtLocal}" required />
            <input type="number" name="maxWinners" min="1" value="${contest.maxWinners}" required />
            <button name="action" value="edit">Edit</button>
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
      .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
      .metrics { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
      .metric { background: #1f2937; border: 1px solid #334155; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
      input, select, button { background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 6px 8px; }
      form.inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .pager { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
      .progress { width: 180px; height: 8px; border-radius: 999px; background: #1e293b; overflow: hidden; border: 1px solid #334155; }
      .progress > span { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #38bdf8); width: ${completionRate}%; }
    </style>
  </head>
  <body>
    <h1>MAX Contest Admin</h1>
    ${flashMessage ? `<div class="flash">${escapeHtml(flashMessage)}</div>` : ""}
    <p>Действия выполняются от имени пользователя, который открыл подписанную ссылку.</p>
    <div class="toolbar">
      <form method="get" action="${basePath}" class="inline">
        <input type="hidden" name="uid" value="${escapeHtml(signedParams.get("uid") ?? "")}" />
        <input type="hidden" name="ts" value="${escapeHtml(signedParams.get("ts") ?? "")}" />
        <input type="hidden" name="sig" value="${escapeHtml(signedParams.get("sig") ?? "")}" />
        <input type="text" name="q" placeholder="Поиск по ID/названию" value="${escapeHtml(filters.query)}" />
        <select name="status">
          <option value="all"${filters.status === FILTER_ALL ? " selected" : ""}>Все статусы</option>
          <option value="active"${filters.status === "active" ? " selected" : ""}>active</option>
          <option value="completed"${filters.status === "completed" ? " selected" : ""}>completed</option>
          <option value="draft"${filters.status === "draft" ? " selected" : ""}>draft</option>
        </select>
        <input type="number" name="pageSize" min="1" max="${MAX_PAGE_SIZE}" value="${filters.pageSize}" />
        <button type="submit">Применить</button>
      </form>
      <a href="${basePath}/export?${pageBaseParams}" style="color:#93c5fd">Экспорт CSV</a>
      <form method="post" action="${basePath}/action?${pageBaseParams}&page=${paging.page}" class="inline">
        <input type="text" name="title" placeholder="Название конкурса" required />
        <input type="datetime-local" name="endsAt" required />
        <input type="number" name="maxWinners" min="1" value="1" required />
        <button name="action" value="create">Create</button>
      </form>
    </div>
    <div class="metrics">
      <div class="metric">Всего: ${filteredContests.length}</div>
      <div class="metric">Active: ${activeCount}</div>
      <div class="metric">Completed: ${completedCount}</div>
      <div class="metric">Участников: ${totalParticipants}</div>
      <div class="metric">Avg участников: ${avgParticipants}</div>
      <div class="metric">Draw/Reroll ops: ${totalDrawOps}</div>
      <div class="metric">Completion:
        <span class="progress"><span></span></span>
        ${completionRate}%
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Sel</th><th>ID</th><th>Название</th><th>Статус</th><th>Участников</th><th>EndsAt</th><th>Победители</th><th>Действия</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="8">Конкурсы по фильтру отсутствуют</td></tr>'}
      </tbody>
    </table>
    <form id="bulk-form" method="post" action="${basePath}/action?${pageBaseParams}&page=${paging.page}" class="inline">
    <div class="pager">
      <button name="action" value="bulk_close">Bulk close</button>
      <button name="action" value="bulk_draw">Bulk draw</button>
      <button name="action" value="bulk_reroll">Bulk reroll</button>
      <span>Стр. ${paging.page} / ${paging.totalPages}</span>
      <a href="${basePath}?${pageBaseParams}&page=${prevPage}" style="color:#93c5fd">Prev</a>
      <a href="${basePath}?${pageBaseParams}&page=${nextPage}" style="color:#93c5fd">Next</a>
    </div>
    </form>
  </body>
</html>`;
}

function performAction(
  repository: ContestRepository,
  input: {
    contestId?: string;
    action: string;
    actorId: string;
    endsAtInput?: string;
    titleInput?: string;
    maxWinnersInput?: string;
  },
): string {
  if (input.action === "create") {
    const title = input.titleInput?.trim() ?? "";
    const parsedDate = new Date(input.endsAtInput ?? "");
    const parsedWinners = Number(input.maxWinnersInput ?? "1");
    if (!title) {
      return "Укажите название конкурса.";
    }
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() <= Date.now()) {
      return "Укажите корректную будущую дату окончания.";
    }
    if (!Number.isFinite(parsedWinners) || parsedWinners < 1) {
      return "maxWinners должен быть числом >= 1.";
    }

    const contest: Contest = {
      id: crypto.randomBytes(4).toString("hex"),
      title,
      createdBy: input.actorId,
      createdAt: new Date().toISOString(),
      endsAt: parsedDate.toISOString(),
      maxWinners: Math.floor(parsedWinners),
      status: "active",
      requiredChats: [],
      participants: [],
      winners: [],
      auditLog: [
        {
          at: new Date().toISOString(),
          action: "created",
          actorId: input.actorId,
          details: "Создан через web-панель",
        },
      ],
    };
    repository.create(contest);
    return `Конкурс создан: ${contest.id}.`;
  }

  const contestId = input.contestId?.trim() ?? "";
  if (!contestId) {
    return "contestId обязателен.";
  }
  const action = input.action;
  const actorId = input.actorId;
  const endsAtInput = input.endsAtInput;
  const contest = repository.get(contestId);
  if (!contest) {
    return "Конкурс не найден.";
  }

  if (action === "edit") {
    const title = input.titleInput?.trim() ?? "";
    const parsedDate = new Date(endsAtInput ?? "");
    const parsedWinners = Number(input.maxWinnersInput ?? String(contest.maxWinners));
    if (!title) {
      return "Укажите название конкурса.";
    }
    if (Number.isNaN(parsedDate.getTime())) {
      return "Укажите корректную дату окончания.";
    }
    if (!Number.isFinite(parsedWinners) || parsedWinners < 1) {
      return "maxWinners должен быть числом >= 1.";
    }

    repository.update(contest.id, (prev) =>
      withAuditEntry(
        {
          ...prev,
          title,
          endsAt: parsedDate.toISOString(),
          maxWinners: Math.floor(parsedWinners),
        },
        {
          at: new Date().toISOString(),
          action: "edited",
          actorId,
          details: "Изменен через web-панель",
        },
      ),
    );
    return "Конкурс обновлен.";
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

function performBulkAction(
  repository: ContestRepository,
  actorId: string,
  action: BulkAction,
  contestIds: string[],
): string {
  if (contestIds.length === 0) {
    return "Выберите хотя бы один конкурс.";
  }

  let applied = 0;
  for (const contestId of contestIds) {
    const message = performAction(repository, {
      contestId,
      action: action.replace("bulk_", ""),
      actorId,
    });
    const ok =
      message.includes("выполнен") ||
      message.includes("закрыт") ||
      message.includes("переоткрыт") ||
      message.includes("обновлен");
    if (ok) {
      applied += 1;
    }
  }

  return `Bulk ${action} применен к ${applied} из ${contestIds.length}.`;
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
  const rateLimitState = new Map<string, RateLimitState>();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const host = req.headers.host || "localhost";
    const requestUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathName = requestUrl.pathname;
    const clientIp = normalizeIp(req.socket.remoteAddress);

    if (pathName === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (
      pathName !== basePath &&
      pathName !== `${basePath}/action` &&
      pathName !== `${basePath}/export` &&
      pathName !== `${basePath}/audit` &&
      pathName !== `${basePath}/metrics` &&
      pathName !== `${basePath}/metrics.csv` &&
      pathName !== `${basePath}/alerts`
    ) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    if (!isIpAllowed(clientIp, config.adminPanelIpAllowlist)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const rateKey = `${clientIp}:${pathName}`;
    const now = Date.now();
    if (
      !hitRateLimit(
        rateLimitState,
        rateKey,
        now,
        config.adminPanelRateLimitWindowMs,
        config.adminPanelRateLimitMax,
      )
    ) {
      res.writeHead(429, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(Math.ceil(config.adminPanelRateLimitWindowMs / 1000)),
      });
      res.end("Too Many Requests");
      return;
    }

    const verification = verifyAdminSignatureWithTtl(
      requestUrl.searchParams,
      secret,
      config.adminPanelTokenTtlMs,
    );
    if (!verification.ok) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("Unauthorized");
      return;
    }

    const signedParams = new URLSearchParams({
      uid: requestUrl.searchParams.get("uid") ?? "",
      ts: requestUrl.searchParams.get("ts") ?? "",
      sig: requestUrl.searchParams.get("sig") ?? "",
    });

    if (method === "GET" && pathName === basePath) {
      const flash = requestUrl.searchParams.get("m") ?? undefined;
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const page = parsePositiveInt(requestUrl.searchParams.get("page"), 1);
      const pageSize = parsePositiveInt(requestUrl.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
      const html = renderPage(repository.list(), basePath, signedParams, { query, status, page, pageSize }, flash);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "GET" && pathName === `${basePath}/export`) {
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const filtered = applyContestFilters(repository.list(), query, status);
      const csv = buildContestCsv(filtered);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="contests-${Date.now()}.csv"`,
      });
      res.end(csv);
      return;
    }

    if (method === "GET" && pathName === `${basePath}/audit`) {
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const filtered = applyContestFilters(repository.list(), query, status);
      const report = buildAuditReport(filtered);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            filters: { query, status },
            ...report,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (method === "GET" && pathName === `${basePath}/metrics`) {
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const filtered = applyContestFilters(repository.list(), query, status);
      const report = buildMetricsReport(filtered);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            filters: { query, status },
            ...report,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (method === "GET" && pathName === `${basePath}/metrics.csv`) {
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const filtered = applyContestFilters(repository.list(), query, status);
      const report = buildMetricsReport(filtered);
      const csv = buildMetricsCsv(report);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="metrics-${Date.now()}.csv"`,
      });
      res.end(csv);
      return;
    }

    if (method === "GET" && pathName === `${basePath}/alerts`) {
      const query = requestUrl.searchParams.get("q") ?? "";
      const status = parseStatusFilter(requestUrl.searchParams.get("status"));
      const filtered = applyContestFilters(repository.list(), query, status);
      const report = buildAlertsReport(filtered);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          {
            filters: { query, status },
            ...report,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (method === "POST" && pathName === `${basePath}/action`) {
      const body = await readPostBody(req);
      const action = body.get("action") ?? "";
      const contestId = body.get("contestId") ?? undefined;
      const endsAt = body.get("endsAt") ?? undefined;
      const title = body.get("title") ?? undefined;
      const maxWinners = body.get("maxWinners") ?? undefined;
      const contestIds = body.getAll("contestIds").map((value) => value.trim()).filter(Boolean);
      const message =
        action === "bulk_close" || action === "bulk_draw" || action === "bulk_reroll"
          ? performBulkAction(repository, verification.userId, action as BulkAction, contestIds)
          : performAction(repository, {
              action,
              actorId: verification.userId,
              ...(contestId ? { contestId } : {}),
              ...(endsAt ? { endsAtInput: endsAt } : {}),
              ...(title ? { titleInput: title } : {}),
              ...(maxWinners ? { maxWinnersInput: maxWinners } : {}),
            });
      logger.info("admin_panel_action", { action, contestId, actorId: verification.userId, message });

      const query = requestUrl.searchParams.get("q") ?? "";
      const status = requestUrl.searchParams.get("status") ?? FILTER_ALL;
      const page = parsePositiveInt(requestUrl.searchParams.get("page"), 1);
      const pageSize = parsePositiveInt(requestUrl.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
      res.writeHead(302, {
        Location: `${basePath}?${signedParams.toString()}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&page=${page}&pageSize=${pageSize}&m=${encodeURIComponent(message)}`,
      });
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
  applyContestFilters,
  buildAuditReport,
  buildAlertsReport,
  buildMetricsCsv,
  buildMetricsReport,
  buildAdminSignature,
  buildContestCsv,
  hitRateLimit,
  isIpAllowed,
  normalizeIp,
  paginateContests,
  performBulkAction,
  performAction,
  toDatetimeLocalValue,
  verifyAdminSignature,
  verifyAdminSignatureWithTtl,
};
