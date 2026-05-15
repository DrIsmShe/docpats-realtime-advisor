// ─── Deribit Options (BTC + ETH) ───
// Бесплатный публичный API без ключа.
// Считаем: Put/Call ratio по OI, Max Pain (approx), Open Interest по страйкам.

import { state } from "./state.js";

const DERIBIT = "https://www.deribit.com/api/v2";

// Только эти символы у Deribit имеют ликвидные опционы
const SUPPORTED = { BTCUSDT: "BTC", ETHUSDT: "ETH" };

async function getJson(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.2" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

// ─── Парсинг instrument_name ───
// Формат: "BTC-30MAY26-90000-C" → currency=BTC, expiry=30MAY26, strike=90000, type=C(call)/P(put)
function parseInstrument(name) {
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  const [currency, expiry, strikeStr, typeChar] = parts;
  const strike = parseFloat(strikeStr);
  if (isNaN(strike)) return null;
  return {
    currency,
    expiry,
    strike,
    type: typeChar === "C" ? "call" : typeChar === "P" ? "put" : null,
  };
}

// Парсим строку expiry "30MAY26" → Date
const MONTH_MAP = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};
function parseExpiry(str) {
  // "30MAY26" — день (1-2 цифры), месяц (3 буквы), год (2 цифры)
  const m = str.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const month = MONTH_MAP[m[2]];
  const year = 2000 + parseInt(m[3]);
  if (month === undefined) return null;
  return new Date(Date.UTC(year, month, day, 8, 0, 0)); // 08:00 UTC — стандартное время expiry Deribit
}

