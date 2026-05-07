import { config } from "./src/config.js";
import {
  loadInitialKlines,
  startWebSocket,
  startPolling,
} from "./src/binance.js";
import { startTriggers } from "./src/triggers.js";
import { startTelegram } from "./src/telegram.js";
import { startWeb } from "./src/web.js";

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  docpats-realtime-advisor v0.1");
  console.log("═══════════════════════════════════════════");
  console.log(`  symbols    : ${config.symbols.join(", ")}`);
  console.log(`  timeframes : ${config.timeframes.join(", ")}`);
  console.log(`  web        : ${config.web.host}:${config.web.port}`);
  console.log(
    `  telegram   : ${config.telegram.token ? "enabled" : "disabled"}`,
  );
  console.log(
    `  claude     : ${config.anthropic.apiKey ? "enabled (" + config.anthropic.model + ")" : "disabled"}`,
  );
  console.log(
    `  quiet utc  : ${config.quietHours.start}-${config.quietHours.end}`,
  );
  console.log("═══════════════════════════════════════════");

  await loadInitialKlines();
  startWebSocket();
  startPolling();
  startTriggers();
  startTelegram();
  startWeb();

  console.log("[main] all systems running\n");
}

process.on("uncaughtException", (e) => {
  console.error("[fatal] uncaughtException:", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[fatal] unhandledRejection:", e);
});

main().catch((e) => {
  console.error("[main] fatal:", e);
  process.exit(1);
});
