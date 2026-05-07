import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { state } from "./state.js";
import { snapshot } from "./analysis.js";
import { askClaude } from "./claude.js";
import { getMLSnapshot } from "./ml.js";

let bot = null;
const allowedChatIds = new Set();

export function startTelegram() {
  if (!config.telegram.token) {
    console.warn("[telegram] no token, skipping");
    return;
  }

  bot = new TelegramBot(config.telegram.token, { polling: true });

  if (config.telegram.chatId) {
    allowedChatIds.add(parseInt(config.telegram.chatId, 10));
  }

  bot.on("polling_error", (e) =>
    console.error("[telegram] polling:", e.message),
  );

  bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `📡 <b>docpats real-time advisor</b>\n` +
        `chat_id: <code>${msg.chat.id}</code>\n\n` +
        `Команды:\n` +
        `/snapshot — сводка по всем парам\n` +
        `/snap BTC|ETH|SOL — по одной паре\n` +
        `/advice — анализ от Claude\n` +
        `/levels — текущие уровни S/R\n` +
        `/status — статус системы`,
      { parse_mode: "HTML" },
    );
  });

  bot.onText(/^\/snapshot/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, formatFullSnapshot(), { parse_mode: "HTML" });
  });

  bot.onText(/^\/snap\s+(\w+)/i, (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    const sym = parseSymbolArg(match[1]);
    if (!sym) {
      bot.sendMessage(msg.chat.id, "Используй: /snap BTC | ETH | SOL");
      return;
    }
    bot.sendMessage(msg.chat.id, formatSymbolSnapshot(sym), {
      parse_mode: "HTML",
    });
  });

  bot.onText(/^\/advice/, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    const thinking = await bot.sendMessage(msg.chat.id, "🤖 Анализирую...");
    try {
      const advice = await askClaude();
      bot.sendMessage(msg.chat.id, advice, { parse_mode: "HTML" });
      bot.deleteMessage(msg.chat.id, thinking.message_id).catch(() => {});
    } catch (e) {
      bot.sendMessage(msg.chat.id, `⚠️ Ошибка: ${e.message}`);
    }
  });

  bot.onText(/^\/levels/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    let out = "<b>Активные уровни</b>\n";
    for (const [sym, lev] of Object.entries(config.levels)) {
      out += `\n<b>${sym}</b>\n`;
      out += `R: ${lev.resistances.join(", ")}\n`;
      out += `S: ${lev.supports.join(", ")}\n`;
    }
    bot.sendMessage(msg.chat.id, out, { parse_mode: "HTML" });
  });

  bot.onText(/^\/status/, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    let out = "<b>Статус</b>\n";
    for (const sym of config.symbols) {
      const d = state.getSymbol(sym);
      const age = d.updatedAt
        ? Math.floor((Date.now() - d.updatedAt) / 1000) + "s"
        : "∞";
      const price = d.ticker?.price?.toFixed(2) ?? "?";
      out += `${sym}: ${price} (last ${age})\n`;
    }
    out += `\nUTC: ${new Date().toISOString().slice(11, 19)}\n`;
    out += `Quiet hours UTC: ${config.quietHours.start}-${config.quietHours.end}`;
    bot.sendMessage(msg.chat.id, out, { parse_mode: "HTML" });
  });

  // Раздача алертов
  state.on("alert", ({ message }) => {
    if (!config.telegram.chatId) return;
    bot
      .sendMessage(config.telegram.chatId, message, { parse_mode: "HTML" })
      .catch((e) => console.error("[telegram] send alert failed:", e.message));
  });

  console.log("[telegram] bot started");
}

function isAllowed(chatId) {
  if (allowedChatIds.size === 0) return true; // если CHAT_ID не задан — открыто
  return allowedChatIds.has(chatId);
}

function parseSymbolArg(arg) {
  const u = arg.toUpperCase();
  for (const sym of config.symbols) {
    if (sym.startsWith(u)) return sym;
  }
  return null;
}

// ─── Форматирование ───
function formatFullSnapshot() {
  let out = `<b>📊 Сводка рынка</b> · <i>${new Date().toISOString().slice(11, 19)} UTC</i>\n`;
  for (const sym of config.symbols) {
    out += "\n" + formatSymbolSnapshot(sym, true);
  }
  return out;
}

