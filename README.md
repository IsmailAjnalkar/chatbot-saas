# 🤖 Chatbot SaaS — Embeddable AI Customer-Service Chatbots for E-commerce & SaaS

A complete, sellable product: businesses paste **one `<script>` tag** into their site and get an AI customer-service chatbot that answers FAQs, tracks orders, captures leads, and escalates to humans. You run the backend; each client gets their own bot (API key), knowledge base, and admin dashboard.

## Architecture

```
┌──────────────┐      ┌──────────────┐      ┌──────────────────────────────┐
│ Client site  │      │  Demo store  │      │        Admin dashboard       │
│  widget.js   │      │   /demo/     │      │          /admin/             │
│  (embed tag) │      │              │      │  FAQs · Leads · Chats ·       │
└──────┬───────┘      └──────┬───────┘      │  Orders · Analytics · Settings│
       │  POST /api/chat (JSON or SSE stream)  └──────────────┬──────────────┘
       │  GET  /api/config?key=…              session-cookie auth (per bot)
       └──────────────────┬───────────────────────────────────┘
                          ▼
              ┌───────────────────────┐
              │   Express (server.js) │
              │  ┌─────────────────┐  │
              │  │ bot.js (engine) │──┼──▶ lib/retrieval.js (TF-IDF cosine over FAQs)
              │  └─────────────────┘  │──▶ lib/llm.js (OpenAI-compatible chat completions, optional)
              │  lib/db.js            │──▶ node:sqlite (zero native deps)
              └───────────────────────┘
                          ▲
              POST /api/webhook/orders  (live order data from the client's store)
```

**How an answer is produced** (`lib/bot.js`):
1. Order number detected (`ORD-1234`) → look up order store → status card.
2. Escalation phrasing ("talk to a human") → flag conversation, start callback capture.
3. FAQ retrieval (TF-IDF cosine similarity). Score ≥ 0.35 → answer directly with confidence.
4. Score < 0.35 → optional LLM (OpenAI-compatible API) answers using the FAQs as context.
5. No confident answer → polite fallback; if lead capture is on, collect name → email → phone and save the lead.
6. Every message, confidence score, and outcome is logged for analytics.

## Quickstart (2 minutes)

```bash
cd chatbot-saas
cp .env.example .env        # then edit: SESSION_SECRET at minimum
npm install
npm run seed                # creates demo business "Glow & Co." + admin account
npm start
```

Open:
- **Demo store:** http://localhost:3000/demo/ — paste the API key printed by `seed` into the key bar, click the chat bubble. Try: `Where is my order ORD-1002`, `What is your return policy?`, `I want to talk to a human`.
- **Admin:** http://localhost:3000/admin/ — sign in with the credentials printed by `seed`. Change the password immediately (Settings tab).

`npm run seed` is idempotent — safe to run again; it skips if the demo business exists.

**Adding a real client:** `npm run provision -- "Acme Inc" acme-admin` — creates the business, prints its widget API key and admin login (shown once), and the embed snippet.

## Embedding the widget on a client site

Paste before `</body>` (the Admin → Settings tab shows this snippet pre-filled):

```html
<script src="https://YOUR-HOST/widget/widget.js"
        data-api-key="cb_<client-key>"
        data-api-url="https://YOUR-HOST"></script>
```

Optional attributes: `data-position="bottom-left"`. The widget fetches the client's branding (name, color, welcome message) from `/api/config` and chats over `/api/chat/stream` (SSE) with CORS enabled.

## Configuring the LLM (the "AI brain")

Without an LLM key the bot runs on FAQ matching + smart fallbacks — fully usable. To enable generative answers for out-of-KB questions, set in `.env` (global default) **or** per-client in Admin → Settings → AI brain:

```
LLM_BASE_URL=https://api.openai.com/v1   # or Ollama: http://localhost:11434/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...
```

Any OpenAI-compatible `/chat/completions` endpoint works (OpenAI, Azure, Ollama, vLLM, OpenRouter, Together…). The LLM only ever answers **from the client's knowledge base** — it is instructed to say "I don't know" and offer a human rather than invent policies.

## Billing (Stripe self-serve signup)

The pricing page at `/pricing/` offers three plans — **Starter** ($500 setup + $99/mo), **Growth** ($1,000 setup + $199/mo), **Scale** ($2,500 setup + $399/mo). The flow is fully self-serve:

