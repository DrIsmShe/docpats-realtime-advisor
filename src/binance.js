import { config } from "./config.js";
import { state } from "./state.js";

// ─── REST helpers ───
async function get(path, params = {}) {
  const url = new URL(config.binance.restBase + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.1" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Health ───
export const wsHealth = {
  connected: true,
  lastMessageAt: 0,
  reconnectCount: 0,
  messagesReceived: 0,
  mode: "rest-polling",
};

// ─── Загрузка исторических свечей ───
export async function loadInitialKlines() {
  for (const symbol of config.symbols) {
    for (const tf of config.timeframes) {
      try {
        const data = await get("/fapi/v1/klines", {
          symbol,
          interval: tf,
          limit: 250,
        });
        const klines = data.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
          isClosed: true,
        }));
        state.setKlines(symbol, tf, klines);
        console.log(
          `[binance] loaded ${klines.length} ${tf} klines for ${symbol}`,
        );
      } catch (e) {
        console.error(`[binance] failed to load ${symbol} ${tf}:`, e.message);
      }
    }
  }
}

// ─── Быстрый поллинг тикера (раз в 1 секунду) ───
async function pollTickers() {
  const promises = config.symbols.map(async (symbol) => {
    try {
      const data = await get("/fapi/v1/ticker/24hr", { symbol });
      state.updateTicker(symbol, {
        price: parseFloat(data.lastPrice),
        priceChange24h: parseFloat(data.priceChange),
        priceChangePct24h: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        volume24h: parseFloat(data.volume),
        quoteVolume24h: parseFloat(data.quoteVolume),
      });
      wsHealth.lastMessageAt = Date.now();
      wsHealth.messagesReceived += 1;
      wsHealth.connected = true;
    } catch (e) {
      console.error(`[ticker] ${symbol}:`, e.message);
      if (Date.now() - wsHealth.lastMessageAt > 30000) {
        wsHealth.connected = false;
      }
    }
  });
  await Promise.all(promises);
}

// ─── Поллинг свежих свечей (только последние 2) ───
async function pollKlinesForTimeframe(timeframe) {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/fapi/v1/klines", {
        symbol,
        interval: timeframe,
        limit: 2,
      });
      for (const k of data) {
        state.updateKline(symbol, timeframe, {
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
          isClosed: k[6] < Date.now() - 1000,
        });
      }
    } catch (e) {
      console.error(`[kline ${timeframe}] ${symbol}:`, e.message);
    }
  }
}

// ─── Funding / OI / L/S ratio ───
async function pollFunding() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/fapi/v1/premiumIndex", { symbol });
      state.updateFunding(symbol, {
        rate: parseFloat(data.lastFundingRate),
        nextFundingTime: data.nextFundingTime,
        markPrice: parseFloat(data.markPrice),
        indexPrice: parseFloat(data.indexPrice),
      });
    } catch (e) {
      console.error(`[funding] ${symbol}:`, e.message);
    }
  }
}

async function pollOpenInterest() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/fapi/v1/openInterest", { symbol });
      state.updateOpenInterest(symbol, {
        openInterest: parseFloat(data.openInterest),
        time: data.time,
      });
    } catch (e) {
      console.error(`[oi] ${symbol}:`, e.message);
    }
  }
}

async function pollLongShortRatio() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/futures/data/globalLongShortAccountRatio", {
        symbol,
        period: "5m",
        limit: 1,
      });
      if (data && data.length > 0) {
        const r = data[0];
        state.updateLongShortRatio(symbol, {
          longShortRatio: parseFloat(r.longShortRatio),
          longAccount: parseFloat(r.longAccount),
          shortAccount: parseFloat(r.shortAccount),
          timestamp: r.timestamp,
        });
      }
    } catch (e) {
      console.error(`[longShort] ${symbol}:`, e.message);
    }
  }
}

// ─── L/S accounts топ-трейдеров (умные деньги по аккаунтам) ───
async function pollTopAccountLS() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/futures/data/topLongShortAccountRatio", {
        symbol,
        period: "5m",
        limit: 1,
      });
      if (data && data.length > 0) {
        const r = data[0];
        state.updateTopAccountLS(symbol, {
          longShortRatio: parseFloat(r.longShortRatio),
          longAccount: parseFloat(r.longAccount),
          shortAccount: parseFloat(r.shortAccount),
          timestamp: r.timestamp,
        });
      }
    } catch (e) {
      console.error(`[topAccountLS] ${symbol}:`, e.message);
    }
  }
}

