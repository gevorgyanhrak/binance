const axios = require("axios");

const CYCLE_RULES = {
  TRANSFER_FEE_USDT: 1, // TRC20 typical
  EXEC_SLIPPAGE_PCT: 0.1,
  MIN_LIQUIDITY_USDT: 500, // per ad
};

function aggregateForExecution(orders, amountUsdt, minPerAdUsdt) {
  let filled = 0;
  let value = 0;
  const used = [];
  for (const o of orders) {
    if (filled >= amountUsdt) break;
    if (!Number.isFinite(o.price) || o.price <= 0) continue;
    const adMaxUsdt = o.max / o.price;
    const adMinUsdt = o.min / o.price;
    if (adMaxUsdt < minPerAdUsdt) continue;
    const remaining = amountUsdt - filled;
    if (remaining < adMinUsdt) continue;
    const take = Math.min(adMaxUsdt, remaining);
    filled += take;
    value += take * o.price;
    used.push({ price: o.price, merchant: o.merchant, usdt: take });
  }
  return {
    filled,
    effectivePrice: filled > 0 ? value / filled : null,
    used,
  };
}

// Aggregate by FIAT amount target (different from USDT amount target above)
// orders: book sorted by price; amountFiat: how much fiat we want to spend/get
function aggregateByFiat(orders, amountFiat, minPerAdUsdt) {
  let filledUsdt = 0;
  let spentFiat = 0;
  const used = [];
  let cheapestAdMinFiat = Infinity;
  for (const o of orders) {
    if (spentFiat >= amountFiat) break;
    if (!Number.isFinite(o.price) || o.price <= 0) continue;
    const adMaxUsdt = o.max / o.price;
    if (adMaxUsdt < minPerAdUsdt) continue;
    if (o.min < cheapestAdMinFiat) cheapestAdMinFiat = o.min;
    const remainingFiat = amountFiat - spentFiat;
    const wantUsdt = remainingFiat / o.price;
    const adMinUsdt = o.min / o.price;
    if (wantUsdt < adMinUsdt) continue;
    const takeUsdt = Math.min(adMaxUsdt, wantUsdt);
    const takeFiat = takeUsdt * o.price;
    filledUsdt += takeUsdt;
    spentFiat += takeFiat;
    used.push({
      price: o.price,
      merchant: o.merchant,
      usdt: takeUsdt,
      fiat: takeFiat,
    });
  }
  return {
    filledUsdt,
    spentFiat,
    effectivePrice: filledUsdt > 0 ? spentFiat / filledUsdt : null,
    used,
    cheapestAdMinFiat: Number.isFinite(cheapestAdMinFiat) ? cheapestAdMinFiat : null,
  };
}

async function getRubAmdBankRates() {
  try {
    const r = await axios.get(
      "https://www.rate.am/hy/armenian-dram-exchange-rates/banks",
      {
        timeout: 8000,
        headers: { RSC: "1", Accept: "*/*", "User-Agent": "Mozilla/5.0" },
      }
    );
    const data = String(r.data || "");
    const re = /"RUR":\{"CASH":\{"buy":"([0-9.]+)","sell":"([0-9.]+)"\}/g;
    const buys = [];
    const sells = [];
    let m;
    while ((m = re.exec(data)) !== null) {
      const b = parseFloat(m[1]);
      const s = parseFloat(m[2]);
      if (b > 3 && b < 10) buys.push(b);
      if (s > 3 && s < 10) sells.push(s);
    }
    if (!buys.length) return null;
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      // bank BUY rate = bank pays you per RUB (if you have RUB and want AMD) — irrelevant here
      // bank SELL rate = bank charges you per RUB (if you want to acquire RUB with AMD) — this is back_rate
      bankBuyAvg: avg(buys),
      bankSellAvg: avg(sells),
      bankSellBest: Math.min(...sells), // cheapest bank to refill RUB from
    };
  } catch {
    return null;
  }
}

