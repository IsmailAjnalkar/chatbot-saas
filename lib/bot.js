/**
 * Chat engine: intent detection -> FAQ/document retrieval -> LLM fallback -> lead capture.
 * Stateless per call; conversational capture state lives on the session row.
 * Multi-language: the visitor's language is detected once per session (LLM only)
 * and cached on the session; when `auto_translate` is on, every reply is
 * translated to the visitor's language before it is stored/sent.
 */
'use strict';

const db = require('./db');
const { buildRetriever } = require('./retrieval');
const llm = require('./llm');

const ANSWER_THRESHOLD = 0.35;  // cosine score: answer directly at/above this
const LOW_THRESHOLD = 0.12;     // below this the question is "unanswered"
const ORDER_RE = /\bORD[-\s]?(\d{3,})\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ESCALATION_RE = /\b(human|real person|agent|representative|call me|callback|call back|manager|someone|support team|live chat)\b/i;
const CONTACT_RE = /\b(contact me|email me|reach me|get in touch)\b/i;
const GREETING_RE = /^(hi|hey|hello|good\s?(morning|afternoon|evening)|yo|sup)\b/i;
const THANKS_RE = /\b(thank|thanks|thx|appreciated)\b/i;
const BYE_RE = /\b(bye|goodbye|see you|good night|goodnight)\b/i;
const CANCEL_RE = /^(cancel|never ?mind|stop|quit|exit|nvm)\b/i;

// Phrases the widget shows as suggestion chips — never treat these as a visitor's name.
async function chipLabels(business) {
  const labels = ['track my order', 'track another order', 'talk to a human', 'yes, thanks', 'return policy'];
  try {
    for (const f of await db.listFaqs(business.id)) labels.push(String(f.question).toLowerCase());
  } catch {}
  return labels;
}

// True when the message looks like a command/intent rather than a person's name.
async function looksLikeCommand(business, message) {
  if ((await chipLabels(business)).includes(message.toLowerCase())) return true;
  return ORDER_RE.test(message) || ESCALATION_RE.test(message) || CONTACT_RE.test(message)
    || (GREETING_RE.test(message) && message.length < 30)
    || (THANKS_RE.test(message) && message.length < 40)
    || BYE_RE.test(message);
}

function getSetting(business, key, fallback) {
  const v = business.settings[key];
  return v === undefined ? fallback : v;
}

/** Detect the visitor's ISO 639-1 language once per session (LLM only) and cache it. */
async function detectLanguage(business, session, message) {
  const cfg = llm.resolveConfig(business.settings);
  let code = 'en';
  if (cfg.enabled && message && message.trim().length >= 3) {
    try {
      const out = await llm.chatComplete(cfg, [
        { role: 'user', content: `Detect the ISO 639-1 language code of this message. Reply with only the code, nothing else.\n\nMessage: ${message.slice(0, 500)}` },
      ], { maxTokens: 10, temperature: 0 });
      const m = String(out || '').toLowerCase().match(/^[a-z]{2}/);
      if (m) code = m[0];
    } catch (err) {
      console.error('[bot] language detection failed:', err.message);
    }
  }
  try { await db.updateSession(session.id, { language: code }); } catch {}
  session.language = code;
  return code;
}

/**
 * Translate a reply to the visitor's language when `auto_translate` is on and
 * the visitor's language differs from the business's default language.
 */
async function maybeTranslate(business, session, text) {
  if (!getSetting(business, 'auto_translate', false) || !text) return text;
  const defLang = String(getSetting(business, 'default_language', 'en') || 'en').toLowerCase().slice(0, 2);
  const lang = String(session.language || 'en').toLowerCase().slice(0, 2);
  if (lang === defLang) return text;
  const cfg = llm.resolveConfig(business.settings);
  if (!cfg.enabled) return text; // translation needs the LLM
  try {
    const out = await llm.chatComplete(cfg, [
      {
        role: 'system',
        content: `Translate the following customer-support reply to ISO 639-1 language "${lang}". Keep formatting (including **bold** and line breaks) and any order numbers or URLs exactly as-is. Reply with ONLY the translation, nothing else.`,
      },
      { role: 'user', content: text },
    ], { maxTokens: 800, temperature: 0.2 });
    return out || text;
  } catch (err) {
    console.error('[bot] translation failed:', err.message);
    return text;
  }
}

