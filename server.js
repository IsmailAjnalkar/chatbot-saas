/**
 * chatbot-saas server — Express + SQLite (node:sqlite), REST + SSE.
 *
 * Public widget API (CORS-open):
 *   GET  /api/config?key=API_KEY            (origin-allowlisted per business)
 *   POST /api/chat            {api_key, session_id?, message, visitor_label?}
 *   POST /api/chat/stream     same body -> Server-Sent Events
 *   POST /api/webhook/orders  X-Webhook-Secret: wh_... + {orders:[...]}  (documented below)
 *
 * Admin API (session-cookie auth, business-scoped): /api/auth/*, /api/admin/*
 */
'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const db = require('./lib/db');
const { processMessage } = require('./lib/bot');
const channels = require('./lib/channels');
const llm = require('./lib/llm');
const { createLimiter } = require('./lib/ratelimit');
const { encryptSecret, encryptionEnabled } = require('./lib/crypto');
const crawl = require('./lib/crawl');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-change-me';

// Behind a reverse proxy / load balancer (the normal production setup),
// trust the first hop so req.ip reflects the real client for rate limiting.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Stripe billing webhook — mounted BEFORE express.json so the signature can be
// verified against the raw body bytes (Stripe requires the exact payload).
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '2mb' }), billingWebhook);

// Shopify order webhook — raw body needed for HMAC verification.
app.post('/api/integrations/shopify/webhook/orders', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const shopify = require('./lib/shopify');
  res.sendStatus(200); // ack immediately; process best-effort below
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    if (!shopify.verifyWebhookHmac(req.body, hmac)) { console.warn('[shopify] webhook HMAC mismatch'); return; }
    const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
    const topic = req.get('X-Shopify-Topic') || '';
    if (!/orders\//.test(topic)) return;
    const shop = await db.getShopByDomain(shopDomain);
    if (!shop) { console.warn('[shopify] order webhook for unknown shop:', shopDomain); return; }
    const payload = JSON.parse(req.body.toString('utf8'));
    const mapped = shopify.mapShopifyOrder(payload);
    if (!mapped.order_number) return;
    await db.upsertOrder(shop.business_id, mapped);
  } catch (err) {
    console.error('[shopify] webhook error:', err.message);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' })); // Twilio posts form-encoded
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));

