import "dotenv/config";

const env = (key, fallback = "") => process.env[key] ?? fallback;

export const config = {
  binance: {
    apiKey: env("BINANCE_API_KEY"),
    apiSecret: env("BINANCE_API_SECRET"),
    wsBase: "wss://fstream.binance.com",
    restBase: "https://fapi.binance.com",
  },
  telegram: {
    token: env("TELEGRAM_BOT_TOKEN"),
    chatId: env("TELEGRAM_CHAT_ID"),
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },
  web: {
    port: parseInt(env("WEB_PORT", "4000"), 10),
    host: env("WEB_HOST", "0.0.0.0"),
  },
  quietHours: {
    start: parseInt(env("QUIET_HOURS_START", "23"), 10),
    end: parseInt(env("QUIET_HOURS_END", "6"), 10),
  },
  symbols: env("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",")
    .map((s) => s.trim()),

  // Таймфреймы для отслеживания тренда
  timeframes: ["15m", "1h", "4h", "1d"],

  // Уровни поддержки/сопротивления (правишь руками под текущую структуру)
  levels: {
    BTCUSDT: {
      resistances: [83000, 84000, 88000, 95000, 98000],
      supports: [80000, 78000, 75000, 70000, 68000],
    },
    ETHUSDT: {
      resistances: [2400, 2500, 2650, 2800, 3000],
      supports: [2300, 2200, 2100, 2000],
    },
    SOLUSDT: {
      resistances: [88, 90, 95, 100],
      supports: [85, 84, 80, 77, 70],
    },
  },

  // Условия алертов
  triggers: {
    levelProximityPct: 0.4, // в пределах 0.4% от уровня
    fundingExtreme: 0.0005, // 0.05% / 8h cycle
    oiSpikePct: 3, // OI Δ > 3% за 5min
    longShortRatioExtreme: 2.5, // ratio > 2.5 или < 0.4
    volumeSpikeMultiplier: 2.0, // volume > 2x от 20-period avg
    cooldownMs: 5 * 60 * 1000, // не повторять тот же алерт 5 минут
  },
};
