/**
 * Voice calls — Twilio Programmable Voice webhooks.
 *
 * Flow: Twilio POSTs to /api/voice/twilio/incoming on call start; we answer
 * with TwiML that <Gather>s speech, then POSTs the transcript to
 * /api/voice/twilio/respond, where the transcript runs through the same
 * processMessage() pipeline as chat and the reply is read back with <Say>.
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (signature validation optional).
 * Without a twilio_phone_number setting on the business, calls get a polite
 * "not configured" message. Signature validation is enforced when
 * TWILIO_AUTH_TOKEN is set; otherwise a warning is logged (dev only).
 */
'use strict';

const crypto = require('crypto');

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Optional Twilio request-signature validation. */
function validTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const signature = req.get('X-Twilio-Signature') || '';
  if (!authToken) {
    console.warn('[voice] TWILIO_AUTH_TOKEN not set — skipping signature validation (dev mode).');
    return true;
  }
  if (!signature) return false;
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = Object.keys(req.body || {}).sort().reduce((acc, k) => acc + k + req.body[k], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(params, 'utf8')).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function gatherTwiml(prompt, actionUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" language="en-US" speechTimeout="auto" timeout="6">
    <Say>${xmlEscape(prompt)}</Say>
  </Gather>
  <Say>We didn't hear anything. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

function sayTwiml(message, actionUrl) {
  // Read the answer, then keep listening for a follow-up question.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${xmlEscape(message)}</Say>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" language="en-US" speechTimeout="auto" timeout="6">
    <Say>Is there anything else I can help with?</Say>
  </Gather>
  <Say>Thanks for calling. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

function rejectTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${xmlEscape(message)}</Say>
  <Hangup/>
</Response>`;
}

module.exports = { validTwilioSignature, gatherTwiml, sayTwiml, rejectTwiml };
