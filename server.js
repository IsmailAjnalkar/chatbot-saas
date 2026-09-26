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

app.use(express.json({ limit: '1mb' }));
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
      metadata: { plan: req.query.plan, business_name: businessName, admin_username: adminUsername },
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
  if (!prov) return res.status(404).json({ error: 'no pending credentials for this session' });
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
  res.json({ nudges: await db.getPendingNudges(business.id, s.id) });
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
admin.get('/settings', async (req, res) => {
  const b = await db.getBusinessById(req.businessId);
  const s = { ...b.settings };
  const llmKeySet = !!(s.llm_api_key || s.llm_api_key_enc);
  delete s.llm_api_key;
  delete s.llm_api_key_enc;
  res.json({
    name: b.name, ...s,
    llm_api_key_set: llmKeySet,
    llm_encryption_on: encryptionEnabled(),
    webhook_secret_set: !!b.webhook_secret_hash,
  });
});
admin.put('/settings', async (req, res) => {
  const allowed = ['welcome_message', 'brand_color', 'support_email', 'bot_name',
    'lead_capture_enabled', 'llm_enabled', 'llm_base_url', 'llm_model', 'allowed_origins',
    'default_language', 'auto_translate', 'voice_enabled'];
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

// Sessions / transcripts
admin.get('/sessions', async (req, res) => {
  res.json(await db.listSessions(req.businessId, { flaggedOnly: req.query.flagged === '1' }));
});
admin.get('/sessions/:id', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  res.json({ session: s, messages: await db.getHistory(req.params.id, 200) });
});
admin.post('/sessions/:id/resolve', async (req, res) => {
  const s = await db.getSession(req.params.id);
  if (!s || s.business_id !== req.businessId) return res.status(404).json({ error: 'not found' });
  await db.updateSession(req.params.id, { flagged_human: 0, resolved: 1 });
  res.json({ ok: true });
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
admin.get('/analytics', async (req, res) => {
  const biz = req.businessId;
  res.json({
    chats_per_day: await db.chatsPerDay(biz, 14),
    top_unanswered: await db.topUnanswered(biz, 10),
    leads_30d: await db.leadCount(biz, 30),
    resolution: await db.resolutionStats(biz, 30),
    csat: await db.feedbackStats(biz, 14),
    funnel: await db.funnelStats(biz, 30),
  });
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
app.get('/', (req, res) => res.redirect('/demo/'));

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