// CORS for the public widget API (widget is embedded on client sites)
app.use('/api/config', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
app.use('/api/chat', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Same pattern for the other public widget endpoints.
app.use(['/api/feedback', '/api/nudge'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- rate limiting (per-minute, in-memory sliding window) ----------
// Env-overridable; set to 0 to disable a limiter (not recommended in production).
function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
const configLimiter = createLimiter({
  max: envInt('RATE_LIMIT_CONFIG_PER_MIN', 120),
  keyFn: (req) => `cfg:${req.query.key || ''}:${req.ip}`,
});
const chatLimiter = createLimiter({
  max: envInt('RATE_LIMIT_CHAT_PER_MIN', 30),
  keyFn: (req) => `chat:${(req.body && req.body.api_key) || ''}:${req.ip}`,
});
const webhookLimiter = createLimiter({
  max: envInt('RATE_LIMIT_WEBHOOK_PER_MIN', 60),
  keyFn: (req) => `wh:${(req.get('X-Webhook-Secret') || '').slice(0, 16)}:${req.ip}`,
});
const loginLimiter = createLimiter({
  max: envInt('RATE_LIMIT_LOGIN_PER_MIN', 10),
  keyFn: (req) => `login:${req.ip}`,
  message: 'too many login attempts, please try again later',
});
const feedbackLimiter = createLimiter({
  max: envInt('RATE_LIMIT_FEEDBACK_PER_MIN', 30),
  keyFn: (req) => `fb:${(req.body && req.body.api_key) || ''}:${req.ip}`,
});
const nudgeLimiter = createLimiter({
  max: envInt('RATE_LIMIT_NUDGE_PER_MIN', 60),
  keyFn: (req) => `nudge:${req.query.key || ''}:${req.ip}`,
});
// Meta channel webhooks are server-to-server (no secret header); rate limit by IP only.
const channelLimiter = createLimiter({
  max: envInt('RATE_LIMIT_CHANNEL_PER_MIN', 120),
  keyFn: (req) => `chan:${req.ip}`,
});
// Public signup (free trial provisioning); strict to deter bot farms.
const signupLimiter = createLimiter({
  max: envInt('RATE_LIMIT_SIGNUP_PER_MIN', 5),
  keyFn: (req) => `signup:${req.ip}`,
  message: 'too many signups, please try again later',
});

// ---------- origin allowlist for the widget config ----------
// Business setting `allowed_origins`: comma/newline-separated list of origins,
// e.g. "https://shop.example.com, https://www.example.com".
// Supports wildcard subdomains: "https://*.example.com". Empty/unset = allow all
// (fine for dev — set it before going live, see README).
function originAllowed(business, req) {
  const raw = String(business.settings.allowed_origins || '').trim();
  if (!raw) return true;
  const entries = raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  const candidates = [req.get('Origin'), req.get('Referer')].filter(Boolean);
  if (!candidates.length) return false; // allowlist set but no origin info -> deny
  return candidates.some((value) => {
    let url;
    try { url = new URL(value); } catch { return false; }
    const origin = url.origin.toLowerCase();
    const host = url.hostname.toLowerCase();
    return entries.some((entry) => {
      let e = entry.toLowerCase().replace(/\/+$/, '');
      if (e === '*') return true;
      let scheme = url.protocol.replace(':', '');
      if (e.includes('://')) {
        const [s, rest] = e.split('://');
        scheme = s; e = rest;
      }
      if (e.startsWith('*.')) {
        const base = e.slice(2);
        return url.protocol.replace(':', '') === scheme &&
          (host === base || host.endsWith('.' + base));
      }
      return origin === `${scheme}://${e}`;
    });
  });
}

// ---------- public widget config ----------
app.get('/api/config', configLimiter, async (req, res) => {
  const business = await db.getBusinessByKey(req.query.key || '');
  if (!business) return res.status(401).json({ error: 'invalid api key' });
  if (!originAllowed(business, req)) return res.status(403).json({ error: 'origin not allowed for this widget' });
  const s = business.settings;
  res.json({
    business_id: business.id,
    business_name: business.name,
    welcome_message: s.welcome_message || `Hi! I'm the ${business.name} assistant. How can I help you today?`,
    brand_color: s.brand_color || '#4f46e5',
    support_email: s.support_email || '',
    bot_name: s.bot_name || `${business.name} Assistant`,
    default_language: s.default_language || 'en',
    voice_enabled: s.voice_enabled !== false,
  });
});

// Throws {status:401} on bad key; routes below own the single response.
async function handleChat(req) {
  const { api_key, session_id, message, visitor_label } = req.body || {};
  const business = await db.getBusinessByKey(api_key || '');
  if (!business) {
    const err = new Error('invalid api key');
    err.status = 401;
    throw err;
  }
  return processMessage({ business, sessionId: session_id, text: message || '', visitorLabel: visitor_label || '' });
}
function chatError(res, err) {
  if (err && err.status === 401) return res.status(401).json({ error: 'invalid api key' });
  console.error('[chat] error:', err && err.message);
  return res.status(500).json({ error: 'chat failed, please try again' });
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    res.json(await handleChat(req));
  } catch (err) { chatError(res, err); }
});

// SSE streaming: emits {"token": "..."} chunks then {"done": true, "meta": {...}}
app.post('/api/chat/stream', chatLimiter, async (req, res) => {
  let result;
  try {
    result = await handleChat(req);
  } catch (err) { return chatError(res, err); }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const { reply } = result;
  // Stream in word chunks to simulate typing (works for FAQ/LLM/order replies alike)
  const chunks = reply.match(/\S+\s*/g) || [reply];
  let i = 0;
  const timer = setInterval(() => {
    const batch = chunks.slice(i, i + 3).join('');
    i += 3;
    if (batch) res.write(`data: ${JSON.stringify({ token: batch })}\n\n`);
    if (i >= chunks.length) {
      clearInterval(timer);
      const { sessionId, type, confidence, suggestions, orderCard, messageId } = result;
      res.write(`data: ${JSON.stringify({ done: true, meta: { sessionId, type, confidence, suggestions, orderCard, messageId } })}\n\n`);
      res.end();
    }
  }, 35);
  req.on('close', () => clearInterval(timer));
});

// ---------- WhatsApp + Messenger channel webhooks (public, Meta-verified) ----------
// All endpoints respond 200 to Meta even on error (retry storms otherwise).
// Inbound handling is best-effort: errors are logged, never thrown back.
app.get('/api/channels/whatsapp/webhook', channelLimiter, (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!verifyToken || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== verifyToken) {
    return res.sendStatus(403);
  }
  res.status(200).send(req.query['hub.challenge'] || '');
});
app.post('/api/channels/whatsapp/webhook', channelLimiter, async (req, res) => {
  res.sendStatus(200); // ack immediately; process best-effort below
  try {
    for (const entry of (req.body && req.body.entry) || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = (value.metadata && value.metadata.phone_number_id) || '';
        // statuses[] (delivery/read receipts) are intentionally ignored
        for (const msg of value.messages || []) {
          if (!phoneNumberId || msg.type !== 'text' || !(msg.text && msg.text.body)) continue;
          const business = await db.findBusinessBySetting('whatsapp_phone_number_id', phoneNumberId);
          if (!business) { console.warn('[channels] WhatsApp message for unknown phone_number_id'); continue; }
          if (business.settings.whatsapp_enabled === false) continue;
          await channels.handleChannelMessage(business, 'whatsapp', msg.from, msg.text.body);
        }
      }
    }
  } catch (err) {
    console.error('[channels] WhatsApp webhook error:', err.message);
  }
});
app.get('/api/channels/messenger/webhook', channelLimiter, (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN || '';
  if (!verifyToken || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== verifyToken) {
    return res.sendStatus(403);
  }
  res.status(200).send(req.query['hub.challenge'] || '');
});
app.post('/api/channels/messenger/webhook', channelLimiter, async (req, res) => {
  res.sendStatus(200); // ack immediately; process best-effort below
  try {
    for (const entry of (req.body && req.body.entry) || []) {
      for (const m of entry.messaging || []) {
        const psid = m.sender && m.sender.id;
        const text = m.message && m.message.text;
        if (!psid || !text || (m.message && m.message.is_echo)) continue; // skip page's own echoes
        const business = await db.findBusinessBySetting('messenger_page_id', entry.id);
        if (!business) { console.warn('[channels] Messenger message for unknown page id'); continue; }
        if (business.settings.messenger_enabled === false) continue;
        await channels.handleChannelMessage(business, 'messenger', String(psid), text);
      }
    }
  } catch (err) {
    console.error('[channels] Messenger webhook error:', err.message);
  }
});

// ---------- Instagram DM webhooks ----------
// Meta delivers Instagram messaging events to the same app webhook; the
// sender id is the Instagram-scoped ID (IGSID). Connect the Instagram
// business account to the Facebook Page, subscribe the app to the
// `messages` webhook field, and set META_VERIFY_TOKEN / META_INSTAGRAM_TOKEN.
app.get('/api/channels/instagram/webhook', channelLimiter, (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN || '';
  if (!verifyToken || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== verifyToken) {
    return res.sendStatus(403);
  }
  res.status(200).send(req.query['hub.challenge'] || '');
});
app.post('/api/channels/instagram/webhook', channelLimiter, async (req, res) => {
  res.sendStatus(200); // ack immediately; process best-effort below
  try {
    for (const entry of (req.body && req.body.entry) || []) {
      for (const m of entry.messaging || []) {
        const igsid = m.sender && m.sender.id;
        const text = m.message && m.message.text;
        if (!igsid || !text || (m.message && m.message.is_echo)) continue; // skip our own echoes
        const business = await db.findBusinessBySetting('instagram_page_id', entry.id)
          || await db.findBusinessBySetting('messenger_page_id', entry.id);
        if (!business) { console.warn('[channels] Instagram message for unknown page id'); continue; }
        if (business.settings.instagram_enabled === false) continue;
        await channels.handleChannelMessage(business, 'instagram', String(igsid), text);
      }
    }
  } catch (err) {
    console.error('[channels] Instagram webhook error:', err.message);
  }
});

