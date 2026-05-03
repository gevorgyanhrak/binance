const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { EventEmitter } = require("events");
const { getAdapter, listAdapters } = require("./adapters");
const riskRouter = require("./risk/routes");
const dbApi = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));
app.use("/api", riskRouter);

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

const liveSettings = Object.assign(
  { amount: 100, minProfitPerUsdt: 3 },
  dbApi.kvGet("liveSettings", {})
);

const telegramSettings = Object.assign(
  { botToken: "", chatId: "", alerts: true, drift: true, newOrders: true },
  dbApi.kvGet("telegramSettings", {})
);

const orderWatcher = Object.assign(
  { apiKey: "", apiSecret: "", lastPoll: 0 },
  dbApi.kvGet("orderWatcher", {}),
  { seenOrderIds: new Set(dbApi.kvGet("orderWatcherSeen", [])) }
);

function persistLive() {
  dbApi.kvSet("liveSettings", {
    amount: liveSettings.amount,
    minProfitPerUsdt: liveSettings.minProfitPerUsdt,
  });
}
function persistTelegram() {
  dbApi.kvSet("telegramSettings", { ...telegramSettings });
}
function persistOrderWatcher() {
  dbApi.kvSet("orderWatcher", {
    apiKey: orderWatcher.apiKey,
    apiSecret: orderWatcher.apiSecret,
    lastPoll: orderWatcher.lastPoll,
  });
  dbApi.kvSet("orderWatcherSeen", [...orderWatcher.seenOrderIds].slice(-3000));
}

