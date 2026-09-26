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
};