// ---------- inbound email triage ----------
// POST /api/channels/email/inbound  { from, to, subject, text }
// Point SendGrid Inbound Parse / Mailgun Routes / any forwarder at this URL.
// `to` must match the business's `inbound_email` setting (set in admin).
// Protected by EMAIL_INBOUND_SECRET (header X-Inbound-Secret).
app.post('/api/channels/email/inbound', channelLimiter, async (req, res) => {
  const secret = process.env.EMAIL_INBOUND_SECRET || '';
  if (!secret || req.get('X-Inbound-Secret') !== secret) return res.sendStatus(403);
  res.sendStatus(200); // ack immediately; process best-effort below
  try {
    const { from, to, subject, text } = req.body || {};
    const fromAddr = String(from || '').trim();
    const toAddr = String(to || '').trim().toLowerCase();
    const body = String(text || '').trim();
    if (!fromAddr || !toAddr || !body) return;
    if (/mailer-daemon|postmaster|auto-?reply/i.test(fromAddr)) return; // loop protection
    const business = await db.findBusinessBySetting('inbound_email', toAddr);
    if (!business) { console.warn('[channels] email for unknown inbound address'); return; }
    if (business.settings.email_enabled === false) return;
    let session = await db.findSessionByChannel(business.id, 'email', fromAddr);
    if (!session) {
      session = await db.createSession(business.id, fromAddr, { channel: 'email', channelSender: fromAddr });
    }
    const result = await processMessage({ business, sessionId: session.id, text: body, visitorLabel: fromAddr });
    const subj = 'Re: ' + String(subject || '(no subject)').replace(/^Re:\s*/i, '').slice(0, 120);
    await channels.sendEmailText(business, fromAddr, subj, result.reply);
  } catch (err) {
    console.error('[channels] email inbound error:', err.message);
  }
});

// Shopify OAuth callback (public URL registered in the Shopify app settings)
app.get('/api/integrations/shopify/callback', async (req, res) => {
  const shopify = require('./lib/shopify');
  try {
    const saved = req.session && req.session.shopify_oauth;
    if (req.session) delete req.session.shopify_oauth;
    if (!saved || !shopify.verifyQueryHmac(req.query) || req.query.state !== saved.state) {
      return res.status(400).send('Shopify authorization could not be verified. Please retry from the admin panel.');
    }
    const shop = shopify.normalizeShop(req.query.shop);
    if (!shop || shop !== saved.shop) return res.status(400).send('Shop mismatch — please retry.');
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: req.query.code,
      }),
    });
    if (!tokenRes.ok) return res.status(502).send('Could not complete Shopify authorization. Please try again.');
    const { access_token, scope } = await tokenRes.json();
    await db.upsertShop(saved.businessId, shop, shopify.encryptShopToken(access_token), scope || '');
    await shopify.registerOrderWebhook(shop, access_token, `${shopify.appUrl(req)}/api/integrations/shopify/webhook/orders`);
    res.redirect('/admin/#integrations?shopify=connected');
  } catch (err) {
    console.error('[shopify] callback error:', err.message);
    res.status(500).send('Shopify connection failed — please try again.');
  }
});

