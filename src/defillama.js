// ─── On-chain метрики Solana через DefiLlama (бесплатно, без ключа) ───
// Что собираем:
// 1. TVL chain — суммарный $ заблокированный в Solana DeFi (Jito, Jupiter, Kamino...)
// 2. Stablecoin supply — USDC/USDT supply на Solana (топливо для покупок)
// 3. DEX volume 24h — реальный спрос на свопы
// 4. Top Solana protocols — кто растёт, кто падает

import { state } from "./state.js";

const LLAMA = "https://api.llama.fi";
const STABLE = "https://stablecoins.llama.fi";

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "docpats-realtime-advisor/0.2" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${url} ${res.status}`);
  }
  return res.json();
}

// ─── 1. TVL Solana ───
async function fetchSolanaTVL() {
  // Endpoint возвращает массив [{ date: unix, tvl: usd_value }, ...]
  const data = await getJson(`${LLAMA}/v2/historicalChainTvl/solana`);
  if (!Array.isArray(data) || data.length === 0) return null;

  const now = data[data.length - 1];
  const oneDayAgo = data[data.length - 2]; // данные дневные → -2 это вчера
  const sevenDaysAgo = data[data.length - 8] || data[0];

  if (!now || !now.tvl) return null;

  const change24h =
    oneDayAgo && oneDayAgo.tvl > 0
      ? ((now.tvl - oneDayAgo.tvl) / oneDayAgo.tvl) * 100
      : null;
  const change7d =
    sevenDaysAgo && sevenDaysAgo.tvl > 0
      ? ((now.tvl - sevenDaysAgo.tvl) / sevenDaysAgo.tvl) * 100
      : null;

  return {
    tvl: now.tvl,
    change24h,
    change7d,
    ts: now.date * 1000,
  };
}

// ─── 2. Stablecoin supply на Solana ───
async function fetchSolanaStables() {
  // Возвращает массив [{ date, totalCirculatingUSD: { peggedUSD: X } }, ...]
  const data = await getJson(`${STABLE}/stablecoinchart/Solana`);
  if (!Array.isArray(data) || data.length === 0) return null;

  const now = data[data.length - 1];
  const oneDayAgo = data[data.length - 2];
  const sevenDaysAgo = data[data.length - 8] || data[0];

  const supply = (entry) => {
    if (!entry || !entry.totalCirculatingUSD) return null;
    // totalCirculatingUSD имеет вид { peggedUSD: X } — это сумма всех USD-стейблов
    return entry.totalCirculatingUSD.peggedUSD ?? null;
  };

  const currentSupply = supply(now);
  const yesterdaySupply = supply(oneDayAgo);
  const weekAgoSupply = supply(sevenDaysAgo);

  if (currentSupply == null) return null;

  const change24h =
    yesterdaySupply && yesterdaySupply > 0
      ? ((currentSupply - yesterdaySupply) / yesterdaySupply) * 100
      : null;
  const change7d =
    weekAgoSupply && weekAgoSupply > 0
      ? ((currentSupply - weekAgoSupply) / weekAgoSupply) * 100
      : null;

  // Абсолютный приток в долларах за 24h — это самое важное для трейдинга
  const netInflow24h =
    yesterdaySupply != null ? currentSupply - yesterdaySupply : null;

  return {
    supply: currentSupply,
    netInflow24h,
    change24h,
    change7d,
    ts: now.date ? now.date * 1000 : Date.now(),
  };
}

// ─── 3. DEX volume Solana ───
async function fetchSolanaDexVolume() {
  // /overview/dexs/solana возвращает { total24h, total7d, change_1d, change_7d, ... }
  const data = await getJson(`${LLAMA}/overview/dexs/solana`);
  if (!data) return null;

  return {
    volume24h: data.total24h ?? null,
    volume7d: data.total7d ?? null,
    change24h: data.change_1d ?? null,
    change7d: data.change_7d ?? null,
    ts: Date.now(),
  };
}

// ─── 4. Top Solana protocols (для контекста) ───
async function fetchTopSolanaProtocols() {
  // /protocols — все протоколы, отфильтруем по Solana и возьмём топ 5 по change_1d
  const data = await getJson(`${LLAMA}/protocols`);
  if (!Array.isArray(data)) return null;

  const solanaProtos = data
    .filter((p) => Array.isArray(p.chains) && p.chains.includes("Solana"))
    .filter((p) => p.tvl != null && p.tvl > 1_000_000) // минимум $1M TVL
    .map((p) => ({
      name: p.name,
      tvl: p.tvl,
      change1d: p.change_1d ?? null,
      change7d: p.change_7d ?? null,
    }))
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
    .slice(0, 5);

  return solanaProtos;
}

// ─── Главный сборщик ───
async function pollSolanaOnchain() {
  // Параллельно, чтобы один медленный не блокировал остальные
  const [tvl, stables, dex, protos] = await Promise.allSettled([
    fetchSolanaTVL(),
    fetchSolanaStables(),
    fetchSolanaDexVolume(),
    fetchTopSolanaProtocols(),
  ]);

  const result = {
    tvl: tvl.status === "fulfilled" ? tvl.value : null,
    stables: stables.status === "fulfilled" ? stables.value : null,
    dexVolume: dex.status === "fulfilled" ? dex.value : null,
    topProtocols: protos.status === "fulfilled" ? protos.value : null,
    ts: Date.now(),
  };

  // Лог ошибок
  if (tvl.status === "rejected")
    console.error("[defillama] tvl:", tvl.reason?.message);
  if (stables.status === "rejected")
    console.error("[defillama] stables:", stables.reason?.message);
  if (dex.status === "rejected")
    console.error("[defillama] dex:", dex.reason?.message);
  if (protos.status === "rejected")
    console.error("[defillama] protocols:", protos.reason?.message);

  // ─── Интерпретация ───
  // Bullish: TVL растёт + stables растут + DEX volume растёт = реальный inflow
  // Bearish: всё падает = capital flight
  // Mixed: spec activity без фундамента (или наоборот)
  let interpretation = "neutral";
  const tvlUp = result.tvl?.change24h > 0.5;
  const stablesUp = result.stables?.change24h > 0.3;
  const dexUp = result.dexVolume?.change24h > 5;

  const tvlDown = result.tvl?.change24h < -0.5;
  const stablesDown = result.stables?.change24h < -0.3;
  const dexDown = result.dexVolume?.change24h < -5;

  const bullScore = [tvlUp, stablesUp, dexUp].filter(Boolean).length;
  const bearScore = [tvlDown, stablesDown, dexDown].filter(Boolean).length;

  if (bullScore >= 2 && bearScore === 0) interpretation = "fundamental_bullish";
  else if (bearScore >= 2 && bullScore === 0)
    interpretation = "fundamental_bearish";
  else if (bullScore >= 1 && bearScore >= 1) interpretation = "mixed";
  else interpretation = "neutral";

  result.interpretation = interpretation;

  // Сохраняем под ключом SOLUSDT (привязано к торгуемому символу)
  state.updateSolanaOnchain(result);
}

// ─── Запуск ───
export function startDefiLlama() {
  console.log("[defillama] starting Solana on-chain polling");

  // Первый запрос через 12 сек (даём остальным модулям инициализироваться)
  setTimeout(pollSolanaOnchain, 12 * 1000);

  // Дальше раз в 5 минут — данные дневные, чаще нет смысла
  setInterval(pollSolanaOnchain, 5 * 60 * 1000);
}