1. A visitor enters their business name + admin username and clicks a Subscribe button → `GET /api/billing/checkout?plan=…` creates a Stripe Checkout Session (subscription for the monthly plan **plus** the one-time setup fee as a second line item) and redirects them to Stripe's hosted page.
2. On payment, Stripe calls `POST /api/billing/webhook` (event `checkout.session.completed`, signature-verified with `STRIPE_WEBHOOK_SECRET`). The server **idempotently** provisions the business, creates its first admin (random `cb-…` password), and stashes the credentials in the `provisions` table.
3. Stripe redirects the buyer to `/pricing/success.html?session_id={CHECKOUT_SESSION_ID}`, which fetches `GET /api/billing/success?session_id=` — the credentials are returned **exactly once** (the row is deleted on read) and displayed with copy buttons and a "shown once" warning.
4. Paid clients manage their subscription from the admin dashboard (Settings → Billing) via `POST /api/admin/billing/portal`, which opens the Stripe customer portal.

Setup: create three recurring monthly USD prices in the Stripe Dashboard and set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER/GROWTH/SCALE`, and `STRIPE_WEBHOOK_SECRET` (webhook endpoint: `https://YOUR-HOST/api/billing/webhook`, event `checkout.session.completed`). See `.env.example`.

When the Stripe keys are absent, `/pricing/` renders a "Contact us to get started" mailto CTA instead of buy buttons, and the billing endpoints (`/api/billing/checkout`, `/api/billing/webhook`, `/api/billing/portal`) return clean `503 { error: 'billing not configured' }` responses — the server never crashes.

## API reference (for integrations)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/config?key=` | API key; origin-allowlisted | Widget branding config (checks `Origin`/`Referer` against the business's `allowed_origins`; 403 on mismatch) |
| `POST /api/chat` | API key in body | `{api_key, session_id?, message, visitor_label?}` → `{sessionId, reply, type, confidence, suggestions, orderCard?}` |
| `POST /api/chat/stream` | API key in body | Same, as SSE (`{"token"}` chunks, then `{"done":true,"meta":{…}}`) |
| `POST /api/webhook/orders` | `X-Webhook-Secret` header | `{orders:[{order_number, status, eta?, carrier?, tracking_number?, items?}]}` — upserts live order data. The secret is per-business, shown once at provision/seed, regenerable in Admin → Settings |
| `POST /api/auth/login` | — (IP rate-limited) | `{username, password}` → session cookie |
| `GET/POST/PUT/DELETE /api/admin/faqs…` | session | Knowledge base CRUD (business-scoped) |
| `POST /api/admin/crawl` | session | `{url, max_pages}` → crawls the website in the background and imports its pages into the knowledge base (Q/A pairs when an LLM is configured, raw chunks otherwise) |
| `GET /api/admin/documents`, `DELETE /api/admin/documents/:id` | session | List / delete crawled knowledge documents |
| `GET/PUT /api/admin/settings` | session | Business name, welcome message, brand color, support email, lead-capture toggle, default language, auto-translate toggle, voice input/output toggle, allowed origins, LLM config (secrets returned as `*_set` flags, never values) |
| `GET /api/admin/webhook`, `POST /api/admin/webhook/regenerate` | session | Webhook secret status / rotation (plaintext shown once) |
| `GET /api/admin/leads[?format=csv]` | session | Leads, CSV-exportable |
| `GET /api/admin/sessions[?flagged=1]`, `GET /api/admin/sessions/:id`, `POST …/resolve` | session | Conversations & transcripts, human-follow-up queue |
| `GET/POST/DELETE /api/admin/orders…` | session | Mock order store management |
| `GET /api/admin/analytics` | session | Chats/day, top unanswered questions, lead counts, resolution-rate estimate, CSAT (thumbs feedback with 14-day trend), and the resolution funnel (answered / escalated / leads) |
| `POST /api/admin/change-password` | session | Rotate the admin password |
| `POST /api/feedback` | API key in body (CORS-open, rate-limited) | `{api_key, session_id, message_id, rating}` — CSAT thumbs vote (rating 0/1); the widget renders 👍/👎 under each bot reply |
| `GET /api/nudge?key=&session_id=` | API key (CORS-open, rate-limited) | Returns unshown proactive messages for the session and marks them shown |
| `POST /api/admin/nudges` | session | `{text, target}` — send a proactive message to all sessions active in the last 15 min (`target: 'active'`) or one session id (≤500 chars) |
| `GET /api/admin/nudges` | session | Recent nudges (text, target session, shown status) |
| `GET /api/billing/status` | — | `{configured: bool}` — whether Stripe billing is enabled |
| `GET /api/billing/checkout?plan=&business_name=&admin_username=` | — | Creates a Stripe Checkout Session (subscription + one-time setup fee) and redirects (303) to Stripe; 503 when billing is unconfigured |
| `POST /api/billing/webhook` | Stripe signature (`STRIPE_WEBHOOK_SECRET`) | `checkout.session.completed` → idempotently provisions the business + admin |
| `GET /api/billing/success?session_id=` | — | Returns the provisioned credentials **exactly once**, then deletes them |
| `POST /api/admin/billing/portal` | session | Opens the Stripe customer portal for the logged-in business |

