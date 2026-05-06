const axios = require("axios");

// In-memory rolling window of recent strategy snapshots (for volatility calc)
const SNAPSHOT_WINDOW = [];
const WINDOW_MAX = 120; // ~last hour at 30s cadence

const RULES = {
  BUY_SPREAD_PCT: 1.5,
  HOLD_SPREAD_PCT: 1.0,
  MIN_LIQUIDITY_USDT: 500, // per ad
  TARGET_LIQUIDITY_USDT: 5000, // qualifying total in top 10
  MAX_VOLATILITY_PCT: 0.7, // std-dev of spread % over rolling window
  TRANSFER_FEE_USDT: 1, // TRC20 typical
  EXEC_SLIPPAGE_PCT: 0.1,
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
    if (adMaxUsdt < minPerAdUsdt) continue; // illiquid ad — skip
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
    qualifyingAds: used.length,
  };
}

function totalQualifyingLiquidity(orders, minPerAdUsdt) {
  let total = 0;
  for (const o of orders) {
    if (!Number.isFinite(o.price) || o.price <= 0) continue;
    const usdt = o.max / o.price;
    if (usdt >= minPerAdUsdt) total += usdt;
  }
  return total;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function getRubAmdRate() {
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
    let m;
    while ((m = re.exec(data)) !== null) {
      const b = parseFloat(m[1]);
      if (b > 3 && b < 10) buys.push(b);
    }
    if (buys.length) return buys.reduce((a, b) => a + b, 0) / buys.length;
  } catch {}
  try {
    const r = await axios.get("https://open.er-api.com/v6/latest/RUB", {
      timeout: 6000,
    });
    if (Number.isFinite(r.data?.rates?.AMD)) return r.data.rates.AMD;
  } catch {}
  return null;
}

async function computeStrategy({ getAdapter, amountUsdt = 1000 }) {
  const buyAdapter = getAdapter("bybit");
  const sellAdapter = getAdapter("bybit");
  if (!buyAdapter?.fetchP2P || !sellAdapter?.fetchP2P) {
    return { ok: false, error: "adapters unavailable" };
  }
  const [rubAsks, amdBids, fxRate] = await Promise.all([
    buyAdapter.fetchP2P({ tradeType: "BUY", asset: "USDT", fiat: "RUB" }),
    sellAdapter.fetchP2P({ tradeType: "SELL", asset: "USDT", fiat: "AMD" }),
    getRubAmdRate(),
  ]);

  const minPerAd = RULES.MIN_LIQUIDITY_USDT;
  const rubAggr = aggregateForExecution(rubAsks || [], amountUsdt, minPerAd);
  const amdAggr = aggregateForExecution(amdBids || [], amountUsdt, minPerAd);
  const rubLiquidity = totalQualifyingLiquidity(rubAsks || [], minPerAd);
  const amdLiquidity = totalQualifyingLiquidity(amdBids || [], minPerAd);

  let spreadPct = null;
  let netProfitAmd = null;
  let profitPerUsdtAmd = null;
  let costRub = null;
  let receiveAmd = null;
  let executable = null;
  if (
    rubAggr.effectivePrice != null &&
    amdAggr.effectivePrice != null &&
    Number.isFinite(fxRate)
  ) {
    executable = Math.min(rubAggr.filled, amdAggr.filled);
    if (executable > 0) {
      // Subtract transfer fee from USDT we can sell
      const usdtAfterFee = executable - RULES.TRANSFER_FEE_USDT;
      // Apply slippage cushion to gross spread
      costRub = rubAggr.effectivePrice * executable;
      const costInAmd = costRub * fxRate;
      receiveAmd = amdAggr.effectivePrice * usdtAfterFee;
      // small slippage haircut on receive side
      receiveAmd *= 1 - RULES.EXEC_SLIPPAGE_PCT / 100;
      netProfitAmd = receiveAmd - costInAmd;
      profitPerUsdtAmd = netProfitAmd / executable;
      spreadPct = (netProfitAmd / costInAmd) * 100;
    }
  }

  // Volatility from rolling window of past spread%
  const recentSpreads = SNAPSHOT_WINDOW.filter((s) => s.spreadPct != null).map(
    (s) => s.spreadPct
  );
  const volatilityPct = stddev(recentSpreads);

  // Liquidity score 0-100 (capped). Combines both sides.
  const liquidityRaw = Math.min(rubLiquidity, amdLiquidity);
  const liquidityScore = Math.min(
    100,
    (liquidityRaw / RULES.TARGET_LIQUIDITY_USDT) * 100
  );

  // Risk score (lower is better): high volatility, low liquidity
  const volatilityScore = Math.min(
    100,
    (volatilityPct / RULES.MAX_VOLATILITY_PCT) * 100
  );
  const riskScore = Math.round(
    Math.min(100, volatilityScore * 0.6 + (100 - liquidityScore) * 0.4)
  );

  // Decision
  const reasons = [];
  let decision = "SKIP";
  if (spreadPct == null || executable == null || executable < 100) {
    reasons.push("no executable size — adapters or FX missing");
  } else if (volatilityPct > RULES.MAX_VOLATILITY_PCT) {
    decision = "SKIP";
    reasons.push(
      `volatility ${volatilityPct.toFixed(2)}% > ${RULES.MAX_VOLATILITY_PCT}%`
    );
  } else if (liquidityScore < 50) {
    decision = "SKIP";
    reasons.push(`liquidity ${liquidityScore.toFixed(0)}/100 too low`);
  } else if (spreadPct >= RULES.BUY_SPREAD_PCT) {
    decision = "BUY";
    reasons.push(
      `spread ${spreadPct.toFixed(2)}% ≥ ${RULES.BUY_SPREAD_PCT}%`
    );
    reasons.push(`liquidity ${liquidityScore.toFixed(0)}/100`);
    reasons.push(`volatility ${volatilityPct.toFixed(2)}% within band`);
  } else if (spreadPct >= RULES.HOLD_SPREAD_PCT) {
    decision = "HOLD";
    reasons.push(
      `spread ${spreadPct.toFixed(2)}% between ${RULES.HOLD_SPREAD_PCT}–${RULES.BUY_SPREAD_PCT}%`
    );
  } else {
    decision = "SKIP";
    reasons.push(
      `spread ${spreadPct.toFixed(2)}% < ${RULES.HOLD_SPREAD_PCT}%`
    );
  }

  const snapshot = {
    t: Date.now(),
    decision,
    reasons,
    spreadPct,
    netProfitAmd,
    profitPerUsdtAmd,
    executable,
    costRub,
    receiveAmd,
    fxRate,
    rub: {
      effectivePrice: rubAggr.effectivePrice,
      filled: rubAggr.filled,
      qualifyingAds: rubAggr.qualifyingAds,
      qualifyingLiquidity: rubLiquidity,
    },
    amd: {
      effectivePrice: amdAggr.effectivePrice,
      filled: amdAggr.filled,
      qualifyingAds: amdAggr.qualifyingAds,
      qualifyingLiquidity: amdLiquidity,
    },
    scores: {
      liquidity: Math.round(liquidityScore),
      volatility: Math.round(volatilityScore),
      risk: riskScore,
    },
    rules: RULES,
  };

  // Push to rolling window
  SNAPSHOT_WINDOW.push({
    t: snapshot.t,
    spreadPct,
    decision,
  });
  if (SNAPSHOT_WINDOW.length > WINDOW_MAX) SNAPSHOT_WINDOW.shift();

  return { ok: true, ...snapshot };
}

