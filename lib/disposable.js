/**
 * Disposable / throwaway email domain blocklist.
 * Used at signup to stop bot signups and free-trial abuse. This is a curated
 * core list — extend DISPOSABLE_DOMAINS_EXTRA (comma-separated env var) for more.
 */
const CORE_DOMAINS = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator.org', 'guerrillamail.com', 'guerrillamail.net',
  'guerrillamail.org', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'temp-mail.io', 'throwawaymail.com', 'getnada.com', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'fakeinbox.com', 'trashmail.com', 'trashmail.net', 'trashmail.org', 'sharklasers.com',
  'grr.la', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'mytrashmail.com',
  'spamgourmet.com', 'spamgourmet.net', 'spamgourmet.org', 'spambog.com', 'spambog.net',
  'tempail.com', 'tempinbox.com', 'tmpmail.org', 'tmpmail.net', 'burnermail.io', 'mohmal.com',
  'emailondeck.com', 'getairmail.com', 'tmail.ws', 'inboxkitten.com', 'anonymbox.com',
  'mailcatch.com', 'moakt.com', 'emailfake.com', 'fakemail.net', 'deadaddress.com',
  'despam.it', 'discardmail.com', 'e4ward.com', 'gishpuppy.com', 'jetable.org', 'kasmail.com',
  'mailmoat.com', 'mailnull.com', 'nada.email', 'wegwerfmail.de', 'wegwerfmail.net',
  'wegwerfmail.org', 'spam4.me', 'spambox.us', 'binkmail.com', 'bobmail.info', 'chammy.info',
  'dodgeit.com', 'dontreg.com', 'e-mail.ph', 'filzmail.com', 'hmamail.com', 'incognitomail.org',
  'ipoo.org', 'irish2me.com', 'klassmaster.com', 'lroid.com', 'mail2rss.org', 'mailbidon.com',
  'mailblocks.com', 'mailquack.com', 'mailshell.com', 'mailsiphon.com', 'mailzilla.com',
  'mt2009.com', 'mytempemail.com', 'nobulk.com', 'nospam.ze.tc', 'nurfuerspam.de',
  'objectmail.com', 'pookmail.com', 'proxymail.eu', 'rcpt.at', 'recode.me', 'safersignup.de',
  'sneakemail.com', 'soodonims.com', 'sofort-mail.de', 'sogetthis.com', 'tagyourself.com',
  'teewars.com', 'teleworm.com', 'tempalias.com', 'tempe-mail.com', 'tempemail.net',
  'thankyou2010.com', 'twinmail.de', 'upliftnow.com', 'venompen.com', 'willhackforfood.biz',
  'wuzup.net', 'xagloo.com', 'xemaps.com', 'xents.com', 'xmaily.com', 'xoxy.net', 'yapped.net',
  'yeah.net', 'yep.it', 'zeqn.com', 'zippymail.info', 'zoemail.org', '0-mail.com', '0815.ru',
  '1ce.us', '1chuan.com', '1zhuan.com', '20mail.it', '2prong.com', '4mail.cf', '4mail.ga',
  '5mail.cf', '5mail.ga', '60minutemail.com', '675hosting.com', '6url.com', '75hosting.com',
  '7mail.ga', '7mail.ml', '8mail.cf', '8mail.ga', '8mail.ml', '99experts.com', '9ox.net',
]);

function extraDomains() {
  const raw = process.env.DISPOSABLE_DOMAINS_EXTRA || '';
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** True when the email's domain is a known disposable/throwaway domain. */
function isDisposableEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (!domain) return false;
  if (CORE_DOMAINS.has(domain)) return true;
  return extraDomains().includes(domain);
}

module.exports = { isDisposableEmail, disposableDomainCount: CORE_DOMAINS.size };