async function sendTelegram(text) {
  if (!telegramSettings.botToken || !telegramSettings.chatId) return;
  try {
    const url = `https://api.telegram.org/bot${telegramSettings.botToken}/sendMessage`;
    await axios.post(
      url,
      {
        chat_id: telegramSettings.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      { timeout: 8000 }
    );
  } catch (err) {
    console.error("[telegram] send failed:", err.response?.data?.description || err.message);
  }
}

const PRICE_STEP = 0.01;
const DRIFT_REPEAT_MS = 5 * 60 * 1000;
const appliedAds = dbApi.kvGet("appliedAds", {});
// scrub any stale lastDrift state from previous run so banners re-evaluate cleanly
for (const id of Object.keys(appliedAds)) {
  appliedAds[id].lastDrift = {};
}
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

  const events = [];
  const isMeaningful = (current, suggested) =>
    suggested != null &&
    Number.isFinite(suggested) &&
    Math.abs(suggested - current) >= PRICE_STEP / 2;

  for (const ad of applied.buyAds || []) {
    const currentRank = rankForBid(sellOrders, ad.price);
    if (currentRank > ad.targetRank) {
      const suggestedPrice = suggestedBuyAdPrice(
        sellOrders,
        ad.targetRank,
        ad.minProfit,
        (applied.sellAds || [])[0]?.price
      );
      if (!isMeaningful(ad.price, suggestedPrice)) continue;
      events.push({
        side: "buy",
        adNo: ad.adNo,
        currentPrice: ad.price,
        currentRank,
        targetRank: ad.targetRank,
        suggestedPrice,
      });
    }
  }
  for (const ad of applied.sellAds || []) {
    const currentRank = rankForAsk(buyOrders, ad.price);
    if (currentRank > ad.targetRank) {
      const suggestedPrice = suggestedSellAdPrice(
        buyOrders,
        ad.targetRank,
        ad.minProfit,
        (applied.buyAds || [])[0]?.price
      );
      if (!isMeaningful(ad.price, suggestedPrice)) continue;
      events.push({
        side: "sell",
        adNo: ad.adNo,
        currentPrice: ad.price,
        currentRank,
        targetRank: ad.targetRank,
        suggestedPrice,
      });
    }
  }

  for (const ev of events) {
    const key = `${ev.side}:${ev.adNo}`;
    const last = applied.lastDrift[key];
    const stale = !last || now - last.t > DRIFT_REPEAT_MS;
    const rankChanged = !last || last.rank !== ev.currentRank;
    if (stale || rankChanged) {
      applied.lastDrift[key] = { t: now, rank: ev.currentRank };
      getDriftBus(exchangeId).emit("drift", {
        exchange: exchangeId,
        t: now,
        ...ev,
      });
      if (telegramSettings.drift) {
        sendTelegram(
          `<b>⚠️ Drift on ${exchangeId}</b>\n` +
            `${ev.side.toUpperCase()} ad ${ev.adNo} dropped to rank #${ev.currentRank} (target #${ev.targetRank}).\n` +
            `Current price: ${ev.currentPrice}\n` +
            (ev.suggestedPrice != null
              ? `Suggested: <b>${ev.suggestedPrice}</b>`
              : "")
        );
      }
    }
  }
  const driftingKeys = new Set(events.map((e) => `${e.side}:${e.adNo}`));
  for (const k of Object.keys(applied.lastDrift)) {
    if (!driftingKeys.has(k)) delete applied.lastDrift[k];
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
      if (telegramSettings.alerts) {
        const fmt = (n) =>
          Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
        const fmt2 = (n) =>
          Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const route = op.sameExchange
          ? `${op.buy.label} (intra)`
          : `${op.buy.label} → ${op.sell.label}${op.network ? ` via ${op.network}` : ""}`;
        sendTelegram(
          `<b>💰 Live alert</b>\n` +
            `${route}\n` +
            `Buy ${fmt2(op.buy.price)} (${op.buy.merchant}) → Sell ${fmt2(op.sell.price)} (${op.sell.merchant})\n` +
            `Net <b>+${fmt(op.netProfit)} AMD</b> on ${fmt(op.amount)} USDT (${op.profitPerUsdt.toFixed(2)} AMD/USDT, ${op.profitPercent.toFixed(2)}%)`
        );
      }
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

function findAdByMerchant(exchangeId, usernameLower) {
  const s = state[exchangeId];
  if (!s?.cache?.data) return null;
  const lists = [s.cache.data.buy || [], s.cache.data.sell || []];
  for (const ads of lists) {
    for (const ad of ads) {
      if (ad.merchant && ad.merchant.toLowerCase() === usernameLower) {
        return ad;
      }
    }
  }
  return null;
}

function extractStatsFromAd(ad) {
  const t = ad.trader || {};
  const monthOrderCount =
    t.monthOrderCount ?? t.recentOrderCount ?? null;
  const monthFinishRate =
    t.monthFinishRate != null
      ? Number(t.monthFinishRate)
      : t.completionRate != null
      ? Number(t.completionRate) / 100
      : null;
  const positiveRate = t.positiveRate != null ? Number(t.positiveRate) : null;
  const orderCount = t.orderCount ?? t.finishCount ?? monthOrderCount ?? null;
  const totalOrders = orderCount;
  let successfulOrders = null;
  let cancelledOrders = null;
  if (Number.isFinite(totalOrders) && Number.isFinite(monthFinishRate)) {
    successfulOrders = Math.round(totalOrders * monthFinishRate);
    cancelledOrders = totalOrders - successfulOrders;
  } else if (Number.isFinite(t.finishCount) && Number.isFinite(orderCount)) {
    successfulOrders = t.finishCount;
    cancelledOrders = orderCount - t.finishCount;
  }
  let stars = null;
  if (positiveRate != null) stars = Number((positiveRate * 5).toFixed(2));
  return {
    totalOrders,
    successfulOrders,
    cancelledOrders,
    positiveFeedback: null,
    negativeFeedback: null,
    stars,
  };
}

function resolveCounterpartyName(order, exchangeId) {
  const masked =
    order.counterPartNickName ||
    order.makerNickname ||
    order.takerNickname ||
    null;
  const userNo =
    order.counterPartUserNo ||
    order.advertiserNo ||
    order.makerUserNo ||
    order.takerUserNo ||
    null;
  const s = state[exchangeId];
  const ads = s?.cache?.data
    ? [...(s.cache.data.buy || []), ...(s.cache.data.sell || [])]
    : [];
  if (userNo) {
    const byNo = ads.find((ad) => ad.trader?.userId === userNo);
    if (byNo?.merchant) return { name: byNo.merchant, full: true };
  }
  if (masked && masked.includes("*")) {
    const prefix = masked.replace(/\*+$/, "").trim();
    if (prefix.length >= 2) {
      const lower = prefix.toLowerCase();
      const matches = ads.filter(
        (ad) => ad.merchant && ad.merchant.toLowerCase().startsWith(lower)
      );
      const unique = Array.from(
        new Map(matches.map((m) => [m.merchant, m])).values()
      );
      if (unique.length === 1) return { name: unique[0].merchant, full: true };
    }
  }
  return { name: masked || "(unknown)", full: !masked || !masked.includes("*") };
}

const { getRecord: riskGetRecord, computeVerdict: riskComputeVerdict } =
  require("./risk/reputation");

app.post("/api/risk/my-orders", async (req, res) => {
  const {
    exchange = "binance",
    apiKey,
    apiSecret,
    days = 30,
  } = req.body || {};
  if (!apiKey || !apiSecret) {
    return res
      .status(400)
      .json({ ok: false, error: "apiKey and apiSecret required" });
  }
  const adapter = getAdapter(exchange);
  if (!adapter?.getOrders) {
    return res.status(501).json({
      ok: false,
      error: `${exchange} does not support order history`,
    });
  }
  const period = Math.max(1, Math.min(90, Number(days) || 30));
  const end = Date.now();
  const start = end - period * 86400000;
  const allOrders = [];
  try {
    for (const side of ["BUY", "SELL"]) {
      let page = 1;
      while (page <= 10) {
        const r = await adapter.getOrders({
          apiKey,
          apiSecret,
          startTimestamp: start,
          endTimestamp: end,
          page,
          rows: 100,
          tradeType: side,
        });
        const rows = r?.data || [];
        if (!rows.length) break;
        for (const o of rows) allOrders.push({ ...o, _side: side });
        if (rows.length < 100) break;
        page++;
      }
    }
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok: false,
      error:
        err.response?.data?.msg ||
        err.response?.data?.message ||
        err.message,
    });
  }

  const byUser = new Map();
  for (const o of allOrders) {
    const resolved = resolveCounterpartyName(o, exchange);
    const display = resolved.name;
    if (!display || display === "(unknown)") continue;
    const key = display.toLowerCase();
    let agg = byUser.get(key);
    if (!agg) {
      agg = {
        username: key,
        displayName: display,
        nameFull: resolved.full,
        total: 0,
        completed: 0,
        cancelled: 0,
        appealed: 0,
        totalUsdt: 0,
        lastTradeAt: 0,
        sides: { BUY: 0, SELL: 0 },
      };
      byUser.set(key, agg);
    } else if (resolved.full && !agg.nameFull) {
      agg.displayName = display;
      agg.nameFull = true;
    }
    agg.total++;
    agg.sides[o._side] = (agg.sides[o._side] || 0) + 1;
    const status = String(o.orderStatus || "").toUpperCase();
    if (status === "COMPLETED" || status === "RELEASED") agg.completed++;
    if (status.includes("CANCEL")) agg.cancelled++;
    if (status.includes("APPEAL") || status.includes("DISPUTE")) agg.appealed++;
    agg.totalUsdt += parseFloat(o.amount) || 0;
    const t = Number(o.createTime || o.orderCreateTime || 0);
    if (t > agg.lastTradeAt) agg.lastTradeAt = t;
  }

  const ordersByUser = new Map();
  for (const o of allOrders) {
    const masked =
      o.counterPartNickName || o.makerNickname || o.takerNickname || "";
    const resolved = resolveCounterpartyName(o, exchange);
    const key = resolved.name.toLowerCase();
    if (!ordersByUser.has(key)) ordersByUser.set(key, []);
    ordersByUser.get(key).push({ orderNumber: o.orderNumber, masked });
  }

  if (adapter.getOrderDetail) {
    const stillMasked = [...byUser.values()].filter(
      (a) => !a.nameFull && a.displayName && a.displayName.includes("*")
    );
    const MAX_DETAIL_CALLS = 30;
    const targets = stillMasked.slice(0, MAX_DETAIL_CALLS);
    await Promise.all(
      targets.map(async (agg) => {
        const list = ordersByUser.get(agg.username) || [];
        const sample = list.find((x) => x.orderNumber);
        if (!sample) return;
        try {
          const d = await adapter.getOrderDetail({
            apiKey,
            apiSecret,
            orderNumber: sample.orderNumber,
          });
          const data = d?.data || {};
          const candidates = [
            data.makerNickname,
            data.takerNickname,
            data.counterPartNickName,
            data.nickName,
            data.advertiser?.nickName,
            data.customer?.nickName,
          ].filter(Boolean);
          const fullName = candidates.find(
            (c) => typeof c === "string" && !c.includes("*")
          );
          if (fullName) {
            const newKey = fullName.toLowerCase();
            const existing = byUser.get(newKey);
            if (existing && existing !== agg) {
              existing.total += agg.total;
              existing.completed += agg.completed;
              existing.cancelled += agg.cancelled;
              existing.appealed += agg.appealed;
              existing.totalUsdt += agg.totalUsdt;
              existing.sides.BUY += agg.sides.BUY || 0;
              existing.sides.SELL += agg.sides.SELL || 0;
              if (agg.lastTradeAt > existing.lastTradeAt)
                existing.lastTradeAt = agg.lastTradeAt;
              byUser.delete(agg.username);
            } else {
              byUser.delete(agg.username);
              agg.username = newKey;
              agg.displayName = fullName;
              agg.nameFull = true;
              byUser.set(newKey, agg);
            }
          }
        } catch {
          /* ignore individual failures */
        }
      })
    );
  }

  const counterparties = [];
  for (const [, agg] of byUser) {
    const record = riskGetRecord(agg.username);
    const verdict = riskComputeVerdict(record);
    const cancelRate = agg.total > 0 ? agg.cancelled / agg.total : 0;
    const stopTrading =
      verdict.verdict === "bad" ||
      record?.manualRating === "bad" ||
      agg.appealed > 0 ||
      (cancelRate >= 0.3 && agg.total >= 3);
    counterparties.push({
      ...agg,
      verdict: verdict.verdict,
      score: verdict.score,
      reasons: verdict.reasons,
      manualRating: record?.manualRating || null,
      stopTrading,
      cancelRate,
    });
  }

  const order = { bad: 0, neutral: 1, unknown: 2, good: 3 };
  counterparties.sort((a, b) => {
    const va = order[a.verdict] ?? 4;
    const vb = order[b.verdict] ?? 4;
    if (va !== vb) return va - vb;
    if (a.cancelRate !== b.cancelRate) return b.cancelRate - a.cancelRate;
    return b.total - a.total;
  });

  res.json({
    ok: true,
    exchange,
    days: period,
    totalOrders: allOrders.length,
    uniqueCounterparties: counterparties.length,
    counterparties,
    flagged: counterparties.filter((c) => c.stopTrading).length,
  });
});

