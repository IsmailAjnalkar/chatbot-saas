/**
 * Messaging channels — WhatsApp Cloud API + Facebook Messenger.
 *
 * Everything here is env-gated and completely inert without keys:
 * senders no-op (console.warn) when the provider token is missing, so the
 * server boots and runs identically whether or not channels are configured.
 */
'use strict';

const db = require('./db');
const { processMessage } = require('./bot');

const GRAPH = 'https://graph.facebook.com/v19.0';

function whatsappPhoneNumberId(business) {
  const s = (business && business.settings) || {};
  return s.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
}
function whatsappToken() {
  return process.env.WHATSAPP_TOKEN || '';
}
function messengerToken(business) {
  const s = (business && business.settings) || {};
  return s.messenger_page_access_token || process.env.META_PAGE_ACCESS_TOKEN || '';
}

/** Send a plain-text WhatsApp message via the Cloud API. */
async function sendWhatsAppText(business, to, text) {
  const token = whatsappToken();
  const phoneNumberId = whatsappPhoneNumberId(business);
  if (!token || !phoneNumberId) {
    console.warn('[channels] WhatsApp send skipped — WHATSAPP_TOKEN or phone number ID not configured.');
    return false;
  }
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[channels] WhatsApp send failed (${res.status}):`, body.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[channels] WhatsApp send error:', err.message);
    return false;
  }
}

/** Send a plain-text Messenger message via the Send API. */
async function sendMessengerText(business, psid, text) {
  const token = messengerToken(business);
  if (!token) {
    console.warn('[channels] Messenger send skipped — META_PAGE_ACCESS_TOKEN not configured.');
    return false;
  }
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[channels] Messenger send failed (${res.status}):`, body.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[channels] Messenger send error:', err.message);
    return false;
  }
}

async function sendChannelText(business, channel, sender, text) {
  if (channel === 'whatsapp') return sendWhatsAppText(business, sender, text);
  if (channel === 'messenger') return sendMessengerText(business, sender, text);
  return false;
}

/**
 * Route one inbound channel message through the bot and send the reply back.
 * Finds (or creates) the session for this channel sender.
 * @returns {Promise<object>} the processMessage result
 */
async function handleChannelMessage(business, channel, sender, text) {
  let session = await db.findSessionByChannel(business.id, channel, sender);
  if (!session) {
    session = await db.createSession(business.id, String(sender || ''), { channel, channelSender: String(sender || '') });
  }
  const result = await processMessage({
    business,
    sessionId: session.id,
    text: String(text || ''),
    visitorLabel: session.visitor_label || String(sender || ''),
  });
  try {
    await sendChannelText(business, channel, sender, result.reply);
  } catch (err) {
    console.error('[channels] reply send failed:', err.message);
  }
  return result;
}

module.exports = {
  sendWhatsAppText,
  sendMessengerText,
  sendChannelText,
  handleChannelMessage,
  whatsappConfigured: () => !!whatsappToken(),
  messengerConfigured: () => !!messengerToken(),
};
