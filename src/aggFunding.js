// ─── Aggregate Funding с Bybit + OKX (Binance уже в state) ───
// Бесплатные публичные endpoints, без ключей.

import { config } from "./config.js";
import { state } from "./state.js";

const BYBIT = "https://api.bybit.com";
const OKX = "https://www.okx.com";

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.2" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

// ─── Bybit funding ───
// API v5: https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT
// fundingRate в result.list[0].fundingRate
async function fetchBybitFunding(symbol) {
  const url = `${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`;
  const data = await getJson(url);
  if (data?.retCode !== 0 || !data?.result?.list?.[0]) {
    throw new Error(`Bybit ${symbol}: retCode=${data?.retCode}`);
  }
  const t = data.result.list[0];
  return {
    rate: parseFloat(t.fundingRate),
    nextFundingTime: parseInt(t.nextFundingTime),
    markPrice: parseFloat(t.markPrice),
    indexPrice: parseFloat(t.indexPrice),
  };
}

// ─── OKX funding ───
// Символ в формате BTC-USDT-SWAP
function toOkxInstId(symbol) {
  // BTCUSDT → BTC-USDT-SWAP
  if (symbol.endsWith("USDT")) {
    return symbol.replace("USDT", "-USDT-SWAP");
  }
  return null;
}

async function fetchOkxFunding(symbol) {
  const instId = toOkxInstId(symbol);
  if (!instId) throw new Error(`OKX: cannot map ${symbol}`);
  const url = `${OKX}/api/v5/public/funding-rate?instId=${instId}`;
  const data = await getJson(url);
  if (data?.code !== "0" || !data?.data?.[0]) {
    throw new Error(`OKX ${symbol}: code=${data?.code}`);
  }
  const r = data.data[0];
  return {
    rate: parseFloat(r.fundingRate),
    nextFundingTime: parseInt(r.nextFundingTime),
  };
}

// ─── Сборка aggregate ───
async function pollAggFunding() {
  for (const symbol of config.symbols) {
    try {
      const [bybitResult, okxResult] = await Promise.allSettled([
        fetchBybitFunding(symbol),
        fetchOkxFunding(symbol),
      ]);

      const bybit =
        bybitResult.status === "fulfilled" ? bybitResult.value : null;
      const okx = okxResult.status === "fulfilled" ? okxResult.value : null;

      // Binance уже в state
      const binanceData = state.getSymbol(symbol)?.funding;
      const binance =
        binanceData?.rate != null ? { rate: binanceData.rate } : null;

      // Aggregate
      const allRates = [binance?.rate, bybit?.rate, okx?.rate].filter(
        (r) => r != null && !isNaN(r),
      );

      const avgRate =
        allRates.length > 0
          ? allRates.reduce((a, b) => a + b, 0) / allRates.length
          : null;

      const minRate = allRates.length > 0 ? Math.min(...allRates) : null;
      const maxRate = allRates.length > 0 ? Math.max(...allRates) : null;
      const spread =
        maxRate != null && minRate != null ? maxRate - minRate : null;

      // Divergence detection: если spread > 0.0005 (0.05%) — серьёзное расхождение
      let divergence = "aligned";
      if (spread != null) {
        if (Math.abs(spread) > 0.0005) {
          // Кто отклоняется в какую сторону?
          if (
            binance?.rate != null &&
            Math.abs(binance.rate - avgRate) > spread / 3
          ) {
            divergence =
              binance.rate > avgRate
                ? "binance_long_heavy"
                : "binance_short_heavy";
          } else if (
            bybit?.rate != null &&
            Math.abs(bybit.rate - avgRate) > spread / 3
          ) {
            divergence =
              bybit.rate > avgRate ? "bybit_long_heavy" : "bybit_short_heavy";
          } else if (
            okx?.rate != null &&
            Math.abs(okx.rate - avgRate) > spread / 3
          ) {
            divergence =
              okx.rate > avgRate ? "okx_long_heavy" : "okx_short_heavy";
          } else {
            divergence = "diverging";
          }
        }
      }

      // Aligned extreme: все 3 биржи в одну сторону экстремально → разворот
      let alignedExtreme = null;
      if (allRates.length >= 2) {
        const allPositive = allRates.every((r) => r > 0.0003); // все >0.03%
        const allNegative = allRates.every((r) => r < -0.0003);
        if (allPositive && Math.abs(avgRate) > 0.0005)
          alignedExtreme = "all_long_extreme";
        else if (allNegative && Math.abs(avgRate) > 0.0005)
          alignedExtreme = "all_short_extreme";
      }

      state.updateAggFunding(symbol, {
        binance: binance?.rate ?? null,
        bybit: bybit?.rate ?? null,
        okx: okx?.rate ?? null,
        avg: avgRate,
        min: minRate,
        max: maxRate,
        spread,
        divergence,
        alignedExtreme,
        ts: Date.now(),
      });
    } catch (e) {
      console.error(`[aggFunding] ${symbol}:`, e.message);
    }
  }
}

export function startAggFunding() {
  console.log("[aggFunding] starting Bybit + OKX polling");

  setTimeout(pollAggFunding, 10 * 1000);
  setInterval(pollAggFunding, 60 * 1000); // раз в минуту — funding меняется медленно
}