app.get("/api/risk/autofill", (req, res) => {
  const username = String(req.query.username || "").trim();
  if (!username) {
    return res.status(400).json({ ok: false, error: "username required" });
  }
  const lower = username.toLowerCase();
  for (const meta of listAdapters()) {
    const ad = findAdByMerchant(meta.id, lower);
    if (ad) {
      return res.json({
        ok: true,
        found: true,
        username,
        exchange: meta.id,
        exchangeLabel: meta.label,
        merchant: ad.merchant,
        stats: extractStatsFromAd(ad),
        trader: ad.trader || null,
      });
    }
  }
  res.status(404).json({
    ok: false,
    found: false,
    error: "User not currently in any cached order book",
  });
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

app.get("/api/:exchange/orders/cached", withAdapter, (req, res) => {
  const id = req.adapter.id;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const rows = dbApi.listOrders(id, start, end, 5000);
  res.json({
    ok: true,
    count: rows.length,
    orders: rows.map((r) => ({
      orderNumber: r.order_no,
      tradeType: r.trade_type,
      asset: r.asset,
      fiat: r.fiat,
      amount: r.amount,
      unitPrice: r.unit_price,
      totalPrice: r.total_price,
      counterPartNickName: r.counterparty,
      orderStatus: r.status,
      createTime: r.create_time,
    })),
  });
});

app.post("/api/:exchange/orders", withAdapter, async (req, res) => {
  const adapter = req.adapter;
  if (!adapter.getOrders) {
    return res
      .status(501)
      .json({ ok: false, error: `getOrders not implemented for ${adapter.id}` });
  }
  const { apiKey, apiSecret, startTimestamp, endTimestamp, page, rows, tradeType } = req.body || {};
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ ok: false, error: "Missing apiKey or apiSecret" });
  }
  try {
    const data = await adapter.getOrders({
      apiKey,
      apiSecret,
      startTimestamp,
      endTimestamp,
      page,
      rows,
      tradeType,
    });
    try {
      dbApi.saveOrders(adapter.id, data?.data || []);
    } catch (e) {
      console.error(`[${adapter.id}] orders db save failed:`, e.message);
    }
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.response?.status || 500;
    const body = err.response?.data;
    res.status(status).json({
      ok: false,
      error: body?.msg || body?.message || err.message || "Adapter error",
      code: body?.code,
    });
  }
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
  const { buy, sell, buyAds, sellAds, clear } = req.body || {};
  if (clear) {
    delete appliedAds[id];
    dbApi.kvSet("appliedAds", appliedAds);
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
  const buyArr = Array.isArray(buyAds)
    ? buyAds.map(norm).filter(Boolean)
    : buy
      ? [norm(buy)].filter(Boolean)
      : [];
  const sellArr = Array.isArray(sellAds)
    ? sellAds.map(norm).filter(Boolean)
    : sell
      ? [norm(sell)].filter(Boolean)
      : [];
  if (buyArr.length === 0 && sellArr.length === 0) {
    return res.status(400).json({ ok: false, error: "buy or sell required" });
  }
  appliedAds[id] = { buyAds: buyArr, sellAds: sellArr, lastDrift: {} };
  dbApi.kvSet("appliedAds", appliedAds);
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
    console.log(`[${adapter.id}] update-ad ok adNo=${adNo} price=${price}`, JSON.stringify(data));
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.response?.status || 500;
    const body = err.response?.data;
    console.error(
      `[${adapter.id}] update-ad FAIL adNo=${adNo} price=${price}`,
      "status=", status,
      "body=", JSON.stringify(body),
      "headers=", JSON.stringify(err.response?.headers || {})
    );
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
  persistLive();
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

app.get("/api/telegram/settings", (req, res) => {
  res.json({
    botToken: telegramSettings.botToken
      ? `${telegramSettings.botToken.slice(0, 6)}…${telegramSettings.botToken.slice(-4)}`
      : "",
    chatId: telegramSettings.chatId,
    alerts: telegramSettings.alerts,
    drift: telegramSettings.drift,
    newOrders: telegramSettings.newOrders,
    configured: !!(telegramSettings.botToken && telegramSettings.chatId),
  });
});

app.post("/api/telegram/settings", (req, res) => {
  const { botToken, chatId, alerts, drift, newOrders } = req.body || {};
  if (botToken !== undefined) telegramSettings.botToken = String(botToken || "").trim();
  if (chatId !== undefined) telegramSettings.chatId = String(chatId || "").trim();
  if (alerts !== undefined) telegramSettings.alerts = !!alerts;
  if (drift !== undefined) telegramSettings.drift = !!drift;
  if (newOrders !== undefined) telegramSettings.newOrders = !!newOrders;
  persistTelegram();
  res.json({ ok: true });
});

app.post("/api/telegram/watch-orders", (req, res) => {
  const { apiKey, apiSecret, clear } = req.body || {};
  if (clear) {
    orderWatcher.apiKey = "";
    orderWatcher.apiSecret = "";
    orderWatcher.seenOrderIds.clear();
    persistOrderWatcher();
    return res.json({ ok: true, watching: false });
  }
  if (!apiKey || !apiSecret) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing apiKey or apiSecret" });
  }
  orderWatcher.apiKey = apiKey;
  orderWatcher.apiSecret = apiSecret;
  persistOrderWatcher();
  // pre-seed seen IDs from the last 24h so historical orders don't all alert
  pollOrdersForTelegram(true).catch(() => {});
  res.json({ ok: true, watching: true });
});

async function pollOrdersForTelegram(seedOnly = false) {
  if (!orderWatcher.apiKey || !orderWatcher.apiSecret) return;
  if (!telegramSettings.botToken || !telegramSettings.chatId) return;
  if (!telegramSettings.newOrders) return;
  const adapter = getAdapter("binance");
  if (!adapter?.getOrders) return;
  const start = Date.now() - 24 * 60 * 60 * 1000;
  const end = Date.now();
  for (const tradeType of ["BUY", "SELL"]) {
    try {
      const data = await adapter.getOrders({
        apiKey: orderWatcher.apiKey,
        apiSecret: orderWatcher.apiSecret,
        startTimestamp: start,
        endTimestamp: end,
        page: 1,
        rows: 20,
        tradeType,
      });
      const rows = data?.data || [];
      try {
        dbApi.saveOrders("binance", rows);
      } catch (e) {
        console.error("[order-watch] db save failed:", e.message);
      }
      for (const o of rows) {
        const id = o.orderNumber;
        if (!id) continue;
        if (orderWatcher.seenOrderIds.has(id)) continue;
        orderWatcher.seenOrderIds.add(id);
        if (seedOnly) continue;
        const status = (o.orderStatus || "").toUpperCase();
        const isBuy = o.tradeType === "BUY";
        sendTelegram(
          `<b>🆕 New P2P ${isBuy ? "BUY" : "SELL"} order</b>\n` +
            `Amount: ${o.amount} ${o.asset || "USDT"}\n` +
            `Price: ${o.unitPrice} ${o.fiat || "AMD"}\n` +
            `Total: ${o.totalPrice}\n` +
            `Counterparty: ${o.counterPartNickName || "—"}\n` +
            `Status: ${status}`
        );
      }
    } catch (err) {
      console.error("[order-watch]", tradeType, err.response?.data || err.message);
    }
  }
  orderWatcher.lastPoll = Date.now();
  // cap memory
  if (orderWatcher.seenOrderIds.size > 5000) {
    orderWatcher.seenOrderIds = new Set(
      [...orderWatcher.seenOrderIds].slice(-3000)
    );
  }
  persistOrderWatcher();
}

setInterval(() => pollOrdersForTelegram().catch(() => {}), 60_000);

app.post("/api/telegram/test", async (req, res) => {
  if (!telegramSettings.botToken || !telegramSettings.chatId) {
    return res.status(400).json({ ok: false, error: "Bot token or chat ID missing" });
  }
  try {
    const url = `https://api.telegram.org/bot${telegramSettings.botToken}/sendMessage`;
    const r = await axios.post(
      url,
      {
        chat_id: telegramSettings.chatId,
        text: "✅ p2p-bot Telegram link OK — alerts will arrive here.",
        parse_mode: "HTML",
      },
      { timeout: 8000 }
    );
    res.json({ ok: true, data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      ok: false,
      error: err.response?.data?.description || err.message,
    });
  }
});

app.post("/api/audit/settings", (req, res) => {
  const { amount, minProfit } = req.body || {};
  if (amount !== undefined) liveSettings.amount = Math.max(100, Number(amount) || 100);
  if (minProfit !== undefined) {
    const v = Number(minProfit);
    if (Number.isFinite(v)) liveSettings.minProfitPerUsdt = v;
  }
  lastAlertProfit.clear();
  persistLive();
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
