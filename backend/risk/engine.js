const { methodRiskLevel } = require("./payment");

const WEIGHTS = {
  completionRate: 25,
  completedOrders: 20,
  priceDeviation: 25,
  paymentMethods: 15,
  suspiciousBehavior: 15,
};

function clampScore(value, max) {
  if (!Number.isFinite(value)) return max;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

function scoreCompletionRate(rate) {
  const max = WEIGHTS.completionRate;
  if (!Number.isFinite(rate)) return max;
  if (rate >= 0.98) return 0;
  if (rate >= 0.95) return Math.round(max * 0.2);
  if (rate >= 0.90) return Math.round(max * 0.45);
  if (rate >= 0.80) return Math.round(max * 0.7);
  return max;
}

function scoreCompletedOrders(count) {
  const max = WEIGHTS.completedOrders;
  if (!Number.isFinite(count) || count < 0) return max;
  if (count >= 1000) return 0;
  if (count >= 200) return Math.round(max * 0.2);
  if (count >= 50) return Math.round(max * 0.45);
  if (count >= 10) return Math.round(max * 0.7);
  return max;
}

function priceDeviationPercent(price, marketAvg) {
  if (!Number.isFinite(price) || !Number.isFinite(marketAvg) || marketAvg === 0) return null;
  return ((price - marketAvg) / marketAvg) * 100;
}

function scorePriceDeviation(price, marketAvg) {
  const max = WEIGHTS.priceDeviation;
  const dev = priceDeviationPercent(price, marketAvg);
  if (dev === null) return Math.round(max * 0.5);
  const abs = Math.abs(dev);
  if (abs <= 1) return 0;
  if (abs <= 3) return Math.round(max * 0.2);
  if (abs <= 7) return Math.round(max * 0.5);
  if (abs <= 15) return Math.round(max * 0.8);
  return max;
}

function scorePaymentMethods(methods) {
  const max = WEIGHTS.paymentMethods;
  if (!Array.isArray(methods) || methods.length === 0) return Math.round(max * 0.5);
  const levels = methods.map(methodRiskLevel);
  const peak = Math.max(...levels);
  const stepMap = { 1: 0, 2: 0.25, 3: 0.55, 4: 0.8, 5: 1 };
  return Math.round(max * (stepMap[peak] ?? 0.5));
}

function scoreSuspiciousBehavior({ price, marketAvg, side, completionRate, completedOrders }) {
  const max = WEIGHTS.suspiciousBehavior;
  const dev = priceDeviationPercent(price, marketAvg);
  if (dev === null) return Math.round(max * 0.4);
  let s = 0;
  const normalizedSide = String(side || "").toUpperCase();
  if (normalizedSide === "SELL" && dev < -5) s += max * 0.45;
  if (normalizedSide === "BUY" && dev > 5) s += max * 0.45;
  if ((completedOrders ?? 0) < 20 && Math.abs(dev) > 5) s += max * 0.3;
  if ((completionRate ?? 0) < 0.85 && Math.abs(dev) > 3) s += max * 0.25;
  if ((completedOrders ?? 0) < 5) s += max * 0.2;
  return clampScore(Math.round(s), max);
}

function levelFor(score) {
  if (score <= 30) return "Low";
  if (score <= 65) return "Medium";
  return "High";
}

function score(input = {}) {
  const completionRate = Number(input.completionRate);
  const completedOrders = Number(input.completedOrders);
  const price = Number(input.price);
  const marketAvg = Number(input.marketAvg);
  const side = input.side;
  const paymentMethods = input.paymentMethods;

  const breakdown = {
    completionRate: scoreCompletionRate(completionRate),
    completedOrders: scoreCompletedOrders(completedOrders),
    priceDeviation: scorePriceDeviation(price, marketAvg),
    paymentMethods: scorePaymentMethods(paymentMethods),
    suspiciousBehavior: scoreSuspiciousBehavior({
      price,
      marketAvg,
      side,
      completionRate,
      completedOrders,
    }),
  };
  const riskScore = Math.min(
    100,
    Object.values(breakdown).reduce((acc, v) => acc + v, 0)
  );
  return {
    riskScore,
    riskLevel: levelFor(riskScore),
    breakdown,
    weights: WEIGHTS,
    deviationPercent: priceDeviationPercent(price, marketAvg),
  };
}

module.exports = { score, levelFor, WEIGHTS };