/**
 * Process one visitor message. Logs both sides to the DB.
 * @returns {Promise<{sessionId, reply, type, confidence, suggestions, orderCard, messageId}>}
 */
async function processMessage({ business, apiKey, sessionId, text, visitorLabel = '' }) {
  let session = sessionId && await db.getSession(sessionId);
  if (!session || session.business_id !== business.id) {
    session = await db.createSession(business.id, visitorLabel);
  }
  sessionId = session.id;
  const message = (text || '').trim();
  await db.addMessage(sessionId, 'user', message);

  // Detect the visitor's language once per session (cached on the row).
  if (message && !session.language) {
    await detectLanguage(business, session, message);
  }

  // Single funnel for every assistant reply: translate (when enabled), append
  // a source citation for document answers, then log + return.
  const finish = async (reply, type, { confidence = 0, faq_id = null, document_id = null, suggestions = [], orderCard = null, sourceUrl = null } = {}) => {
    let finalReply = await maybeTranslate(business, session, reply);
    if (sourceUrl) finalReply += `\n\n(Source: ${sourceUrl})`;
    const messageId = await db.addMessage(sessionId, 'assistant', finalReply,
      { type, confidence, faq_id, document_id, business: business.name }, orderCard ? 'order_card' : 'text');
    return { sessionId, reply: finalReply, type, confidence, suggestions, orderCard, messageId };
  };

  if (!message) {
    return finish(getSetting(business, 'welcome_message', `Hi! How can I help you today?`), 'fallback',
      { confidence: 0, suggestions: await defaultSuggestions(business) });
  }

  // ---- 1. In-progress lead capture flow ----
  let capture = null;
  try { capture = session.capture_state ? JSON.parse(session.capture_state) : null; } catch {}
  if (capture && capture.step) {
    // Let the visitor bail out of capture at any point.
    if (CANCEL_RE.test(message)) {
      await db.updateSession(session.id, { capture_state: null });
      return finish(`No problem — how else can I help?`, 'fallback',
        { confidence: 1, suggestions: await defaultSuggestions(business) });
    }
    // Don't store a tapped suggestion chip ("Talk to a human", …) as the visitor's name —
    // drop capture and handle it as a normal message instead.
    if (capture.step === 'awaiting_name' && await looksLikeCommand(business, message)) {
      await db.updateSession(session.id, { capture_state: null });
      capture = null;
    }
  }
  if (capture && capture.step) {
    const [capReply, capType, capOpts] = await processCapture(business, session, capture, message);
    return finish(capReply, capType, capOpts);
  }

  // ---- 2. Order tracking ----
  const orderMatch = message.match(ORDER_RE);
  if (orderMatch) {
    const orderNumber = 'ORD-' + orderMatch[1];
    const order = await db.findOrder(business.id, orderNumber);
    if (order) {
      const card = { order_number: order.order_number, status: order.status, eta: order.eta, carrier: order.carrier, tracking_number: order.tracking_number, items: order.items };
      return finish(
        `Here's the latest on order ${order.order_number}: **${order.status}**${order.eta ? ` — estimated delivery ${order.eta}` : ''}${order.carrier ? ` via ${order.carrier}` : ''}${order.tracking_number ? ` (tracking: ${order.tracking_number})` : ''}. Is there anything else I can help with?`,
        'order', { confidence: 1, orderCard: card, suggestions: ['Track another order', 'Talk to a human'] });
    }
    return finish(
      `I couldn't find order ${orderNumber} in our system. Double-check the number (it looks like ORD-1234), or I can have someone from our team look into it for you.`,
      'fallback', { confidence: 0, suggestions: ['Talk to a human', 'Return policy'] });
  }

  // ---- 3. Escalation to human ----
  if (ESCALATION_RE.test(message)) {
    await db.updateSession(sessionId, { flagged_human: 1 });
    const cap = { step: 'awaiting_name', kind: 'callback', note: `Callback requested. Visitor said: "${message.slice(0, 200)}"` };
    await db.updateSession(sessionId, { capture_state: cap });
    return finish(
      `Of course — I'll get a human to follow up with you. What's your name?`,
      'capture', { confidence: 1, suggestions: [] });
  }

  // ---- 4. Explicit contact request ----
  if (CONTACT_RE.test(message)) {
    const cap = { step: 'awaiting_name', kind: 'lead', note: `Contact requested. Visitor said: "${message.slice(0, 200)}"` };
    await db.updateSession(sessionId, { capture_state: cap });
    return finish(`Happy to — what's your name?`, 'capture', { confidence: 1 });
  }

  // ---- 5. Small talk ----
  if (GREETING_RE.test(message) && message.length < 30) {
    return finish(getSetting(business, 'welcome_message', `Hi! I'm the ${business.name} assistant. How can I help you today?`),
      'smalltalk', { confidence: 1, suggestions: await defaultSuggestions(business) });
  }
  if (THANKS_RE.test(message) && message.length < 40) {
    return finish(`You're very welcome! Anything else I can help with?`, 'smalltalk', { confidence: 1 });
  }
  if (BYE_RE.test(message)) {
    return finish(`Thanks for chatting with ${business.name}! Have a great day.`, 'smalltalk', { confidence: 1 });
  }

  // ---- 6. FAQ + crawled-document retrieval ----
  const faqs = await db.listFaqs(business.id);
  const documents = await db.listDocuments(business.id);
  const retriever = buildRetriever(faqs, documents);
  const hits = retriever.search(message, 5);
  const best = hits[0];
  const bestFaq = hits.find((h) => h.kind === 'faq');

  if (best && best.score >= ANSWER_THRESHOLD) {
    if (best.kind === 'document') {
      return finish(best.document.answer, 'document',
        {
          confidence: +best.score.toFixed(3), document_id: best.document.id,
          sourceUrl: best.document.source_url, suggestions: ['Talk to a human'],
        });
    }
    return finish(best.faq.answer, 'faq',
      { confidence: +best.score.toFixed(3), faq_id: best.faq.id, suggestions: ['Talk to a human'] });
  }

  // ---- 7. LLM fallback (if configured) ----
  const llmCfg = llm.resolveConfig(business.settings);
  if (llmCfg.enabled) {
    try {
      const history = await db.getHistory(sessionId, 10);
      const messages = llm.buildKbMessages({
        businessName: business.name,
        faqs: hits.filter((h) => h.kind === 'faq').map((h) => h.faq),
        documents: hits.filter((h) => h.kind === 'document').map((h) => h.document),
        history, question: message,
      });
      const answer = await llm.chatComplete(llmCfg, messages);
      const conf = best ? Math.max(best.score, 0.2) : 0.2;
      const suggestions = (best && best.score < LOW_THRESHOLD) ? ['Talk to a human'] : [];
      return finish(answer, 'llm', { confidence: +conf.toFixed(3), suggestions });
    } catch (err) {
      console.error('[bot] LLM failed, falling back:', err.message);
      // fall through to keyword fallback
    }
  }

  // ---- 8. Keyword fallback: suggest closest topic, offer lead capture ----
  const leadCaptureOn = getSetting(business, 'lead_capture_enabled', true);
  if (bestFaq && bestFaq.score >= LOW_THRESHOLD) {
    return finish(
      `I'm not 100% sure, but this might help:\n\n**${bestFaq.faq.question}**\n${bestFaq.faq.answer}\n\nDid that answer your question? If not, I can have someone from our team reach out.`,
      'fallback', { confidence: +bestFaq.score.toFixed(3), faq_id: bestFaq.faq.id, suggestions: ['Yes, thanks', 'Talk to a human'] });
  }

  if (leadCaptureOn) {
    const cap = { step: 'awaiting_name', kind: 'lead', note: `Unanswered question: "${message.slice(0, 200)}"` };
    await db.updateSession(sessionId, { capture_state: cap });
    const supportEmail = getSetting(business, 'support_email', '');
    return finish(
      `I don't have a confident answer for that yet — sorry about that! I'd love to have someone from our team follow up. What's your name?${supportEmail ? ` (You can also email us directly at ${supportEmail}.)` : ''}`,
      'capture', { confidence: 0 });
  }

  const supportEmail = getSetting(business, 'support_email', '');
  return finish(
    `I don't have a confident answer for that yet.${supportEmail ? ` Please reach out to us at ${supportEmail} and we'll help you right away.` : ' Please try rephrasing, or ask about shipping, returns, or order tracking.'}`,
    'fallback', { confidence: 0, suggestions: await defaultSuggestions(business) });
}

