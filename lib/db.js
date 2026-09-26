/**
 * Database layer — dual dialect:
 *   - SQLite via Node's built-in node:sqlite (zero native deps), file at
 *     ./data/chatbot.db (or DB_PATH env), WAL mode.
 *   - Postgres via the pure-JS `pg` driver when DATABASE_URL is set.
 *
 * Same exported API in both modes; every function is async (returns a Promise).
 * SQL is written once in portable form (? placeholders, INTEGER 0/1 booleans);
 * a tiny converter rewrites placeholders to $1, $2, … for Postgres.
 *
 * The module connects and runs schema + migrations on first require; every
 * exported function awaits that init before touching the database.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decryptSecret, newWebhookSecret, webhookSecretHash } = require('./crypto');

const USE_PG = !!process.env.DATABASE_URL;

let sqliteDb = null;
let pool = null;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (err) => console.error('[db] pg pool error:', err.message));
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqliteDb = new DatabaseSync(DB_PATH);
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA foreign_keys = ON;');
}

// ---------- portable query helpers ----------
/** Rewrite ? placeholders to $1, $2, … for Postgres. (Our SQL never has ? in string literals.) */
function pgify(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}
/** COUNT(*) comes back as a string (int8) from pg — cast to int so callers always get numbers. */
function cnt() {
  return USE_PG ? 'COUNT(*)::int' : 'COUNT(*)';
}
async function all(sql, params = []) {
  if (USE_PG) {
    const res = await pool.query(pgify(sql), params);
    return res.rows;
  }
  return sqliteDb.prepare(sql).all(...params);
}
async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}
async function run(sql, params = []) {
  if (USE_PG) {
    await pool.query(pgify(sql), params);
    return;
  }
  sqliteDb.prepare(sql).run(...params);
}
/** INSERT a row, return its new id. */
async function insertGetId(sql, params = []) {
  if (USE_PG) {
    const res = await pool.query(pgify(sql) + ' RETURNING id', params);
    return res.rows[0].id;
  }
  const r = sqliteDb.prepare(sql).run(...params);
  return Number(r.lastInsertRowid);
}

