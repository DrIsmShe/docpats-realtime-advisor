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
    };
  }

  // ─── ML signal — ОТДЕЛЬНЫЙ блок, не смешан с остальными данными ───
  const ml = getMLSnapshot();
  out.ml_signal = {
    available: ml.available,
    symbol_scope: ml.symbol, // на каком символе работает ML (BTCUSDT)
    note: "ML модель — это LSTM+Attention, обучена ТОЛЬКО на BTC 1h данных. Для ETH/SOL не применяется.",
    signal: ml.signal, // BUY / HOLD / SELL
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
   - Если ML противоречит твоему анализу — скажи об этом явно: "ML говорит X, но я не вижу подтверждения, потому что Y"
   - НЕ подчиняйся ML, но и не игнорируй его.

5. <b>⚠️ Главный риск</b>
6. <b>👀 Что мониторить</b>

Интерпретация метрик:
- crowd_long_short_ratio — толпа. >2 или <0.5 — крайность
- top_traders_position_LS — умные деньги. Расхождение с толпой = contrarian сигнал
- taker_buy_sell_ratio: >1.0 = агрессивные покупки, <1.0 = агрессивные продажи
- basis_pct — premium фьюч vs спот. Сильно >0 = перегрев лонгов
- funding_rate_8h: ±0.05% — нейтрально. >0.05% — лонги перегреты
- oi_delta — рост OI на росте цены = новые лонги. Рост OI на падении = новые шорты. Падение OI на росте = шорт-сквиз
- Цена против EMA200 на дневке — макро-уровень

Принципы:
- Если ML и твой анализ согласны → высокая уверенность сетапа
- Если расходятся → лучше WAIT или меньший размер позиции
- ML работает ТОЛЬКО на BTC. Не упоминай его для ETH/SOL`;

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
