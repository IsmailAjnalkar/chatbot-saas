/**
 * Embeddable customer-service chat widget.
 *
 * Usage (paste into any site):
 *   <script src="https://YOUR-HOST/widget/widget.js"
 *           data-api-key="cb_..."
 *           data-api-url="https://YOUR-HOST"></script>
 *
 * Optional: data-position="bottom-right|bottom-left", data-z-index="9999"
 */
(function () {
  'use strict';

  var scripts = document.getElementsByTagName('script');
  var me = scripts[scripts.length - 1];
  var API_KEY = me.getAttribute('data-api-key') || '';
  var API_URL = (me.getAttribute('data-api-url') || '').replace(/\/$/, '');
  var POSITION = me.getAttribute('data-position') || 'bottom-right';

  if (!API_KEY || !API_URL) {
    console.error('[chat-widget] missing data-api-key or data-api-url');
    return;
  }

  var sessionId = null;
  try { sessionId = localStorage.getItem('cb_session_' + API_KEY); } catch (e) {}

  var cfg = { business_name: 'Support', welcome_message: 'Hi! How can I help?', brand_color: '#4f46e5', bot_name: 'Assistant' };

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // lightweight markdown-ish rendering for bot replies (**bold**, line breaks)
  function renderBot(text) {
    var h = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    return h;
  }

  function build() {
    // container
    var root = el('div', 'cbw-root cbw-' + POSITION);
    root.style.setProperty('--cbw-brand', cfg.brand_color);

    // launcher button
    var launcher = el('button', 'cbw-launcher', '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>');
    launcher.setAttribute('aria-label', 'Open chat');

    // panel
    var panel = el('div', 'cbw-panel cbw-hidden');

    var header = el('div', 'cbw-header',
      '<div class="cbw-avatar">' + esc(cfg.business_name.charAt(0).toUpperCase()) + '</div>' +
      '<div class="cbw-title"><strong>' + esc(cfg.bot_name) + '</strong><span>Typically replies instantly</span></div>' +
      '<button class="cbw-close" aria-label="Close chat">&times;</button>');

    var body = el('div', 'cbw-body');

    var chips = el('div', 'cbw-chips');

    var footer = el('div', 'cbw-footer');
    var input = el('input', 'cbw-input');
    input.placeholder = 'Type your message...';
    input.setAttribute('aria-label', 'Type your message');
    var send = el('button', 'cbw-send', '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>');
    send.setAttribute('aria-label', 'Send');

    footer.appendChild(input);
    footer.appendChild(send);
    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(chips);
    panel.appendChild(footer);
    root.appendChild(launcher);
    root.appendChild(panel);
    document.body.appendChild(root);

    var opened = false;
    function toggle(force) {
      opened = force !== undefined ? force : !opened;
      panel.classList.toggle('cbw-hidden', !opened);
      launcher.classList.toggle('cbw-open', opened);
      if (opened) input.focus();
    }
    launcher.addEventListener('click', function () { toggle(); });
    header.querySelector('.cbw-close').addEventListener('click', function () { toggle(false); });

    function scrollDown() { body.scrollTop = body.scrollHeight; }

    function addMsg(who, html) {
      var row = el('div', 'cbw-row cbw-' + who);
      var bubble = el('div', 'cbw-bubble', html);
      row.appendChild(bubble);
      body.appendChild(row);
      scrollDown();
      return bubble;
    }

    function addChips(list) {
      chips.innerHTML = '';
      (list || []).forEach(function (label) {
        var c = el('button', 'cbw-chip', esc(label));
        c.addEventListener('click', function () { sendMessage(label); });
        chips.appendChild(c);
      });
    }

    function typing(on) {
      var t = body.querySelector('.cbw-typing');
      if (on && !t) {
        t = el('div', 'cbw-row cbw-bot cbw-typing');
        t.innerHTML = '<div class="cbw-bubble"><span></span><span></span><span></span></div>';
        body.appendChild(t);
        scrollDown();
      } else if (!on && t) {
        t.remove();
      }
    }

    var busy = false;
    function sendMessage(text) {
      text = (text || '').trim();
      if (!text || busy) return;
      busy = true;
      addMsg('user', esc(text));
      input.value = '';
      chips.innerHTML = '';
      typing(true);

      // SSE streaming via fetch
      fetch(API_URL + '/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: API_KEY, session_id: sessionId, message: text }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        var bubble = null;
        var acc = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { finish(); return; }
            buf += decoder.decode(r.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (p) {
              var line = p.trim();
              if (line.indexOf('data:') !== 0) return;
              try {
                var evt = JSON.parse(line.slice(5));
                if (evt.token) {
                  if (!bubble) { typing(false); bubble = addMsg('bot', ''); }
                  acc += evt.token;
                  bubble.innerHTML = renderBot(acc);
                  scrollDown();
                } else if (evt.done) {
                  finish(evt.meta || {});
                }
              } catch (e) { /* ignore */ }
            });
            return pump();
          });
        }
        function finish(meta) {
          typing(false);
          busy = false;
          if (meta && meta.sessionId) {
            sessionId = meta.sessionId;
            try { localStorage.setItem('cb_session_' + API_KEY, sessionId); } catch (e) {}
          }
          if (meta && meta.orderCard) {
            var o = meta.orderCard;
            addMsg('bot', '<div class="cbw-order"><strong>Order ' + esc(o.order_number) + '</strong><br>' +
              'Status: <strong>' + esc(o.status) + '</strong><br>' +
              (o.eta ? 'ETA: ' + esc(o.eta) + '<br>' : '') +
              (o.carrier ? 'Carrier: ' + esc(o.carrier) + '<br>' : '') +
              (o.tracking_number ? 'Tracking: ' + esc(o.tracking_number) : '') + '</div>');
          }
          if (meta && meta.suggestions) addChips(meta.suggestions);
        }
        return pump();
      }).catch(function () {
        typing(false);
        busy = false;
        addMsg('bot', 'Sorry, something went wrong. Please try again in a moment.');
      });
    }

    send.addEventListener('click', function () { sendMessage(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendMessage(input.value);
    });

    // welcome
    setTimeout(function () {
      addMsg('bot', renderBot(cfg.welcome_message));
      addChips(['Track my order', 'Return policy', 'Talk to a human']);
    }, 600);

    return { sendMessage: sendMessage };
  }

  // load CSS then config then build
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = API_URL + '/widget/widget.css';
  document.head.appendChild(link);

  fetch(API_URL + '/api/config?key=' + encodeURIComponent(API_KEY))
    .then(function (r) { return r.json(); })
    .then(function (c) { if (!c.error) cfg = Object.assign(cfg, c); build(); })
    .catch(function () { build(); }); // still build with defaults if config fails
})();
