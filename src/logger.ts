import fs from "node:fs";
import path from "node:path";

type LogLevel = "info" | "warn" | "error";

export type LoggerConfig = {
  logPath: string;
};

export class AppLogger {
  private readonly logPath: string;

  constructor(config: LoggerConfig) {
    this.logPath = config.logPath;
    const dir = path.dirname(this.logPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  info(event: string, payload?: Record<string, unknown>): void {
    this.write("info", event, payload);
  }

  warn(event: string, payload?: Record<string, unknown>): void {
    this.write("warn", event, payload);
  }

  error(event: string, payload?: Record<string, unknown>): void {
    this.write("error", event, payload);
  }

  private write(level: LogLevel, event: string, payload?: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(payload ? { payload } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(this.logPath, line, "utf8");
    // eslint-disable-next-line no-console
    console.log(line.trim());
  }
}

