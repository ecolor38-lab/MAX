import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Contest, Participant } from "./types";

type StorageShape = {
  contests: Contest[];
};

export class ContestRepository {
  private readonly storagePath: string;
  private readonly useSqlite: boolean;
  private readonly db: DatabaseSync | null;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.useSqlite = this.storagePath.endsWith(".db");
    this.db = this.useSqlite ? new DatabaseSync(this.storagePath) : null;
    this.ensureStorage();
  }

  list(): Contest[] {
    if (this.useSqlite) {
      return this.readSqlite().contests;
    }
    return this.readJson().contests;
  }

  get(contestId: string): Contest | undefined {
    return this.list().find((contest) => contest.id === contestId);
  }

  create(contest: Contest): Contest {
    const data = this.readStorage();
    data.contests.push(contest);
    this.writeStorage(data);
    return contest;
  }

  update(contestId: string, updater: (contest: Contest) => Contest): Contest | undefined {
    const data = this.readStorage();
    const idx = data.contests.findIndex((c) => c.id === contestId);
    if (idx < 0) {
      return undefined;
    }
    const current = data.contests[idx];
    if (!current) {
      return undefined;
    }
    data.contests[idx] = updater(current);
    this.writeStorage(data);
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

  close(): void {
    if (!this.db) {
      return;
    }
    this.db.close();
  }

  private ensureStorage(): void {
    const dir = path.dirname(this.storagePath);
    fs.mkdirSync(dir, { recursive: true });
    if (this.useSqlite) {
      this.ensureSqliteStorage();
      return;
    }

    if (!fs.existsSync(this.storagePath)) {
      this.writeJson({ contests: [] });
    }
  }

  private ensureSqliteStorage(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS contests (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private readStorage(): StorageShape {
    if (this.useSqlite) {
      return this.readSqlite();
    }
    return this.readJson();
  }

  private writeStorage(data: StorageShape): void {
    if (this.useSqlite) {
      this.writeSqlite(data);
      return;
    }
    this.writeJson(data);
  }

  private readJson(): StorageShape {
    try {
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StorageShape>;
      if (!parsed || !Array.isArray(parsed.contests)) {
        return { contests: [] };
      }
      return { contests: parsed.contests };
    } catch {
      return { contests: [] };
    }
  }

  private writeJson(data: StorageShape): void {
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
  }

  private readSqlite(): StorageShape {
    const db = this.requireDb();
    const rows = db
      .prepare("SELECT data FROM contests ORDER BY updated_at ASC")
      .all() as Array<{ data: string }>;
    const contests = rows.map((row) => JSON.parse(row.data) as Contest);
    return { contests };
  }

  private writeSqlite(data: StorageShape): void {
    const db = this.requireDb();
    const now = new Date().toISOString();
    try {
      db.exec("BEGIN");
      db.exec("DELETE FROM contests");
      const stmt = db.prepare("INSERT INTO contests (id, data, updated_at) VALUES (?, ?, ?)");
      for (const contest of data.contests) {
        stmt.run(contest.id, JSON.stringify(contest), now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SQLite database is not initialized.");
    }
    return this.db;
  }
}
