/**
 * In-memory sliding-window rate limiter middleware.
 * Fine for single-instance deployments (the default). For multi-instance,
 * replace with a shared store (e.g. Redis) — see README "Production checklist".
 */
'use strict';

function createLimiter({ windowMs = 60000, max = 60, keyFn = (req) => req.ip, message = 'rate limit exceeded, please slow down' } = {}) {
  // max <= 0 disables the limiter
  if (!(max > 0)) return (req, res, next) => next();

  const hits = new Map();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const fresh = arr.filter((t) => t > cutoff);
      if (fresh.length) hits.set(k, fresh);
      else hits.delete(k);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return function rateLimit(req, res, next) {
    let key;
    try {
      key = keyFn(req) || req.ip;
    } catch {
      key = req.ip;
    }
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(key) || []).filter((t) => t > cutoff);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

module.exports = { createLimiter };
