/**
 * Outgoing webhooks — event fan-out to customer endpoints (Zapier/Make/custom).
 *
 * Businesses register endpoints in Admin -> Integrations -> Outgoing webhooks.
 * Each endpoint picks event names (empty = all). Every delivery is signed:
 *   X-Webhook-Event:     <event name>
 *   X-Webhook-Timestamp:  <unix ms>
 *   X-Webhook-Signature:  hex(HMAC-SHA256(secret, timestamp + "." + rawBody))
 * Body: { event, business_id, occurred_at, data }.
 *
 * Delivery is fire-and-forget with one retry (5s timeout each). Failures are
 * logged, never thrown — a dead endpoint must not break chat.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');

const WEBHOOK_EVENTS = [
  'conversation.started',
  'message.received',
  'message.sent',
  'handoff.requested',
  'ticket.created',
  'ticket.updated',
  'lead.captured',
  'action.executed',
];

function signPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

async function deliver(endpoint, event, payload) {
  const body = JSON.stringify({
    event,
    business_id: payload.business_id,
    occurred_at: new Date().toISOString(),
    data: payload.data || {},
  });
  const timestamp = String(Date.now());
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': event,
    'X-Webhook-Timestamp': timestamp,
    'User-Agent': 'chatbot-saas-webhooks/1.0',
  };
  if (endpoint.secret) headers['X-Webhook-Signature'] = signPayload(endpoint.secret, timestamp, body);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(endpoint.url, { method: 'POST', headers, body, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      if (attempt === 1) console.warn(`[webhooks] delivery failed event=${event} url=${endpoint.url}: ${err.message}`);
    }
  }
  return false;
}

/**
 * Emit an event to every active endpoint of the business subscribed to it.
 * Never throws.
 */
async function emit(businessId, event, data = {}) {
  try {
    if (!WEBHOOK_EVENTS.includes(event)) {
      console.warn(`[webhooks] unknown event: ${event}`);
      return;
    }
    const endpoints = await db.listActiveWebhookEndpoints(businessId);
    const targets = endpoints.filter((e) => {
      let events = [];
      try { events = JSON.parse(e.events || '[]'); } catch {}
      return events.length === 0 || events.includes(event);
    });
    if (!targets.length) return;
    const payload = { business_id: businessId, data };
    await Promise.all(targets.map((e) => deliver(e, event, payload)));
  } catch (err) {
    console.warn('[webhooks] emit failed:', err.message);
  }
}

module.exports = { emit, signPayload, WEBHOOK_EVENTS };
