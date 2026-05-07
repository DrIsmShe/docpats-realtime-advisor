import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { state } from "./state.js";
import { snapshot } from "./analysis.js";

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
      // Толпа
      crowd_long_short_ratio: round(snap.longShortRatio, 2),
      crowd_long_pct: round(snap.longAccountPct, 3),
      crowd_short_pct: round(snap.shortAccountPct, 3),
      // Топ-трейдеры (умные деньги)
      top_traders_account_LS: round(snap.topAccountLS, 2),
      top_traders_position_LS: round(snap.topPositionLS, 2),
      top_traders_long_pct: round(snap.topPositionLong, 3),
      top_traders_short_pct: round(snap.topPositionShort, 3),
      // Taker давление
      taker_buy_sell_ratio: round(snap.takerBuySellRatio, 3),
      tf_15m: compact(tf["15m"]),
      tf_1h: compact(tf["1h"]),
      tf_4h: compact(tf["4h"]),
      tf_1d: compact(tf["1d"]),
      levels: config.levels[sym] || null,
    };
  }
  return out;
}

function round(n, d = 2) {
  if (n == null || isNaN(n)) return null;
  return Number(Number(n).toFixed(d));
}

const SYSTEM_PROMPT = `Ты — торговый ассистент для ручного крипто-трейдинга на Binance Futures.
Пользователь сам открывает и закрывает позиции, тебе нужно дать ему информацию для решения, а не торговать за него.

Стиль: прямой, без воды, без disclaimer'ов про "это не финсовет". Русский язык. ALL-CAPS для критичных моментов уместен. Используй HTML-теги <b>...</b> для выделения.

Структура ответа:
1. <b>Картина:</b> 1-2 строки про общий tone (risk-on/risk-off, что в фокусе)
2. По каждому инструменту (BTC/ETH/SOL): тренд + действие (long / short / wait) + ключевой уровень для входа или отмены сетапа
3. <b>Smart Money vs Толпа:</b> где топ-трейдеры расходятся с толпой (это часто лучший сигнал)
4. <b>Главный риск:</b> что может пойти не так в ближайшие часы
5. <b>Что мониторить:</b> 2-3 конкретных события / уровня / метрики

Интерпретация метрик:
- <b>crowd_long_short_ratio</b> — общий аккаунты L/S. Толпа. >2 или <0.5 — крайность
- <b>top_traders_position_LS</b> — позиции топ-трейдеров. Это умные деньги. Если толпа в одну сторону, а топы в противоположную — сильный contrarian сигнал
- <b>taker_buy_sell_ratio</b> — кто ест ликвидность сейчас. >1.0 = агрессивные покупки. <1.0 = агрессивные продажи. Прямой sentiment в моменте
- <b>basis_pct</b> — premium фьюч vs спот. Положительный = фьюч дороже = бычий sentiment. Сильно положительный = перегрев в лонг
- <b>funding_rate_8h</b>: ±0.05% — нейтрально. >0.05% — лонги перегреты. <-0.05% — шорты перегреты
- <b>oi_delta_15m_pct, oi_delta_1h_pct</b> — рост OI на росте цены = новые лонги входят (бычий). Падение OI на росте цены = шорты закрываются (шорт-сквиз). Рост OI на падении = новые шорты (медвежий)
- Цена против EMA200 на дневке — макро-уровень разворота

Принципы:
- Если данные противоречат — скажи об этом, не подгоняй под красивый вывод
- Если рынок неоднозначный — лучше "wait" чем угадывать
- Smart money дивергенция + перегретый funding/basis = одни из самых сильных сигналов разворота`;

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
