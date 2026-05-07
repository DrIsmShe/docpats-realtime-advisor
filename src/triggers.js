import { config } from "./config.js";
import { state } from "./state.js";
import { snapshot } from "./analysis.js";

function isQuietHours() {
  const h = new Date().getUTCHours();
  const { start, end } = config.quietHours;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function alert(key, message, opts = {}) {
  if (!opts.bypassQuiet && isQuietHours()) return;
  if (!state.shouldAlert(key)) return;
  state.emit("alert", {
    key,
    message,
    severity: opts.severity || "info",
    timestamp: Date.now(),
  });
}

// ─── Близость к уровням S/R ───
function checkLevels(symbol) {
  const data = state.getSymbol(symbol);
  const price = data.ticker?.price;
  if (!price) return;

  const levels = config.levels[symbol];
  if (!levels) return;

  const proxPct = config.triggers.levelProximityPct / 100;

  for (const r of levels.resistances) {
    const dist = Math.abs(price - r) / r;
    if (dist <= proxPct && price < r * 1.005) {
      alert(
        `level:${symbol}:R:${r}`,
        `🔵 <b>${symbol}</b> у сопротивления <b>${r}</b>\n` +
          `Цена: ${price.toFixed(2)} (${(dist * 100).toFixed(2)}% до уровня)`,
        { severity: "level" },
      );
    }
  }
  for (const s of levels.supports) {
    const dist = Math.abs(price - s) / s;
    if (dist <= proxPct && price > s * 0.995) {
      alert(
        `level:${symbol}:S:${s}`,
        `🟢 <b>${symbol}</b> у поддержки <b>${s}</b>\n` +
          `Цена: ${price.toFixed(2)} (${(dist * 100).toFixed(2)}% до уровня)`,
        { severity: "level" },
      );
    }
  }
}

// ─── Funding экстремум ───
function checkFunding({ symbol, funding }) {
  if (!funding) return;
  const t = config.triggers.fundingExtreme;
  if (Math.abs(funding.rate) >= t) {
    const dir =
      funding.rate > 0
        ? "лонги платят шортам — рынок перегрет в лонг"
        : "шорты платят лонгам — рынок перегрет в шорт";
    alert(
      `funding:${symbol}`,
      `⚠️ <b>${symbol}</b> экстремальный funding: <b>${(funding.rate * 100).toFixed(4)}%</b> / 8h\n${dir}`,
      { severity: "warning" },
    );
  }
}

// ─── OI spike ───
function checkOI({ symbol }) {
  const data = state.getSymbol(symbol);
  if (!data.oiHistory || data.oiHistory.length < 10) return;
  const now = data.oiHistory[data.oiHistory.length - 1];
  const past = data.oiHistory[data.oiHistory.length - 10];
  if (past.value <= 0) return;
  const delta = ((now.value - past.value) / past.value) * 100;
  if (Math.abs(delta) >= config.triggers.oiSpikePct) {
    const dir = delta > 0 ? "рост" : "падение";
    alert(
      `oi:${symbol}`,
      `📊 <b>${symbol}</b> OI ${dir}: <b>${delta.toFixed(2)}%</b> за ~5 мин\n` +
        `Текущий OI: ${now.value.toLocaleString()}`,
      { severity: "warning" },
    );
  }
}

// ─── Long/Short ratio экстремум ───
function checkLongShort({ symbol, ratio }) {
  if (!ratio) return;
  const r = ratio.longShortRatio;
  const t = config.triggers.longShortRatioExtreme;

  if (r >= t) {
    alert(
      `lsRatio:${symbol}`,
      `🔥 <b>${symbol}</b> толпа в лонгах: L/S = <b>${r.toFixed(2)}</b>\n` +
        `Long ${(ratio.longAccount * 100).toFixed(0)}% / Short ${(ratio.shortAccount * 100).toFixed(0)}%\n` +
        `Риск: каскадные ликвидации лонгов при просадке`,
      { severity: "warning" },
    );
  } else if (r <= 1 / t) {
    alert(
      `lsRatio:${symbol}`,
      `🔥 <b>${symbol}</b> толпа в шортах: L/S = <b>${r.toFixed(2)}</b>\n` +
        `Long ${(ratio.longAccount * 100).toFixed(0)}% / Short ${(ratio.shortAccount * 100).toFixed(0)}%\n` +
        `Риск: short squeeze при росте`,
      { severity: "warning" },
    );
  }
}

// ─── Закрытие свечи: volume spike + смена тренда ───
const lastTrend = {}; // {symbol_tf: trend}

function checkCandleClose({ symbol, timeframe }) {
  if (!["1h", "4h"].includes(timeframe)) return;
  const snap = snapshot(state.getSymbol(symbol));
  const tf = snap.timeframes[timeframe];
  if (!tf) return;

  // Volume spike
  if (
    tf.avgVolume &&
    tf.lastVolume > tf.avgVolume * config.triggers.volumeSpikeMultiplier
  ) {
    alert(
      `vol:${symbol}:${timeframe}`,
      `📈 <b>${symbol} ${timeframe}</b> volume spike: ` +
        `<b>${(tf.lastVolume / tf.avgVolume).toFixed(1)}x</b> от среднего\n` +
        `Close: ${tf.close.toFixed(2)}`,
      { severity: "info" },
    );
  }

  // Смена тренда
  const key = `${symbol}_${timeframe}`;
  const prev = lastTrend[key];
  if (prev && prev !== tf.trend && tf.trend !== "mixed" && prev !== "mixed") {
    alert(
      `trendFlip:${symbol}:${timeframe}`,
      `🔄 <b>${symbol} ${timeframe}</b> смена тренда: ${prev} → <b>${tf.trend}</b>\n` +
        `Close: ${tf.close.toFixed(2)} | EMA20: ${tf.ema20?.toFixed(2)} | EMA50: ${tf.ema50?.toFixed(2)}`,
      { severity: "warning", bypassQuiet: timeframe === "4h" },
    );
  }
  lastTrend[key] = tf.trend;
}

// ─── Проверки по тикеру: уровни — каждые ~10 секунд (а не на каждый тик) ───
const lastLevelCheck = {};
function throttledLevels(symbol) {
  const now = Date.now();
  if (lastLevelCheck[symbol] && now - lastLevelCheck[symbol] < 10000) return;
  lastLevelCheck[symbol] = now;
  checkLevels(symbol);
}

export function startTriggers() {
  state.on("ticker", ({ symbol }) => throttledLevels(symbol));
  state.on("funding", checkFunding);
  state.on("openInterest", checkOI);
  state.on("longShortRatio", checkLongShort);
  state.on("candleClosed", checkCandleClose);
  console.log("[triggers] started");
}
