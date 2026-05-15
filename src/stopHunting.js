// ─── Stop Hunting / Liquidation Magnets (бесплатный прокси на Coinglass heatmap) ───
// Не делает внешних запросов. Использует только данные из state.
// Считает уровни-магниты, куда вероятно пойдёт цена.

import { config } from "./config.js";
import { state } from "./state.js";

// ─── Swing highs / lows из klines ───
// Локальный максимум = свеча, у которой high строго выше N соседних свечей с обеих сторон.
function findSwings(klines, window = 5) {
  const highs = [];
  const lows = [];
  if (!klines || klines.length < window * 2 + 1) return { highs, lows };

  for (let i = window; i < klines.length - window; i++) {
    const candle = klines[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (klines[j].high >= candle.high) isSwingHigh = false;
      if (klines[j].low <= candle.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      highs.push({
        price: candle.high,
        time: candle.openTime,
        age: klines.length - 1 - i,
      });
    }
    if (isSwingLow) {
      lows.push({
        price: candle.low,
        time: candle.openTime,
        age: klines.length - 1 - i,
      });
    }
  }

  return { highs, lows };
}

// ─── Round numbers вокруг цены ───
function getRoundLevels(price, symbol) {
  if (!price) return [];
  const stepsForSymbol = {
    BTCUSDT: [1000, 5000, 10000],
    ETHUSDT: [100, 250, 500],
    SOLUSDT: [5, 10, 25],
    AVAXUSDT: [5, 10],
    LINKUSDT: [1, 2, 5],
  };
  const steps = stepsForSymbol[symbol] || [
    Math.pow(10, Math.floor(Math.log10(price)) - 1),
  ];

  const strengthOrder = { low: 0, medium: 1, high: 2 };
  const map = new Map();
  const rangeMin = price * 0.85;
  const rangeMax = price * 1.15;

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    const strength =
      s === steps.length - 1 ? "high" : s === 0 ? "low" : "medium";
    const start = Math.ceil(rangeMin / step) * step;
    const end = Math.floor(rangeMax / step) * step;
    for (let level = start; level <= end; level += step) {
      const existing = map.get(level);
      if (
        !existing ||
        strengthOrder[strength] > strengthOrder[existing.strength]
      ) {
        map.set(level, { price: level, strength, type: `round_${step}` });
      }
    }
  }
  return [...map.values()];
}

// ─── Estimated liquidation zones из OI delta ───
// OI↑ + цена↑ за последний час = новые лонги → их ликвидируют ниже текущей цены
// OI↑ + цена↓ за последний час = новые шорты → их ликвидируют выше текущей цены
function estimateLiquidationZones(symbolData, currentPrice) {
  const result = { longLiq: [], shortLiq: [] };
  if (!currentPrice) return result;

  const oiHist = symbolData.oiHistApi || [];
  if (oiHist.length < 13) return result;

  const latest = oiHist[oiHist.length - 1];
  const hourAgo = oiHist[oiHist.length - 13];
  if (!latest || !hourAgo || hourAgo.value <= 0) return result;

  const oiDeltaPct = ((latest.value - hourAgo.value) / hourAgo.value) * 100;
  if (Math.abs(oiDeltaPct) < 0.5) return result; // нет свежих позиций

  const k15m = symbolData.klines["15m"] || [];
  if (k15m.length < 5) return result;
  const priceHourAgo = k15m[k15m.length - 5].close;
  if (!priceHourAgo || priceHourAgo <= 0) return result;
  const priceDeltaPct = ((currentPrice - priceHourAgo) / priceHourAgo) * 100;

  const longsAdded = oiDeltaPct > 0 && priceDeltaPct > 0;
  const shortsAdded = oiDeltaPct > 0 && priceDeltaPct < 0;

  // Уровни ликвидации при разных leverage
  // 25x → ±4%, 10x → ±10%, 5x → ±20%
  const levels = [
    { lev: 25, pct: 4, strength: "high" }, // 25x — самые ранние стопы, чаще всего
    { lev: 10, pct: 10, strength: "medium" },
    { lev: 5, pct: 20, strength: "low" },
  ];

  if (longsAdded) {
    for (const l of levels) {
      const price = currentPrice * (1 - l.pct / 100);
      result.longLiq.push({
        price,
        leverage: l.lev,
        strength: l.strength,
        type: `est_long_liq_${l.lev}x`,
      });
    }
  }
  if (shortsAdded) {
    for (const l of levels) {
      const price = currentPrice * (1 + l.pct / 100);
      result.shortLiq.push({
        price,
        leverage: l.lev,
        strength: l.strength,
        type: `est_short_liq_${l.lev}x`,
      });
    }
  }

  return result;
}

