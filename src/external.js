// ─── Внешние источники: Coinbase Premium ───
// Premium = (Coinbase USD price - Binance USDT price) / Binance price * 100
// Положительная премия = US покупатели агрессивнее (через Coinbase Pro / Advanced Trade)
// Особенно важно для альтов (SOL) — институционалы заходят через Coinbase.

import { config } from "./config.js";
import { state } from "./state.js";

const COINBASE_API = "https://api.exchange.coinbase.com";

// Маппинг наших символов на Coinbase product_id
const CB_MAP = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  SOLUSDT: "SOL-USD",
  AVAXUSDT: "AVAX-USD",
  LINKUSDT: "LINK-USD",
};

async function fetchCoinbasePrice(productId) {
  const url = `${COINBASE_API}/products/${productId}/ticker`;
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.2" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Coinbase ${productId} ${res.status}`);
  }
  const data = await res.json();
  return {
    price: parseFloat(data.price),
    bid: parseFloat(data.bid),
    ask: parseFloat(data.ask),
    volume24h: parseFloat(data.volume),
    ts: Date.now(),
  };
}

async function pollCoinbasePremium() {
  for (const symbol of config.symbols) {
    const cbProduct = CB_MAP[symbol];
    if (!cbProduct) continue;

    try {
      const cb = await fetchCoinbasePrice(cbProduct);
      const sym = state.getSymbol(symbol);
      const binancePrice = sym?.ticker?.price;

      if (!binancePrice || !cb.price) continue;

      const premiumPct = ((cb.price - binancePrice) / binancePrice) * 100;

      // Интерпретация: на крипторынке Coinbase premium > 0.05% это уже сигнал
      // (для BTC обычно ±0.01%, для альтов может быть ±0.1%)
      let interpretation = "neutral";
      if (premiumPct > 0.1) interpretation = "us_buying_strong";
      else if (premiumPct > 0.03) interpretation = "us_buying_mild";
      else if (premiumPct < -0.1) interpretation = "us_selling_strong";
      else if (premiumPct < -0.03) interpretation = "us_selling_mild";

      state.updateCoinbasePremium(symbol, {
        coinbasePrice: cb.price,
        binancePrice,
        premiumPct,
        interpretation,
        cbVolume24h: cb.volume24h,
        ts: Date.now(),
      });
    } catch (e) {
      console.error(`[coinbase] ${symbol}:`, e.message);
    }
  }
}

// ─── Запуск ───
export function startExternal() {
  console.log("[external] starting Coinbase Premium polling");

  // Coinbase rate limit: 10 req/sec для публичного API. У нас 3 запроса каждые 15 сек — безопасно.
  setTimeout(pollCoinbasePremium, 9000);
  setInterval(pollCoinbasePremium, 15 * 1000);
}
