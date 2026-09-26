/**
 * Website knowledge ingestion — polite same-domain crawler + chunker.
 *
 * crawlSite(startUrl, {maxPages, onProgress}) -> [{url, title, chunks[]}]
 * ingestPages(business, pages)               -> stores chunks as documents;
 *   when the business has an LLM configured, each chunk is first turned into
 *   2-4 customer-style Q/A pairs via the LLM, otherwise the raw chunk is stored.
 */
'use strict';

const db = require('./db');
const llm = require('./llm');

const USER_AGENT = 'Mozilla/5.0 (compatible; ChatbotSaaS-Crawler/1.0; +https://chatbot-saas)';
const FETCH_TIMEOUT_MS = 10000;
const MAX_BYTES = 2 * 1024 * 1024; // ~2MB cap per page
const CHUNK_LEN = 800;

function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  return u.toString();
}

/** Fetch HTML with a timeout and a size cap; null on any failure / non-HTML. */
async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok || !res.body) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch { return ''; } });
}

function cleanText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** Strip boilerplate, keep link targets, return title + plain text + outbound hrefs. */
function extractPage(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]).slice(0, 200) : url;
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  const links = [];
  const linkRe = /<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = linkRe.exec(body))) links.push(m[1]);
  // Keep paragraph structure for chunking, then strip the rest of the tags.
  body = body
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|li|tr|blockquote)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  const text = body.split('\n').map((l) => cleanText(l)).filter(Boolean).join('\n');
  return { title, text, links };
}

/** Split text into ~800-char chunks on paragraph/sentence boundaries. */
function chunkText(text, maxLen = CHUNK_LEN) {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
  const chunks = [];
  const push = (c) => { const t = c.trim(); if (t.length > 40) chunks.push(t); };
  let cur = '';
  for (const p of paras) {
    if (p.length > maxLen) {
      push(cur); cur = '';
      const sents = p.split(/(?<=[.!?])\s+/);
      let s = '';
      for (const sent of sents) {
        if ((s + ' ' + sent).trim().length > maxLen) { push(s); s = sent; }
        else s = (s ? s + ' ' : '') + sent;
      }
      push(s);
      continue;
    }
    if ((cur + '\n\n' + p).length > maxLen) { push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  push(cur);
  return chunks;
}

/**
 * Breadth-first crawl of one domain starting at startUrl.
 * Same-origin links only, skips non-HTML content types, polite user-agent.
 */
async function crawlSite(startUrl, { maxPages = 20, onProgress } = {}) {
  const start = new URL(startUrl);
  const origin = start.origin;
  const seen = new Set();
  const queue = [normalizeUrl(start.toString())];
  const pages = [];
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await fetchHtml(url);
    if (html) {
      const { title, text, links } = extractPage(html, url);
      const chunks = chunkText(text);
      if (chunks.length) pages.push({ url, title, chunks });
      for (const href of links) {
        let u;
        try { u = new URL(href, url); } catch { continue; }
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        if (u.origin !== origin) continue; // same-domain only
        const n = normalizeUrl(u.toString());
        if (!seen.has(n) && !queue.includes(n) && queue.length < maxPages * 10) queue.push(n);
      }
    }
    if (onProgress) { try { onProgress({ pages: pages.length, queued: queue.length }); } catch {} }
  }
  return pages;
}

/** Ask the LLM to turn one text chunk into 2-4 customer-style Q/A pairs. */
async function generateQAPairs(cfg, chunk) {
  const out = await llm.chatComplete(cfg, [
    {
      role: 'system',
      content: 'You generate concise customer-support Q/A pairs. Based ONLY on the text below, generate 2-4 question/answer pairs a customer might ask. Return ONLY a JSON array of objects with "question" and "answer" keys — no other text, no markdown fences.',
    },
    { role: 'user', content: chunk.slice(0, 3000) },
  ], { maxTokens: 700, temperature: 0.3 });
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON array in LLM response');
  const arr = JSON.parse(out.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('LLM response was not an array');
  return arr
    .filter((p) => p && p.question && p.answer)
    .slice(0, 4)
    .map((p) => ({
      question: String(p.question).slice(0, 500),
      answer: String(p.answer).slice(0, 2000),
    }));
}

/**
 * Store crawled pages as documents for a business. Replaces anything
 * previously imported from the same page URLs.
 */
async function ingestPages(business, pages) {
  const llmCfg = llm.resolveConfig(business.settings);
  let stored = 0;
  for (const page of pages) {
    await db.clearDocumentsByUrl(business.id, page.url);
    for (const chunk of page.chunks) {
      if (llmCfg.enabled) {
        try {
          const pairs = await generateQAPairs(llmCfg, chunk);
          for (const p of pairs) {
            await db.addDocument({
              businessId: business.id, sourceUrl: page.url, title: page.title,
              question: p.question, answer: p.answer,
            });
            stored++;
          }
          continue; // QA pairs stored — no need for the raw chunk
        } catch (err) {
          console.error('[crawl] Q/A generation failed, storing raw chunk:', err.message);
        }
      }
      await db.addDocument({
        businessId: business.id, sourceUrl: page.url, title: page.title,
        question: null, answer: chunk,
      });
      stored++;
    }
  }
  return stored;
}

module.exports = { crawlSite, ingestPages, chunkText, extractPage, normalizeUrl };