// ─── Главная функция: собрать все магниты для символа ───
function computeMagnets(symbol) {
  const data = state.getSymbol(symbol);
  if (!data) return null;

  const price = data.ticker?.price;
  if (!price) return null;

  const magnets = []; // { price, type, strength, source }

  // 1. Swing highs/lows за разные периоды
  const k15m = data.klines["15m"] || []; // 250 свечей × 15 мин = ~62h истории
  const k1h = data.klines["1h"] || []; // 250 свечей × 1h = ~10 дней
  const k4h = data.klines["4h"] || []; // 250 свечей × 4h = ~42 дня

  // Свинги за 24h (последние 96 свечей 15m)
  const recent24h = k15m.slice(-96);
  const swings24h = findSwings(recent24h, 3);
  for (const h of swings24h.highs) {
    magnets.push({
      price: h.price,
      type: "swing_high_24h",
      strength: "high",
      source: "klines_15m",
    });
  }
  for (const l of swings24h.lows) {
    magnets.push({
      price: l.price,
      type: "swing_low_24h",
      strength: "high",
      source: "klines_15m",
    });
  }

  // Свинги за 72h (последние 72 свечи 1h)
  const recent72h = k1h.slice(-72);
  const swings72h = findSwings(recent72h, 4);
  for (const h of swings72h.highs) {
    magnets.push({
      price: h.price,
      type: "swing_high_72h",
      strength: "medium",
      source: "klines_1h",
    });
  }
  for (const l of swings72h.lows) {
    magnets.push({
      price: l.price,
      type: "swing_low_72h",
      strength: "medium",
      source: "klines_1h",
    });
  }

  // Свинги за 7d (последние 42 свечи 4h)
  const recent7d = k4h.slice(-42);
  const swings7d = findSwings(recent7d, 4);
  for (const h of swings7d.highs) {
    magnets.push({
      price: h.price,
      type: "swing_high_7d",
      strength: "high",
      source: "klines_4h",
    });
  }
  for (const l of swings7d.lows) {
    magnets.push({
      price: l.price,
      type: "swing_low_7d",
      strength: "high",
      source: "klines_4h",
    });
  }

  // 2. Round numbers
  const rounds = getRoundLevels(price, symbol);
  for (const r of rounds) {
    magnets.push({
      price: r.price,
      type: r.type,
      strength: r.strength,
      source: "psychology",
    });
  }

  // 3. Order book walls
  const ob = data.orderBook;
  if (ob?.imb2pct?.largestBidWall?.price) {
    magnets.push({
      price: ob.imb2pct.largestBidWall.price,
      type: "ob_bid_wall",
      strength: "medium",
      source: "orderbook",
      meta: { size_usd: ob.imb2pct.largestBidWall.qty },
    });
  }
  if (ob?.imb2pct?.largestAskWall?.price) {
    magnets.push({
      price: ob.imb2pct.largestAskWall.price,
      type: "ob_ask_wall",
      strength: "medium",
      source: "orderbook",
      meta: { size_usd: ob.imb2pct.largestAskWall.qty },
    });
  }

  // 4. Estimated liquidation zones из OI
  const liqZones = estimateLiquidationZones(data, price);
  for (const z of [...liqZones.longLiq, ...liqZones.shortLiq]) {
    magnets.push({
      price: z.price,
      type: z.type,
      strength: z.strength,
      source: "oi_estimate",
      meta: { leverage: z.leverage },
    });
  }

  // ─── Дедупликация близких уровней (в пределах 0.3% друг от друга) ───
  // Сортируем по цене, мерджим близкие. Сохраняем самый сильный strength.
  const sorted = magnets.sort((a, b) => a.price - b.price);
  const merged = [];
  const mergeRange = 0.003; // 0.3%
  const strengthOrder = { low: 0, medium: 1, high: 2 };

  for (const m of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(m.price - last.price) / last.price < mergeRange) {
      // Сливаем в last
      last.types = last.types || [last.type];
      if (!last.types.includes(m.type)) last.types.push(m.type);
      if (strengthOrder[m.strength] > strengthOrder[last.strength]) {
        last.strength = m.strength;
      }
      last.confluence = (last.confluence || 1) + 1;
    } else {
      merged.push({
        ...m,
        types: [m.type],
        confluence: 1,
      });
    }
  }

  // Бонус к strength за конфлюенс (2+ типа на одном уровне)
  for (const m of merged) {
    if (m.confluence >= 3) m.strength = "high";
    else if (m.confluence >= 2 && m.strength === "low") m.strength = "medium";
  }

  // ─── Разделение на выше / ниже цены ───
  const above = merged
    .filter((m) => m.price > price)
    .map((m) => ({
      ...m,
      distance_pct: ((m.price - price) / price) * 100,
    }))
    .sort((a, b) => a.distance_pct - b.distance_pct);

  const below = merged
    .filter((m) => m.price < price)
    .map((m) => ({
      ...m,
      distance_pct: ((price - m.price) / price) * 100,
    }))
    .sort((a, b) => a.distance_pct - b.distance_pct);

  // ─── Топ магниты ───
  // Ближайший в каждую сторону (если он в пределах 5% и хотя бы medium strength)
  const nearestAbove =
    above.find((m) => m.distance_pct <= 5 && m.strength !== "low") ||
    above[0] ||
    null;
  const nearestBelow =
    below.find((m) => m.distance_pct <= 5 && m.strength !== "low") ||
    below[0] ||
    null;

  // Самый "сильный" магнит в пределах 8% (с учётом конфлюенса)
  const allNear = [...above.slice(0, 8), ...below.slice(0, 8)];
  const strongest = allNear.reduce((best, m) => {
    if (!best) return m;
    const scoreOf = (x) => strengthOrder[x.strength] * 10 + (x.confluence || 1);
    return scoreOf(m) > scoreOf(best) ? m : best;
  }, null);

  return {
    price,
    magnets_above: above.slice(0, 10), // топ-10
    magnets_below: below.slice(0, 10),
    nearest_above: nearestAbove,
    nearest_below: nearestBelow,
    strongest_magnet: strongest,
    ts: Date.now(),
  };
}

// ─── Опрос всех символов ───
function refreshAll() {
  for (const symbol of config.symbols) {
    try {
      const result = computeMagnets(symbol);
      if (result) state.updateStopHunting(symbol, result);
    } catch (e) {
      console.error(`[stopHunting] ${symbol}:`, e.message);
    }
  }
}

export function startStopHunting() {
  console.log(
    "[stopHunting] starting (swing levels + round numbers + OB walls + OI liq zones)",
  );

  // Первый расчёт через 15 сек (даём данным накопиться)
  setTimeout(refreshAll, 15 * 1000);

  // Дальше каждую минуту — пересчёт быстрый, всё локально
  setInterval(refreshAll, 60 * 1000);
}
