# docpats-realtime-advisor

Real-time информационный слой для **ручного** трейдинга на Binance Futures. Не торгует, только собирает данные, считает индикаторы, шлёт алерты в Telegram, показывает дашборд и даёт on-demand анализ через Claude API.

## Что делает

- Подключается к Binance Futures WebSocket — live тикер и свечи 15m / 1h / 4h / 1d по BTC / ETH / SOL
- Раз в 30s опрашивает funding rate, open interest; раз в 60s — long/short ratio
- Считает EMA20/50/200, RSI(14), MACD, тренд по каждому ТФ
- Алертит в Telegram при:
  - подходе к ключевым уровням (±0.4%)
  - экстремальном funding (>±0.05% / 8h)
  - спайке OI (>3% за ~5 мин)
  - перекосе L/S ratio (>2.5 или <0.4)
  - закрытии свечи 1h/4h с volume spike (>2x avg) или сменой тренда
- Команда `/advice` в TG или кнопка на дашборде → Claude получает текущий снимок и даёт совет

## Структура

```
docpats-realtime-advisor/
├── package.json
├── ecosystem.config.cjs       # PM2
├── .env.example               # копировать в .env и заполнить
├── server.js                  # entry point
├── src/
│   ├── config.js              # символы, уровни, пороги
│   ├── state.js               # in-memory state + EventEmitter
│   ├── binance.js             # WS + REST
│   ├── analysis.js            # EMA / RSI / MACD / trend
│   ├── triggers.js            # правила алертов
│   ├── telegram.js            # TG бот
│   ├── claude.js              # Anthropic API
│   └── web.js                 # Express
├── public/
│   └── index.html             # dashboard
└── logs/
```

## Установка на VPS

```bash
# 1. Склонировать в /root
cd /root
git clone <url> docpats-realtime-advisor
cd docpats-realtime-advisor

# 2. Зависимости
npm install

# 3. Конфиг
cp .env.example .env
nano .env   # заполнить TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY

# 4. Создать НОВЫЙ Telegram бот:
#    @BotFather → /newbot → имя любое, например docpats_realtime_bot
#    Получить токен → положить в .env как TELEGRAM_BOT_TOKEN
#
# 5. Узнать свой chat_id:
#    Запустить бота через PM2 (см. ниже),
#    отправить ему /start —
#    в логах (pm2 logs) увидишь chat_id, положи в .env как TELEGRAM_CHAT_ID

# 6. Запуск
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs docpats-realtime-advisor

# 7. Открыть порт 4000 на VPS (если нужен внешний доступ к dashboard)
ufw allow 4000/tcp
# Или nginx reverse proxy с HTTPS — рекомендую
```

## Telegram команды

- `/start` — приветствие, показывает chat_id
- `/snapshot` — сводка по всем парам
- `/snap BTC` — по одной паре (BTC / ETH / SOL)
- `/advice` — анализ от Claude по текущим данным
- `/levels` — текущие уровни S/R из конфига
- `/status` — статус системы (последнее обновление по парам)

## Web dashboard

`http://<VPS_IP>:4000/`

- Live цены и тренды по каждой паре
- Multi-TF тренд visualization (15m / 1h / 4h / 1d)
- Funding / OI Δ / L/S ratio с подсветкой экстремумов
- Кнопка «обновить совет» → Claude

## Настройка уровней

В `src/config.js` блок `levels`. Пример:

```js
levels: {
  BTCUSDT: {
    resistances: [83000, 84000, 88000, 95000, 98000],
    supports: [80000, 78000, 75000, 70000, 68000]
  },
  ...
}
```

Меняешь руками под текущую структуру рынка. После изменения — `pm2 restart docpats-realtime-advisor`.

## Тонкая настройка алертов

В `src/config.js` блок `triggers`:

```js
triggers: {
  levelProximityPct: 0.4,        // % близости к уровню для алерта
  fundingExtreme: 0.0005,         // 0.05% / 8h
  oiSpikePct: 3,                  // %
  longShortRatioExtreme: 2.5,     // ratio
  volumeSpikeMultiplier: 2.0,     // x от 20-period avg
  cooldownMs: 5 * 60 * 1000       // не повторять алерт 5 минут
}
```

## Изоляция от торговых ботов

- **Отдельный процесс** под PM2 (`docpats-realtime-advisor`)
- **Отдельный TG-бот** (новый токен, не пересекается с торговыми)
- **Без записи в Binance** — никаких ордеров, только чтение публичных эндпоинтов
- **Без Mongo в Phase 1** — состояние в памяти, не трогает торговую БД
- **Свой порт** (4000 по умолчанию)

## Дальше (Phase 2+)

- Подключить MongoDB для истории алертов и журнала советов
- CoinGlass API для liquidation heatmaps
- Auto-detect уровней (через clustering daily highs/lows + volume profile)
- Bridge макро-новостей (FOMC, CPI календарь)
- Auto-snapshot за 30 мин до major events с предварительным анализом
