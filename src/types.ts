export type ContestStatus = "draft" | "active" | "completed";

export interface Participant {
  userId: string;
  username?: string;
  joinedAt: string;
  tickets: number;
}

export interface Contest {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  endsAt: string;
  maxWinners: number;
  status: ContestStatus;
  requiredChats: string[];
  participants: Participant[];
  winners: string[];
  drawSeed?: string;
  publishChatId?: number;
  publishMessageId?: string;
}
