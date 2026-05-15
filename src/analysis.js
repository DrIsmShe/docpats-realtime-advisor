// ─── Технические индикаторы ───
import { computeFundingTrend } from "./derivatives.js";
import { state } from "./state.js";

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  if (ema12 === null || ema26 === null) return null;
  return { line: ema12 - ema26 };
}

function avgVolume(klines, period = 20) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  return recent.reduce((a, k) => a + k.volume, 0) / period;
}

// ─── Расчёт по одному ТФ ───
export function computeTimeframe(klines) {
  if (!klines || klines.length < 30) return null;
  const closes = klines.map((k) => k.close);
  const last = klines[klines.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);

  let trend = "neutral";
  if (ema20 && ema50) {
    if (last.close > ema20 && ema20 > ema50) trend = "bullish";
    else if (last.close < ema20 && ema20 < ema50) trend = "bearish";
    else trend = "mixed";
  }

  return {
    close: last.close,
    ema20,
    ema50,
    ema200,
    rsi: r,
    macd: m,
    trend,
    avgVolume: avgVolume(klines, 20),
    lastVolume: last.volume,
  };
}

// ─── Полный снимок по символу ───
export function snapshot(symbolData) {
  if (!symbolData) return null;
  const tfResults = {};
  for (const [tf, klines] of Object.entries(symbolData.klines)) {
    tfResults[tf] = computeTimeframe(klines);
  }

  // OI delta за ~5 min (10 точек по 30s)
  let oiDelta5m = null;
  const oiHist = symbolData.oiHistory;
  if (oiHist && oiHist.length >= 10) {
    const now = oiHist[oiHist.length - 1];
    const past = oiHist[oiHist.length - 10];
    if (past.value > 0) {
      oiDelta5m = ((now.value - past.value) / past.value) * 100;
    }
  }

  // Fallback price
  const klines1d = symbolData.klines["1d"] || [];
  const klines15m = symbolData.klines["15m"] || [];
  const lastKline =
    klines15m[klines15m.length - 1] || klines1d[klines1d.length - 1] || null;

  let priceFallback = null;
  let changePctFallback = null;
  let highFallback = null;
  let lowFallback = null;

  if (lastKline) {
    priceFallback = lastKline.close;
    if (klines1d.length > 0) {
      const today = klines1d[klines1d.length - 1];
      if (today.open > 0) {
        changePctFallback = ((today.close - today.open) / today.open) * 100;
      }
      highFallback = today.high;
      lowFallback = today.low;
    }
  }

  // OI Δ из API
  let oiDelta5mApi = null;
  let oiDelta15mApi = null;
  let oiDelta1hApi = null;
  const oiHistApi = symbolData.oiHistApi || [];
  if (oiHistApi.length >= 2) {
    const latest = oiHistApi[oiHistApi.length - 1];
    const m5 = oiHistApi[oiHistApi.length - 2];
    if (m5 && m5.value > 0)
      oiDelta5mApi = ((latest.value - m5.value) / m5.value) * 100;
    const m15 = oiHistApi[oiHistApi.length - 4];
    if (m15 && m15.value > 0)
      oiDelta15mApi = ((latest.value - m15.value) / m15.value) * 100;
    const h1 = oiHistApi[oiHistApi.length - 13];
    if (h1 && h1.value > 0)
      oiDelta1hApi = ((latest.value - h1.value) / h1.value) * 100;
  }

  // ─── Новые метрики ───
  const cvd = symbolData.cvd; // { spot, perp, divergence, ts }
  const orderBook = symbolData.orderBook; // { midPrice, spread, imb1pct, imb2pct, imb5pct, ts }
  const coinbasePremium = symbolData.coinbasePremium;
  const fundingTrend = computeFundingTrend(symbolData.symbol);

  // On-chain Solana (только для SOL карточки)
  let solanaOnchain = null;
  if (symbolData.symbol === "SOLUSDT") {
    solanaOnchain = state.getSolanaOnchain();
  }

  return {
    symbol: symbolData.symbol,
    price: symbolData.ticker?.price ?? priceFallback,
    priceChangePct24h:
      symbolData.ticker?.priceChangePct24h ?? changePctFallback,
    volume24h: symbolData.ticker?.quoteVolume24h ?? null,
    high24h: symbolData.ticker?.high24h ?? highFallback,
    low24h: symbolData.ticker?.low24h ?? lowFallback,
    funding: symbolData.funding?.rate ?? null,
    nextFundingTime: symbolData.funding?.nextFundingTime ?? null,
    basis: symbolData.basis ?? null,
    openInterest: symbolData.openInterest?.openInterest ?? null,
    oiDelta5m,
    oiDelta5mApi,
    oiDelta15mApi,
    oiDelta1hApi,
    longShortRatio: symbolData.longShortRatio?.longShortRatio ?? null,
    longAccountPct: symbolData.longShortRatio?.longAccount ?? null,
    shortAccountPct: symbolData.longShortRatio?.shortAccount ?? null,
    topAccountLS: symbolData.topAccountLS?.longShortRatio ?? null,
    topAccountLong: symbolData.topAccountLS?.longAccount ?? null,
    topAccountShort: symbolData.topAccountLS?.shortAccount ?? null,
    topPositionLS: symbolData.topPositionLS?.longShortRatio ?? null,
    topPositionLong: symbolData.topPositionLS?.longAccount ?? null,
    topPositionShort: symbolData.topPositionLS?.shortAccount ?? null,
    takerBuySellRatio: symbolData.takerBuySell?.buySellRatio ?? null,
    timeframes: tfResults,
    // ─── Новые поля в snapshot ───
    cvd, // полный объект для UI
    orderBook, // полный объект для UI
    coinbasePremium,
    fundingTrend,
    solanaOnchain, // только для SOL, иначе null
    stopHunting: symbolData.stopHunting,
    aggFunding: symbolData.aggFunding,
    deribit: symbolData.deribit, // только для BTC/ETH
    // ─── Конец новых полей ───
    updatedAt: symbolData.updatedAt,
    lastTickerAt: symbolData.lastTickerAt,
  };
}
