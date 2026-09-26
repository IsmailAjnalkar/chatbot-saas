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
  const pg = require('pg');
  // BIGINT (int8, OID 20) comes back as a string by default; our BIGINT columns
  // are millisecond timestamps and row ids, all safely within Number range.
  pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
/** Millisecond timestamps overflow PG's 32-bit INTEGER; SQLite INTEGER is 64-bit. */
function tsType() { return USE_PG ? 'BIGINT' : 'INTEGER'; }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  api_key TEXT UNIQUE NOT NULL,
  webhook_secret_hash TEXT,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at ${tsType()} NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at ${tsType()} NOT NULL
);
CREATE TABLE IF NOT EXISTS faqs (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  created_at ${tsType()} NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  question TEXT,
  answer TEXT NOT NULL,
  created_at ${tsType()} NOT NULL
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
  channel TEXT NOT NULL DEFAULT 'web',     -- 'web' | 'whatsapp' | 'messenger'
  channel_sender TEXT NOT NULL DEFAULT '', -- phone number (WhatsApp) or PSID (Messenger)
  created_at ${tsType()} NOT NULL,
  flagged_human INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  human_active INTEGER NOT NULL DEFAULT 0,   -- live agent has taken over; bot stays silent
  handoff_summary TEXT NOT NULL DEFAULT '', -- context summary shown to the agent on takeover
  unread_admin INTEGER NOT NULL DEFAULT 0,  -- visitor wrote while flagged/in takeover; agent hasn't seen it
  capture_state TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id ${autoPk()},
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  kind TEXT NOT NULL DEFAULT 'text', -- 'text' | 'order_card'
  text TEXT NOT NULL,
  meta TEXT,                       -- JSON: {type:'faq'|'llm'|'fallback'|'order'|'capture'|'document', confidence, faq_id, document_id}
  created_at ${tsType()} NOT NULL
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
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_leads_biz ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_biz ON sessions(business_id);
CREATE INDEX IF NOT EXISTS idx_docs_biz ON documents(business_id);
CREATE TABLE IF NOT EXISTS feedback (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating IN (0, 1)),
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_biz ON feedback(business_id);
CREATE TABLE IF NOT EXISTS nudges (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  shown INTEGER NOT NULL DEFAULT 0,
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nudges_biz ON nudges(business_id);
CREATE TABLE IF NOT EXISTS provisions (
  id ${autoPk()},
  stripe_session_id TEXT UNIQUE NOT NULL,
  business_id TEXT NOT NULL,
  admin_username TEXT NOT NULL,
  admin_password TEXT NOT NULL,
  created_at ${tsType()} NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_usage (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, month)
);
CREATE TABLE IF NOT EXISTS action_log (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT,
  action TEXT NOT NULL,     -- 'get_order_status' | 'cancel_order' | 'issue_refund' | 'escalate_to_human'
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,     -- 'completed' | 'pending_approval' | 'delegated' | 'denied' | 'failed'
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_biz ON action_log(business_id);
CREATE TABLE IF NOT EXISTS shops (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shop_domain TEXT NOT NULL UNIQUE,
  access_token_enc TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  installed_at ${tsType()} NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  ticket_number TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',       -- open | pending | resolved | closed
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  assignee TEXT NOT NULL DEFAULT '',
  created_at ${tsType()} NOT NULL,
  updated_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_biz ON tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(business_id, status);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',  -- JSON array of event names; [] = all events
  secret_enc TEXT NOT NULL DEFAULT '', -- encrypted HMAC signing secret
  active INTEGER NOT NULL DEFAULT 1,
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_biz ON webhook_endpoints(business_id);
CREATE TABLE IF NOT EXISTS qa_runs (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '[]',   -- JSON: [{message, expect_contains}]
  results TEXT NOT NULL DEFAULT '[]',  -- JSON: [{message, reply, pass, expect_contains}]
  passed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_runs_biz ON qa_runs(business_id);
CREATE TABLE IF NOT EXISTS ab_tests (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT '',     -- when to show: 'welcome' | 'exit_intent' | 'idle_30s'
  variant_a TEXT NOT NULL DEFAULT '',
  variant_b TEXT NOT NULL DEFAULT '',
  split INTEGER NOT NULL DEFAULT 50,    -- % of traffic to variant B (0-100)
  status TEXT NOT NULL DEFAULT 'running', -- running | paused | done
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ab_tests_biz ON ab_tests(business_id);
CREATE TABLE IF NOT EXISTS articles (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',        -- markdown
  source TEXT NOT NULL DEFAULT '',      -- e.g. 'faq:12,faq:15' or 'auto'
  published INTEGER NOT NULL DEFAULT 0,
  created_at ${tsType()} NOT NULL,
  updated_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_biz ON articles(business_id);
CREATE TABLE IF NOT EXISTS email_verifications (
  id ${autoPk()},
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  expires_at ${tsType()} NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at ${tsType()} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emailverif_hash ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_emailverif_biz ON email_verifications(business_id);
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
  ['sessions', 'channel', "ALTER TABLE sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web'"],
  ['sessions', 'channel_sender', "ALTER TABLE sessions ADD COLUMN channel_sender TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'human_active', 'ALTER TABLE sessions ADD COLUMN human_active INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'handoff_summary', "ALTER TABLE sessions ADD COLUMN handoff_summary TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'unread_admin', 'ALTER TABLE sessions ADD COLUMN unread_admin INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'is_test', 'ALTER TABLE sessions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'sentiment', 'ALTER TABLE sessions ADD COLUMN sentiment REAL NOT NULL DEFAULT 0'],
  ['nudges', 'ab_test_id', 'ALTER TABLE nudges ADD COLUMN ab_test_id INTEGER NOT NULL DEFAULT 0'],
  ['nudges', 'variant', "ALTER TABLE nudges ADD COLUMN variant TEXT NOT NULL DEFAULT ''"],
];

async function init() {
  if (USE_PG) {
    await pool.query(SCHEMA);
    // Repair: millisecond timestamps need BIGINT, not 32-bit INTEGER.
    // Idempotent — only alters columns still typed as integer.
    const tsCols = [
      ['businesses', 'created_at'], ['admins', 'created_at'], ['faqs', 'created_at'],
      ['documents', 'created_at'], ['sessions', 'created_at'],
      ['messages', 'created_at'], ['leads', 'created_at'], ['feedback', 'created_at'],
      ['nudges', 'created_at'], ['provisions', 'created_at'],
      ['action_log', 'created_at'], ['shops', 'installed_at'], ['tickets', 'created_at'],
      ['tickets', 'updated_at'], ['webhook_endpoints', 'created_at'], ['qa_runs', 'created_at'],
      ['ab_tests', 'created_at'], ['articles', 'created_at'], ['articles', 'updated_at'],
      ['email_verifications', 'created_at'], ['email_verifications', 'expires_at'],
    ];
    for (const [table, col] of tsCols) {
      try {
        const r = await pool.query(
          'SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
          [table, col]);
        if (r.rows[0] && r.rows[0].data_type === 'integer') {
          await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT`);
          console.log(`[db] migrated ${table}.${col} to BIGINT`);
        }
      } catch (e) {
        console.warn(`[db] bigint migration ${table}.${col} failed:`, e.message);
      }
    }
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
/** Delete a business and all its tenant-scoped rows (used by tests and account deletion). */
async function deleteBusiness(id) {
  const tables = ['email_verifications', 'articles', 'ab_tests', 'qa_runs', 'webhook_endpoints',
    'tickets', 'shops', 'action_log', 'llm_usage', 'provisions', 'nudges', 'feedback', 'leads',
    'messages', 'sessions', 'orders', 'documents', 'faqs', 'admins'];
  for (const t of tables) {
    try { await run(`DELETE FROM ${t} WHERE business_id = ?`, [id]); } catch {}
  }
  await run('DELETE FROM businesses WHERE id = ?', [id]);
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
// ---------- Shopify shops ----------
async function upsertShop(businessId, shopDomain, accessTokenEnc, scopes) {
  const existing = await one('SELECT * FROM shops WHERE shop_domain = ?', [shopDomain]);
  if (existing) {
    await run('UPDATE shops SET business_id = ?, access_token_enc = ?, scopes = ? WHERE id = ?',
      [businessId, accessTokenEnc, scopes || '', existing.id]);
    return one('SELECT * FROM shops WHERE id = ?', [existing.id]);
  }
  const id = await insertGetId(
    'INSERT INTO shops (business_id, shop_domain, access_token_enc, scopes, installed_at) VALUES (?, ?, ?, ?, ?)',
    [businessId, shopDomain, accessTokenEnc, scopes || '', now()]);
  return one('SELECT * FROM shops WHERE id = ?', [id]);
}
async function getShopByDomain(shopDomain) {
  return one('SELECT * FROM shops WHERE shop_domain = ?', [shopDomain]);
}
async function listShops(businessId) {
  // never return the encrypted token to the browser
  return all('SELECT id, shop_domain, scopes, installed_at FROM shops WHERE business_id = ? ORDER BY installed_at DESC', [businessId]);
}
async function deleteShop(id, businessId) {
  await run('DELETE FROM shops WHERE id = ? AND business_id = ?', [id, businessId]);
}
// ---------- lightweight ticketing ----------
const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
async function createTicket(businessId, { session_id = null, subject = '', priority = 'normal' } = {}) {
  if (!TICKET_PRIORITIES.includes(priority)) priority = 'normal';
  const id = await insertGetId(
    'INSERT INTO tickets (business_id, session_id, subject, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, session_id, String(subject || '').slice(0, 300), 'open', priority, now(), now()]);
  const ticketNumber = `T-${1000 + Number(id)}`;
  await run('UPDATE tickets SET ticket_number = ? WHERE id = ?', [ticketNumber, id]);
  return one('SELECT * FROM tickets WHERE id = ?', [id]);
}
async function listTickets(businessId, { status = '', limit = 200 } = {}) {
  if (status && TICKET_STATUSES.includes(status)) {
    return all('SELECT * FROM tickets WHERE business_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?',
      [businessId, status, limit]);
  }
  return all('SELECT * FROM tickets WHERE business_id = ? ORDER BY updated_at DESC LIMIT ?', [businessId, limit]);
}
async function getTicket(id, businessId) {
  return one('SELECT * FROM tickets WHERE id = ? AND business_id = ?', [id, businessId]);
}
/** Open (not resolved/closed) ticket for a session, if any — used to avoid duplicate tickets per escalation. */
async function findOpenTicketForSession(businessId, sessionId) {
  return one("SELECT * FROM tickets WHERE business_id = ? AND session_id = ? AND status IN ('open','pending') ORDER BY created_at DESC",
    [businessId, sessionId]);
}
async function updateTicket(id, businessId, { status, priority, assignee, subject } = {}) {
  const t = await getTicket(id, businessId);
  if (!t) return null;
  const next = {
    status: TICKET_STATUSES.includes(status) ? status : t.status,
    priority: TICKET_PRIORITIES.includes(priority) ? priority : t.priority,
    assignee: assignee !== undefined ? String(assignee).slice(0, 120) : t.assignee,
    subject: subject !== undefined ? String(subject).slice(0, 300) : t.subject,
  };
  await run('UPDATE tickets SET status = ?, priority = ?, assignee = ?, subject = ?, updated_at = ? WHERE id = ?',
    [next.status, next.priority, next.assignee, next.subject, now(), id]);
  return getTicket(id, businessId);
}
async function countOpenTickets(businessId) {
  const row = await one("SELECT COUNT(*) AS c FROM tickets WHERE business_id = ? AND status IN ('open','pending')", [businessId]);
  return row ? row.c : 0;
}
// ---------- outgoing webhook endpoints (Zapier/Make/custom) ----------
async function addWebhookEndpoint(businessId, { url, events = [] } = {}) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('URL must start with http:// or https://');
  const { encryptSecret, encryptionEnabled } = require('./crypto');
  if (!encryptionEnabled()) throw new Error('ENCRYPTION_KEY is not set on the server — cannot store the webhook signing secret securely. Set it and retry.');
  const secret = crypto.randomBytes(24).toString('hex');
  const id = await insertGetId(
    'INSERT INTO webhook_endpoints (business_id, url, events, secret_enc, created_at) VALUES (?, ?, ?, ?, ?)',
    [businessId, clean.slice(0, 500), JSON.stringify((events || []).map(String).slice(0, 30)), encryptSecret(secret), now()]);
  const row = await one('SELECT * FROM webhook_endpoints WHERE id = ?', [id]);
  return { ...row, secret }; // plaintext shown ONCE
}
async function listWebhookEndpoints(businessId) {
  // never expose the encrypted secret to the browser
  return all('SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE business_id = ? ORDER BY created_at DESC', [businessId]);
}
async function getWebhookEndpointForSend(id, businessId) {
  const row = await one('SELECT * FROM webhook_endpoints WHERE id = ? AND business_id = ?', [id, businessId]);
  if (!row) return null;
  const { decryptSecret } = require('./crypto');
  return { ...row, secret: decryptSecret(row.secret_enc || '') || '' };
}
async function listActiveWebhookEndpoints(businessId) {
  const rows = await all('SELECT * FROM webhook_endpoints WHERE business_id = ? AND active = 1', [businessId]);
  const { decryptSecret } = require('./crypto');
  return rows.map((r) => ({ ...r, secret: decryptSecret(r.secret_enc || '') || '' }));
}
async function deleteWebhookEndpoint(id, businessId) {
  await run('DELETE FROM webhook_endpoints WHERE id = ? AND business_id = ?', [id, businessId]);
}
async function setWebhookEndpointActive(id, businessId, active) {
  await run('UPDATE webhook_endpoints SET active = ? WHERE id = ? AND business_id = ?', [active ? 1 : 0, id, businessId]);
}
// ---------- QA playground (regression runs) ----------
async function createQaRun(businessId, { name = '', script = [], results = [] } = {}) {
  const passed = results.filter((r) => r.pass).length;
  const id = await insertGetId(
    'INSERT INTO qa_runs (business_id, name, script, results, passed, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, String(name).slice(0, 120), JSON.stringify(script).slice(0, 20000),
     JSON.stringify(results).slice(0, 60000), passed, results.length, now()]);
  return one('SELECT * FROM qa_runs WHERE id = ?', [id]);
}
async function listQaRuns(businessId, limit = 50) {
  return all('SELECT * FROM qa_runs WHERE business_id = ? ORDER BY created_at DESC LIMIT ?', [businessId, limit]);
}
async function getQaRun(id, businessId) {
  return one('SELECT * FROM qa_runs WHERE id = ? AND business_id = ?', [id, businessId]);
}
async function deleteQaRun(id, businessId) {
  if (USE_PG) {
    const res = await pool.query(pgify('DELETE FROM qa_runs WHERE id = ? AND business_id = ?'), [id, businessId]);
    return res.rowCount > 0;
  }
  const info = sqliteDb.prepare('DELETE FROM qa_runs WHERE id = ? AND business_id = ?').run(id, businessId);
  return info.changes > 0;
}
// ---------- A/B tests (nudge triggers) ----------
const AB_TRIGGERS = ['welcome', 'idle_30s', 'exit_intent'];
async function createAbTest(businessId, { name, trigger, variant_a, variant_b, split = 50 } = {}) {
  if (!name || !variant_a || !variant_b) throw new Error('name, variant_a and variant_b are required');
  if (!AB_TRIGGERS.includes(trigger)) throw new Error(`trigger must be one of: ${AB_TRIGGERS.join(', ')}`);
  const id = await insertGetId(
    'INSERT INTO ab_tests (business_id, name, trigger, variant_a, variant_b, split, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, String(name).slice(0, 120), trigger,
     String(variant_a).slice(0, 500), String(variant_b).slice(0, 500),
     Math.min(100, Math.max(0, parseInt(split, 10) || 50)), now()]);
  return one('SELECT * FROM ab_tests WHERE id = ?', [id]);
}
async function listAbTests(businessId) {
  return all('SELECT * FROM ab_tests WHERE business_id = ? ORDER BY created_at DESC', [businessId]);
}
async function getRunningAbTest(businessId, trigger) {
  return one("SELECT * FROM ab_tests WHERE business_id = ? AND trigger = ? AND status = 'running' ORDER BY created_at DESC",
    [businessId, trigger]);
}
async function updateAbTest(id, businessId, { status } = {}) {
  if (!['running', 'paused', 'done'].includes(status)) throw new Error('invalid status');
  await run('UPDATE ab_tests SET status = ? WHERE id = ? AND business_id = ?', [status, id, businessId]);
  return one('SELECT * FROM ab_tests WHERE id = ?', [id]);
}
async function deleteAbTest(id, businessId) {
  await run('DELETE FROM ab_tests WHERE id = ? AND business_id = ?', [id, businessId]);
}
/** Impressions + reply-rate per variant for a test. A "conversion" is a visitor message after the nudge was shown. */
async function abTestStats(businessId, testId) {
  const test = await one('SELECT * FROM ab_tests WHERE id = ? AND business_id = ?', [testId, businessId]);
  if (!test) return null;
  const rows = await all(`SELECT variant, ${cnt()} AS impressions,
      SUM(CASE WHEN shown = 1 THEN 1 ELSE 0 END) AS shown_count
    FROM nudges WHERE business_id = ? AND ab_test_id = ? GROUP BY variant`, [businessId, testId]);
  const out = { test, variants: {} };
  for (const v of ['a', 'b']) {
    const row = rows.find((r) => r.variant === v) || { impressions: 0, shown_count: 0 };
    // conversions: sessions with this variant shown that later sent a user message
    const conv = await one(`SELECT ${cnt()} AS c FROM sessions s WHERE s.business_id = ?
      AND EXISTS (SELECT 1 FROM nudges n WHERE n.session_id = s.id AND n.ab_test_id = ? AND n.variant = ? AND n.shown = 1)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
        AND m.created_at > (SELECT MIN(n2.created_at) FROM nudges n2 WHERE n2.session_id = s.id AND n2.ab_test_id = ? AND n2.variant = ?))`,
      [businessId, testId, v, testId, v]);
    out.variants[v] = {
      text: v === 'a' ? test.variant_a : test.variant_b,
      impressions: row.impressions || 0,
      shown: row.shown_count || 0,
      conversions: conv.c || 0,
      conversion_rate: row.shown_count ? Math.round((conv.c / row.shown_count) * 1000) / 10 : 0,
    };
  }
  return out;
}
// ---------- help-center articles ----------
async function createArticle(businessId, { title, body = '', source = '', published = false } = {}) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  const id = await insertGetId(
    'INSERT INTO articles (business_id, title, body, source, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, String(title).slice(0, 200), String(body).slice(0, 30000), String(source).slice(0, 300), published ? 1 : 0, now(), now()]);
  return one('SELECT * FROM articles WHERE id = ?', [id]);
}
async function listArticles(businessId, { publishedOnly = false } = {}) {
  const q = publishedOnly
    ? 'SELECT id, title, updated_at FROM articles WHERE business_id = ? AND published = 1 ORDER BY updated_at DESC'
    : 'SELECT * FROM articles WHERE business_id = ? ORDER BY updated_at DESC';
  return all(q, [businessId]);
}
async function getArticle(id, businessId) {
  return one('SELECT * FROM articles WHERE id = ? AND business_id = ?', [id, businessId]);
}
async function updateArticle(id, businessId, { title, body, published } = {}) {
  const a = await getArticle(id, businessId);
  if (!a) return null;
  await run('UPDATE articles SET title = ?, body = ?, published = ?, updated_at = ? WHERE id = ?',
    [title !== undefined ? String(title).slice(0, 200) : a.title,
     body !== undefined ? String(body).slice(0, 30000) : a.body,
     published !== undefined ? (published ? 1 : 0) : a.published, now(), id]);
  return getArticle(id, businessId);
}
async function deleteArticle(id, businessId) {
  await run('DELETE FROM articles WHERE id = ? AND business_id = ?', [id, businessId]);
}
/** Email verification tokens. The raw token goes in the emailed link; only its
 * SHA-256 hash is stored. Tokens expire after 24h and are single-use. */
async function createEmailVerification(businessId, email) {
  const token = require('crypto').randomBytes(24).toString('hex');
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  await run(
    'INSERT INTO email_verifications (business_id, email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [businessId, String(email).slice(0, 160), tokenHash, Date.now() + 24 * 3600e3, now()]);
  return token;
}
async function consumeEmailVerification(token) {
  const tokenHash = require('crypto').createHash('sha256').update(String(token || '')).digest('hex');
  const row = await one(
    'SELECT * FROM email_verifications WHERE token_hash = ? AND used = 0 AND expires_at > ?',
    [tokenHash, Date.now()]);
  if (!row) return null;
  await run('UPDATE email_verifications SET used = 1 WHERE id = ?', [row.id]);
  return { business_id: row.business_id, email: row.email };
}
async function pendingEmailVerification(businessId) {
  const row = await one(
    'SELECT email, expires_at FROM email_verifications WHERE business_id = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    [businessId, Date.now()]);
  return row || null;
}
/** Update an order's status (used by agentic cancel/refund actions). */
async function updateOrderStatus(businessId, orderNumber, status) {
  await run('UPDATE orders SET status = ? WHERE business_id = ? AND order_number = ?',
    [status, businessId, orderNumber]);
  return findOrder(businessId, orderNumber);
}

// ---------- agentic action audit log ----------
async function logAction(businessId, { session_id = null, action, args = {}, status }) {
  const id = await insertGetId(
    'INSERT INTO action_log (business_id, session_id, action, args, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [businessId, session_id, action, JSON.stringify(args), status, now()]);
  return one('SELECT * FROM action_log WHERE id = ?', [id]);
}
async function listActions(businessId, limit = 100) {
  return all('SELECT * FROM action_log WHERE business_id = ? ORDER BY created_at DESC LIMIT ?', [businessId, limit]);
}

// ---------- sessions & messages ----------
async function getSession(sessionId) {
  return await one('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}
async function createSession(businessId, visitorLabel = '', { channel = 'web', channelSender = '' } = {}) {
  const id = newId('sess');
  await run('INSERT INTO sessions (id, business_id, visitor_label, channel, channel_sender, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, businessId, visitorLabel, channel || 'web', channelSender || '', now()]);
  return getSession(id);
}
/** Most recent session for a messaging-channel sender (phone number / PSID). */
async function findSessionByChannel(businessId, channel, sender) {
  if (!sender) return null;
  return await one(
    'SELECT * FROM sessions WHERE business_id = ? AND channel = ? AND channel_sender = ? ORDER BY created_at DESC LIMIT 1',
    [businessId, channel, sender]);
}
/**
 * Find a business by a value stored in its settings JSON (e.g.
 * whatsapp_phone_number_id, messenger_page_id). Scans businesses in JS —
 * fine at this scale, portable across both dialects.
 */
async function findBusinessBySetting(key, value) {
  if (value === undefined || value === null || value === '') return null;
  const rows = await all('SELECT * FROM businesses');
  for (const row of rows) {
    let settings = {};
    try { settings = JSON.parse(row.settings || '{}'); } catch {}
    if (settings[key] !== undefined && String(settings[key]) === String(value)) {
      return decorateBusiness(row);
    }
  }
  return null;
}
async function updateSession(id, patch) {
  const s = await getSession(id);
  if (!s) return null;
  const cs = patch.capture_state === undefined
    ? s.capture_state // keep existing raw DB value (already JSON or null)
    : (patch.capture_state == null ? null : JSON.stringify(patch.capture_state));
  await run(`UPDATE sessions SET visitor_label = ?, flagged_human = ?, resolved = ?, human_active = ?, handoff_summary = ?, unread_admin = ?, capture_state = ?, language = ?, sentiment = ?, is_test = ? WHERE id = ?`,
    [patch.visitor_label ?? s.visitor_label,
      patch.flagged_human !== undefined ? (patch.flagged_human ? 1 : 0) : s.flagged_human,
      patch.resolved !== undefined ? (patch.resolved ? 1 : 0) : s.resolved,
      patch.human_active !== undefined ? (patch.human_active ? 1 : 0) : (s.human_active ? 1 : 0),
      patch.handoff_summary !== undefined ? String(patch.handoff_summary) : (s.handoff_summary || ''),
      patch.unread_admin !== undefined ? (patch.unread_admin ? 1 : 0) : (s.unread_admin ? 1 : 0),
      cs,
      patch.language !== undefined ? patch.language : s.language,
      patch.sentiment !== undefined ? Number(patch.sentiment) : (s.sentiment || 0),
      patch.is_test !== undefined ? (patch.is_test ? 1 : 0) : (s.is_test ? 1 : 0),
      id]);
  return getSession(id);
}
async function addMessage(sessionId, role, text, meta = null, kind = 'text') {
  return insertGetId('INSERT INTO messages (session_id, role, kind, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, role, kind, text, meta ? JSON.stringify(meta) : null, now()]);
}
/** Fetch one message row by its integer id (used to validate feedback votes). */
async function getMessageById(messageId) {
  return await one('SELECT * FROM messages WHERE id = ?', [messageId]);
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
// Conversations per channel (web, whatsapp, messenger, instagram, email).
async function channelStats(businessId, days = 30) {
  const since = now() - days * 86400000;
  return all(`
    SELECT COALESCE(channel, 'web') AS channel, ${cnt()} AS chats
    FROM sessions WHERE business_id = ? AND created_at >= ?
    GROUP BY channel ORDER BY chats DESC`, [businessId, since]);
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

// ---------- feedback (CSAT thumbs up/down) ----------
async function addFeedback(businessId, sessionId, messageId, rating) {
  const id = await insertGetId(
    'INSERT INTO feedback (business_id, session_id, message_id, rating, created_at) VALUES (?, ?, ?, ?, ?)',
    [businessId, sessionId, messageId, rating, now()]);
  return one('SELECT * FROM feedback WHERE id = ?', [id]);
}
/** CSAT stats: totals, percent positive, and a per-day breakdown. */
async function feedbackStats(businessId, days = 14) {
  const since = now() - days * 86400000;
  const dayExpr = USE_PG
    ? `TO_CHAR(TO_TIMESTAMP(created_at / 1000.0), 'YYYY-MM-DD')`
    : `date(created_at / 1000, 'unixepoch')`;
  const pos = USE_PG ? 'SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int' : 'SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)';
  const neg = USE_PG ? 'SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END)::int' : 'SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END)';
  const rows = await all(`
    SELECT ${dayExpr} AS day, ${pos} AS positive, ${neg} AS negative
    FROM feedback WHERE business_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day`, [businessId, since]);
  const perDay = rows.map((r) => ({ day: r.day, positive: Number(r.positive), negative: Number(r.negative) }));
  const positive = perDay.reduce((a, d) => a + d.positive, 0);
  const negative = perDay.reduce((a, d) => a + d.negative, 0);
  const total = positive + negative;
  return {
    positive, negative,
    percent: total ? Math.round((positive / total) * 100) : null,
    per_day: perDay,
  };
}

// ---------- nudges (proactive messages) ----------
async function addNudge(businessId, sessionId, text, { abTestId = 0, variant = '' } = {}) {
  const id = await insertGetId(
    'INSERT INTO nudges (business_id, session_id, text, shown, ab_test_id, variant, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    [businessId, sessionId, text, abTestId || 0, variant || '', now()]);
  return one('SELECT * FROM nudges WHERE id = ?', [id]);
}
/**
 * Fetch unshown nudges for a session and mark them shown (so each nudge is
 * delivered exactly once).
 */
/** One nudge per A/B test per session — has this session already been nudged for the test? */
async function hasNudgeForTest(businessId, sessionId, testId) {
  const row = await one('SELECT 1 FROM nudges WHERE business_id = ? AND session_id = ? AND ab_test_id = ? LIMIT 1',
    [businessId, sessionId, testId]);
  return !!row;
}
async function getPendingNudges(businessId, sessionId) {
  const rows = await all(
    'SELECT id, text FROM nudges WHERE business_id = ? AND session_id = ? AND shown = 0 ORDER BY id',
    [businessId, sessionId]);
  if (rows.length) {
    await run('UPDATE nudges SET shown = 1 WHERE business_id = ? AND session_id = ? AND shown = 0',
      [businessId, sessionId]);
  }
  return rows;
}
async function listNudges(businessId, limit = 50) {
  return all('SELECT * FROM nudges WHERE business_id = ? ORDER BY created_at DESC LIMIT ?', [businessId, limit]);
}
/** Sessions that exchanged at least one message in the last `minutes` minutes. */
async function recentlyActiveSessions(businessId, minutes = 15) {
  const since = now() - minutes * 60000;
  return all(
    'SELECT DISTINCT s.id FROM sessions s JOIN messages m ON m.session_id = s.id WHERE s.business_id = ? AND m.created_at >= ?',
    [businessId, since]);
}

// ---------- Stripe billing provisions ----------
async function getProvision(stripeSessionId) {
  return await one('SELECT * FROM provisions WHERE stripe_session_id = ?', [stripeSessionId]);
}
async function addProvision({ stripeSessionId, businessId, adminUsername, adminPassword }) {
  const id = await insertGetId(
    'INSERT INTO provisions (stripe_session_id, business_id, admin_username, admin_password, created_at) VALUES (?, ?, ?, ?, ?)',
    [stripeSessionId, businessId, adminUsername, adminPassword, now()]);
  return one('SELECT * FROM provisions WHERE id = ?', [id]);
}
async function deleteProvision(stripeSessionId) {
  await run('DELETE FROM provisions WHERE stripe_session_id = ?', [stripeSessionId]);
}

// ---------- platform LLM usage metering ----------
function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
async function getLlmUsage(businessId) {
  const row = await one('SELECT * FROM llm_usage WHERE business_id = ? AND month = ?', [businessId, currentMonth()]);
  return row || { business_id: businessId, month: currentMonth(), messages: 0, tokens: 0 };
}
async function recordLlmUsage(businessId, tokens) {
  const m = currentMonth();
  await run(`INSERT INTO llm_usage (business_id, month, messages, tokens) VALUES (?, ?, 1, ?)
    ON CONFLICT (business_id, month) DO UPDATE SET messages = llm_usage.messages + 1, tokens = llm_usage.tokens + ?`,
    [businessId, m, tokens, tokens]);
}
/**
 * Find the business provisioned from a Stripe checkout session. The
 * provisions row is deleted after the success page shows the credentials
 * once, so replays must also recognize the business itself.
 */
async function getBusinessByStripeSession(sessionId) {
  const cond = USE_PG
    ? "(settings::json ->> 'stripe_session_id') = ?"
    : "json_extract(settings, '$.stripe_session_id') = ?";
  const row = await one(`SELECT * FROM businesses WHERE ${cond}`, [sessionId]);
  return row ? decorateBusiness(row) : null;
}

// ---------- resolution funnel ----------
/**
 * Funnel stages for the admin dashboard:
 *   answered  — sessions whose LAST assistant message was a real answer
 *               (faq | llm | order | document), not a fallback
 *   escalated — sessions flagged for a human
 *   leads     — leads captured (from leadCount)
 */
async function funnelStats(businessId, days = 30) {
  const since = now() - days * 86400000;
  const answered = (await one(`
    SELECT ${cnt()} AS c FROM sessions s
    WHERE s.business_id = ? AND s.created_at >= ?
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.session_id = s.id AND m.role = 'assistant'
          AND m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id)
          AND (m.meta LIKE '%"type":"faq"%'
            OR m.meta LIKE '%"type":"llm"%'
            OR m.meta LIKE '%"type":"order"%'
            OR m.meta LIKE '%"type":"document"%')
      )`, [businessId, since])).c;
  const escalated = (await one(
    `SELECT ${cnt()} AS c FROM sessions WHERE business_id = ? AND created_at >= ? AND flagged_human = 1`,
    [businessId, since])).c;
  const leads = await leadCount(businessId, days);
  return { answered, escalated, leads };
}

module.exports = {
  hashPassword, verifyPassword, newId, ping,
  getBusinessByKey: withReady(getBusinessByKey),
  getBusinessById: withReady(getBusinessById),
  deleteBusiness: withReady(deleteBusiness),
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
  upsertShop: withReady(upsertShop),
  getShopByDomain: withReady(getShopByDomain),
  listShops: withReady(listShops),
  deleteShop: withReady(deleteShop),
  updateOrderStatus: withReady(updateOrderStatus),
  createTicket: withReady(createTicket),
  listTickets: withReady(listTickets),
  getTicket: withReady(getTicket),
  findOpenTicketForSession: withReady(findOpenTicketForSession),
  updateTicket: withReady(updateTicket),
  countOpenTickets: withReady(countOpenTickets),
  addWebhookEndpoint: withReady(addWebhookEndpoint),
  listWebhookEndpoints: withReady(listWebhookEndpoints),
  getWebhookEndpointForSend: withReady(getWebhookEndpointForSend),
  listActiveWebhookEndpoints: withReady(listActiveWebhookEndpoints),
  deleteWebhookEndpoint: withReady(deleteWebhookEndpoint),
  setWebhookEndpointActive: withReady(setWebhookEndpointActive),
  createQaRun: withReady(createQaRun),
  listQaRuns: withReady(listQaRuns),
  getQaRun: withReady(getQaRun),
  deleteQaRun: withReady(deleteQaRun),
  createAbTest: withReady(createAbTest),
  listAbTests: withReady(listAbTests),
  getRunningAbTest: withReady(getRunningAbTest),
  updateAbTest: withReady(updateAbTest),
  deleteAbTest: withReady(deleteAbTest),
  abTestStats: withReady(abTestStats),
  createArticle: withReady(createArticle),
  listArticles: withReady(listArticles),
  getArticle: withReady(getArticle),
  createEmailVerification: withReady(createEmailVerification),
  consumeEmailVerification: withReady(consumeEmailVerification),
  pendingEmailVerification: withReady(pendingEmailVerification),
  updateArticle: withReady(updateArticle),
  deleteArticle: withReady(deleteArticle),
  hasNudgeForTest: withReady(hasNudgeForTest),
  deleteOrder: withReady(deleteOrder),
  getSession: withReady(getSession),
  createSession: withReady(createSession),
  findSessionByChannel: withReady(findSessionByChannel),
  findBusinessBySetting: withReady(findBusinessBySetting),
  updateSession: withReady(updateSession),
  addMessage: withReady(addMessage),
  getHistory: withReady(getHistory),
  listSessions: withReady(listSessions),
  countMessages: withReady(countMessages),
  addLead: withReady(addLead),
  listLeads: withReady(listLeads),
  chatsPerDay: withReady(chatsPerDay),
  channelStats: withReady(channelStats),
  topUnanswered: withReady(topUnanswered),
  leadCount: withReady(leadCount),
  resolutionStats: withReady(resolutionStats),
  getMessageById: withReady(getMessageById),
  addFeedback: withReady(addFeedback),
  feedbackStats: withReady(feedbackStats),
  addNudge: withReady(addNudge),
  getPendingNudges: withReady(getPendingNudges),
  listNudges: withReady(listNudges),
  recentlyActiveSessions: withReady(recentlyActiveSessions),
  getProvision: withReady(getProvision),
  getLlmUsage: withReady(getLlmUsage),
  recordLlmUsage: withReady(recordLlmUsage),
  addProvision: withReady(addProvision),
  deleteProvision: withReady(deleteProvision),
  logAction: withReady(logAction),
  listActions: withReady(listActions),
  getBusinessByStripeSession: withReady(getBusinessByStripeSession),
  funnelStats: withReady(funnelStats),
};
