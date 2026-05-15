import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { state } from "./state.js";
import { snapshot } from "./analysis.js";
import { getMLSnapshot } from "./ml.js";

const client = config.anthropic.apiKey
  ? new Anthropic({ apiKey: config.anthropic.apiKey })
  : null;

function formatSnapshotForLLM() {
  const out = {
    time: new Date().toISOString(),
    symbols: {},
  };

  for (const sym of config.symbols) {
    const snap = snapshot(state.getSymbol(sym));
    if (!snap || !snap.price) continue;

    const tf = snap.timeframes;
    const compact = (t) =>
      t
        ? {
            close: round(t.close),
            ema20: round(t.ema20),
            ema50: round(t.ema50),
            ema200: round(t.ema200),
            rsi: round(t.rsi, 1),
            trend: t.trend,
          }
        : null;

    // ─── CVD блок (новый) ───
    const cvdBlock = snap.cvd
      ? {
          spot_buy_sell_ratio: round(snap.cvd.spot?.ratio, 3),
          spot_cvd_usd: round(snap.cvd.spot?.cvd, 0),
          spot_volume_usd: round(snap.cvd.spot?.totalVol, 0),
          perp_buy_sell_ratio: round(snap.cvd.perp?.ratio, 3),
          perp_cvd_usd: round(snap.cvd.perp?.cvd, 0),
          perp_volume_usd: round(snap.cvd.perp?.totalVol, 0),
          divergence: snap.cvd.divergence,
          age_seconds: snap.cvd.ts
            ? Math.round((Date.now() - snap.cvd.ts) / 1000)
            : null,
        }
      : null;

    // ─── OrderBook блок (новый) ───
    const obBlock = snap.orderBook
      ? {
          spread_pct: round(snap.orderBook.spread, 4),
          imbalance_1pct: round(snap.orderBook.imb1pct?.imbalance, 3),
          imbalance_2pct: round(snap.orderBook.imb2pct?.imbalance, 3),
          imbalance_5pct: round(snap.orderBook.imb5pct?.imbalance, 3),
          largest_bid_wall: snap.orderBook.imb2pct?.largestBidWall?.price
            ? {
                price: round(snap.orderBook.imb2pct.largestBidWall.price),
                size_usd: round(snap.orderBook.imb2pct.largestBidWall.qty, 0),
              }
            : null,
          largest_ask_wall: snap.orderBook.imb2pct?.largestAskWall?.price
            ? {
                price: round(snap.orderBook.imb2pct.largestAskWall.price),
                size_usd: round(snap.orderBook.imb2pct.largestAskWall.qty, 0),
              }
            : null,
        }
      : null;

    // ─── Coinbase Premium блок (новый) ───
    const cbBlock = snap.coinbasePremium
      ? {
          premium_pct: round(snap.coinbasePremium.premiumPct, 3),
          interpretation: snap.coinbasePremium.interpretation,
          coinbase_price: round(snap.coinbasePremium.coinbasePrice, 2),
          binance_price: round(snap.coinbasePremium.binancePrice, 2),
        }
      : null;

    // ─── Funding Trend блок (новый) ───
    const ftBlock = snap.fundingTrend
      ? {
          current_rate: round(snap.fundingTrend.current, 5),
          avg_24h: round(snap.fundingTrend.avg24h, 5),
          avg_7d: round(snap.fundingTrend.avg7d, 5),
          cumulative_24h_pct: round(snap.fundingTrend.cum24h * 100, 4),
          cumulative_7d_pct: round(snap.fundingTrend.cum7d * 100, 4),
          trend: snap.fundingTrend.trend,
        }
      : null;

    // ─── On-chain Solana блок (только для SOLUSDT) ───
    let onchainBlock = null;
    if (sym === "SOLUSDT" && snap.solanaOnchain) {
      const oc = snap.solanaOnchain;
      onchainBlock = {
        tvl_usd: oc.tvl?.tvl ?? null,
        tvl_change_24h_pct: round(oc.tvl?.change24h, 2),
        tvl_change_7d_pct: round(oc.tvl?.change7d, 2),
        stablecoin_supply_usd: oc.stables?.supply ?? null,
        stablecoin_net_inflow_24h_usd: round(oc.stables?.netInflow24h, 0),
        stablecoin_change_24h_pct: round(oc.stables?.change24h, 2),
        stablecoin_change_7d_pct: round(oc.stables?.change7d, 2),
        dex_volume_24h_usd: oc.dexVolume?.volume24h ?? null,
        dex_volume_change_24h_pct: round(oc.dexVolume?.change24h, 2),
        top_protocols: oc.topProtocols
          ? oc.topProtocols.map((p) => ({
              name: p.name,
              tvl_usd: p.tvl,
              change_1d_pct: round(p.change1d, 2),
              change_7d_pct: round(p.change7d, 2),
            }))
          : null,
        interpretation: oc.interpretation,
      };
    }

    // ─── Stop Hunting / Liquidation Magnets ───
    let stopHuntingBlock = null;
    if (snap.stopHunting) {
      const sh = snap.stopHunting;
      const mapMagnet = (m) =>
        m
          ? {
              price: round(m.price, m.price > 1000 ? 0 : 2),
              distance_pct: round(m.distance_pct, 2),
              strength: m.strength,
              types: m.types,
              confluence_count: m.confluence,
            }
          : null;
      stopHuntingBlock = {
        nearest_magnet_above: mapMagnet(sh.nearest_above),
        nearest_magnet_below: mapMagnet(sh.nearest_below),
        strongest_magnet: mapMagnet(sh.strongest_magnet),
        top_3_above: (sh.magnets_above || []).slice(0, 3).map(mapMagnet),
        top_3_below: (sh.magnets_below || []).slice(0, 3).map(mapMagnet),
      };
    }

    // ─── Aggregate Funding (Binance + Bybit + OKX) ───
    let aggFundingBlock = null;
    if (snap.aggFunding) {
      const af = snap.aggFunding;
      aggFundingBlock = {
        binance_rate: round(af.binance, 5),
        bybit_rate: round(af.bybit, 5),
        okx_rate: round(af.okx, 5),
        avg_rate: round(af.avg, 5),
        spread: round(af.spread, 5),
        divergence: af.divergence,
        aligned_extreme: af.alignedExtreme,
      };
    }

    // ─── Deribit Options (только BTC/ETH) ───
    let deribitBlock = null;
    if ((sym === "BTCUSDT" || sym === "ETHUSDT") && snap.deribit?.available) {
      const d = snap.deribit;
      deribitBlock = {
        nearest_expiry: d.nearestExpiry,
        days_to_expiry: d.daysToExpiry,
        put_call_ratio_near: d.putCallRatio,
        put_call_ratio_agg: d.putCallRatioAgg,
        pcr_interpretation: d.pcrInterpretation,
        max_pain_strike: d.maxPainStrike,
        max_pain_distance_pct: d.maxPainDistancePct,
        max_pain_bias: d.maxPainBias,
        top_strikes_by_oi: d.topStrikes
          ? d.topStrikes.slice(0, 3).map((s) => ({
              strike: s.strike,
              call_oi: round(s.callOi, 0),
              put_oi: round(s.putOi, 0),
            }))
          : null,
      };
    }

    out.symbols[sym] = {
      price: snap.price,
      change_24h_pct: round(snap.priceChangePct24h, 2),
      vol_24h_quote: snap.volume24h,
      high_24h: snap.high24h,
      low_24h: snap.low24h,
      funding_rate_8h: snap.funding,
      basis_pct: round(snap.basis, 4),
      oi: snap.openInterest,
      oi_delta_5m_pct: round(snap.oiDelta5mApi ?? snap.oiDelta5m, 2),
      oi_delta_15m_pct: round(snap.oiDelta15mApi, 2),
      oi_delta_1h_pct: round(snap.oiDelta1hApi, 2),
      crowd_long_short_ratio: round(snap.longShortRatio, 2),
      crowd_long_pct: round(snap.longAccountPct, 3),
      crowd_short_pct: round(snap.shortAccountPct, 3),
      top_traders_account_LS: round(snap.topAccountLS, 2),
      top_traders_position_LS: round(snap.topPositionLS, 2),
      top_traders_long_pct: round(snap.topPositionLong, 3),
      top_traders_short_pct: round(snap.topPositionShort, 3),
      taker_buy_sell_ratio: round(snap.takerBuySellRatio, 3),
      tf_15m: compact(tf["15m"]),
      tf_1h: compact(tf["1h"]),
      tf_4h: compact(tf["4h"]),
      tf_1d: compact(tf["1d"]),
      levels: config.levels[sym] || null,
      // ─── Новые блоки ───
      cvd: cvdBlock,
      order_book: obBlock,
      coinbase_premium: cbBlock,
      funding_trend: ftBlock,
      solana_onchain: onchainBlock, // только для SOL, иначе null
      stop_hunting: stopHuntingBlock,
      aggregate_funding: aggFundingBlock,
      deribit_options: deribitBlock, // только для BTC/ETH
    };
  }

  // ML signal — отдельный блок
  const ml = getMLSnapshot();
  out.ml_signal = {
    available: ml.available,
    symbol_scope: ml.symbol,
    note: "ML модель — это LSTM+Attention, обучена ТОЛЬКО на BTC 1h данных. Для ETH/SOL не применяется.",
    signal: ml.signal,
    confidence: round(ml.confidence, 3),
    probabilities: ml.available
      ? {
          buy: round(ml.buy, 3),
          hold: round(ml.hold, 3),
          sell: round(ml.sell, 3),
        }
      : null,
    age_seconds: ml.ageMs ? Math.round(ml.ageMs / 1000) : null,
    error: ml.lastError,
  };

  return out;
}