## Origin allowlist (widget security)

Each business can restrict which websites may load its widget, in Admin → Settings → *Allowed origins* (or the `allowed_origins` setting via API). Format: comma- or line-separated origins, e.g.

```
https://shop.example.com, https://www.example.com, https://*.example.com
```

- Entries are matched against the request's `Origin`/`Referer` headers (browsers always send one for the widget's cross-site fetch). `*.example.com` covers subdomains.
- Mismatches get `403 { "error": "origin not allowed for this widget" }`.
- **Empty = allow all.** That's fine for development, but set it for every real client before going live — otherwise anyone with the (public) widget key could embed the bot on their own site and burn your quota.

## Production database

By default the app uses a local SQLite file (`data/chatbot.db` — zero native
dependencies, via Node's built-in `node:sqlite`). For production — where
deploys are ephemeral and data must survive restarts — point it at Postgres:

```bash
DATABASE_URL=postgresql://user:password@host:5432/chatbot
```

When `DATABASE_URL` is set, `lib/db.js` switches to the pure-JS `pg` driver (no
native compilation step); when unset, it keeps using SQLite. The schema,
migrations, and queries are dialect-portable, so you can develop on SQLite and
deploy on Postgres with no code changes. Tables and migrations run
automatically on boot in both modes.

**On Render:** create a Postgres instance, copy its **Internal Database URL**
into the service's `DATABASE_URL` env var, and redeploy. SQLite data does
**not** migrate automatically — seed or re-import as needed.

## Deployment

**Render / Railway (easiest):**
1. Push this folder to a Git repo. Set the start command to `node server.js` (run `node seed.js` once via the provider's shell first — or let the Dockerfile do it).
2. Add a persistent disk mounted at `/app/data` (SQLite lives in `data/`; without a disk, data resets on redeploy).
3. Set env vars: `SESSION_SECRET` (long random), `ENCRYPTION_KEY` (long random), `LLM_*` as needed, `TRUST_PROXY=1`. The Dockerfile sets `DB_PATH=/app/data/chatbot.db`.

**VPS (Ubuntu):**
```bash
# Node 22+ required (uses built-in node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
cd chatbot-saas && cp .env.example .env && nano .env   # set SESSION_SECRET
npm install && npm run seed
# run under pm2 or systemd:
npm i -g pm2 && pm2 start server.js --name chatbot-saas && pm2 save && pm2 startup
# put Caddy/Nginx in front for HTTPS, proxy to localhost:3000
```

**Notes:** default `express-session` uses an in-memory store — fine for one instance; use a Redis-backed session store if you scale horizontally. Back up `data/chatbot.db` regularly.

## Notes on the stack

- **SQLite via Node's built-in `node:sqlite`** (Node ≥ 22.5) — no native compilation step, so `npm install` works everywhere, including minimal Docker images and hosts without build tools. Set `DATABASE_URL` to switch the same code to Postgres (pure-JS `pg` driver) for production persistence. Passwords are hashed with `crypto.scrypt` for the same reason. If you prefer `better-sqlite3` + `bcrypt`, the data-access layer is isolated in `lib/db.js` and the hashing in `verifyPassword`/`hashPassword`.
- **Session storage** uses Express's default in-memory store — fine for a single instance; add a Redis-backed store if you scale horizontally.

## Project layout

```
├── server.js            # Express app: widget API, chat+SSE, webhook, auth, admin API, static
├── seed.js              # demo business + FAQs + mock orders + admin account
├── lib/
│   ├── db.js            # schema + queries; SQLite (node:sqlite) or Postgres (pg) via DATABASE_URL — async API
│   ├── bot.js           # chat engine: intents, capture flows, escalation, multi-language
│   ├── crawl.js         # website crawler + knowledge ingestion (chunks / LLM Q-A pairs)
│   ├── retrieval.js     # TF-IDF cosine matching over FAQs + crawled documents
│   └── llm.js           # OpenAI-compatible completions (+streaming helper)
├── public/
│   ├── widget/          # widget.js + widget.css — the embeddable snippet
│   ├── demo/            # sample storefront with widget
│   └── admin/           # admin dashboard (single-page app)
├── Dockerfile
└── .env.example
```

## Production checklist

Go through this before pointing real traffic (and paying clients) at the app:

1. **Env vars** — set all of these in your hosting provider's dashboard (never in the repo):
   - `SESSION_SECRET` — long random string (signs admin session cookies).
   - `ENCRYPTION_KEY` — long random string (AES-256-GCM for per-business LLM keys at rest). If unset, newly saved LLM keys are rejected and previously stored keys can't be decrypted — the bot falls back to FAQ-only mode. Changing it later orphans previously stored keys.
   - `TRUST_PROXY=1` — when behind a reverse proxy / load balancer (Render, Railway, nginx…), so rate limiting and logging see the real client IP.
   - `PORT`, `DB_PATH` as needed; `LLM_*` for the global AI brain default.
   - Tune rate limits: `RATE_LIMIT_CHAT_PER_MIN` (30), `RATE_LIMIT_CONFIG_PER_MIN` (120), `RATE_LIMIT_WEBHOOK_PER_MIN` (60), `RATE_LIMIT_LOGIN_PER_MIN` (10), `RATE_LIMIT_FEEDBACK_PER_MIN` (30), `RATE_LIMIT_NUDGE_PER_MIN` (60). `0` disables a limiter (not recommended).
2. **Admin credentials** — rotate every seeded/provisioned password on first login (Admin → Settings → Change password, min 8 chars). Consider one admin user per client staff member.
3. **HTTPS** — terminate TLS at your reverse proxy (nginx, Caddy, or your PaaS). Set the session cookie `secure` flag if you ever move off `sameSite: lax` defaults — with HTTPS in front, cookies are safe.
4. **Origin allowlist** — set `allowed_origins` for every client (Admin → Settings). Empty means "any site may embed this widget".
5. **Webhook secrets** — each business's secret is shown once at provision/seed and stored as a hash. Regenerate from Admin → Settings if one leaks; the old one stops working immediately.
6. **SQLite backups** — the whole product is one file (`data/chatbot.db` + WAL files). Back it up nightly: `sqlite3 data/chatbot.db ".backup '/backups/chatbot-$(date +%F).db'"` (safe while running). On Render/Railway, mount a persistent disk at `/app/data` or data resets on redeploy.
7. **Scaling** — sessions use Express's in-memory store and rate limiting is in-memory: both are fine for a single instance. For multi-instance, add a shared session store (`connect-redis`) and a shared rate-limit store (Redis), and put the instances behind your load balancer.
8. **Watch the logs** — repeated `401`/`403`/`429` on the public endpoints means someone is probing or abusing a key; rotate/regenerate credentials for the affected business.
9. **Never commit** `.env` or `data/` (already in `.gitignore`).

## Security notes

- Admin passwords are hashed with scrypt; admin sessions are httpOnly cookies.
- Per-business LLM API keys are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`) and never returned by the admin API (only `llm_api_key_set` flags).
- Webhook secrets are stored as SHA-256 hashes and shown once; the old widget-key auth on the webhook has been removed.
- The widget API key is public by design (it ships in client HTML) — it only grants *chatting* as that business, never admin access. Pair it with the origin allowlist.
- Public endpoints are rate-limited per API key + IP (chat, config, webhook) and logins per IP.
- Never commit `.env` or `data/` (see `.gitignore`).
