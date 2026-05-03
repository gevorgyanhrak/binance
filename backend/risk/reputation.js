const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "reputation.json");
const HISTORY_MAX = 20;
const VALID_RATINGS = ["good", "bad", "neutral"];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb() {
  if (!fs.existsSync(FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    for (const key of Object.keys(parsed)) {
      const rec = parsed[key];
      if (typeof rec.rating === "string" && !rec.manualRating) {
        rec.manualRating = rec.rating;
        delete rec.rating;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

const db = loadDb();

function persist() {
  fs.writeFile(FILE, JSON.stringify(db, null, 2), () => {});
}

function normalize(u) {
  return String(u || "").trim().toLowerCase();
}

function ensureRecord(username) {
  const key = normalize(username);
  if (!key) return null;
  if (!db[key]) {
    db[key] = {
      username: key,
      manualRating: null,
      notes: "",
      stats: null,
      exchange: null,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return db[key];
}

function getRecord(username) {
  const key = normalize(username);
  if (!key) return null;
  return db[key] || null;
}

function setManualRating({ username, rating, notes, exchange }) {
  const key = normalize(username);
  if (!key) throw new Error("username required");
  if (!VALID_RATINGS.includes(rating)) {
    throw new Error("rating must be good|bad|neutral");
  }
  const rec = ensureRecord(key);
  rec.manualRating = rating;
  if (notes != null) rec.notes = String(notes);
  if (exchange) rec.exchange = exchange;
  rec.updatedAt = Date.now();
  rec.history = [
    { kind: "flag", rating, notes: notes || "", exchange: exchange || null, at: Date.now() },
    ...(rec.history || []),
  ].slice(0, HISTORY_MAX);
  persist();
  return rec;
}

function setProfile({ username, stats, exchange, notes }) {
  const key = normalize(username);
  if (!key) throw new Error("username required");
  if (!stats || typeof stats !== "object") {
    throw new Error("stats object required");
  }
  const rec = ensureRecord(key);
  const cleanStats = {
    totalOrders: numberOrNull(stats.totalOrders),
    successfulOrders: numberOrNull(stats.successfulOrders),
    cancelledOrders: numberOrNull(stats.cancelledOrders),
    positiveFeedback: numberOrNull(stats.positiveFeedback),
    negativeFeedback: numberOrNull(stats.negativeFeedback),
    stars: numberOrNull(stats.stars),
  };
  rec.stats = cleanStats;
  if (exchange) rec.exchange = exchange;
  if (notes != null) rec.notes = String(notes);
  rec.updatedAt = Date.now();
  rec.history = [
    { kind: "profile", stats: cleanStats, at: Date.now() },
    ...(rec.history || []),
  ].slice(0, HISTORY_MAX);
  persist();
  return rec;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function listAll() {
  return Object.values(db).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

function renameUser(oldUsername, newUsername) {
  const oldKey = normalize(oldUsername);
  const newKey = normalize(newUsername);
  if (!oldKey || !newKey) throw new Error("usernames required");
  if (oldKey === newKey) return db[oldKey] || null;
  const oldRec = db[oldKey];
  const newRec = db[newKey];
  if (!oldRec && !newRec) return null;
  if (!oldRec) return newRec;
  if (newRec) {
    // merge: prefer newer manualRating, accumulate history
    newRec.manualRating = oldRec.manualRating || newRec.manualRating;
    newRec.notes = newRec.notes || oldRec.notes;
    newRec.stats = newRec.stats || oldRec.stats;
    newRec.exchange = newRec.exchange || oldRec.exchange;
    newRec.history = [
      ...(newRec.history || []),
      ...(oldRec.history || []),
    ]
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, HISTORY_MAX);
    newRec.updatedAt = Date.now();
    delete db[oldKey];
    persist();
    return newRec;
  }
  oldRec.username = newKey;
  oldRec.history = [
    {
      kind: "rename",
      from: oldKey,
      to: newKey,
      at: Date.now(),
    },
    ...(oldRec.history || []),
  ].slice(0, HISTORY_MAX);
  oldRec.updatedAt = Date.now();
  db[newKey] = oldRec;
  delete db[oldKey];
  persist();
  return oldRec;
}

function removeUser(username) {
  const key = normalize(username);
  if (!key || !db[key]) return false;
  delete db[key];
  persist();
  return true;
}

function computeVerdict(record) {
  if (!record) {
    return {
      verdict: "unknown",
      score: null,
      reasons: ["No history with this user"],
    };
  }

  const reasons = [];
  let score = 0;
  const stats = record.stats || {};
  const total = stats.totalOrders ?? 0;
  const success = stats.successfulOrders ?? 0;
  const cancelled = stats.cancelledOrders ?? 0;
  const pos = stats.positiveFeedback ?? 0;
  const neg = stats.negativeFeedback ?? 0;
  const stars = stats.stars;

  const completionDenom = success + cancelled;
  if (completionDenom > 0) {
    const completion = success / completionDenom;
    if (completion < 0.7) {
      score += 32;
      reasons.push(`Low completion ${(completion * 100).toFixed(0)}%`);
    } else if (completion < 0.85) {
      score += 18;
      reasons.push(`Borderline completion ${(completion * 100).toFixed(0)}%`);
    } else if (completion < 0.95) {
      score += 8;
    } else {
      reasons.push(`Strong completion ${(completion * 100).toFixed(0)}%`);
    }
  } else if (record.stats) {
    score += 12;
    reasons.push("No success/cancel data");
  }

  const fbDenom = pos + neg;
  if (fbDenom > 0) {
    const ratio = pos / fbDenom;
    if (ratio < 0.6) {
      score += 25;
      reasons.push(
        `Heavy negative feedback (${neg} neg / ${pos} pos)`
      );
    } else if (ratio < 0.85) {
      score += 12;
      reasons.push(`Mixed feedback (${neg} neg / ${pos} pos)`);
    } else if (ratio >= 0.95 && fbDenom >= 20) {
      reasons.push(`Excellent feedback (${pos} pos / ${neg} neg)`);
    }
  }

  if (record.stats) {
    if (total < 5) {
      score += 28;
      reasons.push("Very new account (<5 orders)");
    } else if (total < 20) {
      score += 15;
      reasons.push("Limited history (<20 orders)");
    } else if (total < 100) {
      score += 5;
    } else if (total >= 1000) {
      reasons.push("High-volume merchant (1000+ orders)");
    }
  }

  if (Number.isFinite(stars)) {
    if (stars < 3) {
      score += 20;
      reasons.push(`Low rating ${stars.toFixed(1)}★`);
    } else if (stars < 4) {
      score += 10;
      reasons.push(`Average rating ${stars.toFixed(1)}★`);
    } else if (stars >= 4.7) {
      reasons.push(`Top rating ${stars.toFixed(1)}★`);
    }
  }

  let verdict;
  if (score <= 20) verdict = "good";
  else if (score <= 55) verdict = "neutral";
  else verdict = "bad";

  if (record.manualRating === "good") {
    return {
      verdict: "good",
      score: Math.max(0, score - 30),
      reasons: ["Manually flagged trusted", ...reasons],
      manualOverride: true,
      autoVerdict: verdict,
      autoScore: Math.min(100, score),
    };
  }
  if (record.manualRating === "bad") {
    return {
      verdict: "bad",
      score: Math.min(100, score + 40),
      reasons: ["Manually flagged risky", ...reasons],
      manualOverride: true,
      autoVerdict: verdict,
      autoScore: Math.min(100, score),
    };
  }
  if (record.manualRating === "neutral") {
    return {
      verdict: "neutral",
      score: Math.min(100, score + 10),
      reasons: ["Manually flagged caution", ...reasons],
      manualOverride: true,
      autoVerdict: verdict,
      autoScore: Math.min(100, score),
    };
  }

  return {
    verdict,
    score: Math.min(100, score),
    reasons: reasons.length ? reasons : ["Looks normal so far"],
    manualOverride: false,
  };
}

module.exports = {
  getRecord,
  setManualRating,
  setProfile,
  listAll,
  removeUser,
  renameUser,
  computeVerdict,
};
