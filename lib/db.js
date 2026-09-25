/**
 * Database layer — SQLite via Node's built-in node:sqlite (zero native deps).
 * Synchronous API, WAL mode, file at ./data/chatbot.db (or DB_PATH env).
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decryptSecret, newWebhookSecret, webhookSecretHash } = require('./crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  api_key TEXT UNIQUE NOT NULL,
  webhook_secret_hash TEXT,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  status TEXT NOT NULL,
  eta TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '',
  UNIQUE(business_id, order_number)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  visitor_label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  flagged_human INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  capture_state TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  kind TEXT NOT NULL DEFAULT 'text', -- 'text' | 'order_card'
  text TEXT NOT NULL,
  meta TEXT,                       -- JSON: {type:'faq'|'llm'|'fallback'|'order'|'capture', confidence, faq_id}
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'lead', -- 'lead' | 'callback'
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_leads_biz ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_biz ON sessions(business_id);
`;
db.exec(SCHEMA);

// Migration for databases created before the webhook-secret column existed.
try {
  const cols = db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
  if (!cols.includes('webhook_secret_hash')) {
    db.exec('ALTER TABLE businesses ADD COLUMN webhook_secret_hash TEXT');
  }
} catch (e) {
  console.warn('[db] webhook_secret_hash migration check failed:', e.message);
}

// ---------- password hashing (scrypt, no native deps) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  try {
    const [algo, salt, derived] = stored.split(':');
    if (algo !== 'scrypt') return false;
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(derived, 'hex'));
  } catch { return false; }
}

function now() { return Date.now(); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }

// ---------- businesses ----------
function getBusinessByKey(apiKey) {
  const row = db.prepare('SELECT * FROM businesses WHERE api_key = ?').get(apiKey);
  return row ? decorateBusiness(row) : null;
}
function getBusinessById(id) {
  const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
  return row ? decorateBusiness(row) : null;
}
/** Look up a business by its order-webhook secret (sent as X-Webhook-Secret). */
function getBusinessByWebhookSecret(secret) {
  if (!secret) return null;
  const row = db.prepare('SELECT * FROM businesses WHERE webhook_secret_hash = ?').get(webhookSecretHash(secret));
  return row ? decorateBusiness(row) : null;
}
/** Generate a new webhook secret for a business. Returns the plaintext (shown once). */
function regenerateWebhookSecret(businessId) {
  const secret = newWebhookSecret();
  db.prepare('UPDATE businesses SET webhook_secret_hash = ? WHERE id = ?')
    .run(webhookSecretHash(secret), businessId);
  return secret;
}
let decryptWarned = false;
function decorateBusiness(row) {
  let settings = {};
  try { settings = JSON.parse(row.settings || '{}'); } catch {}
  // Decrypt a stored LLM API key into memory only — it is never written back
  // to the DB in plaintext. Falls back to a legacy plaintext value (if any).
  if (settings.llm_api_key_enc) {
    const plain = decryptSecret(settings.llm_api_key_enc);
    if (plain) {
      settings.llm_api_key = plain;
    } else if (!decryptWarned) {
      decryptWarned = true;
      console.warn('[security] ENCRYPTION_KEY is missing or does not match — stored LLM API keys cannot be decrypted; LLM fallback stays disabled until it is set.');
    }
  }
  return { ...row, settings };
}
function createBusiness({ id, name, settings }) {
  const apiKey = `cb_${crypto.randomBytes(24).toString('hex')}`;
  const webhookSecret = newWebhookSecret(); // plaintext shown ONCE to the caller, only the hash is stored
  const businessId = id || newId('biz');
  db.prepare('INSERT INTO businesses (id, api_key, webhook_secret_hash, name, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(businessId, apiKey, webhookSecretHash(webhookSecret), name, JSON.stringify(settings || {}), now());
  const biz = getBusinessById(businessId);
  biz.webhook_secret = webhookSecret;
  return biz;
}
function updateBusinessSettings(businessId, settings) {
  db.prepare('UPDATE businesses SET settings = ? WHERE id = ?').run(JSON.stringify(settings), businessId);
}

// ---------- admins ----------
function createAdmin(businessId, username, password) {
  db.prepare('INSERT INTO admins (business_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(businessId, username, hashPassword(password), now());
}
function findAdmin(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username) || null;
}

// ---------- FAQs ----------
function listFaqs(businessId) {
  return db.prepare('SELECT * FROM faqs WHERE business_id = ? ORDER BY id').all(businessId);
}
function addFaq(businessId, question, answer, keywords = '') {
  const r = db.prepare('INSERT INTO faqs (business_id, question, answer, keywords, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(businessId, question, answer, keywords, now());
  return db.prepare('SELECT * FROM faqs WHERE id = ?').get(r.lastInsertRowid);
}
function updateFaq(id, businessId, { question, answer, keywords }) {
  db.prepare('UPDATE faqs SET question = ?, answer = ?, keywords = ? WHERE id = ? AND business_id = ?')
    .run(question, answer, keywords || '', id, businessId);
  return db.prepare('SELECT * FROM faqs WHERE id = ?').get(id);
}
function deleteFaq(id, businessId) {
  db.prepare('DELETE FROM faqs WHERE id = ? AND business_id = ?').run(id, businessId);
}

// ---------- orders (mock store + webhook target) ----------
function listOrders(businessId) {
  return db.prepare('SELECT * FROM orders WHERE business_id = ? ORDER BY id').all(businessId);
}
function findOrder(businessId, orderNumber) {
  return db.prepare('SELECT * FROM orders WHERE business_id = ? AND UPPER(order_number) = UPPER(?)')
    .get(businessId, orderNumber) || null;
}
function upsertOrder(businessId, { order_number, status, eta, carrier, tracking_number, items }) {
  const existing = findOrder(businessId, order_number);
  if (existing) {
    db.prepare('UPDATE orders SET status = ?, eta = ?, carrier = ?, tracking_number = ?, items = ? WHERE id = ?')
      .run(status, eta || '', carrier || '', tracking_number || '', items || '', existing.id);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(existing.id);
  }
  const r = db.prepare(
    'INSERT INTO orders (business_id, order_number, status, eta, carrier, tracking_number, items) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(businessId, order_number, status, eta || '', carrier || '', tracking_number || '', items || '');
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
}
function deleteOrder(id, businessId) {
  db.prepare('DELETE FROM orders WHERE id = ? AND business_id = ?').run(id, businessId);
}

// ---------- sessions & messages ----------
function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) || null;
}
function createSession(businessId, visitorLabel = '') {
  const id = newId('sess');
  db.prepare('INSERT INTO sessions (id, business_id, visitor_label, created_at) VALUES (?, ?, ?, ?)')
    .run(id, businessId, visitorLabel, now());
  return getSession(id);
}
function updateSession(id, patch) {
  const s = getSession(id);
  if (!s) return null;
  const cs = patch.capture_state === undefined
    ? s.capture_state // keep existing raw DB value (already JSON or null)
    : (patch.capture_state == null ? null : JSON.stringify(patch.capture_state));
  db.prepare(`UPDATE sessions SET visitor_label = ?, flagged_human = ?, resolved = ?, capture_state = ? WHERE id = ?`)
    .run(patch.visitor_label ?? s.visitor_label,
      patch.flagged_human !== undefined ? (patch.flagged_human ? 1 : 0) : s.flagged_human,
      patch.resolved !== undefined ? (patch.resolved ? 1 : 0) : s.resolved,
      cs, id);
  return getSession(id);
}
function addMessage(sessionId, role, text, meta = null, kind = 'text') {
  db.prepare('INSERT INTO messages (session_id, role, kind, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, role, kind, text, meta ? JSON.stringify(meta) : null, now());
}
function getHistory(sessionId, limit = 30) {
  return db.prepare('SELECT role, text, kind, meta, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, limit).reverse();
}
function listSessions(businessId, { flaggedOnly = false, limit = 100 } = {}) {
  const q = flaggedOnly
    ? 'SELECT * FROM sessions WHERE business_id = ? AND flagged_human = 1 ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM sessions WHERE business_id = ? ORDER BY created_at DESC LIMIT ?';
  return db.prepare(q).all(businessId, limit);
}
function countMessages(sessionId, role) {
  return db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = ?').get(sessionId, role).c;
}

// ---------- leads ----------
function addLead(businessId, { session_id, name, email, phone, kind, note }) {
  const r = db.prepare(
    'INSERT INTO leads (business_id, session_id, name, email, phone, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(businessId, session_id || null, name || '', email || '', phone || '', kind || 'lead', note || '', now());
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(r.lastInsertRowid);
}
function listLeads(businessId, limit = 500) {
  return db.prepare('SELECT * FROM leads WHERE business_id = ? ORDER BY created_at DESC LIMIT ?').all(businessId, limit);
}

// ---------- analytics ----------
function chatsPerDay(businessId, days = 14) {
  const since = now() - days * 86400000;
  return db.prepare(`
    SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS chats
    FROM sessions WHERE business_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day`).all(businessId, since);
}
function topUnanswered(businessId, limit = 10) {
  // user questions that were answered with a fallback
  return db.prepare(`
    SELECT u.text AS question, COUNT(*) AS times, MAX(u.created_at) AS last_seen
    FROM messages u
    JOIN messages a ON a.session_id = u.session_id AND a.id = (
      SELECT MIN(id) FROM messages m2 WHERE m2.session_id = u.session_id AND m2.id > u.id AND m2.role = 'assistant'
    )
    JOIN sessions s ON s.id = u.session_id
    WHERE s.business_id = ? AND u.role = 'user'
      AND a.meta LIKE '%"type":"fallback"%'
    GROUP BY u.text ORDER BY times DESC LIMIT ?`).all(businessId, limit);
}
function leadCount(businessId, days = 30) {
  const since = now() - days * 86400000;
  return db.prepare('SELECT COUNT(*) AS c FROM leads WHERE business_id = ? AND created_at >= ?').get(businessId, since).c;
}
function resolutionStats(businessId, days = 30) {
  const since = now() - days * 86400000;
  const total = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE business_id = ? AND created_at >= ?').get(businessId, since).c;
  // "resolved" = not flagged for human AND last assistant message was not a fallback
  const resolved = db.prepare(`
    SELECT COUNT(*) AS c FROM sessions s
    WHERE s.business_id = ? AND s.created_at >= ? AND s.flagged_human = 0
      AND EXISTS (
        SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant'
          AND (m.meta IS NULL OR m.meta NOT LIKE '%"type":"fallback"%')
          AND m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id)
      )`).get(businessId, since).c;
  return { total, resolved, resolution_rate: total ? Math.round((resolved / total) * 100) : 0 };
}

module.exports = {
  db, hashPassword, verifyPassword, newId,
  getBusinessByKey, getBusinessById, getBusinessByWebhookSecret, regenerateWebhookSecret,
  createBusiness, updateBusinessSettings,
  createAdmin, findAdmin,
  listFaqs, addFaq, updateFaq, deleteFaq,
  listOrders, findOrder, upsertOrder, deleteOrder,
  getSession, createSession, updateSession, addMessage, getHistory, listSessions, countMessages,
  addLead, listLeads,
  chatsPerDay, topUnanswered, leadCount, resolutionStats,
};
