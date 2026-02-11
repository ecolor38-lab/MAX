import crypto from "node:crypto";

import type { Contest } from "./types";

function seededHash(seed: string, value: string): string {
  return crypto.createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

type TicketEntry = {
  userId: string;
  joinedAt: string;
  ticketNo: number;
};

function rankTicketEntries(seed: string, entries: TicketEntry[]): TicketEntry[] {
  return [...entries].sort((a, b) => {
    const hashA = seededHash(seed, `${a.userId}:${a.joinedAt}:${a.ticketNo}`);
    const hashB = seededHash(seed, `${b.userId}:${b.joinedAt}:${b.ticketNo}`);
    return hashA.localeCompare(hashB);
  });
}

export function runDeterministicDraw(contest: Contest): { seed: string; winners: string[] } {
  if (contest.participants.length === 0) {
    return { seed: "", winners: [] };
  }

  const seed = crypto
    .createHash("sha256")
    .update(`${contest.id}|${contest.endsAt}|${contest.participants.length}`)
    .digest("hex");

  const entries: TicketEntry[] = contest.participants.flatMap((participant) => {
    const safeTickets = Math.max(1, Math.floor(participant.tickets || 1));
    return Array.from({ length: safeTickets }, (_, index) => ({
      userId: participant.userId,
      joinedAt: participant.joinedAt,
      ticketNo: index + 1,
    }));
  });

  const ranked = rankTicketEntries(seed, entries);
  const winners: string[] = [];
  const seen = new Set<string>();
  for (const entry of ranked) {
    if (seen.has(entry.userId)) {
      continue;
    }
    seen.add(entry.userId);
    winners.push(entry.userId);
    if (winners.length >= contest.maxWinners) {
      break;
    }
  }

  return { seed, winners };
}
