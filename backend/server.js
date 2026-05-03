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
const ALERT_TTL_MS = 10 * 60 * 1000;
const recentAlerts = [];
const lastAlertProfit = new Map();

function pruneRecentAlerts() {
  const cutoff = Date.now() - ALERT_TTL_MS;
  while (recentAlerts.length && recentAlerts[recentAlerts.length - 1].t < cutoff) {
    recentAlerts.pop();
  }
}
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
  amount: 100,
  minProfitPerUsdt: 3,
};

const PRICE_STEP = 0.01;
const DRIFT_REPEAT_MS = 5 * 60 * 1000;
const appliedAds = {};
const driftBuses = {};

function getDriftBus(id) {
  if (!driftBuses[id]) {
    const bus = new EventEmitter();
    bus.setMaxListeners(50);
    driftBuses[id] = bus;
  }
  return driftBuses[id];
}

function rankForBid(sellOrders, bidPrice) {
  let ahead = 0;
  for (const item of sellOrders) {
    if (item.price > bidPrice) ahead++;
    else break;
  }
  return ahead + 1;
}

function rankForAsk(buyOrders, askPrice) {
  let ahead = 0;
  for (const item of buyOrders) {
    if (item.price < askPrice) ahead++;
    else break;
  }
  return ahead + 1;
}

function suggestedBuyAdPrice(sellOrders, targetRank, minProfit, sellAdPrice) {
  if (!sellOrders.length) return null;
  const idx = Math.min(targetRank, sellOrders.length) - 1;
  const target = sellOrders[idx];
  if (!target) return null;
  let price = Math.round((target.price + PRICE_STEP) * 100) / 100;
  if (minProfit > 0 && Number.isFinite(sellAdPrice)) {
    if (sellAdPrice - price < minProfit) price = Math.round((sellAdPrice - minProfit) * 100) / 100;
  }
  return price;
}

function suggestedSellAdPrice(buyOrders, targetRank, minProfit, buyAdPrice) {
  if (!buyOrders.length) return null;
  const idx = Math.min(targetRank, buyOrders.length) - 1;
  const target = buyOrders[idx];
  if (!target) return null;
  let price = Math.round((target.price - PRICE_STEP) * 100) / 100;
  if (minProfit > 0 && Number.isFinite(buyAdPrice)) {
    if (price - buyAdPrice < minProfit) price = Math.round((buyAdPrice + minProfit) * 100) / 100;
  }
  return price;
}

function checkDrift(exchangeId) {
  const applied = appliedAds[exchangeId];
  if (!applied) return;
  const cache = state[exchangeId]?.cache;
  if (!cache?.data) return;
  const buyOrders = cache.data.buy || [];
  const sellOrders = cache.data.sell || [];
  const now = Date.now();
  applied.lastDrift = applied.lastDrift || {};

  const sides = [];
  if (applied.buy) {
    const currentRank = rankForBid(sellOrders, applied.buy.price);
    if (currentRank > applied.buy.targetRank) {
      sides.push({
        side: "buy",
        adNo: applied.buy.adNo,
        currentPrice: applied.buy.price,
        currentRank,
        targetRank: applied.buy.targetRank,
        suggestedPrice: suggestedBuyAdPrice(
          sellOrders,
          applied.buy.targetRank,
          applied.buy.minProfit,
          applied.sell?.price
        ),
      });
    }
  }
  if (applied.sell) {
    const currentRank = rankForAsk(buyOrders, applied.sell.price);
    if (currentRank > applied.sell.targetRank) {
      sides.push({
        side: "sell",
        adNo: applied.sell.adNo,
        currentPrice: applied.sell.price,
        currentRank,
        targetRank: applied.sell.targetRank,
        suggestedPrice: suggestedSellAdPrice(
          buyOrders,
          applied.sell.targetRank,
          applied.sell.minProfit,
          applied.buy?.price
        ),
      });
    }
  }

  for (const ev of sides) {
    const last = applied.lastDrift[ev.side];
    const stale = !last || now - last.t > DRIFT_REPEAT_MS;
    const rankChanged = !last || last.rank !== ev.currentRank;
    if (stale || rankChanged) {
      applied.lastDrift[ev.side] = { t: now, rank: ev.currentRank };
      getDriftBus(exchangeId).emit("drift", { exchange: exchangeId, t: now, ...ev });
    }
  }
  // clear lastDrift for sides no longer drifting
  const driftingSides = new Set(sides.map((s) => s.side));
  for (const k of Object.keys(applied.lastDrift)) {
    if (!driftingSides.has(k)) delete applied.lastDrift[k];
  }
}

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
          checkDrift(adapter.id);
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
    (o) => o.profitPerUsdt >= liveSettings.minProfitPerUsdt
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
  pruneRecentAlerts();
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

