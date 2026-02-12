import "dotenv/config";

import { createAdminPanelServer } from "./admin-panel";
import { createContestBot, type ContestBot } from "./bot";
import { loadConfig, type AppConfig } from "./config";
import { AppLogger } from "./logger";
import { ContestRepository } from "./repository";

function normalizeError(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message, ...(reason.stack ? { stack: reason.stack } : {}) };
  }
  return { message: String(reason) };
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    // Config errors should fail fast before runtime starts.
    console.error("config_load_failed", normalizeError(error));
    process.exit(1);
    throw error;
  }
}

function main(): void {
  const config = loadConfigOrExit();
  const logger = new AppLogger({ logPath: config.logPath });
  const repository = new ContestRepository(config.storagePath);
  const bot: ContestBot = createContestBot(config, logger, repository);
  const adminServer = createAdminPanelServer(config, repository, logger);
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.warn("shutdown_started", { reason, exitCode });

    try {
      bot.shutdown();
    } catch (error) {
      logger.error("bot_stop_failed", normalizeError(error));
    }

    try {
      repository.close();
    } catch (error) {
      logger.error("repository_close_failed", normalizeError(error));
    }

    const forceExit = setTimeout(() => {
      logger.error("shutdown_forced_exit", { reason });
      process.exit(exitCode);
    }, 5000);
    forceExit.unref();

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
