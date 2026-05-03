const axios = require("axios");
const { sanitizeOrders } = require("./util");

const SEARCH_URL = "https://otc.mexc.com/api/market";

const SIDE_FOR = { BUY: "SELL", SELL: "BUY" };

async function fetchP2P({ tradeType, asset = "USDT", fiat = "AMD" }) {
  const side = SIDE_FOR[tradeType];
  if (!side) throw new Error(`Unsupported tradeType: ${tradeType}`);

  const res = await axios.get(SEARCH_URL, {
    params: {
      allowTrade: false,
      blockType: "GENERAL_BLOCK",
      coinName: asset.toUpperCase(),
      currency: fiat.toUpperCase(),
      follow: false,
      haveTrade: false,
      page: 1,
      size: 10,
      tradeType: side,
    },
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000,
  });

  const items = res.data?.data || [];
  const orders = items.map((item) => {
    const ms = item.merchantStatistics || {};
    const totalOrders =
      (Number(ms.totalBuyCount) || 0) + (Number(ms.totalSellCount) || 0) ||
      null;
    return {
      price: parseFloat(item.price),
      min: parseFloat(item.minTradeLimit ?? 0),
      max: parseFloat(item.maxTradeLimit ?? 0),
      merchant: item.merchant?.nickName || "",
      trader: {
        userId: item.merchant?.uid,
        nickname: item.merchant?.nickName,
        kycLevel: item.kycLevel,
        orderCount: totalOrders,
        monthOrderCount: Number(ms.doneLastMonthCount) || null,
        monthFinishRate:
          ms.lastMonthCompleteRate != null
            ? Number(ms.lastMonthCompleteRate)
            : null,
        positiveRate:
          ms.completeRate != null ? Number(ms.completeRate) : null,
      },
    };
  });

  const clean = sanitizeOrders(orders);
  clean.sort((a, b) =>
    tradeType === "BUY" ? a.price - b.price : b.price - a.price
  );
  return clean.slice(0, 10);
}

module.exports = {
  id: "mexc",
  label: "MEXC",
  fetchP2P,
};