// ---------- AI phone calls (Twilio Programmable Voice) ----------
// Point a Twilio phone number's voice webhook at /api/voice/twilio/incoming
// (HTTP POST). The caller talks; the bot answers from the same knowledge base.
app.post('/api/voice/twilio/incoming', channelLimiter, async (req, res) => {
  const voice = require('./lib/voice');
  try {
    if (!voice.validTwilioSignature(req)) return res.sendStatus(403);
    const to = String(req.body.To || '').trim();
    const business = to ? await db.findBusinessBySetting('twilio_phone_number', to) : null;
    const base = `${req.protocol}://${req.get('host')}`;
    res.type('text/xml');
    if (!business) {
      return res.send(voice.rejectTwiml('Sorry, this number is not configured for automated support yet. Goodbye.'));
    }
    const name = (business.settings && business.settings.bot_name) || business.name || 'our support assistant';
    const greeting = `Hi, thanks for calling ${business.name}. I'm ${name}. How can I help you today?`;
    res.send(voice.gatherTwiml(greeting, `${base}/api/voice/twilio/respond`));
  } catch (err) {
    console.error('[voice] incoming error:', err.message);
    res.sendStatus(500);
  }
});
app.post('/api/voice/twilio/respond', channelLimiter, async (req, res) => {
  const voice = require('./lib/voice');
  try {
    if (!voice.validTwilioSignature(req)) return res.sendStatus(403);
    const to = String(req.body.To || '').trim();
    const from = String(req.body.From || '').trim();
    const speech = String(req.body.SpeechResult || '').trim();
    const business = to ? await db.findBusinessBySetting('twilio_phone_number', to) : null;
    const base = `${req.protocol}://${req.get('host')}`;
    res.type('text/xml');
    if (!business || !from) {
      return res.send(voice.rejectTwiml('Sorry, something went wrong. Goodbye.'));
    }
    let session = await db.findSessionByChannel(business.id, 'voice', from);
    if (!session) {
      session = await db.createSession(business.id, from, { channel: 'voice', channelSender: from });
    }
    const text = speech || 'hello';
    const result = await processMessage({ business, sessionId: session.id, text, visitorLabel: from });
    // Strip markdown-ish formatting so it reads naturally over the phone.
    const spoken = String(result.reply || '').replace(/[*_`#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 900)
      || 'I had trouble with that. Please try again or ask for a human agent.';
    res.send(voice.sayTwiml(spoken, `${base}/api/voice/twilio/respond`));
  } catch (err) {
    console.error('[voice] respond error:', err.message);
    res.sendStatus(500);
  }
});

// ---------- order webhook (documented interface for real stores) ----------
// POST /api/webhook/orders
//   Headers: X-Webhook-Secret: wh_...   (per-business secret, shown once at
//                                        provision/seed and regenerable in admin)
//   Body: { "orders": [ {order_number, status, eta?, carrier?, tracking_number?, items?} ] }
// Upserts orders so the bot's tracking answers stay live. See README for details.
app.post('/api/webhook/orders', webhookLimiter, async (req, res) => {
  const secret = req.get('X-Webhook-Secret') || (req.body && req.body.webhook_secret) || '';
  const business = await db.getBusinessByWebhookSecret(secret);
  if (!business) return res.status(401).json({ error: 'invalid webhook secret' });
  const { orders } = req.body || {};
  if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders must be an array' });
  const saved = [];
  for (const o of orders.slice(0, 500)) {
    if (!o || !o.order_number || !o.status) continue;
    saved.push(await db.upsertOrder(business.id, {
      order_number: String(o.order_number).toUpperCase(),
      status: String(o.status), eta: o.eta || '', carrier: o.carrier || '',
      tracking_number: o.tracking_number || '', items: o.items || '',
    }));
  }
  res.json({ ok: true, upserted: saved.length });
});

// ---------- Stripe billing (self-serve signup) ----------
// Never crashes when unconfigured: every entry point returns
// 503 { error: 'billing not configured' } if the Stripe keys are absent.
const BILLING_PLANS = {
  starter: { env: 'STRIPE_PRICE_STARTER', setupCents: 50000, label: 'Starter' },
  growth:  { env: 'STRIPE_PRICE_GROWTH',  setupCents: 100000, label: 'Growth' },
  scale:   { env: 'STRIPE_PRICE_SCALE',   setupCents: 250000, label: 'Scale' },
};
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return require('stripe')(key); // lazy: module stays optional when unconfigured
}
function billingConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_PRICE_STARTER &&
    process.env.STRIPE_PRICE_GROWTH &&
    process.env.STRIPE_PRICE_SCALE);
}
app.get('/api/billing/status', (req, res) => {
  res.json({ configured: billingConfigured() });
});
// Create a subscription Checkout Session (recurring plan + one-time setup fee)
// and redirect the visitor to Stripe's hosted page.
app.get('/api/billing/checkout', async (req, res) => {
  const plan = BILLING_PLANS[req.query.plan];
  if (!plan) return res.status(400).json({ error: 'invalid plan (starter|growth|scale)' });
  if (!billingConfigured()) return res.status(503).json({ error: 'billing not configured' });
  const businessName = String(req.query.business_name || '').trim();
  const adminUsername = String(req.query.admin_username || '').trim();
  if (!businessName || !adminUsername)
    return res.status(400).json({ error: 'business_name and admin_username are required' });
  // Trial upgrade: pass business_id to convert an existing trial instead of
  // provisioning a brand-new business.
  const upgradeId = String(req.query.business_id || '').trim();
  try {
    const stripe = getStripe();
    const base = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: process.env[plan.env] },
        {
          price_data: {
            currency: 'usd',
            unit_amount: plan.setupCents,
            product_data: { name: `Setup fee — ${plan.label} plan` },
          },
        },
      ],
      success_url: `${base}/pricing/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/pricing/`,
      metadata: { plan: req.query.plan, business_name: businessName, admin_username: adminUsername, business_id: upgradeId || '' },
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[billing] checkout failed:', err.message);
    res.status(502).json({ error: 'could not create a checkout session' });
  }
});
// Idempotent provisioning from a completed checkout: create the business and
// its first admin, then stash the credentials so success.html can show them once.
async function provisionFromCheckout(s) {
  const existing = await db.getProvision(s.id);
  if (existing) {
    console.log('[billing] session already provisioned, skipping:', s.id);
    return existing;
  }
  // The provisions row is deleted once the success page shows the credentials,
  // so a replayed delivery must also recognize the business we already made.
  if (await db.getBusinessByStripeSession(s.id)) {
    console.log('[billing] session already provisioned (credentials claimed), skipping:', s.id);
    return null;
  }
  const plan = (s.metadata && s.metadata.plan) || 'starter';
  // Trial upgrade: convert the existing trial business instead of creating one.
  const upgradeId = s.metadata && s.metadata.business_id;
  if (upgradeId) {
    const existingBiz = await db.getBusinessById(upgradeId);
    if (existingBiz) {
      const next = { ...(existingBiz.settings || {}), plan,
        stripe_session_id: s.id, stripe_customer_id: s.customer || null,
        stripe_subscription_id: s.subscription || null };
      delete next.trial_ends_at;
      await db.updateBusinessSettings(existingBiz.id, next);
      console.log(`[billing] upgraded trial business "${existingBiz.name}" (${existingBiz.id}) to ${plan}`);
      return { upgraded: true, businessId: existingBiz.id, stripeSessionId: s.id };
    }
  }
  const name = (s.metadata && s.metadata.business_name) || 'New Business';
  const username = (s.metadata && s.metadata.admin_username) ||
    ('admin-' + crypto.randomBytes(3).toString('hex'));
  const business = await db.createBusiness({
    name,
    settings: {
      plan,
      stripe_session_id: s.id,
      stripe_customer_id: s.customer || null,
      stripe_subscription_id: s.subscription || null,
    },
  });
  const password = 'cb-' + crypto.randomBytes(8).toString('hex');
  await db.createAdmin(business.id, username, password);
  console.log(`[billing] provisioned business "${name}" (${business.id}) from session ${s.id}`);
  return db.addProvision({
    stripeSessionId: s.id,
    businessId: business.id,
    adminUsername: username,
    adminPassword: password,
  });
}
async function billingWebhook(req, res) {
  if (!billingConfigured() || !process.env.STRIPE_WEBHOOK_SECRET)
    return res.status(503).json({ error: 'billing not configured' });
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[billing] webhook signature invalid:', err.message);
    return res.status(400).json({ error: 'invalid webhook signature' });
  }
  if (event.type === 'checkout.session.completed') {
    try {
      await provisionFromCheckout(event.data.object);
    } catch (err) {
      console.error('[billing] provisioning failed:', err.message);
      return res.status(500).json({ error: 'provisioning failed, will retry via webhook' });
    }
  }
  res.json({ received: true });
}
// One-time credential handoff for the success page: returns the provisioned
// credentials, then deletes the row so they can never be read again.
app.get('/api/billing/success', async (req, res) => {
  const prov = await db.getProvision(req.query.session_id || '');
  if (!prov) {
    // Trial upgrade: no new credentials were issued; confirm the upgrade.
    const biz = await db.getBusinessByStripeSession(req.query.session_id || '');
    if (biz) return res.json({ upgraded: true, business_name: biz.name, plan: (biz.settings || {}).plan || '', admin_url: `${req.protocol}://${req.get('host')}/admin/` });
    return res.status(404).json({ error: 'no pending credentials for this session' });
  }
  const biz = await db.getBusinessById(prov.business_id);
  await db.deleteProvision(prov.stripe_session_id);
  res.json({
    business_name: biz ? biz.name : '',
    admin_username: prov.admin_username,
    admin_password: prov.admin_password,
    api_key: biz ? biz.api_key : '',
    admin_url: `${req.protocol}://${req.get('host')}/admin/`,
  });
});
// Customer billing portal (admin session required, business-scoped).
// (route defined on the admin router, below)

// ---------- free trial signup ----------
// POST /api/signup {name, email, business_name, website?, plan?}
// Provisions a 14-day trial business + admin login. No card required.
app.post('/api/signup', signupLimiter, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 160);
  const businessName = String((req.body && req.body.business_name) || '').trim().slice(0, 120);
  let website = String((req.body && req.body.website) || '').trim().slice(0, 300);
  const planChoice = ['starter', 'growth', 'scale'].includes(req.body && req.body.plan) ? req.body.plan : 'starter';
  if (!name || !businessName) return res.status(400).json({ error: 'name and business_name are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  if (website) {
    try {
      const u = new URL(website);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
    } catch { return res.status(400).json({ error: 'website URL looks invalid' }); }
  }
  try {
    const business = await db.createBusiness({
      name: businessName,
      settings: {
        plan: 'trial', trial_plan: planChoice, trial_ends_at: Date.now() + 14 * 864e5,
        contact_name: name, contact_email: email, website: website || '',
      },
    });
    const username = 'admin-' + crypto.randomBytes(3).toString('hex');
    const password = 'cb-' + crypto.randomBytes(8).toString('hex');
    await db.createAdmin(business.id, username, password);
    const token = crypto.randomBytes(16).toString('hex');
    await db.addProvision({ stripeSessionId: 'signup:' + token, businessId: business.id, adminUsername: username, adminPassword: password });
    // Seed a starter FAQ and crawl their website in the background so the
    // trial bot knows something on day one.
    db.addFaq(business.id,
      `What does ${businessName} do?`,
      `Thanks for asking! This is a starter answer created during your free trial — replace it in the admin Knowledge Base with what your business actually does.`,
      businessName.toLowerCase()).catch(() => {});
    if (website) {
      (async () => {
        try {
          const pages = await crawl.crawlSite(website, { maxPages: 20 });
          const stored = await crawl.ingestPages(business, pages);
          console.log(`[signup] business ${business.id}: ${pages.length} pages crawled, ${stored} documents stored`);
        } catch (err) { console.error('[signup] crawl failed:', err.message); }
      })();
    }
    console.log(`[signup] trial business "${businessName}" (${business.id}) for ${email}`);
    res.json({ ok: true, token });
  } catch (err) {
    console.error('[signup] failed:', err.message);
    res.status(500).json({ error: 'signup failed, please try again' });
  }
});
// One-time credential handoff for the signup success page.
app.get('/api/signup/success', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token is required' });
  const prov = await db.getProvision('signup:' + token);
  if (!prov) return res.status(404).json({ error: 'no pending credentials for this signup' });
  const biz = await db.getBusinessById(prov.business_id);
  await db.deleteProvision(prov.stripe_session_id);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    business_name: biz ? biz.name : '',
    admin_username: prov.admin_username,
    admin_password: prov.admin_password,
    api_key: biz ? biz.api_key : '',
    admin_url: `${base}/admin/`,
    embed_snippet: `<script src="${base}/widget/widget.js" data-key="${biz ? biz.api_key : ''}" async></script>`,
  });
});

