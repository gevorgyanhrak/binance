const axios = require("axios");
const { sanitizeOrders } = require("./util");

const SEARCH_URL = "https://www.okx.com/v3/c2c/tradingOrders/books";

const SIDE_FOR = { BUY: "sell", SELL: "buy" };

async function fetchP2P({ tradeType, asset = "USDT", fiat = "AMD" }) {
  const side = SIDE_FOR[tradeType];
  if (!side) throw new Error(`Unsupported tradeType: ${tradeType}`);

  const res = await axios.get(SEARCH_URL, {
    params: {
      quoteCurrency: fiat.toUpperCase(),
      baseCurrency: asset.toLowerCase(),
      side,
      paymentMethod: "all",
      userType: "all",
      showTrade: false,
      showFollow: false,
      showAlreadyTraded: false,
      isAbleFilter: false,
      limit: 10,
      offset: 0,
    },
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000,
  });

  const items = res.data?.data?.[side] || [];
  const orders = items.map((item) => ({
    price: parseFloat(item.price),
    min: parseFloat(item.quoteMinAmountPerOrder ?? item.availableAmount ?? 0),
    max: parseFloat(item.quoteMaxAmountPerOrder ?? 0),
    merchant: item.nickName,
  }));

  const clean = sanitizeOrders(orders);
  clean.sort((a, b) =>
    tradeType === "BUY" ? a.price - b.price : b.price - a.price
  );
  return clean.slice(0, 10);
}

module.exports = {
  id: "okx",
  label: "OKX",
  fetchP2P,
};
