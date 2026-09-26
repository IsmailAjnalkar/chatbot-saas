/**
 * LLM integration — OpenAI-compatible chat completions API via fetch.
 * Works with OpenAI, Azure OpenAI (chat completions endpoint), Ollama,
 * vLLM, OpenRouter, Together, etc. — anything speaking the /chat/completions dialect.
 *
 * Config resolution: per-business settings override global env.
 *   settings.llm_base_url / LLM_BASE_URL, settings.llm_model / LLM_MODEL,
 *   settings.llm_api_key / LLM_API_KEY.  LLM is disabled when no API key is set
 *   (settings.llm_enabled !== false and env LLM_ENABLED !== '0' also required).
 */
'use strict';

function resolveConfig(settings) {
  const s = settings || {};
  const enabledEnv = process.env.LLM_ENABLED !== '0';
  const enabledSetting = s.llm_enabled !== false;
  const apiKey = s.llm_api_key || process.env.LLM_API_KEY || '';
  const baseUrl = (s.llm_base_url || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = s.llm_model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const enabled = enabledEnv && enabledSetting && !!apiKey;
  return { enabled, apiKey, baseUrl, model };
}

/**
 * Non-streaming completion.
 * @returns {Promise<string>} assistant text
 */
async function chatComplete(cfg, messages, { maxTokens = 500, temperature = 0.4 } = {}) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('LLM returned no content');
  return text.trim();
}

/**
 * Streaming completion. Calls onToken(chunk) for each content delta.
 * @returns {Promise<string>} full assistant text
 */
async function chatCompleteStream(cfg, messages, onToken, { maxTokens = 500, temperature = 0.4 } = {}) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature, stream: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        const piece = delta && (delta.content || '');
        if (piece) { full += piece; if (onToken) onToken(piece); }
      } catch { /* ignore malformed chunk */ }
    }
  }
  return full.trim();
}

/**
 * Build the messages array for answering a customer question with KB context.
 * `documents` are crawled website documents (with source URLs for citation).
 */
function buildKbMessages({ businessName, faqs, documents = [], history, question }) {
  const kb = faqs.map((f, i) => `[${i + 1}] Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
  const docKb = documents.map((d, i) =>
    `[D${i + 1}] ${d.question ? `Q: ${d.question}\nA: ` : ''}${d.answer}${d.source_url ? `\n(Source: ${d.source_url})` : ''}`
  ).join('\n\n');
  const fullKb = [kb, docKb].filter(Boolean).join('\n\n');
  const hist = (history || []).slice(-8).map(m =>
    `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.text}`).join('\n');
  return [
    {
      role: 'system',
      content: `You are the friendly customer support chatbot for "${businessName}". Answer the customer's question using ONLY the knowledge base below. Be concise (2-4 sentences), warm, and specific. If the knowledge base does not contain the answer, say so honestly in one sentence and offer to connect them with a human agent — do not invent policies, prices, or timelines.\n\nKNOWLEDGE BASE:\n${fullKb || '(empty)'}`,
    },
    ...(hist ? [{ role: 'user', content: `Recent conversation:\n${hist}` }] : []),
    { role: 'user', content: question },
  ];
}

/**
 * Tool (function) calling — OpenAI-style: the model may respond with
 * response.choices[0].message.tool_calls instead of content.
 * @returns {Promise<{content: string, toolCalls: Array<{name: string, args: object}>}>}
 */
async function chatCompleteTools(cfg, messages, tools, { maxTokens = 500, temperature = 0.4 } = {}) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model, messages, max_tokens: maxTokens, temperature, stream: false,
      tools: (tools || []).map((t) => ({ type: 'function', function: t })),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  const toolCalls = [];
  for (const tc of (message && message.tool_calls) || []) {
    if (tc.type !== 'function' || !tc.function || !tc.function.name) continue;
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
    toolCalls.push({ name: tc.function.name, args });
  }
  const content = (message && typeof message.content === 'string' ? message.content : '').trim();
  return { content, toolCalls };
}

module.exports = { resolveConfig, chatComplete, chatCompleteStream, chatCompleteTools, buildKbMessages };
