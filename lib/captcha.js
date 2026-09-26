/**
 * CAPTCHA verification (hCaptcha). Active only when HCAPTCHA_SECRET is set —
 * otherwise verification is skipped so self-hosted installs keep working.
 *
 * Frontend: render the hCaptcha widget on signup/login forms and send the
 * resulting token as `captcha_token` in the POST body.
 */
async function verifyCaptcha(token, remoteIp) {
  const secret = process.env.HCAPTCHA_SECRET || '';
  if (!secret) return { ok: true, skipped: true }; // not configured
  if (!token) return { ok: false, error: 'captcha required' };
  try {
    const params = new URLSearchParams({ secret, response: String(token) });
    if (remoteIp) params.set('remoteip', remoteIp);
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success) return { ok: true };
    return { ok: false, error: 'captcha verification failed' };
  } catch (err) {
    console.error('[captcha] verify error:', err.message);
    return { ok: false, error: 'captcha service unavailable' };
  }
}

function captchaConfigured() {
  return !!process.env.HCAPTCHA_SECRET;
}

function captchaSiteKey() {
  return process.env.HCAPTCHA_SITEKEY || '';
}

module.exports = { verifyCaptcha, captchaConfigured, captchaSiteKey };
