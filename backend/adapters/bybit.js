const axios = require("axios");
const { sanitizeOrders } = require("./util");

const SEARCH_URL = "https://api2.bybit.com/fiat/otc/item/online";

const SIDE_FOR = { BUY: "1", SELL: "0" };

async function fetchP2P({ tradeType, asset = "USDT", fiat = "AMD" }) {
  const side = SIDE_FOR[tradeType];
  if (side === undefined) {
    throw new Error(`Unsupported tradeType: ${tradeType}`);
  }

  const res = await axios.post(
    SEARCH_URL,
    {
      userId: "",
      tokenId: asset,
      currencyId: fiat,
      payment: [],
      side,
      size: "10",
      page: "1",
      amount: "",
      authMaker: false,
      canTrade: false,
    },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 }
  );

  const items = res.data?.result?.items || [];
  const orders = items.map((item) => ({
    price: parseFloat(item.price),
    min: parseFloat(item.minAmount),
    max: parseFloat(item.maxAmount),
    merchant: item.nickName,
    trader: {
      userId: item.userId,
      accountId: item.accountId,
      nickname: item.nickName,
      userType: item.userType,
      orderCount: item.orderNum,
      finishCount: item.finishNum,
      recentOrderCount: item.recentOrderNum,
      completionRate: item.recentExecuteRate,
      paymentPeriodMin: item.paymentPeriod,
      isOnline: item.isOnline,
      remark: item.remark,
      availableUsdt: parseFloat(item.lastQuantity || item.quantity || 0),
      adNo: item.id,
      profileUrl: item.userMaskId
        ? `https://www.bybit.com/fiat/trade/otc/profile/${item.userMaskId}/USDT/${fiat}/buy`
        : null,
    },
  }));

  const clean = sanitizeOrders(orders);
  clean.sort((a, b) =>
    tradeType === "BUY" ? a.price - b.price : b.price - a.price
  );
  return clean.slice(0, 10);
}

module.exports = {
  id: "bybit",
  label: "Bybit",
  fetchP2P,
};
