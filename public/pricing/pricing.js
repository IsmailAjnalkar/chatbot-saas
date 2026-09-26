/**
 * Pricing page behavior:
 *  - checks /api/billing/status; when Stripe is configured, the Subscribe
 *    buttons redirect to /api/billing/checkout?plan=… — otherwise a
 *    "Contact us" mailto CTA is shown instead.
 */
(function () {
  'use strict';

  var buyButtons = document.getElementById('buy-buttons');
  var contactCta = document.getElementById('contact-cta');
  var err = document.getElementById('signup-err');

  fetch('/api/billing/status')
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.configured) {
        buyButtons.style.display = 'flex';
        contactCta.style.display = 'none';
      } else {
        buyButtons.style.display = 'none';
        contactCta.style.display = 'block';
      }
    })
    .catch(function () {
      // If the status check itself fails, fall back to the contact CTA.
      buyButtons.style.display = 'none';
      contactCta.style.display = 'block';
    });

  buyButtons.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-plan]') : null;
    if (!btn) return;
    var name = document.getElementById('business-name').value.trim();
    var user = document.getElementById('admin-username').value.trim();
    if (!name || !user) {
      err.style.display = 'block';
      err.textContent = 'Please enter your business name and an admin username first.';
      return;
    }
    err.style.display = 'none';
    var url = '/api/billing/checkout?plan=' + encodeURIComponent(btn.getAttribute('data-plan')) +
      '&business_name=' + encodeURIComponent(name) +
      '&admin_username=' + encodeURIComponent(user);
    window.location.href = url;
  });
})();
