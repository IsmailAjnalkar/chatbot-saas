/**
 * Seed a demo business ("Glow & Co.") with sample FAQs, mock orders,
 * and an admin account. Run: npm run seed
 * Idempotent — skips if the demo business already exists.
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const db = require('./lib/db');

const BUSINESS_ID = 'glow-co';

async function main() {
  if (await db.getBusinessById(BUSINESS_ID)) {
    console.log('Demo business already exists — skipping seed.');
    return;
  }

  const business = await db.createBusiness({
    id: BUSINESS_ID,
    name: 'Glow & Co.',
    settings: {
      bot_name: 'Glow Assistant',
      welcome_message: "Hi! I'm the Glow & Co. assistant. Ask me about shipping, returns, or tracking your order!",
      brand_color: '#7c3aed',
      support_email: 'hello@glowandco.example',
      lead_capture_enabled: true,
      // The demo business is a system account, not a signup — always verified
      // so email-verification enforcement on login can never lock it out.
      email_verified: true,
    },
  });

  const FAQS = [
    ['What are your shipping options?', 'We offer Standard shipping (5-7 business days, $4.95, free over $50), Express (2-3 business days, $12.95), and Overnight ($24.95). Orders placed before 2pm ET ship the same day.', 'shipping delivery ship how long arrive'],
    ['What is your return policy?', 'You can return any unopened product within 30 days of delivery for a full refund. Opened skincare can be returned within 14 days if you had a reaction — just contact us first. Start a return from your account page or reply here.', 'return refund exchange send back'],
    ['How do I track my order?', 'Just type your order number (it looks like ORD-1001) and I\'ll pull up the latest status for you right away.', 'track tracking where is my order status package'],
    ['Do you offer discounts or a loyalty program?', 'Yes! New customers get 15% off their first order with code GLOW15. Our Glow Rewards program earns you 1 point per $1 spent — 100 points = $10 off.', 'discount coupon promo code sale loyalty rewards'],
    ['Are your products cruelty-free and vegan?', 'Yes — every Glow & Co. product is 100% cruelty-free and vegan. We never test on animals and all formulas are paraben-free and fragrance-free.', 'cruelty free vegan animals testing ingredients'],
    ['Which moisturizer is right for my skin type?', 'For dry skin we recommend our Hydra Silk Cream; for oily or combination skin, the Featherweight Gel Moisturizer; for sensitive skin, the Calm Cloud Barrier Cream. All are fragrance-free.', 'moisturizer skin type dry oily sensitive recommend which product'],
    ['Do you ship internationally?', 'We currently ship to the US, Canada, UK, and Australia. International shipping takes 7-14 business days and costs a flat $14.95. Duties may apply at checkout.', 'international worldwide canada uk australia abroad'],
    ['What are your customer support hours?', 'Our support team is available Monday-Friday, 9am-6pm ET. This chatbot is here 24/7 for instant answers about orders, shipping, and returns.', 'support hours contact help when open'],
  ];

  for (const [q, a, k] of FAQS) await db.addFaq(business.id, q, a, k);

  const ORDERS = [
    ['ORD-1001', 'Delivered', '', 'UPS', '1Z8845W20398451234', 'Hydra Silk Cream x1'],
    ['ORD-1002', 'Out for delivery', 'today by 8pm', 'FedEx', '784512039641', 'Featherweight Gel Moisturizer x2'],
    ['ORD-1003', 'Shipped', 'Sep 24', 'USPS', '94001118992233445566', 'Calm Cloud Barrier Cream x1, Vitamin C Serum x1'],
    ['ORD-1004', 'Processing', 'ships within 24h', '', '', 'Glow Starter Kit x1'],
    ['ORD-1005', 'Delivered', '', 'UPS', '1Z8845W20398459999', 'Rosehip Face Oil x1'],
  ];
  for (const [n, status, eta, carrier, tracking, items] of ORDERS) {
    await db.upsertOrder(business.id, { order_number: n, status, eta, carrier, tracking_number: tracking, items });
  }

  const adminUser = 'glowadmin';
  // Stable password when ADMIN_PASSWORD is set (e.g. production); otherwise
  // generate a random one per seed so local/dev installs don't share a default.
  const adminPass = process.env.ADMIN_PASSWORD || ('glow-' + crypto.randomBytes(3).toString('hex'));
  await db.createAdmin(business.id, adminUser, adminPass);

  console.log('\nSeed complete!\n');
  console.log('  Demo store:  http://localhost:3000/demo/');
  console.log('  Admin panel: http://localhost:3000/admin/');
  console.log(`  Admin login: ${adminUser} / ${adminPass}`);
  console.log('  (Change the password after first login: Settings tab -> Change password)\n');
  console.log('  Widget API key:', business.api_key);
  console.log('  Webhook secret:', business.webhook_secret);
  console.log('  (shown once — send as the X-Webhook-Secret header to POST /api/webhook/orders)\n');
  console.log('\nEmbed snippet for a client site:\n');
  console.log(`  <script src="http://localhost:3000/widget/widget.js"`);
  console.log(`          data-api-key="${business.api_key}"`);
  console.log(`          data-api-url="http://localhost:3000"></script>\n`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
