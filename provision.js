// Provision a new tenant: node provision.js "Acme Inc" acme-admin
// Prints the widget API key + admin credentials (shown once — give them to the client).
require('dotenv').config();
const crypto = require('crypto');
const db = require('./lib/db');

async function main() {
  const [name, adminUser] = process.argv.slice(2);
  if (!name || !adminUser) {
    console.error('Usage: node provision.js "Business Name" admin-username');
    process.exit(1);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (await db.getBusinessById(slug)) {
    console.error(`Business "${slug}" already exists.`);
    process.exit(1);
  }

  const business = await db.createBusiness({
    id: slug,
    name,
    settings: { welcome_message: `Hi! I am the ${name} assistant. How can I help?`, lead_capture_enabled: true },
  });
  const apiKey = (await db.getBusinessById(slug)).api_key;
  const password = 'admin-' + crypto.randomBytes(4).toString('hex');
  await db.createAdmin(business.id, adminUser, password);

  console.log('\nTenant provisioned!\n');
  console.log(`  Business:    ${name} (${slug})`);
  console.log(`  Widget key:  ${apiKey}`);
  console.log(`  Webhook secret: ${business.webhook_secret}`);
  console.log('  (shown once — the store sends it as the X-Webhook-Secret header to POST /api/webhook/orders)');
  console.log(`  Admin login: ${adminUser} / ${password}`);
  console.log('\nEmbed snippet:');
  console.log(`  <script src="https://YOUR-HOST/widget/widget.js" data-api-key="${apiKey}" data-api-url="https://YOUR-HOST"></script>`);
  console.log('\nGive the admin credentials to the client, then have them change the password (Admin -> Settings).');
}

main().catch((err) => {
  console.error('Provision failed:', err.message);
  process.exit(1);
});