async function computeCycle({
  getAdapter,
  principalRub = 10000,
  backMethod = "reverse_p2p", // 'bank' or 'reverse_p2p'
}) {
  const buyAdapter = getAdapter("bybit");
  const sellAdapter = getAdapter("bybit");
  if (!buyAdapter?.fetchP2P || !sellAdapter?.fetchP2P) {
    return { ok: false, error: "adapters unavailable" };
  }

  // Fetch all four legs in parallel:
  // forward leg: RUB asks (Russian merchants selling USDT) + AMD bids (Armenian merchants buying USDT)
  // backward leg: AMD asks (Armenian merchants selling USDT) + RUB bids (Russian merchants buying USDT)
  const [rubAsks, amdBids, amdAsks, rubBids, bankRates] = await Promise.all([
    buyAdapter.fetchP2P({ tradeType: "BUY", asset: "USDT", fiat: "RUB" }),
    sellAdapter.fetchP2P({ tradeType: "SELL", asset: "USDT", fiat: "AMD" }),
    sellAdapter.fetchP2P({ tradeType: "BUY", asset: "USDT", fiat: "AMD" }),
    buyAdapter.fetchP2P({ tradeType: "SELL", asset: "USDT", fiat: "RUB" }),
    getRubAmdBankRates(),
  ]);

  const minPerAd = CYCLE_RULES.MIN_LIQUIDITY_USDT;

  // ===== FORWARD LEG =====
  // 1) Spend principalRub on RUB asks → get USDT
  const fwdBuy = aggregateByFiat(rubAsks || [], principalRub, minPerAd);
  const usdtAcquired = fwdBuy.filledUsdt;
  const usdtAfterFee = Math.max(0, usdtAcquired - CYCLE_RULES.TRANSFER_FEE_USDT);
  // 2) Sell that USDT on AMD bids → get AMD
  const fwdSell = aggregateForExecution(amdBids || [], usdtAfterFee, minPerAd);
  let amdReceived = fwdSell.effectivePrice
    ? fwdSell.effectivePrice * fwdSell.filled
    : 0;
  amdReceived *= 1 - CYCLE_RULES.EXEC_SLIPPAGE_PCT / 100;

  // ===== BACK LEG: how much AMD to restore principalRub =====
  let backRate = null; // AMD per RUB
  let backMethodUsed = backMethod;
  let backDetail = null;

  if (backMethod === "bank") {
    if (bankRates) {
      backRate = bankRates.bankSellAvg;
      backDetail = {
        type: "bank",
        amdPerRub: bankRates.bankSellAvg,
        bestBank: bankRates.bankSellBest,
      };
    } else {
      backMethodUsed = "reverse_p2p"; // fallback
    }
  }

  // Restore only the RUB that was actually deployed in the forward leg
  // (if forward couldn't fully fill principal, we don't owe restoration on the unspent portion)
  const rubToRestore = fwdBuy.spentFiat > 0 ? fwdBuy.spentFiat : principalRub;

  if (backMethodUsed === "reverse_p2p") {
    // Reverse path: sell AMD to buy USDT (AMD asks), then sell USDT for RUB (RUB bids)
    // To get rubToRestore RUB, walk RUB bids first to compute USDT needed:
    let remainingRub = rubToRestore;
    let usdtNeededForRub = 0;
    const reverseSteps = [];
    for (const o of rubBids || []) {
      if (remainingRub <= 0) break;
      if (!Number.isFinite(o.price) || o.price <= 0) continue;
      const usdtMaxAd = o.max / o.price;
      if (usdtMaxAd < minPerAd) continue;
      const wantUsdt = remainingRub / o.price;
      const adMinUsdt = o.min / o.price;
      if (wantUsdt < adMinUsdt) continue;
      const takeUsdt = Math.min(usdtMaxAd, wantUsdt);
      const takeRub = takeUsdt * o.price;
      usdtNeededForRub += takeUsdt;
      remainingRub -= takeRub;
      reverseSteps.push({
        step: "sell-usdt-for-rub",
        merchant: o.merchant,
        price: o.price,
        usdt: takeUsdt,
        rub: takeRub,
      });
    }
    // Now buy that USDT with AMD on AMD asks
    const reverseBuy = aggregateForExecution(
      amdAsks || [],
      usdtNeededForRub,
      minPerAd
    );
    const amdSpent = reverseBuy.effectivePrice
      ? reverseBuy.effectivePrice * reverseBuy.filled
      : 0;
    if (
      remainingRub <= rubToRestore * 0.001 && // got essentially all the RUB
      reverseBuy.filled >= usdtNeededForRub * 0.999 &&
      usdtNeededForRub > 0
    ) {
      backRate = amdSpent / rubToRestore;
      backDetail = {
        type: "reverse_p2p",
        amdPerRub: backRate,
        usdtBridge: usdtNeededForRub,
        amdToSpend: amdSpent,
        amdAskPrice: reverseBuy.effectivePrice,
        rubBidPrice:
          reverseSteps.length > 0
            ? reverseSteps.reduce((a, s) => a + s.rub, 0) /
              reverseSteps.reduce((a, s) => a + s.usdt, 0)
            : null,
      };
    }
  }

  // If reverse_p2p couldn't fill, fall back to bank
  if (backRate == null && bankRates) {
    backRate = bankRates.bankSellAvg;
    backMethodUsed = "bank_fallback";
    backDetail = {
      type: "bank_fallback",
      amdPerRub: bankRates.bankSellAvg,
      bestBank: bankRates.bankSellBest,
    };
  }

  const amdToRestoreRub =
    backRate != null ? rubToRestore * backRate : null;
  const profitAmd =
    amdReceived > 0 && amdToRestoreRub != null
      ? amdReceived - amdToRestoreRub
      : null;
  const profitPct =
    amdReceived > 0 && amdToRestoreRub != null && amdToRestoreRub > 0
      ? (profitAmd / amdToRestoreRub) * 100
      : null;

  // Decision
  const reasons = [];
  let decision = "SKIP";
  if (!fwdBuy.filledUsdt) {
    if (
      fwdBuy.cheapestAdMinFiat != null &&
      fwdBuy.cheapestAdMinFiat > principalRub
    ) {
      reasons.push(
        `principal ${principalRub} RUB is below the smallest ad minimum (${Math.round(fwdBuy.cheapestAdMinFiat)} RUB). Increase principal or use exchanges with smaller ads.`
      );
    } else {
      reasons.push(
        `can't fill RUB buy leg — no ads meet ad-max ≥ ${minPerAd} USDT and ad-min ≤ ${principalRub} RUB`
      );
    }
  } else if (!fwdSell.filled) {
    reasons.push("can't fill AMD sell leg with min ad ≥ 500 USDT");
  } else if (backRate == null) {
    reasons.push("no viable back-rate (bank or reverse-P2P)");
  } else if (profitAmd == null || profitAmd <= 0) {
    decision = "SKIP";
    reasons.push(
      `profit ${profitAmd != null ? profitAmd.toFixed(0) : "—"} AMD ≤ 0`
    );
  } else {
    decision = "GO";
    reasons.push(
      `forward returns ${amdReceived.toFixed(0)} AMD, capital restoration costs ${amdToRestoreRub.toFixed(0)} AMD`
    );
    reasons.push(
      `net profit ${profitAmd.toFixed(0)} AMD (${profitPct.toFixed(2)}%)`
    );
  }

  return {
    ok: true,
    t: Date.now(),
    principalRub,
    decision,
    reasons,
    forward: {
      rubSpent: fwdBuy.spentFiat,
      rubBuyPrice: fwdBuy.effectivePrice,
      usdtAcquired,
      transferFeeUsdt: CYCLE_RULES.TRANSFER_FEE_USDT,
      usdtSold: fwdSell.filled,
      amdSellPrice: fwdSell.effectivePrice,
      amdReceived,
      slippagePct: CYCLE_RULES.EXEC_SLIPPAGE_PCT,
    },
    back: {
      methodRequested: backMethod,
      methodUsed: backMethodUsed,
      amdPerRub: backRate,
      amdToRestoreRub,
      rubToRestore,
      detail: backDetail,
    },
    bankRates,
    profitAmd,
    profitPct,
    rules: CYCLE_RULES,
  };
}

module.exports = { computeCycle, CYCLE_RULES };
