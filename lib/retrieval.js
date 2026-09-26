/**
 * Retrieval: TF-IDF cosine similarity over a business's FAQ knowledge base.
 * Simple, dependency-free, and genuinely effective for FAQ matching.
 */
'use strict';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she', 'it', 'we',
  'they', 'me', 'my', 'your', 'our', 'their', 'this', 'that', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'about',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'can', 'could',
  'should', 'would', 'will', 'just', 'so', 'if', 'not', 'no', 'yes', 'get',
  'please', 'there', 'here', 'into', 'up', 'out', 'over', 'under', 'than',
]);

function tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const n = tokens.length || 1;
  for (const k in tf) tf[k] = tf[k] / n;
  return tf;
}

/**
 * Build a retriever over one business's FAQ list plus crawled documents.
 * Search hits are shaped {kind:'faq'|'document', faq?, document?, score}.
 * @param {Array} faqs rows with {id, question, answer, keywords}
 * @param {Array} documents rows with {id, source_url, title, question, answer}
 */
function buildRetriever(faqs, documents = []) {
  const docs = [];
  for (const f of faqs || []) {
    const text = `${f.question} ${f.question} ${f.keywords || ''}`; // question weighted 2x
    docs.push({ kind: 'faq', faq: f, tokens: tokenize(text) });
  }
  for (const d of documents || []) {
    // A generated Q/A pair gets the same 2x question weighting; a raw chunk
    // is indexed on its full text.
    const text = d.question ? `${d.question} ${d.question} ${d.answer || ''}` : (d.answer || '');
    docs.push({ kind: 'document', document: d, tokens: tokenize(text) });
  }
  const N = Math.max(docs.length, 1);
  const df = {};
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const t in df) idf[t] = Math.log(1 + N / df[t]);

  function vector(tokens) {
    const tf = termFreq(tokens);
    const v = {};
    for (const t in tf) v[t] = tf[t] * (idf[t] || Math.log(1 + N)); // unseen terms get max idf
    return v;
  }
  const docVectors = docs.map(d => {
    const v = vector(d.tokens);
    const norm = Math.sqrt(Object.values(v).reduce((s, x) => s + x * x, 0)) || 1;
    return { kind: d.kind, faq: d.faq, document: d.document, v, norm };
  });

  function search(query, topK = 3) {
    const qv = vector(tokenize(query));
    const qnorm = Math.sqrt(Object.values(qv).reduce((s, x) => s + x * x, 0));
    if (!qnorm) return [];
    return docVectors.map(d => {
      let dot = 0;
      for (const t in qv) if (d.v[t]) dot += qv[t] * d.v[t];
      const hit = { kind: d.kind, score: dot / (qnorm * d.norm) };
      if (d.kind === 'faq') hit.faq = d.faq; else hit.document = d.document;
      return hit;
    }).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  return { search };
}

/** Alias kept for clarity at call sites that mix FAQs and crawled documents. */
const buildHybridRetriever = buildRetriever;

module.exports = { buildRetriever, buildHybridRetriever, tokenize };
