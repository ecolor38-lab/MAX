import fs from "node:fs";
import path from "node:path";

import type { Contest, Participant } from "./types";

type StorageShape = {
  contests: Contest[];
};

export class ContestRepository {
  private readonly storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.ensureStorage();
  }

  list(): Contest[] {
    return this.read().contests;
  }

  get(contestId: string): Contest | undefined {
    return this.list().find((contest) => contest.id === contestId);
  }

  create(contest: Contest): Contest {
    const data = this.read();
    data.contests.push(contest);
    this.write(data);
    return contest;
  }

  update(contestId: string, updater: (contest: Contest) => Contest): Contest | undefined {
    const data = this.read();
    const idx = data.contests.findIndex((c) => c.id === contestId);
    if (idx < 0) {
      return undefined;
    }
    const current = data.contests[idx];
    if (!current) {
      return undefined;
    }
    data.contests[idx] = updater(current);
    this.write(data);
    return data.contests[idx];
  }

  addParticipant(contestId: string, participant: Participant): Contest | undefined {
    return this.update(contestId, (contest) => {
      const alreadyExists = contest.participants.some((p) => p.userId === participant.userId);
      if (alreadyExists) {
        return contest;
      }
      return { ...contest, participants: [...contest.participants, participant] };
    });
  }

  private ensureStorage(): void {
    const dir = path.dirname(this.storagePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.storagePath)) {
      this.write({ contests: [] });
    }
  }

  private read(): StorageShape {
    const raw = fs.readFileSync(this.storagePath, "utf8");
    return JSON.parse(raw) as StorageShape;
  }

  private write(data: StorageShape): void {
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
  }
}