// ---------- schema (one definition, per-dialect primary keys) ----------
function autoPk() { return USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'; }
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
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS faqs (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  question TEXT,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id ${autoPk()},
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
  language TEXT,
  created_at INTEGER NOT NULL,
  flagged_human INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  capture_state TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id ${autoPk()},
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  kind TEXT NOT NULL DEFAULT 'text', -- 'text' | 'order_card'
  text TEXT NOT NULL,
  meta TEXT,                       -- JSON: {type:'faq'|'llm'|'fallback'|'order'|'capture'|'document', confidence, faq_id, document_id}
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id ${autoPk()},
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
CREATE INDEX IF NOT EXISTS idx_docs_biz ON documents(business_id);
`;

async function hasColumn(table, column) {
  if (USE_PG) {
    const res = await pool.query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      [table, column]);
    return res.rows.length > 0;
  }
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  return cols.includes(column);
}

// Migrations for databases created before a column existed.
const MIGRATIONS = [
  ['businesses', 'webhook_secret_hash', 'ALTER TABLE businesses ADD COLUMN webhook_secret_hash TEXT'],
  ['sessions', 'language', 'ALTER TABLE sessions ADD COLUMN language TEXT'],
];

async function init() {
  if (USE_PG) {
    await pool.query(SCHEMA);
  } else {
    sqliteDb.exec(SCHEMA);
  }
  for (const [table, column, ddl] of MIGRATIONS) {
    try {
      if (!(await hasColumn(table, column))) await run(ddl);
    } catch (e) {
      console.warn(`[db] migration ${table}.${column} failed:`, e.message);
    }
  }
  console.log(`[db] using ${USE_PG ? 'Postgres' : 'SQLite'}`);
}
const ready = init().catch((err) => {
  console.error('[db] init failed:', err.message);
  process.exit(1);
});
/** Wrap an exported function so it waits for schema/migrations first. */
function withReady(fn) {
  return async (...args) => { await ready; return fn(...args); };
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
async function getBusinessByKey(apiKey) {
  const row = await one('SELECT * FROM businesses WHERE api_key = ?', [apiKey]);
  return row ? decorateBusiness(row) : null;
}
async function getBusinessById(id) {
  const row = await one('SELECT * FROM businesses WHERE id = ?', [id]);
  return row ? decorateBusiness(row) : null;
}
/** Look up a business by its order-webhook secret (sent as X-Webhook-Secret). */
async function getBusinessByWebhookSecret(secret) {
  if (!secret) return null;
  const row = await one('SELECT * FROM businesses WHERE webhook_secret_hash = ?', [webhookSecretHash(secret)]);
  return row ? decorateBusiness(row) : null;
}
/** Generate a new webhook secret for a business. Returns the plaintext (shown once). */
async function regenerateWebhookSecret(businessId) {
  const secret = newWebhookSecret();
  await run('UPDATE businesses SET webhook_secret_hash = ? WHERE id = ?',
    [webhookSecretHash(secret), businessId]);
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
async function createBusiness({ id, name, settings }) {
  const apiKey = `cb_${crypto.randomBytes(24).toString('hex')}`;
  const webhookSecret = newWebhookSecret(); // plaintext shown ONCE to the caller, only the hash is stored
  const businessId = id || newId('biz');
  await run('INSERT INTO businesses (id, api_key, webhook_secret_hash, name, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [businessId, apiKey, webhookSecretHash(webhookSecret), name, JSON.stringify(settings || {}), now()]);
  const biz = await getBusinessById(businessId);
  biz.webhook_secret = webhookSecret;
  return biz;
}
async function updateBusinessSettings(businessId, settings) {
  await run('UPDATE businesses SET settings = ? WHERE id = ?', [JSON.stringify(settings), businessId]);
}
/** Rename a business (admin settings). */
async function updateBusinessName(id, name) {
  await run('UPDATE businesses SET name = ? WHERE id = ?', [name, id]);
}
async function countBusinesses() {
  const row = await one(`SELECT ${cnt()} AS c FROM businesses`);
  return row.c;
}

// ---------- admins ----------
async function createAdmin(businessId, username, password) {
  await run('INSERT INTO admins (business_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [businessId, username, hashPassword(password), now()]);
}
async function findAdmin(username) {
  return await one('SELECT * FROM admins WHERE username = ?', [username]);
}
/** Rotate an admin's password (takes a plaintext password, hashes it). */
async function updateAdminPassword(adminId, newPassword) {
  await run('UPDATE admins SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), adminId]);
}

// ---------- FAQs ----------
async function listFaqs(businessId) {
  return all('SELECT * FROM faqs WHERE business_id = ? ORDER BY id', [businessId]);
}
async function addFaq(businessId, question, answer, keywords = '') {
  const id = await insertGetId(
    'INSERT INTO faqs (business_id, question, answer, keywords, created_at) VALUES (?, ?, ?, ?, ?)',
    [businessId, question, answer, keywords, now()]);
  return one('SELECT * FROM faqs WHERE id = ?', [id]);
}
async function updateFaq(id, businessId, { question, answer, keywords }) {
  await run('UPDATE faqs SET question = ?, answer = ?, keywords = ? WHERE id = ? AND business_id = ?',
    [question, answer, keywords || '', id, businessId]);
  return one('SELECT * FROM faqs WHERE id = ?', [id]);
}
async function deleteFaq(id, businessId) {
  await run('DELETE FROM faqs WHERE id = ? AND business_id = ?', [id, businessId]);
}

// ---------- crawled documents (website knowledge ingestion) ----------
async function addDocument({ businessId, sourceUrl, title, question, answer }) {
  const id = await insertGetId(
    'INSERT INTO documents (business_id, source_url, title, question, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [businessId, sourceUrl || '', title || '', question || null, answer, now()]);
  return one('SELECT * FROM documents WHERE id = ?', [id]);
}
async function listDocuments(businessId) {
  return all('SELECT * FROM documents WHERE business_id = ? ORDER BY id', [businessId]);
}
async function deleteDocument(id, businessId) {
  await run('DELETE FROM documents WHERE id = ? AND business_id = ?', [id, businessId]);
}
/** Remove everything previously imported from one URL (re-crawl replaces it). */
async function clearDocumentsByUrl(businessId, url) {
  await run('DELETE FROM documents WHERE business_id = ? AND source_url = ?', [businessId, url]);
}

// ---------- orders (mock store + webhook target) ----------
async function listOrders(businessId) {
  return all('SELECT * FROM orders WHERE business_id = ? ORDER BY id', [businessId]);
}
async function findOrder(businessId, orderNumber) {
  return await one('SELECT * FROM orders WHERE business_id = ? AND UPPER(order_number) = UPPER(?)',
    [businessId, orderNumber]);
}
async function upsertOrder(businessId, { order_number, status, eta, carrier, tracking_number, items }) {
  const existing = await findOrder(businessId, order_number);
  if (existing) {
    await run('UPDATE orders SET status = ?, eta = ?, carrier = ?, tracking_number = ?, items = ? WHERE id = ?',
      [status, eta || '', carrier || '', tracking_number || '', items || '', existing.id]);
    return one('SELECT * FROM orders WHERE id = ?', [existing.id]);
  }
  const id = await insertGetId(
    'INSERT INTO orders (business_id, order_number, status, eta, carrier, tracking_number, items) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, order_number, status, eta || '', carrier || '', tracking_number || '', items || '']);
  return one('SELECT * FROM orders WHERE id = ?', [id]);
}
async function deleteOrder(id, businessId) {
  await run('DELETE FROM orders WHERE id = ? AND business_id = ?', [id, businessId]);
}

// ---------- sessions & messages ----------
async function getSession(sessionId) {
  return await one('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}
async function createSession(businessId, visitorLabel = '') {
  const id = newId('sess');
  await run('INSERT INTO sessions (id, business_id, visitor_label, created_at) VALUES (?, ?, ?, ?)',
    [id, businessId, visitorLabel, now()]);
  return getSession(id);
}
async function updateSession(id, patch) {
  const s = await getSession(id);
  if (!s) return null;
  const cs = patch.capture_state === undefined
    ? s.capture_state // keep existing raw DB value (already JSON or null)
    : (patch.capture_state == null ? null : JSON.stringify(patch.capture_state));
  await run(`UPDATE sessions SET visitor_label = ?, flagged_human = ?, resolved = ?, capture_state = ?, language = ? WHERE id = ?`,
    [patch.visitor_label ?? s.visitor_label,
      patch.flagged_human !== undefined ? (patch.flagged_human ? 1 : 0) : s.flagged_human,
      patch.resolved !== undefined ? (patch.resolved ? 1 : 0) : s.resolved,
      cs,
      patch.language !== undefined ? patch.language : s.language,
      id]);
  return getSession(id);
}
async function addMessage(sessionId, role, text, meta = null, kind = 'text') {
  await run('INSERT INTO messages (session_id, role, kind, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, role, kind, text, meta ? JSON.stringify(meta) : null, now()]);
}
async function getHistory(sessionId, limit = 30) {
  const rows = await all(
    'SELECT role, text, kind, meta, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    [sessionId, limit]);
  return rows.reverse();
}
async function listSessions(businessId, { flaggedOnly = false, limit = 100 } = {}) {
  const q = flaggedOnly
    ? 'SELECT * FROM sessions WHERE business_id = ? AND flagged_human = 1 ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM sessions WHERE business_id = ? ORDER BY created_at DESC LIMIT ?';
  return all(q, [businessId, limit]);
}
async function countMessages(sessionId, role) {
  const row = await one(`SELECT ${cnt()} AS c FROM messages WHERE session_id = ? AND role = ?`, [sessionId, role]);
  return row.c;
}

// ---------- leads ----------
async function addLead(businessId, { session_id, name, email, phone, kind, note }) {
  const id = await insertGetId(
    'INSERT INTO leads (business_id, session_id, name, email, phone, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [businessId, session_id || null, name || '', email || '', phone || '', kind || 'lead', note || '', now()]);
  return one('SELECT * FROM leads WHERE id = ?', [id]);
}
async function listLeads(businessId, limit = 500) {
  return all('SELECT * FROM leads WHERE business_id = ? ORDER BY created_at DESC LIMIT ?', [businessId, limit]);
}

// ---------- analytics ----------
async function chatsPerDay(businessId, days = 14) {
  const since = now() - days * 86400000;
  const dayExpr = USE_PG
    ? `TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD')`
    : `date(created_at / 1000, 'unixepoch')`;
  return all(`
    SELECT ${dayExpr} AS day, ${cnt()} AS chats
    FROM sessions WHERE business_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day`, [businessId, since]);
}
async function topUnanswered(businessId, limit = 10) {
  // user questions that were answered with a fallback ("text" is quoted: a type name in pg)
  return all(`
    SELECT u."text" AS question, ${cnt()} AS times, MAX(u.created_at) AS last_seen
    FROM messages u
    JOIN messages a ON a.session_id = u.session_id AND a.id = (
      SELECT MIN(id) FROM messages m2 WHERE m2.session_id = u.session_id AND m2.id > u.id AND m2.role = 'assistant'
    )
    JOIN sessions s ON s.id = u.session_id
    WHERE s.business_id = ? AND u.role = 'user'
      AND a.meta LIKE '%"type":"fallback"%'
    GROUP BY u."text" ORDER BY times DESC LIMIT ?`, [businessId, limit]);
}
async function leadCount(businessId, days = 30) {
  const since = now() - days * 86400000;
  const row = await one(`SELECT ${cnt()} AS c FROM leads WHERE business_id = ? AND created_at >= ?`, [businessId, since]);
  return row.c;
}
async function resolutionStats(businessId, days = 30) {
  const since = now() - days * 86400000;
  const total = (await one(`SELECT ${cnt()} AS c FROM sessions WHERE business_id = ? AND created_at >= ?`, [businessId, since])).c;
  // "resolved" = not flagged for human AND last assistant message was not a fallback
  const resolved = (await one(`
    SELECT ${cnt()} AS c FROM sessions s
    WHERE s.business_id = ? AND s.created_at >= ? AND s.flagged_human = 0
      AND EXISTS (
        SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant'
          AND (m.meta IS NULL OR m.meta NOT LIKE '%"type":"fallback"%')
          AND m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id)
      )`, [businessId, since])).c;
  return { total, resolved, resolution_rate: total ? Math.round((resolved / total) * 100) : 0 };
}

/** Lightweight liveness check for /api/health. */
async function ping() {
  await one('SELECT 1');
  return true;
}

module.exports = {
  hashPassword, verifyPassword, newId, ping,
  getBusinessByKey: withReady(getBusinessByKey),
  getBusinessById: withReady(getBusinessById),
  getBusinessByWebhookSecret: withReady(getBusinessByWebhookSecret),
  regenerateWebhookSecret: withReady(regenerateWebhookSecret),
  createBusiness: withReady(createBusiness),
  updateBusinessSettings: withReady(updateBusinessSettings),
  updateBusinessName: withReady(updateBusinessName),
  countBusinesses: withReady(countBusinesses),
  createAdmin: withReady(createAdmin),
  findAdmin: withReady(findAdmin),
  updateAdminPassword: withReady(updateAdminPassword),
  listFaqs: withReady(listFaqs),
  addFaq: withReady(addFaq),
  updateFaq: withReady(updateFaq),
  deleteFaq: withReady(deleteFaq),
  addDocument: withReady(addDocument),
  listDocuments: withReady(listDocuments),
  deleteDocument: withReady(deleteDocument),
  clearDocumentsByUrl: withReady(clearDocumentsByUrl),
  listOrders: withReady(listOrders),
  findOrder: withReady(findOrder),
  upsertOrder: withReady(upsertOrder),
  deleteOrder: withReady(deleteOrder),
  getSession: withReady(getSession),
  createSession: withReady(createSession),
  updateSession: withReady(updateSession),
  addMessage: withReady(addMessage),
  getHistory: withReady(getHistory),
  listSessions: withReady(listSessions),
  countMessages: withReady(countMessages),
  addLead: withReady(addLead),
  listLeads: withReady(listLeads),
  chatsPerDay: withReady(chatsPerDay),
  topUnanswered: withReady(topUnanswered),
  leadCount: withReady(leadCount),
  resolutionStats: withReady(resolutionStats),
};
