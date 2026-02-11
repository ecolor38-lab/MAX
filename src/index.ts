import "dotenv/config";

import { createContestBot } from "./bot";
import { loadConfig } from "./config";
import { AppLogger } from "./logger";

function main(): void {
  const config = loadConfig();
  const logger = new AppLogger({ logPath: config.logPath });
  const bot = createContestBot(config, logger);
  bot.start();
  logger.info("bot_started", { storagePath: config.storagePath });
}

main();
