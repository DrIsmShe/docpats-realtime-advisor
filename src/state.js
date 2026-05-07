import { EventEmitter } from "events";
import { config } from "./config.js";

class State extends EventEmitter {
  constructor() {
    super();
    this.data = {};
    for (const symbol of config.symbols) {
      this.data[symbol] = {
        symbol,
        ticker: null,
        klines: {}, // { '1h': [...], '4h': [...] }
        funding: null,
        fundingHistory: [], // последние ~40 funding rates
        openInterest: null,
        oiHistory: [], // [{ time, value }] из нашего поллинга (быстрый)
        oiHistApi: [], // [{ time, value }] из Binance API /openInterestHist 5m
        longShortRatio: null, // глобальный L/S accounts
        topAccountLS: null, // L/S accounts топ-трейдеров
        topPositionLS: null, // L/S positions топ-трейдеров
        takerBuySell: null, // taker buy/sell volume ratio
        basis: null, // premium = (markPrice - indexPrice) / indexPrice
        updatedAt: null,
        lastTickerAt: null,
      };
      for (const tf of config.timeframes) {
        this.data[symbol].klines[tf] = [];
      }
    }
    this.alertHistory = []; // для cooldown
  }

  updateTicker(symbol, ticker) {
    if (!this.data[symbol]) return;
    this.data[symbol].ticker = ticker;
    this.data[symbol].updatedAt = Date.now();
    this.data[symbol].lastTickerAt = Date.now();
    this.emit("ticker", { symbol, ticker });
  }

  updateKline(symbol, timeframe, kline) {
    if (!this.data[symbol] || !this.data[symbol].klines[timeframe]) return;
    const arr = this.data[symbol].klines[timeframe];
    const last = arr[arr.length - 1];
    if (last && last.openTime === kline.openTime) {
      arr[arr.length - 1] = kline;
    } else {
      arr.push(kline);
      if (arr.length > 250) arr.shift();
    }
    if (kline.isClosed) {
      this.emit("candleClosed", { symbol, timeframe, kline });
    }
  }

  setKlines(symbol, timeframe, klines) {
    if (!this.data[symbol] || !this.data[symbol].klines[timeframe]) return;
    this.data[symbol].klines[timeframe] = klines.slice(-250);
  }

  updateFunding(symbol, funding) {
    if (!this.data[symbol]) return;
    this.data[symbol].funding = funding;
    // Также вычисляем basis из markPrice / indexPrice
    if (funding.markPrice && funding.indexPrice) {
      this.data[symbol].basis =
        ((funding.markPrice - funding.indexPrice) / funding.indexPrice) * 100;
    }
    this.emit("funding", { symbol, funding });
  }

  updateFundingHistory(symbol, history) {
    if (!this.data[symbol]) return;
    this.data[symbol].fundingHistory = history;
  }

  updateOpenInterest(symbol, oi) {
    if (!this.data[symbol]) return;
    const prev = this.data[symbol].openInterest;
    this.data[symbol].openInterest = oi;
    this.data[symbol].oiHistory.push({
      time: Date.now(),
      value: oi.openInterest,
    });
    if (this.data[symbol].oiHistory.length > 60) {
      this.data[symbol].oiHistory.shift();
    }
    this.emit("openInterest", { symbol, oi, prev });
  }

  updateOIHistApi(symbol, history) {
    if (!this.data[symbol]) return;
    this.data[symbol].oiHistApi = history;
  }

  updateLongShortRatio(symbol, ratio) {
    if (!this.data[symbol]) return;
    this.data[symbol].longShortRatio = ratio;
    this.emit("longShortRatio", { symbol, ratio });
  }

  updateTopAccountLS(symbol, ratio) {
    if (!this.data[symbol]) return;
    this.data[symbol].topAccountLS = ratio;
  }

  updateTopPositionLS(symbol, ratio) {
    if (!this.data[symbol]) return;
    this.data[symbol].topPositionLS = ratio;
  }

  updateTakerBuySell(symbol, ratio) {
    if (!this.data[symbol]) return;
    this.data[symbol].takerBuySell = ratio;
  }

  getSymbol(symbol) {
    return this.data[symbol];
  }

  getAll() {
    return this.data;
  }

  // дедупликация алертов с cooldown
  shouldAlert(key) {
    const now = Date.now();
    const recent = this.alertHistory.find(
      (a) => a.key === key && now - a.time < config.triggers.cooldownMs,
    );
    if (recent) return false;
    this.alertHistory.push({ key, time: now });
    this.alertHistory = this.alertHistory.filter(
      (a) => now - a.time < config.triggers.cooldownMs * 4,
    );
    return true;
  }
}

export const state = new State();