// ---------- public widget endpoints: feedback + nudges ----------
// POST /api/feedback  {api_key, session_id, message_id, rating} — CSAT thumbs vote.
app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  const { api_key, session_id, message_id, rating } = req.body || {};
  const business = await db.getBusinessByKey(api_key || '');
  if (!business) return res.status(401).json({ error: 'invalid api key' });
  if (rating !== 0 && rating !== 1 && rating !== '0' && rating !== '1')
    return res.status(400).json({ error: 'rating must be 0 or 1' });
  const s = await db.getSession(session_id || '');
  if (!s || s.business_id !== business.id) return res.status(404).json({ error: 'session not found' });
  const m = await db.getMessageById(Number(message_id) || 0);
  if (!m || m.session_id !== s.id) return res.status(404).json({ error: 'message not found' });
  await db.addFeedback(business.id, s.id, m.id, Number(rating));
  res.json({ ok: true });
});
// GET /api/nudge?key=&session_id= — fetch + mark-shown pending nudges.
app.get('/api/nudge', nudgeLimiter, async (req, res) => {
  const business = await db.getBusinessByKey(req.query.key || '');
  if (!business) return res.status(401).json({ error: 'invalid api key' });
  const s = await db.getSession(req.query.session_id || '');
  if (!s || s.business_id !== business.id) return res.status(404).json({ error: 'session not found' });
  res.json({ nudges: await db.getPendingNudges(business.id, s.id), human_active: !!s.human_active });
});

