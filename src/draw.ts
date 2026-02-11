import crypto from "node:crypto";

import type { Contest, Participant } from "./types";

function seededHash(seed: string, value: string): string {
  return crypto.createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

function rankParticipants(seed: string, participants: Participant[]): Participant[] {
  return [...participants].sort((a, b) => {
    const hashA = seededHash(seed, `${a.userId}:${a.joinedAt}`);
    const hashB = seededHash(seed, `${b.userId}:${b.joinedAt}`);
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

  const ranked = rankParticipants(seed, contest.participants);
  const winners = ranked.slice(0, contest.maxWinners).map((participant) => participant.userId);

  return { seed, winners };
}
