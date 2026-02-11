import "dotenv/config";

import { createAdminPanelServer } from "./admin-panel";
import { createContestBot } from "./bot";
import { loadConfig } from "./config";
import { AppLogger } from "./logger";
import { ContestRepository } from "./repository";

function main(): void {
  const config = loadConfig();
  const logger = new AppLogger({ logPath: config.logPath });
  const repository = new ContestRepository(config.storagePath);
  const bot = createContestBot(config, logger, repository);
  createAdminPanelServer(config, repository, logger);
  bot.start();
  logger.info("bot_started", { storagePath: config.storagePath });
}

main();
