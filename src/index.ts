import "dotenv/config";

import { createAdminPanelServer } from "./admin-panel";
import { createContestBot } from "./bot";
import { loadConfig } from "./config";
import { AppLogger } from "./logger";
import { ContestRepository } from "./repository";

function normalizeError(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message, ...(reason.stack ? { stack: reason.stack } : {}) };
  }
  return { message: String(reason) };
}

function main(): void {
  const config = loadConfig();
  const logger = new AppLogger({ logPath: config.logPath });
  const repository = new ContestRepository(config.storagePath);
  const bot = createContestBot(config, logger, repository);
  const adminServer = createAdminPanelServer(config, repository, logger);
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.warn("shutdown_started", { reason, exitCode });

    try {
      bot.stop();
    } catch (error) {
      logger.error("bot_stop_failed", normalizeError(error));
    }

    const forceExit = setTimeout(() => {
      logger.error("shutdown_forced_exit", { reason });
      process.exit(exitCode);
    }, 5000);
    forceExit.unref();

    if (!adminServer) {
      process.exit(exitCode);
      return;
    }

    adminServer.close(() => {
      clearTimeout(forceExit);
      logger.info("shutdown_completed", { reason, exitCode });
      process.exit(exitCode);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", normalizeError(error));
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", normalizeError(reason));
    shutdown("unhandledRejection", 1);
  });

  bot.start();
  logger.info("bot_started", { storagePath: config.storagePath });
}

main();
