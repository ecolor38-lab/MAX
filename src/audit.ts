import type { Contest, ContestAuditEntry } from "./types";

export function withAuditEntry(contest: Contest, entry: ContestAuditEntry): Contest {
  const current = contest.auditLog ?? [];
  return { ...contest, auditLog: [...current, entry] };
}
