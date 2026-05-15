// ─── Расширенные деривативные метрики ───
// Spot vs Perp CVD, Order Book Imbalance, Funding Trend
// Всё через бесплатные публичные эндпоинты Binance.

import { config } from "./config.js";
import { state } from "./state.js";

const FAPI = "https://fapi.binance.com"; // фьючерсы
const SAPI = "https://api.binance.com"; // спот

// ─── REST helper ───
async function get(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.2" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── 1. Spot vs Perp CVD ───
// CVD = Cumulative Volume Delta.
// За последние N трейдов считаем market BUY volume - market SELL volume.
// isBuyerMaker=false → покупатель был taker → market BUY.
// isBuyerMaker=true → продавец был taker → market SELL.

function computeCVDFromAggTrades(trades) {
  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    const q = parseFloat(t.q); // quantity
    const p = parseFloat(t.p); // price
    const notional = q * p; // USD объём
    if (t.m === false) buyVol += notional;
    else sellVol += notional;
  }
  const totalVol = buyVol + sellVol;
  const cvd = buyVol - sellVol;
  const ratio = sellVol > 0 ? buyVol / sellVol : null;
  return { buyVol, sellVol, totalVol, cvd, ratio };
}

async function fetchPerpCVD(symbol) {
  // Последние 1000 агрегированных трейдов на perp
  const trades = await get(FAPI, "/fapi/v1/aggTrades", {
    symbol,
    limit: 1000,
  });
  return computeCVDFromAggTrades(trades);
}

async function fetchSpotCVD(symbol) {
  // Spot symbol такой же (BTCUSDT, ETHUSDT, SOLUSDT)
  const trades = await get(SAPI, "/api/v3/aggTrades", {
    symbol,
    limit: 1000,
  });
  return computeCVDFromAggTrades(trades);
}

async function pollSpotPerpCVD() {
  for (const symbol of config.symbols) {
    try {
      const [perp, spot] = await Promise.all([
        fetchPerpCVD(symbol),
        fetchSpotCVD(symbol),
      ]);

      // Дивергенция: если spot покупает, а perp продаёт — squeeze setup
      let divergence = "neutral";
      const perpBuying = perp.ratio != null && perp.ratio > 1.1;
      const perpSelling = perp.ratio != null && perp.ratio < 0.9;
      const spotBuying = spot.ratio != null && spot.ratio > 1.1;
      const spotSelling = spot.ratio != null && spot.ratio < 0.9;

      if (spotBuying && perpSelling)
        divergence = "squeeze_setup"; // spot покупают, perp шортят → short squeeze
      else if (spotSelling && perpBuying)
        divergence = "trap_setup"; // spot продают, perp лонгуют → long trap
      else if (spotBuying && perpBuying) divergence = "aligned_bull";
      else if (spotSelling && perpSelling) divergence = "aligned_bear";
      else divergence = "neutral";

      state.updateCVD(symbol, { spot, perp, divergence, ts: Date.now() });
    } catch (e) {
      console.error(`[cvd] ${symbol}:`, e.message);
    }
  }
}

// ─── 2. Order Book Imbalance ───
// /fapi/v1/depth?limit=500 — даст 500 уровней с каждой стороны.
// Считаем сумму bid volume в пределах 1%, 2%, 5% от mid price.
// Аналогично для ask. Imbalance = (bidVol - askVol) / (bidVol + askVol).

function computeImbalance(bids, asks, midPrice, pctRange) {
  const range = midPrice * (pctRange / 100);
  const minBid = midPrice - range;
  const maxAsk = midPrice + range;

  let bidVol = 0;
  let askVol = 0;
  let largestBidWall = { price: null, qty: 0 };
  let largestAskWall = { price: null, qty: 0 };

  for (const [p, q] of bids) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (price >= minBid) {
      const notional = price * qty;
      bidVol += notional;
      if (notional > largestBidWall.qty) {
        largestBidWall = { price, qty: notional };
      }
    }
  }
  for (const [p, q] of asks) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (price <= maxAsk) {
      const notional = price * qty;
      askVol += notional;
      if (notional > largestAskWall.qty) {
        largestAskWall = { price, qty: notional };
      }
    }
  }

  const total = bidVol + askVol;
  const imbalance = total > 0 ? (bidVol - askVol) / total : 0;
  return { bidVol, askVol, imbalance, largestBidWall, largestAskWall };
}

