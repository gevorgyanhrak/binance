const express = require("express");
const { score } = require("./engine");
const { methodRiskLevel } = require("./payment");
const {
  getRecord,
  setManualRating,
  setProfile,
  listAll,
  removeUser,
  renameUser,
  computeVerdict,
} = require("./reputation");
const { analyze } = require("./aiAnalyze");

const router = express.Router();

router.post("/risk/score", (req, res) => {
  const {
    completionRate,
    completedOrders,
    price,
    marketAvg,
    paymentMethods,
    side,
  } = req.body || {};
  if (price === undefined || marketAvg === undefined) {
    return res
      .status(400)
      .json({ ok: false, error: "price and marketAvg required" });
  }
  const result = score({
    completionRate,
    completedOrders,
    price,
    marketAvg,
    paymentMethods,
    side,
  });
  res.json({ ok: true, ...result });
});

router.post("/risk/batch", (req, res) => {
  const { ads, marketAvg, side } = req.body || {};
  if (!Array.isArray(ads) || !Number.isFinite(Number(marketAvg))) {
    return res
      .status(400)
      .json({ ok: false, error: "ads[] and numeric marketAvg required" });
  }
  const results = ads.map((ad) => ({
    ad,
    risk: score({
      completionRate: ad.completionRate,
      completedOrders: ad.completedOrders,
      price: ad.price,
      marketAvg,
      paymentMethods: ad.paymentMethods,
      side,
    }),
  }));
  res.json({ ok: true, marketAvg: Number(marketAvg), side, results });
});

router.get("/risk/payment-method/:method", (req, res) => {
  const level = methodRiskLevel(req.params.method);
  res.json({ method: req.params.method, level });
});

router.get("/risk/user/:username", (req, res) => {
  const rec = getRecord(req.params.username);
  const verdict = computeVerdict(rec);
  res.json({
    username: req.params.username,
    record: rec,
    ...verdict,
  });
});

router.post("/risk/user/flag", (req, res) => {
  const { username, rating, notes, exchange } = req.body || {};
  try {
    const rec = setManualRating({ username, rating, notes, exchange });
    res.json({ ok: true, record: rec, ...computeVerdict(rec) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post("/risk/user/profile", (req, res) => {
  const { username, stats, exchange, notes } = req.body || {};
  try {
    const rec = setProfile({ username, stats, exchange, notes });
    res.json({ ok: true, record: rec, ...computeVerdict(rec) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete("/risk/user/:username", (req, res) => {
  const ok = removeUser(req.params.username);
  if (!ok) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true });
});

router.post("/risk/user/rename", (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) {
    return res.status(400).json({ ok: false, error: "from and to required" });
  }
  try {
    const rec = renameUser(from, to);
    res.json({ ok: true, record: rec });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get("/risk/users", (req, res) => {
  res.json({
    users: listAll().map((rec) => ({ ...rec, verdict: computeVerdict(rec) })),
  });
});

router.post("/risk/user/analyze", async (req, res) => {
  const { username, lang } = req.body || {};
  const rec = getRecord(username);
  if (!rec) {
    return res.status(404).json({ ok: false, error: "user not found" });
  }
  const verdict = computeVerdict(rec);
  try {
    const ai = await analyze({ record: rec, verdict, lang });
    res.json({ ok: true, username, ruleVerdict: verdict, ai });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
