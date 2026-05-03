const PAYMENT_RISK = {
  BANK_TRANSFER: 1,
  WIRE_TRANSFER: 1,
  SEPA: 1,
  SWIFT: 1,
  IDRAM: 1,
  INECOBANK: 1,
  ACBA: 1,
  AMERIABANK: 1,
  ARDSHINBANK: 1,
  CONVERSE_BANK: 1,
  EVOCABANK: 1,
  ARCA: 1,
  TELCELL: 2,
  EASYPAY: 2,
  REVOLUT: 2,
  WISE: 2,
  PAYPAL: 2,
  VISA: 2,
  MASTERCARD: 2,
  CARD: 2,
  CASH: 3,
  CASH_IN_PERSON: 3,
  CASH_DEPOSIT: 3,
  WESTERN_UNION: 4,
  MONEYGRAM: 4,
  ZELLE: 3,
  GIFT_CARD: 5,
  AMAZON_GIFT_CARD: 5,
};

function methodRiskLevel(method) {
  if (!method) return 2;
  const norm = String(method).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (PAYMENT_RISK[norm] !== undefined) return PAYMENT_RISK[norm];
  if (norm.includes("GIFT")) return 5;
  if (norm.includes("WESTERN") || norm.includes("MONEYGRAM")) return 4;
  if (norm.includes("CASH")) return 3;
  if (norm.includes("BANK") || norm.includes("TRANSFER") || norm.includes("WIRE") || norm.includes("SEPA")) return 1;
  if (norm.includes("VISA") || norm.includes("MASTER") || norm.includes("CARD")) return 2;
  return 2;
}

module.exports = { methodRiskLevel, PAYMENT_RISK };
