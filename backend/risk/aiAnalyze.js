const axios = require("axios");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function buildPrompt(record, verdict, lang) {
  const stats = record?.stats || {};
  const fmt = (k) => (stats[k] === null || stats[k] === undefined ? "n/a" : stats[k]);
  const profile = `
Username: ${record?.username || "n/a"}
Total orders: ${fmt("totalOrders")}
Successful orders: ${fmt("successfulOrders")}
Cancelled orders: ${fmt("cancelledOrders")}
Positive feedback: ${fmt("positiveFeedback")}
Negative feedback: ${fmt("negativeFeedback")}
Star rating: ${fmt("stars")}
Manual flag from operator: ${record?.manualRating || "none"}
Operator notes: ${record?.notes || "none"}
Rule-based verdict: ${verdict.verdict} (score ${verdict.score})
Rule reasons: ${(verdict.reasons || []).join(" | ") || "none"}
`.trim();

  const langLine =
    lang === "ru"
      ? "Respond in Russian."
      : "Respond in English.";

  return `You are a P2P trading risk assistant. Decide if the counterparty below is safe to trade with on a crypto P2P exchange (USDT/AMD). Use ONLY the public trading signals provided — never imply you have access to identity or KYC data. ${langLine}

PROFILE:
${profile}

Respond with strict JSON ONLY (no markdown), with exactly these keys:
{
  "verdict": "good" | "neutral" | "bad",
  "confidence": "low" | "medium" | "high",
  "summary": "1-2 sentence verdict for the operator",
  "reasons": ["short bullet 1", "short bullet 2", "..."],
  "advice": "1 short sentence of actionable advice"
}`;
}

async function analyze({ record, verdict, lang }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const prompt = buildPrompt(record, verdict, lang);

  if (!apiKey) {
    return fallback(record, verdict, lang);
  }

  try {
    const resp = await axios.post(
      ANTHROPIC_URL,
      {
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 20000,
      }
    );
    const text =
      resp.data?.content?.[0]?.text || resp.data?.content?.[0]?.value || "";
    const parsed = safeParseJson(text);
    if (parsed && parsed.verdict) {
      return { ...parsed, source: "claude", model: MODEL };
    }
    return { ...fallback(record, verdict, lang), source: "fallback-bad-json" };
  } catch (err) {
    return {
      ...fallback(record, verdict, lang),
      source: "fallback-error",
      error: err.response?.data?.error?.message || err.message,
    };
  }
}

function safeParseJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function fallback(record, verdict, lang) {
  const reasons = verdict?.reasons || [];
  const stats = record?.stats || {};
  const adviceMap = {
    good: lang === "ru" ? "Можно торговать как обычно." : "Safe to trade normally.",
    neutral:
      lang === "ru"
        ? "Уменьшите объём, требуйте оплату до релиза."
        : "Trade smaller amounts; require payment confirmation before release.",
    bad:
      lang === "ru"
        ? "Не открывайте сделку или отмените, если уже открыта."
        : "Do not trade — cancel if an order is already open.",
  };
  const summaryMap = {
    good:
      lang === "ru"
        ? "Сигналы выглядят надёжно."
        : "Signals look healthy and consistent.",
    neutral:
      lang === "ru"
        ? "Смешанные сигналы — действуйте осторожно."
        : "Mixed signals — proceed with caution.",
    bad:
      lang === "ru"
        ? "Высокий риск по публичным сигналам."
        : "High risk based on public signals.",
  };
  return {
    verdict: verdict?.verdict || "unknown",
    confidence: stats.totalOrders >= 100 ? "high" : stats.totalOrders >= 20 ? "medium" : "low",
    summary: summaryMap[verdict?.verdict] || "Not enough data.",
    reasons: reasons.length ? reasons : ["No history yet"],
    advice: adviceMap[verdict?.verdict] || (lang === "ru" ? "Соберите больше данных." : "Gather more data first."),
    source: "fallback-rule-based",
  };
}

module.exports = { analyze };