// ---------- auth ----------
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await db.findAdmin((username || '').trim());
  if (!admin || !db.verifyPassword(password || '', admin.password_hash)) {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  const business = await db.getBusinessById(admin.business_id);
  req.session.admin = { username: admin.username, business_id: admin.business_id };
  res.json({ ok: true, username: admin.username, business: { id: business.id, name: business.name } });
});
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'not logged in' });
  const business = await db.getBusinessById(req.session.admin.business_id);
  res.json({ username: req.session.admin.username, business: { id: business.id, name: business.name } });
});

function requireAuth(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: 'not logged in' });
  req.businessId = req.session.admin.business_id;
  next();
}
const admin = express.Router();
admin.use(requireAuth);

// FAQs
admin.get('/faqs', async (req, res) => res.json(await db.listFaqs(req.businessId)));
admin.post('/faqs', async (req, res) => {
  const { question, answer, keywords } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
  res.status(201).json(await db.addFaq(req.businessId, question, answer, keywords || ''));
});
admin.put('/faqs/:id', async (req, res) => {
  const { question, answer, keywords } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
  res.json(await db.updateFaq(req.params.id, req.businessId, { question, answer, keywords }));
});
admin.delete('/faqs/:id', async (req, res) => {
  await db.deleteFaq(req.params.id, req.businessId);
  res.json({ ok: true });
});

// Website crawl -> knowledge ingestion (runs in the background)
admin.post('/crawl', async (req, res) => {
  const { url, max_pages } = req.body || {};
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return res.status(400).json({ error: 'invalid URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }
  const maxPages = Math.min(Math.max(parseInt(max_pages, 10) || 20, 1), 100);
  const business = await db.getBusinessById(req.businessId);
  // Background job — not awaited; errors are logged, progress is visible
  // by polling GET /api/admin/documents.
  (async () => {
    try {
      const pages = await crawl.crawlSite(parsed.toString(), { maxPages });
      const stored = await crawl.ingestPages(business, pages);
      console.log(`[crawl] business ${business.id}: ${pages.length} pages crawled, ${stored} documents stored`);
    } catch (err) {
      console.error('[crawl] failed:', err.message);
    }
  })();
  res.json({ ok: true, started: true });
});

// Crawled documents
admin.get('/documents', async (req, res) => res.json(await db.listDocuments(req.businessId)));
admin.delete('/documents/:id', async (req, res) => {
  await db.deleteDocument(req.params.id, req.businessId);
  res.json({ ok: true });
});

// Settings (secrets are never returned in full — see flags below)
// ---------- Shopify OAuth (native app-style install) ----------
// 1. Logged-in admin visits /api/admin/integrations/shopify/install?shop=mystore.myshopify.com
// 2. We redirect to Shopify OAuth; the callback below stores the access token
//    (encrypted) and registers the orders/create webhook.
admin.get('/integrations/shopify/install', async (req, res) => {
  const shopify = require('./lib/shopify');
  if (!shopify.shopifyConfigured()) {
    return res.status(503).json({ error: 'Shopify integration not configured (SHOPIFY_API_KEY / SHOPIFY_API_SECRET).' });
  }
  const shop = shopify.normalizeShop(req.query.shop);
  if (!shop) return res.status(400).json({ error: 'valid ?shop=mystore.myshopify.com required' });
  const state = crypto.randomBytes(16).toString('hex');
  req.session.shopify_oauth = { state, businessId: req.businessId, shop };
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY,
    scope: 'read_orders,read_products',
    redirect_uri: `${shopify.appUrl(req)}/api/integrations/shopify/callback`,
    state,
    'grant_options[]': 'per-user',
  });
  res.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
});
admin.get('/integrations', async (req, res) => {
  const shopify = require('./lib/shopify');
  res.json({
    shopify_configured: shopify.shopifyConfigured(),
    shops: await db.listShops(req.businessId),
    channels: {
      whatsapp: channels.whatsappConfigured(),
      messenger: channels.messengerConfigured(),
      instagram: channels.instagramConfigured(),
      email: channels.emailConfigured(),
    },
  });
});
admin.delete('/integrations/shopify/:id', async (req, res) => {
  await db.deleteShop(req.params.id, req.businessId);
  res.json({ ok: true });
});
admin.get('/settings', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  const s = { ...b.settings };
  const llmKeySet = !!(s.llm_api_key || s.llm_api_key_enc);
  delete s.llm_api_key;
  delete s.llm_api_key_enc;
  const actionSecretSet = !!(s.action_webhook_secret || s.action_webhook_secret_enc);
  delete s.action_webhook_secret;
  delete s.action_webhook_secret_enc;
  const igTokenSet = !!s.instagram_access_token;
  delete s.instagram_access_token;
  res.json({
    name: b.name, ...s,
    llm_api_key_set: llmKeySet,
    llm_encryption_on: encryptionEnabled(),
    action_webhook_secret_set: actionSecretSet,
    instagram_access_token_set: igTokenSet,
    webhook_secret_set: !!b.webhook_secret_hash,
    whatsapp_token_set: channels.whatsappConfigured(),
    messenger_token_set: channels.messengerConfigured(),
  });
});
admin.put('/settings', async (req, res) => {
  const allowed = ['welcome_message', 'brand_color', 'support_email', 'bot_name',
    'lead_capture_enabled', 'llm_enabled', 'llm_base_url', 'llm_model', 'allowed_origins',
    'default_language', 'auto_translate', 'voice_enabled',
    'whatsapp_enabled', 'whatsapp_phone_number_id', 'messenger_enabled', 'messenger_page_id',
    'instagram_enabled', 'instagram_page_id', 'instagram_access_token',
    'email_enabled', 'inbound_email', 'twilio_phone_number',
    'actions_enabled', 'actions', 'refund_auto_approve_limit', 'action_webhook_url'];
  const b = await db.getBusinessById(req.businessId);
  const next = { ...b.settings };
  for (const k of allowed) if (req.body[k] !== undefined) next[k] = req.body[k];
  // LLM API key is stored AES-256-GCM-encrypted, never in plaintext.
  if (req.body.llm_api_key !== undefined) {
    if (req.body.llm_api_key === '') {
      delete next.llm_api_key;
      delete next.llm_api_key_enc;
    } else {
      const enc = encryptSecret(String(req.body.llm_api_key));
      if (!enc) {
        return res.status(400).json({ error: 'ENCRYPTION_KEY is not set on the server — cannot store the LLM API key securely. Set it and retry.' });
      }
      next.llm_api_key_enc = enc;
      delete next.llm_api_key;
    }
  }
  // Action webhook secret (for delegating agentic actions) — same shown-once
  // encrypted pattern as the LLM API key; never returned by GET /settings.
  if (req.body.action_webhook_secret !== undefined) {
    if (req.body.action_webhook_secret === '') {
      delete next.action_webhook_secret;
      delete next.action_webhook_secret_enc;
    } else {
      const enc = encryptSecret(String(req.body.action_webhook_secret));
      if (!enc) {
        return res.status(400).json({ error: 'ENCRYPTION_KEY is not set on the server — cannot store the action webhook secret securely. Set it and retry.' });
      }
      next.action_webhook_secret_enc = enc;
      delete next.action_webhook_secret;
    }
  }
  if (req.body.name) await db.updateBusinessName(req.businessId, req.body.name);
  await db.updateBusinessSettings(req.businessId, next);
  res.json({ ok: true });
});

