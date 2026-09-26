/**
 * Sentiment scoring for priority routing — no LLM cost, no network.
 *
 * Lexicon-based: each message scores in [-1, 1]. Strong negative signals
 * (anger, legal threats, chargeback talk) push toward -1. The bot keeps a
 * rolling average on the session; escalations inherit ticket priority from it.
 */
'use strict';

const NEGATIVE = new Map([
  // word -> weight (negative)
  ['angry', -0.6], ['furious', -0.9], ['terrible', -0.7], ['awful', -0.7],
  ['horrible', -0.7], ['worst', -0.7], ['hate', -0.7], ['disgusting', -0.8],
  ['pathetic', -0.8], ['useless', -0.7], ['stupid', -0.6], ['idiot', -0.7],
  ['scam', -0.9], ['fraud', -0.9], ['cheat', -0.8], ['lied', -0.7], ['lying', -0.7],
  ['refund', -0.3], ['chargeback', -0.9], ['dispute', -0.6], ['lawsuit', -1.0],
  ['lawyer', -0.9], ['sue', -0.9], ['court', -0.8], ['complaint', -0.6],
  ['complain', -0.5], ['unacceptable', -0.8], ['ridiculous', -0.7], ['outrageous', -0.8],
  ['never again', -0.7], ['cancel everything', -0.6], ['waste', -0.5],
  ['broken', -0.4], ['damaged', -0.4], ['wrong', -0.3], ['late', -0.3],
  ['waiting', -0.2], ['still', -0.15], ['annoying', -0.5], ['frustrating', -0.5],
  ['disappointed', -0.5], ['upset', -0.5], ['mad', -0.6],
]);

const POSITIVE = new Map([
  ['love', 0.7], ['great', 0.5], ['awesome', 0.6], ['excellent', 0.6],
  ['perfect', 0.6], ['amazing', 0.6], ['thank', 0.4], ['thanks', 0.4],
  ['happy', 0.5], ['pleased', 0.4], ['wonderful', 0.6], ['fantastic', 0.6],
  ['good', 0.3], ['nice', 0.3], ['helpful', 0.4], ['fast', 0.2],
]);

const INTENSIFIERS = new Map([
  ['very', 1.4], ['really', 1.4], ['extremely', 1.7], ['so', 1.3],
  ['absolutely', 1.5], ['totally', 1.4], ['completely', 1.4],
]);

/** Score one message in [-1, 1]. */
function scoreMessage(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  let score = 0;
  let hits = 0;
  const check = (lexicon, sign) => {
    for (const [word, weight] of lexicon) {
      if (t.includes(word)) {
        let w = weight;
        for (const [intens, mult] of INTENSIFIERS) {
          if (t.includes(intens)) { w *= mult; break; }
        }
        score += sign * Math.abs(w);
        hits++;
      }
    }
  };
  check(NEGATIVE, -1);
  check(POSITIVE, 1);
  if (!hits) return 0;
  // ALL-CAPS shouting amplifies negativity
  const caps = (String(text).match(/[A-Z]{4,}/g) || []).length;
  if (caps && score < 0) score *= 1.2;
  return Math.max(-1, Math.min(1, score / Math.max(1, hits * 0.8)));
}

/** Rolling average: newAvg = 0.7 * old + 0.3 * latest. */
function rollAverage(prev, latest) {
  return Math.round((0.7 * (prev || 0) + 0.3 * latest) * 100) / 100;
}

/** Ticket priority from session sentiment. */
function priorityForSentiment(sentiment) {
  if (sentiment <= -0.6) return 'urgent';
  if (sentiment <= -0.3) return 'high';
  if (sentiment >= 0.3) return 'low';
  return 'normal';
}

module.exports = { scoreMessage, rollAverage, priorityForSentiment };