async function pollOrderBook() {
  for (const symbol of config.symbols) {
    try {
      const data = await get(FAPI, "/fapi/v1/depth", {
        symbol,
        limit: 500,
      });
      const bids = data.bids || [];
      const asks = data.asks || [];
      if (bids.length === 0 || asks.length === 0) continue;

      const bestBid = parseFloat(bids[0][0]);
      const bestAsk = parseFloat(asks[0][0]);
      const midPrice = (bestBid + bestAsk) / 2;
      const spread = ((bestAsk - bestBid) / midPrice) * 100;

      const imb1pct = computeImbalance(bids, asks, midPrice, 1);
      const imb2pct = computeImbalance(bids, asks, midPrice, 2);
      const imb5pct = computeImbalance(bids, asks, midPrice, 5);

      state.updateOrderBook(symbol, {
        midPrice,
        spread,
        imb1pct,
        imb2pct,
        imb5pct,
        ts: Date.now(),
      });
    } catch (e) {
      console.error(`[orderbook] ${symbol}:`, e.message);
    }
  }
}

// ─── 3. Funding Trend ───
// fundingHistory уже накапливается в state. Считаем avg за разные периоды.
// Funding каждые 8h → 3 точки в сутки → 21 точка в неделю.

export function computeFundingTrend(symbol) {
  const data = state.getSymbol(symbol);
  const hist = data?.fundingHistory || [];
  if (hist.length === 0) return null;

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const threeDayAgo = now - 3 * 24 * 60 * 60 * 1000;
  const sevenDayAgo = now - 7 * 24 * 60 * 60 * 1000;

  const last24h = hist.filter((f) => f.time >= oneDayAgo);
  const last3d = hist.filter((f) => f.time >= threeDayAgo);
  const last7d = hist.filter((f) => f.time >= sevenDayAgo);

  const avg = (arr) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b.rate, 0) / arr.length;

  const current = hist[hist.length - 1]?.rate ?? null;
  const avg24h = avg(last24h);
  const avg3d = avg(last3d);
  const avg7d = avg(last7d);

  // Накопленный funding за период (примерное "влияние" на лонга)
  const cum24h = last24h.reduce((a, b) => a + b.rate, 0);
  const cum7d = last7d.reduce((a, b) => a + b.rate, 0);

  // Trend: текущий vs средний за неделю
  let trend = "neutral";
  if (avg7d != null && current != null) {
    if (current > avg7d * 1.5 && current > 0) trend = "heating_long";
    else if (current < avg7d * 1.5 && current < 0) trend = "heating_short";
    else if (Math.abs(current) < Math.abs(avg7d) * 0.5) trend = "cooling";
  }

  return {
    current,
    avg24h,
    avg3d,
    avg7d,
    cum24h,
    cum7d,
    trend,
    samples: hist.length,
  };
}

// ─── Запуск ───
export function startDerivatives() {
  console.log("[derivatives] starting CVD + OrderBook + FundingTrend modules");

  // CVD — каждые 30 секунд (1000 трейдов покрывают ~5-30 минут активности)
  setTimeout(pollSpotPerpCVD, 7000);
  setInterval(pollSpotPerpCVD, 30 * 1000);

  // OrderBook — каждые 10 секунд (стакан быстро меняется, важно держать свежим)
  setTimeout(pollOrderBook, 8000);
  setInterval(pollOrderBook, 10 * 1000);
}
