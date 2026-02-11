import { createContestBot } from "./bot";
import { loadConfig } from "./config";

function main(): void {
  const config = loadConfig();
  const bot = createContestBot(config);
  bot.start();
  console.log("MAX Contest Bot started");
}

main();
