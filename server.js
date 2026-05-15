import { config } from "./src/config.js";
import {
  loadInitialKlines,
  startWebSocket,
  startPolling,
} from "./src/binance.js";
import { startTriggers } from "./src/triggers.js";
import { startTelegram } from "./src/telegram.js";
import { startWeb } from "./src/web.js";
import { startML } from "./src/ml.js";
import { startDerivatives } from "./src/derivatives.js";
import { startExternal } from "./src/external.js";
import { startDefiLlama } from "./src/defillama.js";
import { startStopHunting } from "./src/stopHunting.js";
import { startAggFunding } from "./src/aggFunding.js";
import { startDeribit } from "./src/deribit.js";

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  docpats-realtime-advisor v0.2");
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
  console.log(`  ml-service : http://localhost:3001 (BTC only)`);
  console.log(`  cvd+ob     : enabled (spot/perp + orderbook imbalance)`);
  console.log(`  coinbase   : enabled (US premium tracking)`);
  console.log(`  defillama  : enabled (Solana on-chain: TVL + stables + DEX)`);
  console.log(`  stop hunt  : enabled (liquidation magnets proxy)`);
  console.log(`  agg fund   : enabled (Bybit + OKX funding aggregate)`);
  console.log(`  deribit    : enabled (BTC + ETH options PCR + max pain)`);
  console.log(
    `  quiet utc  : ${config.quietHours.start}-${config.quietHours.end}`,
  );
  console.log("═══════════════════════════════════════════");

  await loadInitialKlines();
  startWebSocket();
  startPolling();
  startDerivatives();
  startExternal();
  startDefiLlama();
  startStopHunting(); // ← новый
  startAggFunding(); // ← новый
  startDeribit(); // ← новый
  startTriggers();
  startTelegram();
  startWeb();
  startML();

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