// Webhook secret management — plaintext is shown ONCE, only here.
admin.get('/webhook', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  res.json({ webhook_secret_set: !!b.webhook_secret_hash });
});
admin.post('/webhook/regenerate', async (req, res) => {
  const secret = await db.regenerateWebhookSecret(req.businessId);
  res.json({
    webhook_secret: secret,
    warning: 'Shown once — copy it now. Your store must send it as the X-Webhook-Secret header to POST /api/webhook/orders.',
  });
});

// Leads (+ CSV export)
function leadsToCsv(leads) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['id', 'created_at', 'kind', 'name', 'email', 'phone', 'note', 'session_id'],
    ...leads.map(l => [l.id, new Date(l.created_at).toISOString(), l.kind, l.name, l.email, l.phone, l.note, l.session_id || ''])];
  return rows.map(r => r.map(esc).join(',')).join('\n');
}
admin.get('/leads', async (req, res) => {
  const leads = await db.listLeads(req.businessId);
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    return res.send(leadsToCsv(leads));
  }
  res.json(leads);
});

// Sessions / transcripts (+ CSV export)
admin.get('/sessions', async (req, res) => {
  const sessions = await db.listSessions(req.businessId, { flaggedOnly: req.query.flagged === '1' });
  if (req.query.format === 'csv') {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['id', 'created_at', 'channel', 'visitor_label', 'language'],
      ...sessions.map(s => [s.id, new Date(s.created_at).toISOString(), s.channel || 'web', s.visitor_label || '', s.language || ''])];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversations.csv"');
    return res.send(rows.map(r => r.map(esc).join(',')).join('\n'));
  }
  res.json(sessions);
});
admin.get('/sessions/:id', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  if (s.unread_admin) await db.updateSession(req.params.id, { unread_admin: 0 }); // agent has seen it
  res.json({ session: s, messages: await db.getHistory(req.params.id, 200) });
});
admin.post('/sessions/:id/resolve', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  await db.updateSession(req.params.id, { flagged_human: 0, resolved: 1, human_active: 0, unread_admin: 0 });
  res.json({ ok: true });
});
// Live-agent takeover: the bot goes silent on this conversation until the
// agent hands it back (or resolves it). The visitor's side is notified via
// the widget nudge poll / next agent reply.
admin.post('/sessions/:id/takeover', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  await db.updateSession(req.params.id, { human_active: 1, unread_admin: 0 });
  await db.logAction(req.businessId, { session_id: req.params.id, action: 'agent_takeover', status: 'completed' });
  res.json({ ok: true });
});
// Hand the conversation back to the bot.
admin.post('/sessions/:id/handback', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  await db.updateSession(req.params.id, { human_active: 0 });
  await db.logAction(req.businessId, { session_id: req.params.id, action: 'agent_handback', status: 'completed' });
  res.json({ ok: true });
});
// Admin reply to a conversation: sends via the channel provider when
// available (WhatsApp/Messenger), otherwise delivers as a widget nudge.
// Always also recorded on the transcript as an assistant message.
admin.post('/sessions/:id/reply', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 2000) return res.status(400).json({ error: 'text must be 2000 characters or less' });
  const business = await db.getBusinessById(req.businessId);
  let delivered_via = 'transcript';
  try {
    if (s.channel === 'whatsapp' && channels.whatsappConfigured()) {
      delivered_via = await channels.sendWhatsAppText(business, s.channel_sender, text) ? 'whatsapp' : 'transcript';
    } else if (s.channel === 'messenger' && channels.messengerConfigured()) {
      delivered_via = await channels.sendMessengerText(business, s.channel_sender, text) ? 'messenger' : 'transcript';
    } else {
      await db.addNudge(req.businessId, s.id, text);
      delivered_via = 'nudge';
    }
  } catch (err) {
    console.error('[admin] session reply send failed:', err.message);
  }
  await db.addMessage(s.id, 'assistant', text, { type: 'admin_reply' });
  // Replying from the inbox takes the conversation over: the bot stays
  // silent until the agent hands it back or resolves it.
  await db.updateSession(s.id, { human_active: 1, unread_admin: 0 });
  res.json({ ok: true, delivered_via });
});

