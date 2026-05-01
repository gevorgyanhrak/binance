const axios = require("axios");
const { sanitizeOrders } = require("./util");

const SEARCH_URL = "https://www.kucoin.com/_api/otc/ad/list";

const SIDE_FOR = { BUY: "SELL", SELL: "BUY" };

async function fetchP2P({ tradeType, asset = "USDT", fiat = "AMD" }) {
  const side = SIDE_FOR[tradeType];
  if (!side) throw new Error(`Unsupported tradeType: ${tradeType}`);

  const res = await axios.get(SEARCH_URL, {
    params: {
      status: "PUTUP",
      currency: asset,
      legal: fiat,
      page: 1,
      pageSize: 10,
      side,
    },
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000,
  });

  const items = res.data?.items || [];
  const orders = items
    .map((item) => {
      const price = parseFloat(item.limitPrice ?? item.floatPrice ?? 0);
      if (!price) return null;
      return {
        price,
        min: parseFloat(item.limitMinQuote ?? 0),
        max: parseFloat(item.limitMaxQuote ?? 0),
        merchant: item.nickName || item.userName || "",
      };
    })
    .filter(Boolean);

  const clean = sanitizeOrders(orders);
  clean.sort((a, b) =>
    tradeType === "BUY" ? a.price - b.price : b.price - a.price
  );
  return clean.slice(0, 10);
}

module.exports = {
  id: "kucoin",
  label: "KuCoin",
  fetchP2P,
};
