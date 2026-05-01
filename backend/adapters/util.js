const MIN_FIAT_LIMIT = 100;

function sanitizeOrders(orders) {
  return orders.filter((o) => {
    if (!o) return false;
    if (!Number.isFinite(o.price) || o.price <= 0) return false;
    if (!Number.isFinite(o.max) || o.max < MIN_FIAT_LIMIT) return false;
    if (!o.merchant || typeof o.merchant !== "string") return false;
    return true;
  });
}

module.exports = { sanitizeOrders, MIN_FIAT_LIMIT };