// Orders (mock store management)
admin.get('/orders', async (req, res) => res.json(await db.listOrders(req.businessId)));
admin.post('/orders', async (req, res) => {
  const { order_number, status, eta, carrier, tracking_number, items } = req.body || {};
  if (!order_number || !status) return res.status(400).json({ error: 'order_number and status required' });
  res.status(201).json(await db.upsertOrder(req.businessId, {
    order_number: String(order_number).toUpperCase(), status, eta, carrier, tracking_number, items,
  }));
});
admin.delete('/orders/:id', async (req, res) => {
  await db.deleteOrder(req.params.id, req.businessId);
  res.json({ ok: true });
});

// Analytics
// Account: plan + trial status for the admin banner / upgrade CTA.
admin.get('/account', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  const s = (b && b.settings) || {};
  const trialEnds = s.trial_ends_at || 0;
  res.json({
    business_name: b ? b.name : '',
    plan: s.plan || 'starter',
    trial: s.plan === 'trial',
    trial_ends_at: trialEnds,
    trial_plan: s.trial_plan || null,
    trial_days_left: s.plan === 'trial' ? Math.max(0, Math.ceil((trialEnds - Date.now()) / 864e5)) : null,
    billing_configured: billingConfigured(),
  });
});

admin.get('/analytics', async (req, res) => {
  const biz = req.businessId;
  res.json({
    chats_per_day: await db.chatsPerDay(biz, 14),
    top_unanswered: await db.topUnanswered(biz, 10),
    leads_30d: await db.leadCount(biz, 30),
    resolution: await db.resolutionStats(biz, 30),
    csat: await db.feedbackStats(biz, 14),
    funnel: await db.funnelStats(biz, 30),
    channels: await db.channelStats(biz, 30),
    ai_usage: await llm.getAiUsageSummary({ id: biz, settings: (await db.getBusinessById(biz)).settings }),
  });
});

// Platform AI usage detail (metered messages/tokens vs plan cap).
admin.get('/ai-usage', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  res.json(await llm.getAiUsageSummary(b));
});

// Proactive messaging (nudges)
admin.post('/nudges', async (req, res) => {
  const { text, target } = req.body || {};
  const clean = String(text || '').trim();
  if (!clean) return res.status(400).json({ error: 'text is required' });
  if (clean.length > 500) return res.status(400).json({ error: 'text must be 500 characters or less' });
  let sessions;
  if (!target || target === 'active') {
    sessions = await db.recentlyActiveSessions(req.businessId, 15);
  } else {
    const s = await db.getSession(String(target));
    if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'session not found' });
    sessions = [s];
  }
  for (const s of sessions) await db.addNudge(req.businessId, s.id, clean);
  res.json({ ok: true, sent: sessions.length });
});
admin.get('/nudges', async (req, res) => {
  res.json(await db.listNudges(req.businessId, 50));
});

// Agentic actions audit log
admin.get('/actions', async (req, res) => {
  res.json(await db.listActions(req.businessId, 100));
});

// Stripe billing portal for the logged-in business (self-serve plan management).
admin.post('/billing/portal', async (req, res) => {
  if (!billingConfigured()) return res.status(503).json({ error: 'billing not configured' });
  const b = await db.getBusinessById(req.businessId);
  const customer = b.settings && b.settings.stripe_customer_id;
  if (!customer) return res.status(400).json({ error: 'no Stripe customer on file for this business' });
  try {
    const portal = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${req.protocol}://${req.get('host')}/admin/`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('[billing] portal failed:', err.message);
    res.status(502).json({ error: 'could not open the billing portal' });
  }
});

// API key (public widget key — safe to display; it's embedded in client sites)
admin.get('/api-key', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  res.json({ api_key: b.api_key });
});

// Change own password
admin.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const adminRow = await db.findAdmin(req.session.admin.username);
  if (!adminRow || !db.verifyPassword(current_password || '', adminRow.password_hash))
    return res.status(401).json({ error: 'current password incorrect' });
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'new password must be at least 8 characters' });
  await db.updateAdminPassword(adminRow.id, new_password);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------- health check (for hosting platforms) ----------
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    await db.ping();
    dbOk = true;
  } catch {}
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, time: new Date().toISOString() });
});

// ---------- static frontends ----------
app.use('/widget', express.static(path.join(__dirname, 'public', 'widget')));
app.use('/demo', express.static(path.join(__dirname, 'public', 'demo')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/pricing', express.static(path.join(__dirname, 'public', 'pricing')));
app.use('/security', express.static(path.join(__dirname, 'public', 'security')));
app.use('/signup', express.static(path.join(__dirname, 'public', 'signup')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`chatbot-saas listening on http://localhost:${PORT}`);
  console.log(`  demo:   http://localhost:${PORT}/demo/`);
  console.log(`  admin:  http://localhost:${PORT}/admin/`);
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ENCRYPTION_KEY) console.warn('[security] ENCRYPTION_KEY is not set — per-business LLM API keys cannot be stored encrypted.');
    if (SESSION_SECRET === 'dev-change-me') console.warn('[security] SESSION_SECRET is still the default — set a long random value.');
  }
  try {
    db.countBusinesses().then((n) => {
      if (!n) console.log('  (no businesses yet — run `npm run seed` to create the demo business)');
    }).catch(() => {});
  } catch {}
});
