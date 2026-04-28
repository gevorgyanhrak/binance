const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

const BASE_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
const HISTORY_FILE = path.join(__dirname, "history.json");
const REFRESH_INTERVAL_MS = 30_000;
const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

let history = [];
if (fs.existsSync(HISTORY_FILE)) {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
}

function pruneAndPersist() {
  const cutoff = Date.now() - RETENTION_MS;
  history = history.filter((s) => s.t >= cutoff);
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
}

async function fetchP2P(tradeType) {
  const res = await axios.post(BASE_URL, {
    page: 1,
    rows: 10,
    payTypes: [],
    asset: "USDT",
    fiat: "AMD",
    tradeType,
  });
  return res.data.data.map((item) => ({
    price: parseFloat(item.adv.price),
    min: parseFloat(item.adv.minSingleTransAmount),
    max: parseFloat(item.adv.dynamicMaxSingleTransAmount),
    merchant: item.advertiser.nickName,
  }));
}

async function buildSnapshot() {
  const [buy, sell] = await Promise.all([fetchP2P("BUY"), fetchP2P("SELL")]);
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

let cache = null;
let refreshing = null;

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const data = await buildSnapshot();
      const t = Date.now();
      cache = { data, t };
      history.push({
        t,
        buyPrice: data.bestBuy.price,
        sellPrice: data.bestSell.price,
        spread: data.spread,
        profitPercent: data.profitPercent,
        buyPrices: data.buy.slice(0, 10).map((b) => b.price),
        sellPrices: data.sell.slice(0, 10).map((s) => s.price),
      });
      pruneAndPersist();
    } catch (err) {
      console.error("Refresh failed:", err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

setInterval(refresh, REFRESH_INTERVAL_MS);
refresh();

app.get("/api/p2p", async (req, res) => {
  try {
    if (!cache) await refresh();
    if (!cache) return res.status(503).json({ error: "No data available yet" });
    res.json({ ...cache.data, updatedAt: cache.t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PERIOD_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const MAX_CHART_POINTS = 180;

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

app.get("/api/history", (req, res) => {
  const period = String(req.query.period || "day");
  const ms = PERIOD_MS[period];
  if (!ms) {
    return res.status(400).json({ error: "Invalid period. Use day|week|month." });
  }

  const cutoff = Date.now() - ms;
  const slice = history.filter((s) => s.t >= cutoff);

  if (slice.length === 0) {
    return res.json({ period, dataPoints: 0, snapshots: [], aggregates: null });
  }

  const buyPrices = slice.map((s) => s.buyPrice);
  const sellPrices = slice.map((s) => s.sellPrice);
  const spreads = slice.map((s) => s.spread);
  const profits = slice.map((s) => s.profitPercent);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const POSITIONS = 10;
  const buyByPos = Array.from({ length: POSITIONS }, () => []);
  const sellByPos = Array.from({ length: POSITIONS }, () => []);

  for (const s of slice) {
    const bps =
      s.buyPrices || (s.buyPrice !== undefined ? [s.buyPrice] : []);
    const sps =
      s.sellPrices || (s.sellPrice !== undefined ? [s.sellPrice] : []);
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
    snapshots: downsample(slice, MAX_CHART_POINTS).map((s) => ({
      t: s.t,
      buyPrice: s.buyPrices?.[0] ?? s.buyPrice,
      sellPrice: s.sellPrices?.[0] ?? s.sellPrice,
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

const BINANCE_API_BASE = "https://api.binance.com";
const UPDATE_AD_PATH = "/sapi/v1/c2c/ads/update";

function signQuery(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(query)
    .digest("hex");
  return `${query}&signature=${signature}`;
}

async function updateBinanceAd({ apiKey, apiSecret, adNo, price }) {
  const params = {
    adsNo: adNo,
    price: String(price),
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const signedQuery = signQuery(params, apiSecret);
  const url = `${BINANCE_API_BASE}${UPDATE_AD_PATH}?${signedQuery}`;
  const response = await axios.post(url, null, {
    headers: { "X-MBX-APIKEY": apiKey },
    timeout: 15000,
  });
  return response.data;
}

app.post("/api/binance/update-ad", async (req, res) => {
  const { apiKey, apiSecret, adNo, price } = req.body || {};
  if (!apiKey || !apiSecret || !adNo || price === undefined) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing apiKey, apiSecret, adNo or price" });
  }

  try {
    const data = await updateBinanceAd({ apiKey, apiSecret, adNo, price });
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.response?.status || 500;
    const body = err.response?.data;
    res.status(status).json({
      ok: false,
      error: body?.msg || body?.message || err.message || "Binance error",
      code: body?.code,
      raw: body,
    });
  }
});

app.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});