function round(n, d = 2) {
  if (n == null || isNaN(n)) return null;
  return Number(Number(n).toFixed(d));
}

const SYSTEM_PROMPT = `Ты — торговый ассистент для ручного крипто-трейдинга на Binance Futures.
Пользователь сам открывает и закрывает позиции, тебе нужно дать ему информацию для решения, а не торговать за него.

Стиль: прямой, без воды, без disclaimer'ов про "это не финсовет". Русский язык. ALL-CAPS для критичных моментов уместен. Используй HTML-теги <b>...</b> для выделения.

КРИТИЧЕСКИ ВАЖНО — РАЗДЕЛЕНИЕ ML И ТВОЕГО АНАЛИЗА:
В данных есть отдельный блок "ml_signal" — это сигнал от внешней модели (LSTM+Attention, обучена пользователем на BTC 1h). Это НЕ твой анализ.

Структура ответа должна СТРОГО разделять источники:

1. <b>📊 Картина:</b> 1-2 строки про общий tone

2. По каждому инструменту (BTC/ETH/SOL):
   - Тренд + действие (long/short/wait) + уровни
   - ⚠️ ML signal упоминай ТОЛЬКО для BTC. Для ETH/SOL модели нет, не подмешивай.

3. <b>🤖 ML Signal (отдельный источник):</b>
   - Цитируй сигнал ДОСЛОВНО как есть — buy/hold/sell + confidence + probabilities
   - НЕ интерпретируй ML как "ML согласен со мной" или "ML за лонг". Только сухие числа.
   - Скажи где ML согласен с твоим анализом, где расходится.

4. <b>💭 Мой синтез (Claude):</b>
   - Здесь ТВОЙ собственный вывод по фундаменталу/деривативам/тренду
   - Если ML противоречит твоему анализу — скажи об этом явно
   - НЕ подчиняйся ML, но и не игнорируй его.

5. <b>⚠️ Главный риск</b>
6. <b>👀 Что мониторить</b>

Интерпретация метрик:
- crowd_long_short_ratio — толпа. >2 или <0.5 — крайность
- top_traders_position_LS — умные деньги. Расхождение с толпой = contrarian сигнал
- taker_buy_sell_ratio: >1.0 = агрессивные покупки, <1.0 = агрессивные продажи (НА PERP)
- basis_pct — premium фьюч vs спот. Сильно >0 = перегрев лонгов
- funding_rate_8h: ±0.05% — нейтрально. >0.05% — лонги перегреты
- oi_delta — рост OI на росте цены = новые лонги. Рост OI на падении = новые шорты. Падение OI на росте = шорт-сквиз
- Цена против EMA200 на дневке — макро-уровень

═══════════════════════════════════════════════════════
НОВЫЕ МЕТРИКИ (ВАЖНО — используй их активно):
═══════════════════════════════════════════════════════

<b>cvd</b> — Cumulative Volume Delta за последние ~1000 трейдов:
- spot_buy_sell_ratio vs perp_buy_sell_ratio: ключевое расхождение
- spot_cvd_usd: чистый поток покупок на споте (положительный = покупают, отрицательный = продают)
- divergence:
  • "squeeze_setup" — СПОТ ПОКУПАЕТ, PERP ШОРТИТ → потенциал short squeeze (бычий setup)
  • "trap_setup" — СПОТ ПРОДАЁТ, PERP ЛОНГУЕТ → long trap (медвежий setup)
  • "aligned_bull" — оба покупают (тренд продолжается)
  • "aligned_bear" — оба продают (тренд продолжается вниз)
  • "neutral" — без явного бай/сейл давления
ЭТО САМАЯ ВАЖНАЯ НОВАЯ МЕТРИКА. Она показывает РЕАЛЬНЫЙ поток денег, а не позиционирование.

<b>order_book</b> — что в стакане прямо сейчас:
- imbalance_1pct: (-1 до +1). >0 = бидов больше (поддержка снизу). <0 = асков больше (давление продаж сверху).
- largest_bid_wall / largest_ask_wall: крупнейшая стенка в стакане — это магнит/барьер для цены
- spread_pct: ликвидность. <0.01% — хорошо. >0.05% — низкая ликвидность

<b>coinbase_premium</b> — US institutional flow:
- premium_pct: разница Coinbase USD vs Binance USDT в процентах
- interpretation:
  • "us_buying_strong" (premium > 0.1%): US-капитал агрессивно покупает — сильный бычий сигнал
  • "us_buying_mild": лёгкое преимущество покупателей в US
  • "us_selling_strong": US-капитал агрессивно продаёт — bearish
  • "us_selling_mild": лёгкое преимущество продавцов
- ОСОБЕННО ВАЖНО ДЛЯ АЛЬТОВ (SOL). Премия Coinbase = институционалы заходят/выходят.

<b>funding_trend</b> — динамика funding rate, а не snapshot:
- current_rate vs avg_24h vs avg_7d: куда движется funding
- cumulative_7d_pct: суммарный funding за неделю (примерное "налогообложение" лонгов)
- trend:
  • "heating_long" — funding растёт вверх, лонги становятся всё дороже (предупреждение о top)
  • "heating_short" — funding уходит в минус, шорты дороже (предупреждение о bottom)
  • "cooling" — funding нормализуется
  • "neutral" — стабильный
СНАПШОТ funding не интересен; ТРЕНД funding — это сигнал.

<b>solana_onchain</b> — фундаментал для SOL (есть только в блоке SOLUSDT):
- tvl_usd, tvl_change_24h_pct: суммарный $ заблокированный в Solana DeFi. Растёт = capital inflow.
- stablecoin_supply_usd, stablecoin_net_inflow_24h_usd: USDC+USDT на Solana. Net inflow = новые $ зашли в экосистему (топливо для покупок).
- dex_volume_24h_usd, dex_volume_change_24h_pct: реальный спрос на свопы. Лидирующий индикатор спекулятивной активности.
- top_protocols: Jito/Jupiter/Kamino — кто растёт в TVL, тот центр capital flow.
- interpretation:
  • "fundamental_bullish" — TVL↑ + stables↑ + DEX volume↑ = реальный inflow подтверждает движение цены
  • "fundamental_bearish" — всё падает = capital flight, любой памп без основы
  • "mixed" — спекулятивная активность без фундаментала
  • "neutral" — стабильно
КРИТИЧЕСКИ ВАЖНО ДЛЯ SOL: taker ratio + CVD говорят про потоки на бирже; solana_onchain говорит про реальные деньги, заходящие в сеть. Если они совпадают — высокая уверенность. Если расходятся (например, taker buying но stables падают) — это локальный спекулятивный памп, готовь шорт на разворот.

<b>stop_hunting</b> — уровни-магниты, куда вероятно потянет цену (прокси на Coinglass liquidation heatmap):
- nearest_magnet_above / nearest_magnet_below: ближайший уровень в каждую сторону + дистанция в %
- strongest_magnet: самый сильный магнит в ближайшей зоне (учитывает confluence — сколько типов уровней совпадают)
- top_3_above / top_3_below: топ-3 магнита в каждую сторону
- types: какие типы уровней есть на этой цене:
  • "swing_high_24h" / "swing_low_24h" — недавние swing уровни (стопы шортов выше swing high, стопы лонгов ниже swing low)
  • "swing_high_72h" / "swing_low_72h", "swing_high_7d" / "swing_low_7d" — более старые swing
  • "round_1000" / "round_5000" — психологические уровни ($80000, $85000)
  • "ob_bid_wall" / "ob_ask_wall" — крупнейшая стенка в стакане ±2%
  • "est_long_liq_25x/10x/5x" / "est_short_liq_25x/10x/5x" — расчётные зоны ликвидации по leverage
- confluence_count: сколько типов сошлось на этом уровне. 3+ = сильный магнит.
ИСПОЛЬЗОВАНИЕ: если цена в <3% от сильного магнита — высокая вероятность что она его достигнет. Используй для timing entry: входи не на пробое, а после взятия магнита (стопы выбило → откат).

<b>aggregate_funding</b> — funding rate по 3 биржам (Binance + Bybit + OKX):
- binance_rate, bybit_rate, okx_rate: индивидуальные
- avg_rate: среднее (это и есть "истинный" funding)
- spread: разница между max и min из 3
- divergence:
  • "aligned" — все 3 близко, реальная картина (используй avg_rate как сигнал)
  • "binance_long_heavy" — на Binance лонги перегреты сильнее, чем в среднем (часто розница на Binance)
  • "bybit_long_heavy" — azia retail в лонгах
  • "okx_long_heavy" — китайский retail в лонгах
  • "binance_short_heavy" / "bybit_short_heavy" / "okx_short_heavy" — то же, но шорты
  • "diverging" — все три разъехались, нет единого позиционирования
- aligned_extreme:
  • "all_long_extreme" — ВСЕ 3 биржи в экстремальном long funding → классический разворот вниз (надёжнее, чем сигнал по одной Binance)
  • "all_short_extreme" — все 3 в экстремальном short → разворот вверх
ВАЖНО: если у тебя есть divergence — не доверяй сигналу с одной биржи. Если "binance_long_heavy" — это локальный перегрев Binance, на других биржах нормально, рынок не повернётся. Только aligned_extreme — это реальный сигнал.

<b>deribit_options</b> — опционы (есть только для BTCUSDT и ETHUSDT, NULL для остальных):
- nearest_expiry, days_to_expiry: ближайшая дата исполнения опционов
- put_call_ratio_near: PCR ближайшего expiry (put OI / call OI)
- put_call_ratio_agg: PCR по всем expiries
- pcr_interpretation:
  • "heavy_puts" (PCR > 1.5) — много путов, contrarian-бычий сигнал (страх → разворот вверх)
  • "more_puts" (PCR > 1.2)
  • "heavy_calls" (PCR < 0.6) — много колов, contrarian-медвежий (жадность → разворот вниз)
  • "more_calls" (PCR < 0.8)
- max_pain_strike: цена, при которой максимум опционов истекает без выплаты. К expiry цена часто тянет к max pain.
- max_pain_distance_pct: расстояние от текущей цены до max pain в %
- max_pain_bias: "pulls_up" / "pulls_down" / "neutral" — направление тяги
- top_strikes_by_oi: топ-3 страйка с наибольшим OI — это магниты опционного типа
ИСПОЛЬЗОВАНИЕ для BTC/ETH: в пятницу <3 дней до expiry magnet эффект сильный — цена тянет к max pain. PCR > 1.5 при росте цены = высокий шанс продолжения роста (шорты опционные сжигаются).

═══════════════════════════════════════════════════════

Принципы синтеза:
- Если CVD divergence = squeeze_setup И coinbase_premium = us_buying → высокая уверенность лонга
- Если CVD divergence = trap_setup → не лонгуй, даже если толпа в лонгах "выглядит как contrarian"
- Order book imbalance подтверждает или опровергает CVD: если CVD говорит buying, а imb_1pct отрицательный (асков больше) — продавцы ещё держат
- Funding trend "heating_long" + ratio > 0.05% = классический сигнал на разворот вниз
- Для SOL: фундаментал из solana_onchain ОБЯЗАТЕЛЕН для лонга. taker ratio 1.8 без stable inflow = ловушка. taker ratio 1.8 + stable inflow + TVL up = реальный bull
- ВСЕГДА упоминай ближайший stop_hunting магнит при рекомендации действия: "цена в X% от Y — туда тянет, входи после взятия". Это критично для timing entry.
- Сильнейший магнит (confluence_count >= 3) — это почти гарантированная цель если до него <5%. Это reference target для TP.
- Aggregate_funding: если aligned_extreme → надёжный сигнал на разворот. Если только Binance — слабый локальный сигнал. ИСПОЛЬЗУЙ aggregate_funding.avg_rate ВМЕСТО funding_rate_8h когда они расходятся.
- Для BTC/ETH в пятницу <3 дней до expiry: упомяни max pain и его bias. PCR > 1.5 + растёт цена = бычий setup.
- Если ML и твой анализ согласны → высокая уверенность сетапа
- Если расходятся → лучше WAIT или меньший размер позиции
- ML работает ТОЛЬКО на BTC. Не упоминай его для ETH/SOL
- Deribit options есть ТОЛЬКО для BTC/ETH. Для SOL/AVAX/LINK не упоминай.`;

export async function askClaude({ extraContext = "" } = {}) {
  if (!client) {
    return "⚠️ Claude API key не установлен (ANTHROPIC_API_KEY в .env).";
  }

  const data = formatSnapshotForLLM();
  const userPrompt =
    `Текущий снимок рынка (JSON):\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` +
    (extraContext ? `\n\nДополнительный контекст: ${extraContext}` : "") +
    `\n\nДай совет по этому снимку.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