// ─── L/S positions топ-трейдеров (умные деньги по позициям, более информативно) ───
async function pollTopPositionLS() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/futures/data/topLongShortPositionRatio", {
        symbol,
        period: "5m",
        limit: 1,
      });
      if (data && data.length > 0) {
        const r = data[0];
        state.updateTopPositionLS(symbol, {
          longShortRatio: parseFloat(r.longShortRatio),
          longAccount: parseFloat(r.longAccount),
          shortAccount: parseFloat(r.shortAccount),
          timestamp: r.timestamp,
        });
      }
    } catch (e) {
      console.error(`[topPositionLS] ${symbol}:`, e.message);
    }
  }
}

// ─── Taker Buy/Sell Volume — кто ест ликвидность ───
async function pollTakerBuySell() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/futures/data/takerlongshortRatio", {
        symbol,
        period: "5m",
        limit: 1,
      });
      if (data && data.length > 0) {
        const r = data[0];
        state.updateTakerBuySell(symbol, {
          buySellRatio: parseFloat(r.buySellRatio),
          buyVol: parseFloat(r.buyVol),
          sellVol: parseFloat(r.sellVol),
          timestamp: r.timestamp,
        });
      }
    } catch (e) {
      console.error(`[takerBuySell] ${symbol}:`, e.message);
    }
  }
}

// ─── OI history (5m) — реальная динамика OI с биржи ───
async function pollOIHistApi() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/futures/data/openInterestHist", {
        symbol,
        period: "5m",
        limit: 30,
      });
      if (data && data.length > 0) {
        const history = data.map((r) => ({
          time: parseInt(r.timestamp),
          value: parseFloat(r.sumOpenInterest),
          valueUsd: parseFloat(r.sumOpenInterestValue),
        }));
        state.updateOIHistApi(symbol, history);
      }
    } catch (e) {
      console.error(`[oiHistApi] ${symbol}:`, e.message);
    }
  }
}

// ─── Funding history — последние 40 циклов ───
async function pollFundingHistory() {
  for (const symbol of config.symbols) {
    try {
      const data = await get("/fapi/v1/fundingRate", {
        symbol,
        limit: 40,
      });
      if (data && data.length > 0) {
        const history = data.map((r) => ({
          time: parseInt(r.fundingTime),
          rate: parseFloat(r.fundingRate),
        }));
        state.updateFundingHistory(symbol, history);
      }
    } catch (e) {
      console.error(`[fundingHist] ${symbol}:`, e.message);
    }
  }
}

// ─── Главный планировщик (REST polling) ───
export function startWebSocket() {
  console.log(
    "[binance] mode: REST polling (no websocket — ISP/firewall blocks WS)",
  );

  // Тикер: каждую секунду
  pollTickers();
  setInterval(pollTickers, 1000);

  // Свечи 15m: каждые 5 секунд
  setTimeout(() => pollKlinesForTimeframe("15m"), 1500);
  setInterval(() => pollKlinesForTimeframe("15m"), 5000);

  // Свечи 1h: каждые 10 секунд
  setTimeout(() => pollKlinesForTimeframe("1h"), 2000);
  setInterval(() => pollKlinesForTimeframe("1h"), 10000);

  // Свечи 4h: каждую минуту
  setTimeout(() => pollKlinesForTimeframe("4h"), 3000);
  setInterval(() => pollKlinesForTimeframe("4h"), 60 * 1000);

  // Свечи 1d: каждую минуту
  setTimeout(() => pollKlinesForTimeframe("1d"), 4000);
  setInterval(() => pollKlinesForTimeframe("1d"), 60 * 1000);
}

export function startPolling() {
  // Базовые
  pollFunding();
  pollOpenInterest();
  pollLongShortRatio();

  setInterval(pollFunding, 30 * 1000);
  setInterval(pollOpenInterest, 30 * 1000);
  setInterval(pollLongShortRatio, 60 * 1000);

  // Smart Money: топ-трейдеры
  setTimeout(() => pollTopAccountLS(), 2000);
  setTimeout(() => pollTopPositionLS(), 3000);
  setInterval(pollTopAccountLS, 60 * 1000);
  setInterval(pollTopPositionLS, 60 * 1000);

  // Taker давление
  setTimeout(() => pollTakerBuySell(), 4000);
  setInterval(pollTakerBuySell, 60 * 1000);

  // История OI 5m с биржи (реальная)
  setTimeout(() => pollOIHistApi(), 5000);
  setInterval(pollOIHistApi, 5 * 60 * 1000); // каждые 5 минут

  // История funding (40 циклов = ~13 дней)
  setTimeout(() => pollFundingHistory(), 6000);
  setInterval(pollFundingHistory, 30 * 60 * 1000); // каждые 30 минут
}