function formatStatus(s) {
  if (!s.ok) return "❌ Strategy unavailable.";
  const sign = s.spreadPct != null && s.spreadPct >= 0 ? "+" : "";
  return (
    `<b>📊 Status</b>\n` +
    `Decision: <b>${s.decision}</b>\n` +
    `Spread: ${sign}${s.spreadPct?.toFixed(2)}%\n` +
    `RUB price: ${s.rub.effectivePrice?.toFixed(2)} RUB/USDT\n` +
    `AMD price: ${s.amd.effectivePrice?.toFixed(2)} AMD/USDT\n` +
    `FX: 1 RUB = ${s.fxRate?.toFixed(4)} AMD\n` +
    `Executable: ${s.executable?.toFixed(0) ?? "—"} USDT`
  );
}

function formatOpportunity(s) {
  if (!s.ok || s.spreadPct == null) return "❌ No data.";
  return (
    `<b>💰 Opportunity</b>\n` +
    `Buy ${s.executable?.toFixed(0)} USDT @ ${s.rub.effectivePrice?.toFixed(2)} RUB → spend ${Math.round(
      s.costRub
    )} RUB\n` +
    `Sell @ ${s.amd.effectivePrice?.toFixed(2)} AMD → receive ${Math.round(s.receiveAmd)} AMD\n` +
    `Net profit: <b>${s.netProfitAmd >= 0 ? "+" : ""}${Math.round(s.netProfitAmd)} AMD</b> (${s.spreadPct.toFixed(2)}%)\n` +
    `Per USDT: ${s.profitPerUsdtAmd?.toFixed(2)} AMD`
  );
}

function formatReinvest(s) {
  if (!s.ok) return "❌ No data.";
  const verb =
    s.decision === "BUY"
      ? "✅ <b>YES — buy now.</b>"
      : s.decision === "HOLD"
        ? "🟡 <b>HOLD — spread too thin.</b>"
        : "❌ <b>SKIP — not worth it right now.</b>";
  return (
    `<b>🔁 Reinvest?</b>\n` +
    `${verb}\n\n` +
    `Reason: ${s.reasons.join("; ")}`
  );
}

function formatRisk(s) {
  if (!s.ok) return "❌ No data.";
  return (
    `<b>⚠️ Risk score: ${s.scores.risk}/100</b>\n` +
    `Liquidity: ${s.scores.liquidity}/100 (RUB ${Math.round(s.rub.qualifyingLiquidity)} USDT, AMD ${Math.round(
      s.amd.qualifyingLiquidity
    )} USDT qualifying)\n` +
    `Volatility: ${s.scores.volatility}/100 (rolling spread σ over last ${SNAPSHOT_WINDOW.length} samples)`
  );
}

const HELP =
  "<b>Commands</b>\n" +
  "/status — current spreads &amp; decision\n" +
  "/opportunity — best arbitrage path right now\n" +
  "/reinvest — should I buy now?\n" +
  "/risk — market health score\n" +
  "/help — this list";

module.exports = {
  computeStrategy,
  formatStatus,
  formatOpportunity,
  formatReinvest,
  formatRisk,
  HELP,
  RULES,
};
