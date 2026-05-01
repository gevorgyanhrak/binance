const binance = require("./binance");
const bybit = require("./bybit");
const okx = require("./okx");
const mexc = require("./mexc");
const kucoin = require("./kucoin");

const adapters = {
  [binance.id]: binance,
  [bybit.id]: bybit,
  [okx.id]: okx,
  [mexc.id]: mexc,
  [kucoin.id]: kucoin,
};

function getAdapter(id) {
  return adapters[id] || null;
}

function listAdapters() {
  return Object.values(adapters).map((a) => ({ id: a.id, label: a.label }));
}

module.exports = { getAdapter, listAdapters };
