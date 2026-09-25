# 💰 SELLING.md — Go-to-market cheat sheet for the chatbot product

## The pitch (30 seconds)

"Most of your customer questions are the same 20 questions, asked at 11pm when nobody's around to answer. I install an AI assistant on your website that answers them instantly, tracks orders, and captures the visitor's contact details when it can't help — so you wake up to leads instead of missed chats. It takes me a day to set up, and you can watch every conversation from your own dashboard."

## Pricing (suggested)

| Tier | Setup | Monthly | For |
|---|---|---|---|
| **Starter** | $500 | $99/mo | Single site, FAQ bot, lead capture, email support |
| **Growth** | $1,000 | $199/mo | + order tracking integration, custom branding, monthly FAQ tuning |
| **Scale** | $2,500 | $399/mo | + LLM brain ( generative answers), priority support, quarterly optimization |

Why this works: setup covers your one day of work; monthly covers hosting + "it keeps getting smarter." Annual prepay: offer 2 months free to lock clients in.

## The demo (what to show, in order — 5 minutes)

1. **Open the demo store** (`/demo/`). Point at the chat bubble: "This is what your customers see."
2. **Ask a FAQ**: "What is your return policy?" → instant, confident answer. "It learned this from your website in minutes."
3. **Track an order**: type `ORD-1002` → status card appears. "It plugs into your order system — no more 'where is my order' emails."
4. **Stump it**: ask something obscure → watch it politely capture the visitor's name/email. "Every question it can't answer becomes a lead, not a lost customer."
5. **Open the admin panel** (`/admin/`): show the Leads tab, the flagged "needs human" conversation, and Analytics. "You see everything. Nothing happens in a black box."
6. **Live customization**: in Admin → Knowledge Base, add a FAQ, then ask the bot about it in the store. "You can teach it new answers yourself in 30 seconds."

## Objection handling

| They say | You say |
|---|---|
| "AI makes things up." | "This one is grounded in *your* FAQs — it's instructed to say 'I don't know' and hand to a human rather than guess. And you can read every transcript." |
| "We already have live chat." | "Live chat only works when someone's awake. This handles the 70% of repetitive questions 24/7 and hands the tricky ones to your team with context." |
| "What if it gives a wrong answer?" | "You review transcripts in the dashboard, fix the FAQ once, and it never makes that mistake again. It literally gets smarter from your corrections." |
| "We don't get that much traffic." | "Then every visitor matters more. The lead-capture flow means no visitor leaves without you getting their contact details." |
| "Too expensive." | "One recovered sale or one saved support hire pays for a year. Start on Starter — upgrade when you see the leads." |
| "Can we try before we buy?" | "Two-week pilot: I'll set it up on your site, you watch the dashboard. If it doesn't capture leads or deflect questions, we take it down, no charge." |

## New-client onboarding checklist

- [ ] Create the business: generate API key + admin account (see README for the pattern; or add a row via a small admin script)
- [ ] Collect 15–30 FAQs from their site, support inbox, and team (offer to draft them — it's the highest-value hour you spend)
- [ ] Set brand color, welcome message, support email in Admin → Settings
- [ ] Connect order data: either seed mock orders for the demo, then wire `POST /api/webhook/orders` to their store (Shopify/WooCommerce webhook → your endpoint, with the client's `X-Webhook-Secret` header)
- [ ] Add the `<script>` embed to their site (copy from Admin → Settings → Embed snippet)
- [ ] Add their LLM key if on Growth/Scale, or use your pooled key and bake it into the monthly price
- [ ] 48-hour check-in: review transcripts together, fix the first 3 unanswered questions
- [ ] 2-week review: show them the analytics (chats deflected, leads captured) → ask for a testimonial + referral

## Where to find clients

- Local service businesses with online booking (dentists, salons, clinics) — they lose calls daily.
- Shopify/WooCommerce stores doing $50k–$2M/yr — drowning in "where is my order" emails.
- SaaS startups with a docs page but no support team — the bot *is* the support team.
- Outreach angle: "I looked at your site — you get asked about [shipping/returns/pricing] a lot. I can put a 24/7 assistant on your site this week that answers those and captures leads. 10-minute demo?"

## Costs to you (per client)

- Hosting: ~$5–7/mo on Render/Railway (one instance can serve many clients).
- LLM: ~$1–10/mo per client at typical volumes on `gpt-4o-mini`; $0 if FAQ-only.
- Your time: ~1 day setup, ~1 hr/month maintenance. Price accordingly.