/** Handle one step of the lead/callback capture conversation. */
async function processCapture(business, session, capture, message) {
  const data = capture.data || {};
  const done = async (reply) => {
    await db.updateSession(session.id, { capture_state: null });
    return [reply, 'capture', { suggestions: await defaultSuggestions(business) }];
  };

  if (capture.step === 'awaiting_name') {
    if (message.length < 2 || message.length > 60) {
      return [`I didn't quite catch that — what's your name?`, 'capture', {}];
    }
    data.name = message;
    await db.updateSession(session.id, { capture_state: { ...capture, step: 'awaiting_email', data } });
    return [`Thanks, ${data.name}! What's the best email to reach you at?`, 'capture', {}];
  }

  if (capture.step === 'awaiting_email') {
    if (/^(skip|no|n\/a|none)$/i.test(message)) {
      data.email = '';
      await db.updateSession(session.id, { capture_state: { ...capture, step: 'awaiting_phone', data } });
      return [`No problem — we'll use your phone instead. What's the best number to reach you at? (Type "skip" to skip.)`, 'capture', {}];
    }
    if (!EMAIL_RE.test(message)) {
      return [`Hmm, that doesn't look like a valid email. Could you double-check it? (Type "skip" to skip email.)`, 'capture', {}];
    }
    data.email = message;
    await db.updateSession(session.id, { capture_state: { ...capture, step: 'awaiting_phone', data } });
    return [`Got it. And a phone number in case email doesn't work? (Type "skip" to skip.)`, 'capture', {}];
  }

  if (capture.step === 'awaiting_phone') {
    data.phone = /^(skip|no|n\/a|none)$/i.test(message) ? '' : message.slice(0, 30);
    await db.addLead(business.id, {
      session_id: session.id, name: data.name, email: data.email,
      phone: data.phone, kind: capture.kind || 'lead', note: capture.note || '',
    });
    const isCallback = (capture.kind || 'lead') === 'callback';
    return done(isCallback
      ? `All set, ${data.name}! Someone from ${business.name} will call you back shortly. Anything else I can help with meanwhile?`
      : `Thanks, ${data.name}! We've got your details and someone from ${business.name} will be in touch soon. Anything else I can help with?`);
  }

  await db.updateSession(session.id, { capture_state: null });
  return [`Let's start over — how can I help you?`, 'fallback', {}];
}

async function defaultSuggestions(business) {
  const faqs = (await db.listFaqs(business.id)).slice(0, 3).map(f => f.question);
  const base = ['Track my order', 'Talk to a human'];
  return [...faqs.slice(0, 2), ...base].slice(0, 4);
}

module.exports = { processMessage };
