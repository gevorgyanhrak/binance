const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { getAdapter, listAdapters } = require("./adapters");

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

const REFRESH_INTERVAL_MS = 30_000;
const LIVE_REFRESH_INTERVAL_MS = 3_000;
const auditBus = new EventEmitter();
auditBus.setMaxListeners(50);
const ALERT_HISTORY_MAX = 50;
const recentAlerts = [];
const lastAlertProfit = new Map();
const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const HISTORY_DIR = path.join(__dirname, "history");
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

const PERIOD_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};
const MAX_CHART_POINTS = 180;

const state = {};

function historyFile(exchangeId) {
  const legacy = path.join(__dirname, "history.json");
  if (exchangeId === "binance" && fs.existsSync(legacy)) return legacy;
  return path.join(HISTORY_DIR, `${exchangeId}.json`);
}

function loadHistory(exchangeId) {
  const file = historyFile(exchangeId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory(exchangeId, history) {
  const file = historyFile(exchangeId);
  const cutoff = Date.now() - RETENTION_MS;
  const pruned = history.filter((s) => s.t >= cutoff);
  fs.writeFile(file, JSON.stringify(pruned), () => {});
  return pruned;
}

function getState(exchangeId) {
  if (!state[exchangeId]) {
    state[exchangeId] = {
      cache: null,
      refreshing: null,
      history: loadHistory(exchangeId),
    };
  }
  return state[exchangeId];
}

async function buildSnapshot(adapter) {
  const [buy, sell] = await Promise.all([
    adapter.fetchP2P({ tradeType: "BUY" }),
    adapter.fetchP2P({ tradeType: "SELL" }),
  ]);
  if (!buy.length || !sell.length) {
    const which = !buy.length && !sell.length ? "both sides" : !buy.length ? "buy side" : "sell side";
    throw new Error(`empty order book (${which})`);
  }
  const bestBuy = buy[0];
  const bestSell = sell[0];
  const spread = bestSell.price - bestBuy.price;
  const profitPercent = (spread / bestBuy.price) * 100;
  return {
    bestBuy,
    bestSell,
    spread,
    profitPercent: Number(profitPercent.toFixed(2)),
    buy,
    sell,
  };
}

async function refresh(adapter) {
  const s = getState(adapter.id);
  if (s.refreshing) return s.refreshing;
  s.refreshing = (async () => {
    try {
      const data = await buildSnapshot(adapter);
      const t = Date.now();
      s.cache = { data, t };
      s.history.push({
        t,
        buyPrice: data.bestBuy.price,
        sellPrice: data.bestSell.price,
        spread: data.spread,
        profitPercent: data.profitPercent,
        buyPrices: data.buy.slice(0, 10).map((b) => b.price),
        sellPrices: data.sell.slice(0, 10).map((s) => s.price),
      });
      s.history = persistHistory(adapter.id, s.history);
    } catch (err) {
      console.error(`[${adapter.id}] refresh failed:`, err.message);
    } finally {
      s.refreshing = null;
    }
  })();
  return s.refreshing;
}

for (const meta of listAdapters()) {
  const adapter = getAdapter(meta.id);
  refresh(adapter);
  setInterval(() => refresh(adapter), REFRESH_INTERVAL_MS);
}

const liveSettings = {
  amount: 1000,
  feeOverride: null,
  threshold: 1000,
};

(function startLiveLoop() {
  const adapters = listAdapters().map((m) => getAdapter(m.id));
  if (!adapters.length) return;
  const stride = Math.max(400, Math.floor(LIVE_REFRESH_INTERVAL_MS / adapters.length));
  adapters.forEach((adapter, idx) => {
    setTimeout(() => {
      const tick = async () => {
        try {
          await refresh(adapter);
          const audit = computeAudit(liveSettings);
          auditBus.emit("snapshot", audit);
          detectAlerts(audit);
        } catch (err) {
          console.error(`[live ${adapter.id}]`, err.message);
        }
      };
      tick();
      setInterval(tick, LIVE_REFRESH_INTERVAL_MS);
    }, idx * stride);
  });
})();

function detectAlerts(audit) {
  const profitable = audit.opportunities.filter(
    (o) => o.netProfit >= liveSettings.threshold
  );
  for (const op of profitable) {
    const key = `${op.buy.exchange}>${op.sell.exchange}`;
    const prev = lastAlertProfit.get(key);
    const isNew = prev === undefined;
    const meaningfulChange =
      !isNew && Math.abs(op.netProfit - prev) / Math.max(prev, 1) > 0.05;
    if (isNew || meaningfulChange) {
      lastAlertProfit.set(key, op.netProfit);
      const alert = { ...op, key, t: Date.now() };
      recentAlerts.unshift(alert);
      if (recentAlerts.length > ALERT_HISTORY_MAX) recentAlerts.length = ALERT_HISTORY_MAX;
      auditBus.emit("alert", alert);
    }
  }
  // expire keys whose route is no longer above threshold so re-entry re-alerts
  const liveKeys = new Set(profitable.map((o) => `${o.buy.exchange}>${o.sell.exchange}`));
  for (const k of [...lastAlertProfit.keys()]) {
    if (!liveKeys.has(k)) lastAlertProfit.delete(k);
  }
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) {
    out.push(arr[Math.floor(i * step)]);
  }
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

app.get("/api/exchanges", (req, res) => {
  res.json({ exchanges: listAdapters() });
});

function withAdapter(req, res, next) {
  const adapter = getAdapter(req.params.exchange);
  if (!adapter) return res.status(404).json({ error: "Unknown exchange" });
  req.adapter = adapter;
  next();
}

app.get("/api/:exchange/p2p", withAdapter, async (req, res) => {
  const adapter = req.adapter;
  const s = getState(adapter.id);
  try {
    if (!s.cache) await refresh(adapter);
    if (!s.cache) return res.status(503).json({ error: "No data available yet" });
    res.json({ ...s.cache.data, updatedAt: s.cache.t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/:exchange/history", withAdapter, (req, res) => {
  const period = String(req.query.period || "day");
  const ms = PERIOD_MS[period];
  if (!ms) {
    return res.status(400).json({ error: "Invalid period. Use day|week|month." });
  }
  const s = getState(req.adapter.id);
  const cutoff = Date.now() - ms;
  const slice = s.history.filter((x) => x.t >= cutoff);

  if (slice.length === 0) {
    return res.json({ period, dataPoints: 0, snapshots: [], aggregates: null });
  }

  const buyPrices = slice.map((x) => x.buyPrice);
  const sellPrices = slice.map((x) => x.sellPrice);
  const spreads = slice.map((x) => x.spread);
  const profits = slice.map((x) => x.profitPercent);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const POSITIONS = 10;
  const buyByPos = Array.from({ length: POSITIONS }, () => []);
  const sellByPos = Array.from({ length: POSITIONS }, () => []);

  for (const x of slice) {
    const bps = x.buyPrices || (x.buyPrice !== undefined ? [x.buyPrice] : []);
    const sps = x.sellPrices || (x.sellPrice !== undefined ? [x.sellPrice] : []);
    for (let i = 0; i < POSITIONS; i++) {
      if (bps[i] !== undefined) buyByPos[i].push(bps[i]);
      if (sps[i] !== undefined) sellByPos[i].push(sps[i]);
    }
  }

  const statsFor = (prices) => {
    if (!prices.length) return null;
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: avg(prices),
      samples: prices.length,
    };
  };

  res.json({
    period,
    dataPoints: slice.length,
    snapshots: downsample(slice, MAX_CHART_POINTS).map((x) => ({
      t: x.t,
      buyPrice: x.buyPrices?.[0] ?? x.buyPrice,
      sellPrice: x.sellPrices?.[0] ?? x.sellPrice,
    })),
    positions: {
      buy: buyByPos.map(statsFor),
      sell: sellByPos.map(statsFor),
    },
    aggregates: {
      avgBuy: avg(buyPrices),
      minBuy: Math.min(...buyPrices),
      maxBuy: Math.max(...buyPrices),
      avgSell: avg(sellPrices),
      minSell: Math.min(...sellPrices),
      maxSell: Math.max(...sellPrices),
      avgSpread: avg(spreads),
      minSpread: Math.min(...spreads),
      maxSpread: Math.max(...spreads),
      avgProfitPercent: avg(profits),
      maxProfitPercent: Math.max(...profits),
      firstAt: slice[0].t,
      lastAt: slice[slice.length - 1].t,
    },
  });
});

app.post("/api/:exchange/update-ad", withAdapter, async (req, res) => {
  const adapter = req.adapter;
  if (!adapter.updateAd) {
    return res
      .status(501)
      .json({ ok: false, error: `update-ad not implemented for ${adapter.id}` });
  }
  const { apiKey, apiSecret, adNo, price } = req.body || {};
  if (!apiKey || !apiSecret || !adNo || price === undefined) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing apiKey, apiSecret, adNo or price" });
  }
  try {
    const data = await adapter.updateAd({ apiKey, apiSecret, adNo, price });
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.response?.status || 500;
    const body = err.response?.data;
    res.status(status).json({
      ok: false,
      error: body?.msg || body?.message || err.message || "Adapter error",
      code: body?.code,
      raw: body,
    });
  }
});

const WITHDRAWAL_FEES = {
  binance: { TRC20: 1, BEP20: 0.29, SOL: 1, TON: 0.8, ARB: 0.1 },
  bybit:   { TRC20: 1, BEP20: 0.5,  SOL: 1, TON: 0.1, ARB: 0.1 },
  okx:     { TRC20: 1, BEP20: 0.8,  SOL: 1, TON: 0.2 },
  mexc:    { TRC20: 1, BEP20: 1,    SOL: 1, TON: 0.5 },
  kucoin:  { TRC20: 1, BEP20: 0.5,  SOL: 1, TON: 0.2 },
};

function pickBestNetwork(fromId, toId) {
  if (fromId === toId) return { network: null, fee: 0 };
  const fromFees = WITHDRAWAL_FEES[fromId];
  const toFees = WITHDRAWAL_FEES[toId];
  if (!fromFees || !toFees) return { network: null, fee: 1 };
  let best = null;
  for (const net of Object.keys(fromFees)) {
    if (toFees[net] === undefined) continue;
    if (!best || fromFees[net] < best.fee) best = { network: net, fee: fromFees[net] };
  }
  return best || { network: null, fee: 1 };
}

function computeAudit({ amount = 1000, feeOverride = null }) {
  const adapters = listAdapters().map((m) => getAdapter(m.id));
  const snapshots = adapters.map((adapter) => {
    const s = getState(adapter.id);
    if (!s.cache) return { id: adapter.id, label: adapter.label, error: "no data" };
    return { id: adapter.id, label: adapter.label, data: s.cache.data, t: s.cache.t };
  });

  const exchanges = [];
  for (const snap of snapshots) {
    if (snap.error || !snap.data) {
      exchanges.push({ id: snap.id, label: snap.label, error: snap.error || "no data" });
      continue;
    }
    const fillsAmount = (order) => {
      if (!order || !Number.isFinite(order.price) || order.price <= 0) return false;
      const usdtMin = order.min / order.price;
      const usdtMax = order.max / order.price;
      return usdtMin <= amount && amount <= usdtMax;
    };
    const buyOrders = (snap.data.buy || []).filter(fillsAmount);
    const sellOrders = (snap.data.sell || []).filter(fillsAmount);
    const bestAsk = buyOrders[0] || null;
    const bestBid = sellOrders[0] || null;
    exchanges.push({
      id: snap.id,
      label: snap.label,
      updatedAt: snap.t,
      bestAsk,
      bestBid,
    });
  }

  const opportunities = [];
  for (const buyEx of exchanges) {
    if (!buyEx.bestAsk) continue;
    for (const sellEx of exchanges) {
      if (!sellEx.bestBid) continue;
      const buyPrice = buyEx.bestAsk.price;
      const sellPrice = sellEx.bestBid.price;
      const route = pickBestNetwork(buyEx.id, sellEx.id);
      const transferFee = feeOverride !== null ? feeOverride : route.fee;
      const usdtAfterFee = amount - transferFee;
      if (usdtAfterFee <= 0) continue;
      const cost = amount * buyPrice;
      const receive = usdtAfterFee * sellPrice;
      const netProfit = receive - cost;
      const profitPerUsdt = netProfit / amount;
      const profitPercent = (netProfit / cost) * 100;
      opportunities.push({
        buy: {
          exchange: buyEx.id,
          label: buyEx.label,
          price: buyPrice,
          merchant: buyEx.bestAsk.merchant,
          min: buyEx.bestAsk.min,
          max: buyEx.bestAsk.max,
        },
        sell: {
          exchange: sellEx.id,
          label: sellEx.label,
          price: sellPrice,
          merchant: sellEx.bestBid.merchant,
          min: sellEx.bestBid.min,
          max: sellEx.bestBid.max,
        },
        sameExchange: buyEx.id === sellEx.id,
        network: route.network,
        amount,
        transferFee,
        cost,
        receive,
        netProfit,
        profitPerUsdt,
        profitPercent,
      });
    }
  }

  opportunities.sort((a, b) => b.netProfit - a.netProfit);

  return {
    amount,
    feeOverride,
    exchanges,
    opportunities,
    generatedAt: Date.now(),
  };
}

app.get("/api/audit", (req, res) => {
  const amount = Math.max(1000, Number(req.query.amount) || 1000);
  const feeOverride =
    req.query.fee === undefined ? null : Math.max(0, Number(req.query.fee));
  liveSettings.amount = amount;
  liveSettings.feeOverride = feeOverride;
  if (req.query.threshold !== undefined) {
    liveSettings.threshold = Math.max(0, Number(req.query.threshold) || 0);
  }
  res.json(computeAudit({ amount, feeOverride }));
});

app.get("/api/audit/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("hello", { recentAlerts, settings: liveSettings });
  send("snapshot", computeAudit(liveSettings));

  const onSnapshot = (audit) => send("snapshot", audit);
  const onAlert = (alert) => send("alert", alert);
  auditBus.on("snapshot", onSnapshot);
  auditBus.on("alert", onAlert);

  const ka = setInterval(() => res.write(": ka\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ka);
    auditBus.off("snapshot", onSnapshot);
    auditBus.off("alert", onAlert);
  });
});

app.post("/api/audit/settings", (req, res) => {
  const { amount, fee, threshold } = req.body || {};
  if (amount !== undefined) liveSettings.amount = Math.max(1000, Number(amount) || 1000);
  if (fee !== undefined)
    liveSettings.feeOverride = fee === null ? null : Math.max(0, Number(fee));
  if (threshold !== undefined)
    liveSettings.threshold = Math.max(0, Number(threshold) || 0);
  lastAlertProfit.clear();
  res.json({ ok: true, settings: liveSettings });
});

app.get("/api/p2p", (req, res) => res.redirect(307, "/api/binance/p2p"));
app.get("/api/history", (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(307, `/api/binance/history${qs ? `?${qs}` : ""}`);
});

app.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
  console.log("Loaded exchanges:", listAdapters().map((a) => a.id).join(", "));
});