function formatSymbolSnapshot(symbol, compact = false) {
  const data = state.getSymbol(symbol);
  if (!data) return `${symbol}: нет данных`;

  const snap = snapshot(data);
  if (!snap || snap.price == null) return `${symbol}: нет данных`;

  const arrow = (snap.priceChangePct24h ?? 0) >= 0 ? "🟢" : "🔴";
  const decimals = symbol === "SOLUSDT" ? 2 : 1;

  let out = `\n<b>${symbol}</b> ${arrow} <b>${snap.price?.toFixed(decimals)}</b>`;
  out += ` (${snap.priceChangePct24h >= 0 ? "+" : ""}${snap.priceChangePct24h?.toFixed(2)}%)\n`;

  // Тренд по ТФ
  const tfMap = ["15m", "1h", "4h", "1d"];
  out += "<i>тренд:</i> ";
  out += tfMap
    .map((tf) => {
      const t = snap.timeframes[tf];
      if (!t) return `${tf}:?`;
      const sign =
        t.trend === "bullish"
          ? "↑"
          : t.trend === "bearish"
            ? "↓"
            : t.trend === "mixed"
              ? "↔"
              : "·";
      return `${tf}${sign}`;
    })
    .join(" ");
  out += "\n";

  if (!compact) {
    const tf1d = snap.timeframes["1d"];
    if (tf1d) {
      out += `<i>EMA50/200 (1d):</i> ${tf1d.ema50?.toFixed(decimals)} / ${tf1d.ema200?.toFixed(decimals)}\n`;
      out += `<i>RSI 1d:</i> ${tf1d.rsi?.toFixed(1)}\n`;
    }
  }

  // Деривативы
  const fundingPct =
    snap.funding != null ? (snap.funding * 100).toFixed(4) + "%" : "?";
  out += `<i>funding:</i> ${fundingPct}`;
  if (snap.basis != null) out += ` · <i>basis:</i> ${snap.basis.toFixed(3)}%`;
  out += "\n";

  // OI динамика
  const oiD5m = snap.oiDelta5mApi ?? snap.oiDelta5m;
  if (oiD5m != null) {
    out += `<i>OI:</i> Δ5m ${oiD5m >= 0 ? "+" : ""}${oiD5m.toFixed(2)}%`;
    if (snap.oiDelta1hApi != null) {
      out += ` · Δ1h ${snap.oiDelta1hApi >= 0 ? "+" : ""}${snap.oiDelta1hApi.toFixed(2)}%`;
    }
    out += "\n";
  }

  // Smart Money
  if (snap.longShortRatio != null && snap.topPositionLS != null) {
    out += `<i>L/S толпа:</i> <b>${snap.longShortRatio.toFixed(2)}</b>`;
    out += ` · <i>топы:</i> <b>${snap.topPositionLS.toFixed(2)}</b>`;
    const crowdLong = snap.longShortRatio > 1;
    const topsLong = snap.topPositionLS > 1;
    if (crowdLong !== topsLong) {
      out += topsLong
        ? " ⚠️ топы LONG vs толпа SHORT"
        : " ⚠️ топы SHORT vs толпа LONG";
    }
    out += "\n";
  }

  // Taker давление
  if (snap.takerBuySellRatio != null) {
    const t = snap.takerBuySellRatio;
    const tEmoji = t > 1.1 ? "🟢" : t < 0.9 ? "🔴" : "⚪";
    out += `<i>taker B/S:</i> ${tEmoji} ${t.toFixed(2)}\n`;
  }

  // ─── ML signal — только для BTC ───
  if (symbol === "BTCUSDT") {
    const ml = getMLSnapshot();
    if (ml.available) {
      const mlEmoji =
        ml.signal === "BUY" ? "🟢" : ml.signal === "SELL" ? "🔴" : "⚪";
      const ageS = Math.round(ml.ageMs / 1000);
      out += `\n🤖 <b>ML signal</b> (LSTM, отдельно от Claude)\n`;
      out += `${mlEmoji} <b>${ml.signal}</b> · confidence: ${(ml.confidence * 100).toFixed(1)}%\n`;
      out += `<i>buy:</i> ${(ml.buy * 100).toFixed(1)}% · `;
      out += `<i>hold:</i> ${(ml.hold * 100).toFixed(1)}% · `;
      out += `<i>sell:</i> ${(ml.sell * 100).toFixed(1)}%\n`;
      out += `<i>обновлено: ${ageS < 60 ? ageS + "s" : Math.floor(ageS / 60) + "m"} назад</i>\n`;
    } else if (ml.lastError) {
      out += `\n🤖 <i>ML: недоступен (${ml.lastError.slice(0, 60)})</i>\n`;
    } else {
      out += `\n🤖 <i>ML: ожидает данных...</i>\n`;
    }
  }

  return out;
}
