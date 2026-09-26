/**
 * Shopify integration — OAuth install + order webhooks.
 *
 * Env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL (public base URL).
 * Without them every route explains the integration is not configured.
 *
 * Install flow:
 *   1. Merchant (logged into admin) visits /api/integrations/shopify/install?shop=mystore.myshopify.com
 *   2. We redirect to Shopify OAuth; on callback we store the access token
 *      (encrypted at rest) and register the orders/create webhook.
 *   3. Order webhooks POST here and are upserted into the orders table,
 *      so the bot's tracking/cancel/refund answers stay live automatically.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const { encryptSecret, decryptSecret } = require('./crypto');

const API_VERSION = '2024-10';

function shopifyConfigured() {
  return !!(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
}

function appUrl(req) {
  return (process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/** Verify a Shopify webhook HMAC (raw body required — see server.js). */
function verifyWebhookHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET || '';
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify an OAuth callback HMAC. */
function verifyQueryHmac(query) {
  const secret = process.env.SHOPIFY_API_SECRET || '';
  const { hmac, signature, ...rest } = query;
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmac)));
}

function normalizeShop(shop) {
  const s = String(shop || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return '';
  return s;
}

/** Register the orders/create webhook on the shop (best-effort). */
async function registerOrderWebhook(shopDomain, accessToken, callbackUrl) {
  try {
    const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/webhooks.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        webhook: { topic: 'orders/create', address: callbackUrl, format: 'json' },
      }),
    });
    if (!res.ok) console.warn('[shopify] webhook register failed:', res.status, (await res.text()).slice(0, 120));
  } catch (err) {
    console.warn('[shopify] webhook register error:', err.message);
  }
}

/** Map a Shopify order payload to our orders-table shape. */
function mapShopifyOrder(o) {
  return {
    order_number: String(o.order_number || o.name || '').replace(/^#/, '').toUpperCase(),
    status: o.financial_status === 'paid' ? 'paid' : String(o.financial_status || o.fulfillment_status || 'pending'),
    eta: '',
    carrier: '',
    tracking_number: '',
    items: (o.line_items || []).map(li => `${li.quantity}x ${li.title}`).join(', ').slice(0, 500),
  };
}

/* ---------------- Live Admin API (real order actions) ---------------- */

/** Low-level Admin API call. Returns { ok, status, data } — never throws on HTTP errors. */
async function shopifyApi(shopDomain, accessToken, method, path, body = undefined) {
  const url = `https://${shopDomain}/admin/api/${API_VERSION}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

/** Find a live order by name/number (e.g. "1005" or "#1005"). Returns the order object or null. */
async function findShopifyOrderByName(shopDomain, accessToken, orderNumber) {
  const name = `#${String(orderNumber).replace(/^#/, '').trim()}`;
  const r = await shopifyApi(shopDomain, accessToken, 'GET',
    `/orders.json?name=${encodeURIComponent(name)}&status=any&limit=5`);
  if (!r.ok || !r.data || !Array.isArray(r.data.orders)) return null;
  return r.data.orders[0] || null;
}

/** Cancel a live order. Returns { ok, error? }. */
async function cancelShopifyOrder(shopDomain, accessToken, orderId) {
  const r = await shopifyApi(shopDomain, accessToken, 'POST', `/orders/${orderId}/cancel.json`);
  if (!r.ok) {
    const msg = (r.data && (r.data.errors || r.data.error)) || `HTTP ${r.status}`;
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200) };
  }
  return { ok: true };
}

/**
 * Create a full refund for a live order (restocks line items).
 * Fetches transactions first if the order payload doesn't carry them.
 * Returns { ok, error? }.
 */
async function refundShopifyOrder(shopDomain, accessToken, order) {
  let transactions = order.transactions || [];
  if (!transactions.length && order.id) {
    const t = await shopifyApi(shopDomain, accessToken, 'GET', `/orders/${order.id}/transactions.json`);
    if (t.ok && t.data && Array.isArray(t.data.transactions)) transactions = t.data.transactions;
  }
  const lineItems = (order.line_items || []).map((li) => ({
    line_item_id: li.id,
    quantity: li.quantity,
    restock: true,
  }));
  const refundTransactions = transactions
    .filter((t) => t.kind === 'sale' && t.status === 'success')
    .map((t) => ({ parent_id: t.id, amount: t.amount, kind: 'refund', gateway: t.gateway }));
  const body = {
    refund: {
      currency: order.currency,
      notify: true,
      note: 'Refund issued via chatbot',
      ...(lineItems.length ? { refund_line_items: lineItems } : {}),
      ...(refundTransactions.length ? { transactions: refundTransactions } : {}),
    },
  };
  const r = await shopifyApi(shopDomain, accessToken, 'POST', '/refunds.json', body);
  if (!r.ok) {
    const msg = (r.data && (r.data.errors || r.data.error)) || `HTTP ${r.status}`;
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200) };
  }
  return { ok: true };
}

/** Fetch live fulfillment/tracking summary for an order. */
async function getShopifyFulfillmentSummary(shopDomain, accessToken, orderId) {
  const r = await shopifyApi(shopDomain, accessToken, 'GET',
    `/orders/${orderId}/fulfillments.json?limit=5`);
  if (!r.ok || !r.data || !Array.isArray(r.data.fulfillments) || !r.data.fulfillments.length) return null;
  const f = r.data.fulfillments[0];
  return {
    status: f.status || '',
    tracking_number: (f.tracking_numbers || [])[0] || f.tracking_number || '',
    tracking_url: (f.tracking_urls || [])[0] || f.tracking_url || '',
    carrier: f.tracking_company || '',
  };
}

/**
 * Resolve the connected shop for a business (first installed shop).
 * Returns { shopDomain, accessToken } or null.
 */
async function getConnectedShop(businessId) {
  const shops = await db.listShops(businessId);
  if (!shops.length) return null;
  const full = await db.getShopByDomain(shops[0].shop_domain);
  if (!full || !full.access_token_enc) return null;
  const token = decryptSecret(full.access_token_enc);
  if (!token) return null;
  return { shopDomain: full.shop_domain, accessToken: token };
}

module.exports = {
  shopifyConfigured,
  appUrl,
  verifyWebhookHmac,
  verifyQueryHmac,
  normalizeShop,
  registerOrderWebhook,
  mapShopifyOrder,
  API_VERSION,
  getShopToken: (shopRow) => decryptSecret(shopRow.access_token_enc || ''),
  encryptShopToken: (token) => encryptSecret(token),
  // Live Admin API
  shopifyApi,
  findShopifyOrderByName,
  cancelShopifyOrder,
  refundShopifyOrder,
  getShopifyFulfillmentSummary,
  getConnectedShop,
};
