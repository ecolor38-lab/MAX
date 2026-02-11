export type ContestStatus = "draft" | "active" | "completed";

export interface Participant {
  userId: string;
  username?: string;
  joinedAt: string;
  tickets: number;
  referredBy?: string;
  referralsCount?: number;
}

export interface ContestAuditEntry {
  at: string;
  action:
    | "created"
    | "edited"
    | "closed"
    | "reopened"
    | "draw"
    | "reroll"
    | "autofinish"
    | "join";
  actorId: string;
  details?: string;
}

export interface Contest {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  endsAt: string;
  maxWinners: number;
  status: ContestStatus;
  requiredChats: number[];
  participants: Participant[];
  winners: string[];
  drawSeed?: string;
  publishChatId?: number;
  publishMessageId?: string;
  auditLog?: ContestAuditEntry[];
}
