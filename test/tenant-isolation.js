/**
 * Tenant-isolation verification tests.
 * Creates two tenants (A and B), seeds data under B, then proves that A's
 * admin session cannot read, list, or mutate B's data.
 *
 * Run against a local server:  PORT=3100 node server.js  (in another shell)
 *   node test/tenant-isolation.js
 */
const BASE = process.env.TEST_BASE || 'http://localhost:3100';
const db = require('../lib/db');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error('login failed for ' + username);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function req(cookie, method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('== tenant isolation tests ==');
  const tag = Date.now().toString(36);

  // --- setup: two tenants, each with an admin ---
  const bizA = await db.createBusiness({ name: 'Tenant A Co', settings: { plan: 'trial' } });
  const bizB = await db.createBusiness({ name: 'Tenant B Co', settings: { plan: 'trial' } });
  const userA = 'iso-a-' + tag, userB = 'iso-b-' + tag;
  const passA = 'pw-a-' + tag + '-x', passB = 'pw-b-' + tag + '-x';
  await db.createAdmin(bizA.id, userA, passA);
  await db.createAdmin(bizB.id, userB, passB);
  const cookieA = await login(userA, passA);
  const cookieB = await login(userB, passB);
  check('both admins log in', !!cookieA && !!cookieB);

  // --- seed data under tenant B ---
  const faq = await db.addFaq(bizB.id, 'B secret FAQ?', 'B secret answer', 'b');
  const sess = await db.createSession(bizB.id, 'B visitor');
  await db.addMessage(sess.id, 'visitor', 'B private message');
  const ticket = await db.createTicket(bizB.id, { session_id: sess.id, subject: 'B ticket', priority: 'high' });
  const article = await db.createArticle(bizB.id, { title: 'B article', body: 'B body', published: 1 });
  const qa = await db.createQaRun(bizB.id, { name: 'B run', script: [] });
  const ab = await db.createAbTest(bizB.id, { name: 'B test', trigger: 'welcome', variant_a: 'a', variant_b: 'b' });
  const keyB = (await db.getBusinessById(bizB.id)).api_key;
  console.log('  seeded B:', { faq: faq.id, sess: sess.id, ticket: ticket.id, article: article.id, qa: qa.id, ab: ab.id });

  // --- cross-tenant :id reads must 404 ---
  const idTests = [
    ['session', `/api/admin/sessions/${sess.id}`],
    ['ticket detail via sessions', `/api/admin/sessions/${sess.id}`],
    ['article', `/api/admin/articles/${article.id}`],
    ['qa run', `/api/admin/qa/runs/${qa.id}`],
    ['ab test stats', `/api/admin/ab-tests/${ab.id}/stats`],
    ['account (own only)', `/api/admin/account`],
  ];
  for (const [name, path] of idTests) {
    const r = await req(cookieA, 'GET', path);
    if (name === 'account (own only)') {
      check(name + ' shows A not B', r.status === 200 && r.json.business_name === 'Tenant A Co');
    } else {
      check(name + ' cross-read -> 404', r.status === 404);
    }
  }

  // --- cross-tenant mutations must 404 ---
  const m1 = await req(cookieA, 'POST', `/api/admin/sessions/${sess.id}/resolve`);
  check('resolve B session -> 404', m1.status === 404);
  const m2 = await req(cookieA, 'DELETE', `/api/admin/qa/runs/${qa.id}`);
  check('delete B qa run -> 404', m2.status === 404);
  const m3 = await req(cookieA, 'PUT', `/api/admin/articles/${article.id}`, { title: 'hacked' });
  check('update B article -> 404', m3.status === 404);

  // --- list endpoints must not leak B data ---
  const lists = [
    ['faqs', '/api/admin/faqs', (j) => Array.isArray(j) && !j.some((f) => String(f.question).includes('B secret'))],
    ['sessions', '/api/admin/sessions', (j) => Array.isArray(j) && !j.some((x) => x.id === sess.id)],
    ['tickets', '/api/admin/tickets', (j) => Array.isArray(j) && !j.some((t) => t.id === ticket.id)],
    ['articles', '/api/admin/articles', (j) => Array.isArray(j) && !j.some((a) => a.id === article.id)],
    ['qa runs', '/api/admin/qa/runs', (j) => Array.isArray(j) && !j.some((x) => x.id === qa.id)],
    ['ab tests', '/api/admin/ab-tests', (j) => Array.isArray(j) && !j.some((x) => x.id === ab.id)],
  ];
  for (const [name, path, ok] of lists) {
    const r = await req(cookieA, 'GET', path);
    check('list ' + name + ' hides B data', r.status === 200 && ok(r.json));
  }

  // --- sanity: B's own admin CAN read B's data ---
  const own = await req(cookieB, 'GET', `/api/admin/sessions/${sess.id}`);
  check('B admin reads own session', own.status === 200 && own.json.session && own.json.session.id === sess.id);
  const ownArt = await req(cookieB, 'GET', `/api/admin/articles/${article.id}`);
  check('B admin reads own article', ownArt.status === 200 && ownArt.json.id === article.id);

  // --- public API v1: A's key cannot touch B's conversations ---
  const keyA = (await db.getBusinessById(bizA.id)).api_key;
  // v1 auth: Authorization: Bearer <key>; list returns an array directly
  const v1 = await fetch(BASE + '/api/v1/conversations?limit=5', {
    headers: { Authorization: 'Bearer ' + keyA },
  });
  const v1j = await v1.json().catch(() => []);
  check('v1 key A lists only A conversations',
    v1.status === 200 && Array.isArray(v1j) && !v1j.some((c) => c.id === sess.id));
  const v1x = await fetch(BASE + '/api/v1/conversations/' + sess.id, {
    headers: { Authorization: 'Bearer ' + keyA },
  });
  check('v1 key A cross-read B conversation -> 404', v1x.status === 404);
  const v1b = await fetch(BASE + '/api/v1/conversations?limit=5', {
    headers: { Authorization: 'Bearer ' + keyB },
  });
  check('v1 key B works for B', v1b.status === 200);

  // --- cleanup ---
  await db.deleteBusiness(bizA.id).catch(() => {});
  await db.deleteBusiness(bizB.id).catch(() => {});

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test error:', e.message); process.exit(1); });
