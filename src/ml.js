import { config } from './config.js';
import { state } from './state.js';

// ─── ML-сервис состояние ───
export const mlState = {
  enabled: true,
  url: 'http://localhost:3001',
  symbol: 'BTCUSDT',                  // ML обучен только на BTC
  lastSignal: null,                   // { signal, buy, hold, sell, confidence, timestamp }
  lastError: null,
  lastRequestAt: null,
  successCount: 0,
  errorCount: 0,
  serviceStatus: null                 // ответ от /status
};

async function getServiceStatus() {
  try {
    const res = await fetch(`${mlState.url}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      mlState.serviceStatus = await res.json();
    }
  } catch (e) {
    mlState.serviceStatus = null;
  }
}

// ─── Запрос предсказания ───
async function fetchPrediction() {
  const data = state.getSymbol(mlState.symbol);
  if (!data) return;

  const candles1h = data.klines?.['1h'] || [];
  const candles4h = data.klines?.['4h'] || [];
  const candles1d = data.klines?.['1d'] || [];

  // ML требует минимум 250 1h свечей
  if (candles1h.length < 250) {
    mlState.lastError = `Недостаточно 1h свечей: ${candles1h.length}/250`;
    return;
  }

  // Подготовим данные в формате который ждёт ml-service
  // (ML видит: 1h, 4h, 1d свечи + funding + OI + L/S history)
  const fundingHist = (data.fundingHistory || []).map(f => ({
    time: f.time,
    rate: f.rate
  }));
  const oiHist = (data.oiHistApi || []).map(o => ({
    time: o.time,
    openInterest: o.value
  }));
  // long_short_ratio: ml-service ждёт {time, ratio} формат
  // У нас только текущий L/S, не история — отдадим текущее значение как одну точку
  const lsHist = data.longShortRatio
    ? [{ time: data.longShortRatio.timestamp, ratio: data.longShortRatio.longShortRatio }]
    : [];

  const payload = {
    candles1h,
    candles4h,
    candles1d,
    fundingRate: fundingHist,
    openInterest: oiHist,
    longShortRatio: lsHist
  };

  mlState.lastRequestAt = Date.now();

  try {
    const res = await fetch(`${mlState.url}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      const text = await res.text();
      mlState.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      mlState.errorCount += 1;
      return;
    }

    const result = await res.json();
    mlState.lastSignal = {
      signal: result.signal,
      buy: result.buy,
      hold: result.hold,
      sell: result.sell,
      confidence: result.confidence,
      timestamp: Date.now()
    };
    mlState.lastError = null;
    mlState.successCount += 1;
  } catch (e) {
    mlState.lastError = e.message;
    mlState.errorCount += 1;
  }
}

// ─── Запуск ML интеграции ───
export function startML() {
  console.log(`[ml] starting client → ${mlState.url} (symbol: ${mlState.symbol})`);

  // Первый запрос через 30 сек (даём advisor загрузить достаточно данных)
  setTimeout(() => {
    getServiceStatus();
    fetchPrediction();
  }, 30 * 1000);

  // Дальше — раз в минуту (свечи 1h обновляются каждые 10 сек, но новая свеча раз в час)
  setInterval(fetchPrediction, 60 * 1000);

  // Status — раз в 5 минут
  setInterval(getServiceStatus, 5 * 60 * 1000);
}

// ─── Получить ML signal в формате для UI/API ───
export function getMLSnapshot() {
  const ageMs = mlState.lastSignal
    ? Date.now() - mlState.lastSignal.timestamp
    : null;

  return {
    enabled: mlState.enabled,
    symbol: mlState.symbol,
    available: !!mlState.lastSignal,
    signal: mlState.lastSignal?.signal ?? null,
    confidence: mlState.lastSignal?.confidence ?? null,
    buy: mlState.lastSignal?.buy ?? null,
    hold: mlState.lastSignal?.hold ?? null,
    sell: mlState.lastSignal?.sell ?? null,
    ageMs,
    lastError: mlState.lastError,
    successCount: mlState.successCount,
    errorCount: mlState.errorCount,
    serviceStatus: mlState.serviceStatus ? {
      predictionCount: mlState.serviceStatus.predictionCount,
      feedbackCount: mlState.serviceStatus.feedbackCount,
      lastTrainTime: mlState.serviceStatus.lastTrainTime,
      lastFineTuneTime: mlState.serviceStatus.lastFineTuneTime
    } : null
  };
}
