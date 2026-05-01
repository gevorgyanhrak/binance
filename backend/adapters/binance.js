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
  const orders = res.data.data.map((item) => ({
    price: parseFloat(item.adv.price),
    min: parseFloat(item.adv.minSingleTransAmount),
    max: parseFloat(item.adv.dynamicMaxSingleTransAmount),
    merchant: item.advertiser.nickName,
  }));
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

async function updateAd({ apiKey, apiSecret, adNo, price }) {
  const params = {
    adsNo: adNo,
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
};