app.post("/api/:exchange/balance", withAdapter, async (req, res) => {
  const adapter = req.adapter;
  if (!adapter.getBalance) {
    return res
      .status(501)
      .json({ ok: false, error: `getBalance not implemented for ${adapter.id}` });
  }
  const { apiKey, apiSecret, asset } = req.body || {};
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ ok: false, error: "Missing apiKey or apiSecret" });
  }
  try {
    const data = await adapter.getBalance({ apiKey, apiSecret, asset: asset || "USDT" });
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.response?.status || 500;
    const body = err.response?.data;
    res.status(status).json({
      ok: false,
      error: body?.msg || body?.message || err.message || "Balance error",
      code: body?.code,
    });
  }
});

app.post("/api/:exchange/applied", withAdapter, (req, res) => {
  const id = req.adapter.id;
  const { buy, sell, clear } = req.body || {};
  if (clear) {
    delete appliedAds[id];
    return res.json({ ok: true, applied: null });
  }
  const norm = (raw) => {
    if (!raw) return null;
    const price = Number(raw.price);
    if (!Number.isFinite(price)) return null;
    return {
      adNo: String(raw.adNo || ""),
      price,
      targetRank: Math.max(1, Math.min(5, Number(raw.targetRank) || 5)),
      minProfit: Math.max(0, Number(raw.minProfit) || 0),
      appliedAt: Date.now(),
    };
  };
  const next = { buy: norm(buy), sell: norm(sell), lastDrift: {} };
  if (!next.buy && !next.sell) {
    return res.status(400).json({ ok: false, error: "buy or sell required" });
  }
  appliedAds[id] = next;
  // immediately re-evaluate so a fresh apply that's already drifted fires right away
  checkDrift(id);
  res.json({ ok: true, applied: appliedAds[id] });
});

app.get("/api/:exchange/applied", withAdapter, (req, res) => {
  res.json({ applied: appliedAds[req.adapter.id] || null });
});

app.get("/api/:exchange/drift/stream", withAdapter, (req, res) => {
  const id = req.adapter.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("hello", { applied: appliedAds[id] || null });

  const bus = getDriftBus(id);
  const onDrift = (ev) => send("drift", ev);
  bus.on("drift", onDrift);

  const ka = setInterval(() => res.write(": ka\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ka);
    bus.off("drift", onDrift);
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

function aggregateBook(orders, amount) {
  let filled = 0;
  let value = 0;
  const used = [];
  for (const o of orders) {
    if (filled >= amount) break;
    if (!Number.isFinite(o.price) || o.price <= 0) continue;
    const usdtMaxFromAd = o.max / o.price;
    const usdtMinFromAd = o.min / o.price;
    const remaining = amount - filled;
    if (remaining < usdtMinFromAd) continue;
    const take = Math.min(usdtMaxFromAd, remaining);
    filled += take;
    value += take * o.price;
    used.push({
      price: o.price,
      merchant: o.merchant,
      usdt: take,
      maxUsdt: usdtMaxFromAd,
      trader: o.trader || null,
    });
  }
  if (filled < amount * 0.999) return null;
  return {
    effectivePrice: value / filled,
    usdtFilled: filled,
    used,
    topPrice: used[0]?.price ?? null,
    topMerchant: used[0]?.merchant ?? null,
    topAdMaxUsdt: used[0]?.maxUsdt ?? null,
    adsUsed: used.length,
  };
}

function computeAudit({ amount = 100, feeOverride = null }) {
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
    const bestAsk = aggregateBook(snap.data.buy || [], amount);
    const bestBid = aggregateBook(snap.data.sell || [], amount);
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
      const buyPrice = buyEx.bestAsk.effectivePrice;
      const sellPrice = sellEx.bestBid.effectivePrice;
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
          price: buyEx.bestAsk.topPrice,
          effectivePrice: buyPrice,
          merchant: buyEx.bestAsk.topMerchant,
          merchantAvailUsdt: buyEx.bestAsk.topAdMaxUsdt,
          adsUsed: buyEx.bestAsk.adsUsed,
          fills: buyEx.bestAsk.used,
        },
        sell: {
          exchange: sellEx.id,
          label: sellEx.label,
          price: sellEx.bestBid.topPrice,
          effectivePrice: sellPrice,
          merchant: sellEx.bestBid.topMerchant,
          merchantAvailUsdt: sellEx.bestBid.topAdMaxUsdt,
          adsUsed: sellEx.bestBid.adsUsed,
          fills: sellEx.bestBid.used,
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
  const amount = Math.max(100, Number(req.query.amount) || 100);
  liveSettings.amount = amount;
  if (req.query.minProfit !== undefined) {
    const v = Number(req.query.minProfit);
    if (Number.isFinite(v)) liveSettings.minProfitPerUsdt = v;
  }
  res.json(computeAudit({ amount, feeOverride: null }));
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

  pruneRecentAlerts();
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
  const { amount, minProfit } = req.body || {};
  if (amount !== undefined) liveSettings.amount = Math.max(100, Number(amount) || 100);
  if (minProfit !== undefined) {
    const v = Number(minProfit);
    if (Number.isFinite(v)) liveSettings.minProfitPerUsdt = v;
  }
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
