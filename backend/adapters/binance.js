const axios = require("axios");
const crypto = require("crypto");
const { sanitizeOrders } = require("./util");

const SEARCH_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
const API_BASE = "https://api.binance.com";
const UPDATE_AD_PATH = "/sapi/v1/c2c/ads/update";

async function fetchP2P({ tradeType, asset = "USDT", fiat = "AMD" }) {
  const res = await axios.post(SEARCH_URL, {
    page: 1,
    rows: 10,
    payTypes: [],
    asset,
    fiat,
    tradeType,
  });
  const orders = res.data.data.map((item) => {
    const adv = item.adv || {};
    const advertiser = item.advertiser || {};
    const payments = (adv.tradeMethods || [])
      .map((m) => m.tradeMethodName || m.identifier || m.payType)
      .filter(Boolean);
    return {
      price: parseFloat(adv.price),
      min: parseFloat(adv.minSingleTransAmount),
      max: parseFloat(adv.dynamicMaxSingleTransAmount),
      merchant: advertiser.nickName,
      trader: {
        userId: advertiser.userNo,
        nickname: advertiser.nickName,
        userType: advertiser.userType,
        userGrade: advertiser.userGrade,
        vipLevel: advertiser.vipLevel,
        monthOrderCount: advertiser.monthOrderCount,
        monthFinishRate: advertiser.monthFinishRate,
        positiveRate: advertiser.positiveRate,
        payTimeLimitMin: adv.payTimeLimit,
        availableUsdt: parseFloat(
          adv.dynamicMaxSingleTransQuantity || adv.tradableQuantity || 0
        ),
        paymentMethods: payments,
        adNo: adv.advNo,
        profileUrl: advertiser.userNo
          ? `https://p2p.binance.com/en/advertiserDetail?advertiserNo=${advertiser.userNo}`
          : null,
      },
    };
  });
  return sanitizeOrders(orders);
}

function signQuery(params, secret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(query)
    .digest("hex");
  return `${query}&signature=${signature}`;
}

async function getOrderDetail({ apiKey, apiSecret, orderNumber }) {
  const params = {
    adOrderNo: orderNumber,
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const signedQuery = signQuery(params, apiSecret);
  const url = `${API_BASE}/sapi/v1/c2c/orderMatch/getUserOrderDetail?${signedQuery}`;
  const response = await axios.get(url, {
    headers: { "X-MBX-APIKEY": apiKey },
    timeout: 15000,
  });
  return response.data;
}

async function getOrders({ apiKey, apiSecret, startTimestamp, endTimestamp, page = 1, rows = 100, tradeType }) {
  const params = {
    page,
    rows: Math.min(rows, 100),
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  if (startTimestamp) params.startTimestamp = startTimestamp;
  if (endTimestamp) params.endTimestamp = endTimestamp;
  if (tradeType) params.tradeType = tradeType;
  const signedQuery = signQuery(params, apiSecret);
  const url = `${API_BASE}/sapi/v1/c2c/orderMatch/listUserOrderHistory?${signedQuery}`;
  const response = await axios.get(url, {
    headers: { "X-MBX-APIKEY": apiKey },
    timeout: 15000,
  });
  return response.data;
}

async function getBalance({ apiKey, apiSecret, asset = "USDT" }) {
  const params = {
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const signedQuery = signQuery(params, apiSecret);
  const url = `${API_BASE}/sapi/v3/asset/getUserAsset?${signedQuery}`;
  const response = await axios.post(url, null, {
    headers: { "X-MBX-APIKEY": apiKey },
    timeout: 15000,
  });
  const rows = Array.isArray(response.data) ? response.data : [];
  const row = rows.find((r) => r.asset === asset);
  if (!row) return { asset, free: 0, locked: 0, total: 0 };
  const free = parseFloat(row.free) || 0;
  const locked = parseFloat(row.locked) || 0;
  return { asset, free, locked, total: free + locked };
}

async function updateAd({ apiKey, apiSecret, adNo, price }) {
  const params = {
    adsNo: adNo,
    priceType: 1,
    price: String(price),
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const signedQuery = signQuery(params, apiSecret);
  const url = `${API_BASE}${UPDATE_AD_PATH}?${signedQuery}`;
  const response = await axios.post(url, null, {
    headers: { "X-MBX-APIKEY": apiKey },
    timeout: 15000,
  });
  return response.data;
}

module.exports = {
  id: "binance",
  label: "Binance",
  fetchP2P,
  updateAd,
  getBalance,
  getOrders,
  getOrderDetail,
};