// ─── Получить summary всех опционов для валюты ───
async function fetchBookSummary(currency) {
  const url = `${DERIBIT}/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
  const data = await getJson(url);
  if (!data?.result || !Array.isArray(data.result)) {
    throw new Error(`Deribit ${currency}: no result`);
  }
  return data.result;
}

// ─── Получить index price (referenced спот цена) ───
async function fetchIndexPrice(currency) {
  const url = `${DERIBIT}/public/get_index_price?index_name=${currency.toLowerCase()}_usd`;
  const data = await getJson(url);
  return data?.result?.index_price ?? null;
}

// ─── Главная обработка для одной валюты ───
async function processCurrency(currency, symbol) {
  const [summary, indexPrice] = await Promise.all([
    fetchBookSummary(currency),
    fetchIndexPrice(currency),
  ]);

  if (!indexPrice) throw new Error(`${currency}: no index price`);

  // Группируем по expiry
  const byExpiry = new Map();
  const now = Date.now();

  for (const inst of summary) {
    const parsed = parseInstrument(inst.instrument_name);
    if (!parsed || !parsed.type) continue;

    const expiryDate = parseExpiry(parsed.expiry);
    if (!expiryDate) continue;

    const expiryMs = expiryDate.getTime();
    if (expiryMs <= now) continue; // прошедшие пропускаем

    const oi = parseFloat(inst.open_interest) || 0;
    if (oi <= 0) continue;

    if (!byExpiry.has(parsed.expiry)) {
      byExpiry.set(parsed.expiry, {
        expiry: parsed.expiry,
        expiryMs,
        daysToExpiry: (expiryMs - now) / (24 * 60 * 60 * 1000),
        callOi: 0,
        putOi: 0,
        strikes: new Map(), // strike → { callOi, putOi }
      });
    }
    const bucket = byExpiry.get(parsed.expiry);

    if (parsed.type === "call") bucket.callOi += oi;
    else bucket.putOi += oi;

    const s = bucket.strikes.get(parsed.strike) || { callOi: 0, putOi: 0 };
    if (parsed.type === "call") s.callOi += oi;
    else s.putOi += oi;
    bucket.strikes.set(parsed.strike, s);
  }

  // Сортируем expiry по близости
  const allExpiries = [...byExpiry.values()].sort(
    (a, b) => a.expiryMs - b.expiryMs,
  );

  if (allExpiries.length === 0) {
    state.updateDeribit(symbol, {
      currency,
      indexPrice,
      available: false,
      ts: Date.now(),
    });
    return;
  }

  const nearest = allExpiries[0];

  // ─── Put/Call ratio для ближайшего expiry ───
  const pcr = nearest.callOi > 0 ? nearest.putOi / nearest.callOi : null;

  // ─── Aggregate PCR (все expiries) ───
  const totalCallOi = allExpiries.reduce((a, e) => a + e.callOi, 0);
  const totalPutOi = allExpiries.reduce((a, e) => a + e.putOi, 0);
  const aggPcr = totalCallOi > 0 ? totalPutOi / totalCallOi : null;

  // ─── Max Pain (approximate) ───
  // Для каждого страйка считаем total cash payout всех опционов если бы expiry было сейчас.
  // Max pain = страйк с минимальным payout (там продавцы опционов выигрывают больше всего, цена тяги туда).
  const strikes = [...nearest.strikes.keys()].sort((a, b) => a - b);
  let maxPainStrike = null;
  let minPayout = Infinity;
  for (const strike of strikes) {
    let payout = 0;
    for (const [s, oi] of nearest.strikes) {
      // Call payout: max(0, strike_settle - s) * callOi
      if (strike > s) payout += (strike - s) * oi.callOi;
      // Put payout: max(0, s - strike_settle) * putOi
      if (s > strike) payout += (s - strike) * oi.putOi;
    }
    if (payout < minPayout) {
      minPayout = payout;
      maxPainStrike = strike;
    }
  }

  // ─── Топ страйки по OI ───
  const topStrikes = strikes
    .map((s) => ({
      strike: s,
      callOi: nearest.strikes.get(s).callOi,
      putOi: nearest.strikes.get(s).putOi,
      totalOi: nearest.strikes.get(s).callOi + nearest.strikes.get(s).putOi,
    }))
    .sort((a, b) => b.totalOi - a.totalOi)
    .slice(0, 5);

  // ─── Интерпретация ───
  let pcrInterp = "neutral";
  if (pcr != null) {
    if (pcr > 1.5)
      pcrInterp = "heavy_puts"; // contrarian bullish
    else if (pcr > 1.2) pcrInterp = "more_puts";
    else if (pcr < 0.6)
      pcrInterp = "heavy_calls"; // contrarian bearish
    else if (pcr < 0.8) pcrInterp = "more_calls";
  }

  // Max pain vs current price
  let maxPainBias = "neutral";
  if (maxPainStrike != null && indexPrice) {
    const diff = ((maxPainStrike - indexPrice) / indexPrice) * 100;
    if (diff > 1) maxPainBias = "pulls_up";
    else if (diff < -1) maxPainBias = "pulls_down";
  }

  state.updateDeribit(symbol, {
    currency,
    indexPrice,
    available: true,
    nearestExpiry: nearest.expiry,
    daysToExpiry: round1(nearest.daysToExpiry),
    putCallRatio: round2(pcr),
    putCallRatioAgg: round2(aggPcr),
    pcrInterpretation: pcrInterp,
    callOi: nearest.callOi,
    putOi: nearest.putOi,
    maxPainStrike,
    maxPainBias,
    maxPainDistancePct:
      maxPainStrike != null && indexPrice
        ? round2(((maxPainStrike - indexPrice) / indexPrice) * 100)
        : null,
    topStrikes,
    ts: Date.now(),
  });
}

function round1(n) {
  if (n == null || isNaN(n)) return null;
  return Number(n.toFixed(1));
}
function round2(n) {
  if (n == null || isNaN(n)) return null;
  return Number(n.toFixed(2));
}

async function pollDeribit() {
  for (const [symbol, currency] of Object.entries(SUPPORTED)) {
    try {
      await processCurrency(currency, symbol);
    } catch (e) {
      console.error(`[deribit] ${symbol}:`, e.message);
    }
  }
}

export function startDeribit() {
  console.log("[deribit] starting options polling (BTC + ETH only)");

  setTimeout(pollDeribit, 14 * 1000);
  setInterval(pollDeribit, 3 * 60 * 1000); // раз в 3 минуты — опционы двигаются медленно
}
