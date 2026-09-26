/**
 * Embeddable customer-service chat widget.
 *
 * Usage (paste into any site):
 *   <script src="https://YOUR-HOST/widget/widget.js"
 *           data-api-key="cb_..."
 *           data-api-url="https://YOUR-HOST"></script>
 *
 * Optional: data-position="bottom-right|bottom-left", data-z-index="9999",
 *            data-lang="es" (UI language override; defaults to the business's
 *            default_language, then the browser language)
 */
(function () {
  'use strict';

  var scripts = document.getElementsByTagName('script');
  var me = scripts[scripts.length - 1];
  var API_KEY = me.getAttribute('data-api-key') || '';
  var API_URL = (me.getAttribute('data-api-url') || '').replace(/\/$/, '');
  var POSITION = me.getAttribute('data-position') || 'bottom-right';
  var LANG_ATTR = (me.getAttribute('data-lang') || '').toLowerCase().slice(0, 2);

  if (!API_KEY || !API_URL) {
    console.error('[chat-widget] missing data-api-key or data-api-url');
    return;
  }

  // UI strings for the widget chrome (bot replies are translated server-side).
  var STRINGS = {
    en: { placeholder: 'Type a message…', inputAria: 'Type your message', sendAria: 'Send', openChat: 'Open chat', closeChat: 'Close chat', subtitle: 'Typically replies instantly', error: 'Sorry, something went wrong. Please try again in a moment.', thumbsUp: 'Mark reply as helpful', thumbsDown: 'Mark reply as not helpful', mic: 'Voice input', listening: 'Listening…', speakOn: 'Read replies aloud', speakOff: 'Stop reading aloud', teamNote: 'Message from the team' },
    es: { placeholder: 'Escribe un mensaje…', inputAria: 'Escribe tu mensaje', sendAria: 'Enviar', openChat: 'Abrir chat', closeChat: 'Cerrar chat', subtitle: 'Suele responder al instante', error: 'Lo sentimos, algo salió mal. Inténtalo de nuevo en un momento.', thumbsUp: 'Marcar la respuesta como útil', thumbsDown: 'Marcar la respuesta como no útil', mic: 'Entrada de voz', listening: 'Escuchando…', speakOn: 'Leer las respuestas en voz alta', speakOff: 'Dejar de leer en voz alta', teamNote: 'Mensaje del equipo' },
    fr: { placeholder: 'Écrivez un message…', inputAria: 'Écrivez votre message', sendAria: 'Envoyer', openChat: 'Ouvrir le chat', closeChat: 'Fermer le chat', subtitle: 'Répond généralement instantanément', error: 'Désolé, une erreur est survenue. Veuillez réessayer dans un instant.', thumbsUp: 'Marquer la réponse comme utile', thumbsDown: 'Marquer la réponse comme non utile', mic: 'Saisie vocale', listening: 'Écoute…', speakOn: 'Lire les réponses à voix haute', speakOff: 'Arrêter la lecture à voix haute', teamNote: 'Message de l’équipe' },
    de: { placeholder: 'Nachricht eingeben…', inputAria: 'Nachricht eingeben', sendAria: 'Senden', openChat: 'Chat öffnen', closeChat: 'Chat schließen', subtitle: 'Antwortet in der Regel sofort', error: 'Entschuldigung, etwas ist schiefgelaufen. Bitte versuchen Sie es gleich erneut.', thumbsUp: 'Als hilfreich markieren', thumbsDown: 'Als nicht hilfreich markieren', mic: 'Spracheingabe', listening: 'Höre zu…', speakOn: 'Antworten vorlesen', speakOff: 'Vorlesen beenden', teamNote: 'Nachricht vom Team' },
    pt: { placeholder: 'Digite uma mensagem…', inputAria: 'Digite sua mensagem', sendAria: 'Enviar', openChat: 'Abrir bate-papo', closeChat: 'Fechar bate-papo', subtitle: 'Normalmente responde na hora', error: 'Desculpe, algo deu errado. Tente novamente em instantes.', thumbsUp: 'Marcar a resposta como útil', thumbsDown: 'Marcar a resposta como não útil', mic: 'Entrada de voz', listening: 'Ouvindo…', speakOn: 'Ler as respostas em voz alta', speakOff: 'Parar de ler em voz alta', teamNote: 'Mensagem da equipe' },
    hi: { placeholder: 'संदेश लिखें…', inputAria: 'अपना संदेश लिखें', sendAria: 'भेजें', openChat: 'चैट खोलें', closeChat: 'चैट बंद करें', subtitle: 'आमतौर पर तुरंत जवाब देता है', error: 'माफ़ करें, कुछ गड़बड़ हो गई। कृपया थोड़ी देर में पुनः प्रयास करें।', thumbsUp: 'जवाब को उपयोगी बताएं', thumbsDown: 'जवाब को अनुपयोगी बताएं', mic: 'आवाज़ इनपुट', listening: 'सुन रहा है…', speakOn: 'जवाब ज़ोर से पढ़ें', speakOff: 'ज़ोर से पढ़ना बंद करें', teamNote: 'टीम का संदेश' },
    it: { placeholder: 'Scrivi un messaggio…', inputAria: 'Scrivi il tuo messaggio', sendAria: 'Invia', openChat: 'Apri chat', closeChat: 'Chiudi chat', subtitle: 'Di solito risponde subito', error: 'Spiacenti, qualcosa è andato storto. Riprova tra un momento.', thumbsUp: 'Segna la risposta come utile', thumbsDown: 'Segna la risposta come non utile', mic: 'Input vocale', listening: 'Ascolto…', speakOn: 'Leggi le risposte ad alta voce', speakOff: 'Interrompi la lettura ad alta voce', teamNote: 'Messaggio dal team' },
    nl: { placeholder: 'Typ een bericht…', inputAria: 'Typ je bericht', sendAria: 'Verstuur', openChat: 'Chat openen', closeChat: 'Chat sluiten', subtitle: 'Reageert meestal direct', error: 'Sorry, er is iets misgegaan. Probeer het zo opnieuw.', thumbsUp: 'Markeer als nuttig', thumbsDown: 'Markeer als niet nuttig', mic: 'Spraakinvoer', listening: 'Luisteren…', speakOn: 'Antwoorden hardop voorlezen', speakOff: 'Stoppen met hardop voorlezen', teamNote: 'Bericht van het team' },
    ru: { placeholder: 'Введите сообщение…', inputAria: 'Введите ваше сообщение', sendAria: 'Отправить', openChat: 'Открыть чат', closeChat: 'Закрыть чат', subtitle: 'Обычно отвечает мгновенно', error: 'Извините, что-то пошло не так. Попробуйте ещё раз через минуту.', thumbsUp: 'Отметить как полезное', thumbsDown: 'Отметить как бесполезное', mic: 'Голосовой ввод', listening: 'Слушаю…', speakOn: 'Читать ответы вслух', speakOff: 'Не читать вслух', teamNote: 'Сообщение от команды' },
    ja: { placeholder: 'メッセージを入力…', inputAria: 'メッセージを入力', sendAria: '送信', openChat: 'チャットを開く', closeChat: 'チャットを閉じる', subtitle: '通常すぐに返信します', error: '申し訳ありません。問題が発生しました。しばらくしてからもう一度お試しください。', thumbsUp: '役に立ったと評価', thumbsDown: '役に立たなかったと評価', mic: '音声入力', listening: '聞き取り中…', speakOn: '返信を読み上げる', speakOff: '読み上げを停止', teamNote: 'チームからのメッセージ' },
    zh: { placeholder: '输入消息…', inputAria: '输入您的消息', sendAria: '发送', openChat: '打开聊天', closeChat: '关闭聊天', subtitle: '通常即时回复', error: '抱歉，出了点问题。请稍后再试。', thumbsUp: '标记为有帮助', thumbsDown: '标记为没有帮助', mic: '语音输入', listening: '正在聆听…', speakOn: '朗读回复', speakOff: '停止朗读', teamNote: '来自团队的消息' },
    ko: { placeholder: '메시지 입력…', inputAria: '메시지를 입력하세요', sendAria: '보내기', openChat: '채팅 열기', closeChat: '채팅 닫기', subtitle: '보통 즉시 답변합니다', error: '죄송합니다. 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.', thumbsUp: '도움이 됨으로 표시', thumbsDown: '도움이 안 됨으로 표시', mic: '음성 입력', listening: '듣는 중…', speakOn: '답변을 소리 내어 읽기', speakOff: '소리 내어 읽기 중지', teamNote: '팀의 메시지' },
    tr: { placeholder: 'Bir mesaj yazın…', inputAria: 'Mesajınızı yazın', sendAria: 'Gönder', openChat: 'Sohbeti aç', closeChat: 'Sohbeti kapat', subtitle: 'Genellikle anında yanıtlar', error: 'Üzgünüz, bir şeyler ters gitti. Lütfen bir dakika sonra tekrar deneyin.', thumbsUp: 'Yararlı olarak işaretle', thumbsDown: 'Yararlı değil olarak işaretle', mic: 'Sesli giriş', listening: 'Dinleniyor…', speakOn: 'Yanıtları sesli oku', speakOff: 'Sesli okumayı durdur', teamNote: 'Ekipten mesaj' },
    pl: { placeholder: 'Wpisz wiadomość…', inputAria: 'Wpisz swoją wiadomość', sendAria: 'Wyślij', openChat: 'Otwórz czat', closeChat: 'Zamknij czat', subtitle: 'Zazwyczaj odpowiada natychmiast', error: 'Przepraszamy, coś poszło nie tak. Spróbuj ponownie za chwilę.', thumbsUp: 'Oznacz jako pomocne', thumbsDown: 'Oznacz jako niepomocne', mic: 'Wprowadzanie głosowe', listening: 'Słucham…', speakOn: 'Czytaj odpowiedzi na głos', speakOff: 'Przestań czytać na głos', teamNote: 'Wiadomość od zespołu' },
    sv: { placeholder: 'Skriv ett meddelande…', inputAria: 'Skriv ditt meddelande', sendAria: 'Skicka', openChat: 'Öppna chatt', closeChat: 'Stäng chatt', subtitle: 'Svarar vanligtvis direkt', error: 'Tyvärr gick något fel. Försök igen om en stund.', thumbsUp: 'Markera som hjälpsamt', thumbsDown: 'Markera som inte hjälpsamt', mic: 'Röstinmatning', listening: 'Lyssnar…', speakOn: 'Läs upp svaren', speakOff: 'Sluta läsa upp', teamNote: 'Meddelande från teamet' },
    id: { placeholder: 'Ketik pesan…', inputAria: 'Ketik pesan Anda', sendAria: 'Kirim', openChat: 'Buka obrolan', closeChat: 'Tutup obrolan', subtitle: 'Biasanya langsung membalas', error: 'Maaf, terjadi kesalahan. Silakan coba lagi sebentar.', thumbsUp: 'Tandai sebagai membantu', thumbsDown: 'Tandai sebagai tidak membantu', mic: 'Input suara', listening: 'Mendengarkan…', speakOn: 'Bacakan balasan', speakOff: 'Berhenti membacakan', teamNote: 'Pesan dari tim' },
    ms: { placeholder: 'Taip mesej…', inputAria: 'Taip mesej anda', sendAria: 'Hantar', openChat: 'Buka sembang', closeChat: 'Tutup sembang', subtitle: 'Biasanya membalas serta-merta', error: 'Maaf, berlaku ralat. Sila cuba lagi sebentar.', thumbsUp: 'Tandakan sebagai membantu', thumbsDown: 'Tandakan sebagai tidak membantu', mic: 'Input suara', listening: 'Mendengar…', speakOn: 'Bacakan balasan dengan kuat', speakOff: 'Berhenti membacakan', teamNote: 'Mesej daripada pasukan' },
    vi: { placeholder: 'Nhập tin nhắn…', inputAria: 'Nhập tin nhắn của bạn', sendAria: 'Gửi', openChat: 'Mở trò chuyện', closeChat: 'Đóng trò chuyện', subtitle: 'Thường trả lời ngay lập tức', error: 'Xin lỗi, đã xảy ra lỗi. Vui lòng thử lại sau giây lát.', thumbsUp: 'Đánh dấu là hữu ích', thumbsDown: 'Đánh dấu là không hữu ích', mic: 'Nhập bằng giọng nói', listening: 'Đang nghe…', speakOn: 'Đọc to câu trả lời', speakOff: 'Dừng đọc to', teamNote: 'Tin nhắn từ đội ngũ' },
    th: { placeholder: 'พิมพ์ข้อความ…', inputAria: 'พิมพ์ข้อความของคุณ', sendAria: 'ส่ง', openChat: 'เปิดแชท', closeChat: 'ปิดแชท', subtitle: 'มักจะตอบทันที', error: 'ขออภัย เกิดข้อผิดพลาด กรุณาลองอีกครั้งในภายหลัง', thumbsUp: 'ทำเครื่องหมายว่ามีประโยชน์', thumbsDown: 'ทำเครื่องหมายว่าไม่มีประโยชน์', mic: 'ป้อนข้อมูลด้วยเสียง', listening: 'กำลังฟัง…', speakOn: 'อ่านคำตอบออกเสียง', speakOff: 'หยุดอ่านออกเสียง', teamNote: 'ข้อความจากทีม' },
    ar: { placeholder: 'اكتب رسالة…', inputAria: 'اكتب رسالتك', sendAria: 'إرسال', openChat: 'فتح الدردشة', closeChat: 'إغلاق الدردشة', subtitle: 'يرد عادةً على الفور', error: 'عذرًا، حدث خطأ ما. يرجى المحاولة مرة أخرى بعد قليل.', thumbsUp: 'وضع علامة على الرد كمفيد', thumbsDown: 'وضع علامة على الرد كغير مفيد', mic: 'إدخال صوتي', listening: 'أستمع…', speakOn: 'قراءة الردود بصوت عالٍ', speakOff: 'إيقاف القراءة بصوت عالٍ', teamNote: 'رسالة من الفريق' },
  };
  var RTL_LANGS = { ar: true };

  // Voice input/output helpers.
  var VOICE_LANGS = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', hi: 'hi-IN', ar: 'ar-SA', it: 'it-IT', nl: 'nl-NL', ru: 'ru-RU', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', tr: 'tr-TR', pl: 'pl-PL', sv: 'sv-SE', id: 'id-ID', ms: 'ms-MY', vi: 'vi-VN', th: 'th-TH' };
  var SPEECH_REC = window.SpeechRecognition || window.webkitSpeechRecognition;
  var SPEAKER_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
  var MIC_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
  // Read-aloud toggle, persisted per widget key.
  var speakKey = 'cb_speak_' + API_KEY;
  var speakOn = false;
  try { speakOn = localStorage.getItem(speakKey) === '1'; } catch (e) {}

  var sessionId = null;
  try { sessionId = localStorage.getItem('cb_session_' + API_KEY); } catch (e) {}

  var cfg = { business_name: 'Support', welcome_message: 'Hi! How can I help?', brand_color: '#4f46e5', bot_name: 'Assistant', default_language: 'en', voice_enabled: true };
  var T = STRINGS.en; // resolved UI strings (set once config arrives)

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
    if (RTL_LANGS[T.lang]) root.setAttribute('dir', 'rtl');

    // launcher button
    var launcher = el('button', 'cbw-launcher', '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>');
    launcher.setAttribute('aria-label', T.openChat);

    // panel
    var panel = el('div', 'cbw-panel cbw-hidden');

    var header = el('div', 'cbw-header',
      '<div class="cbw-avatar">' + esc(cfg.business_name.charAt(0).toUpperCase()) + '</div>' +
      '<div class="cbw-title"><strong>' + esc(cfg.bot_name) + '</strong><span>' + esc(T.subtitle) + '</span></div>' +
      (cfg.voice_enabled !== false
        ? '<button class="cbw-speaker' + (speakOn ? ' cbw-speaking' : '') + '" aria-label="' + esc(speakOn ? T.speakOff : T.speakOn) + '">' + SPEAKER_SVG + '</button>'
        : '') +
      '<button class="cbw-close" aria-label="' + esc(T.closeChat) + '">&times;</button>');

    var body = el('div', 'cbw-body');

    var chips = el('div', 'cbw-chips');

    var footer = el('div', 'cbw-footer');
    var input = el('input', 'cbw-input');
    input.placeholder = T.placeholder;
    input.setAttribute('aria-label', T.inputAria);
    var send = el('button', 'cbw-send', '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>');
    send.setAttribute('aria-label', T.sendAria);

    footer.appendChild(input);
    footer.appendChild(send);

    // Mic button (voice input) — only when the business allows voice and the
    // browser supports speech recognition.
    var micBtn = null;
    if (cfg.voice_enabled !== false && SPEECH_REC) {
      micBtn = el('button', 'cbw-mic', MIC_SVG);
      micBtn.setAttribute('aria-label', T.mic);
      micBtn.addEventListener('click', listenOnce);
      footer.insertBefore(micBtn, send);
    }
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
    header.querySelector('.cbw-close').addEventListener('click', function () { stopSpeaking(); toggle(false); });

    // Speaker toggle (read-aloud). Persisted; cancelled when a new reply
    // arrives or the panel closes.
    var speakerBtn = header.querySelector('.cbw-speaker');
    if (speakerBtn) {
      speakerBtn.addEventListener('click', function () {
        speakOn = !speakOn;
        try { localStorage.setItem(speakKey, speakOn ? '1' : '0'); } catch (e) {}
        speakerBtn.classList.toggle('cbw-speaking', speakOn);
        speakerBtn.setAttribute('aria-label', speakOn ? T.speakOff : T.speakOn);
        if (!speakOn) stopSpeaking();
      });
    }

    function stopSpeaking() {
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    }
    function speak(text) {
      if (!speakOn || !window.speechSynthesis || !text) return;
      stopSpeaking();
      try {
        var u = new SpeechSynthesisUtterance(text);
        u.lang = VOICE_LANGS[T.lang] || 'en-US';
        window.speechSynthesis.speak(u);
      } catch (e) { /* speech synthesis unavailable */ }
    }

    // Voice input: one recognition pass, result lands in the input box.
    var listening = false;
    function listenOnce() {
      if (listening) return;
      var rec;
      try { rec = new SPEECH_REC(); } catch (e) { return; }
      rec.lang = VOICE_LANGS[T.lang] || 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      listening = true;
      if (micBtn) { micBtn.classList.add('cbw-listening'); micBtn.setAttribute('aria-label', T.listening); }
      rec.onresult = function (e) {
        var t = '';
        try { t = e.results[0][0].transcript; } catch (err) {}
        if (t) { input.value = t; input.focus(); }
      };
      var stop = function () {
        listening = false;
        if (micBtn) { micBtn.classList.remove('cbw-listening'); micBtn.setAttribute('aria-label', T.mic); }
      };
      rec.onend = stop;
      rec.onerror = stop;
      try { rec.start(); } catch (e) { stop(); }
    }

    // CSAT thumbs under a bot reply — POSTs to /api/feedback, then locks in.
    function attachFeedback(bubble, messageId) {
      var fb = el('div', 'cbw-feedback');
      var up = el('button', 'cbw-fb', '👍');
      var down = el('button', 'cbw-fb', '👎');
      up.setAttribute('aria-label', T.thumbsUp); up.setAttribute('title', T.thumbsUp);
      down.setAttribute('aria-label', T.thumbsDown); down.setAttribute('title', T.thumbsDown);
      function rate(rating, btn) {
        fetch(API_URL + '/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: API_KEY, session_id: sessionId, message_id: messageId, rating: rating }),
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          up.disabled = true; down.disabled = true;
          fb.classList.add('cbw-rated');
          btn.classList.add('cbw-fb-chosen');
        }).catch(function () { /* leave active so the visitor can retry */ });
      }
      up.addEventListener('click', function () { rate(1, up); });
      down.addEventListener('click', function () { rate(0, down); });
      fb.appendChild(up);
      fb.appendChild(down);
      bubble.appendChild(fb);
    }

    // Proactive nudges: polled every 20s, shown as "message from the team".
    function showNudge(n) {
      var bubble = addMsg('bot', renderBot(n.text));
      bubble.parentNode.classList.add('cbw-nudge');
      bubble.insertBefore(el('div', 'cbw-team', esc(T.teamNote)), bubble.firstChild);
      speak(n.text);
      scrollDown();
    }
    function pollNudges() {
      if (!sessionId) return;
      fetch(API_URL + '/api/nudge?key=' + encodeURIComponent(API_KEY) + '&session_id=' + encodeURIComponent(sessionId))
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (j) {
          (j.nudges || []).forEach(showNudge);
          // Live-agent takeover: tell the visitor once that a human is now on the chat.
          if (j.human_active && !humanAnnounced) {
            humanAnnounced = true;
            var bubble = addMsg('bot', '');
            bubble.parentNode.classList.add('cbw-nudge');
            bubble.insertBefore(el('div', 'cbw-team', 'Live agent'), bubble.firstChild);
            bubble.appendChild(document.createTextNode(T.humanJoined || "You're now chatting with our team — an agent will reply here shortly."));
            scrollDown();
          }
        })
        .catch(function () { /* silent — next poll retries */ });
    }
    setInterval(pollNudges, 20000);
    var humanAnnounced = false;

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
      stopSpeaking(); // cancel read-aloud when the visitor sends a new message
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
          if (bubble && meta && meta.messageId) attachFeedback(bubble, meta.messageId);
          if (acc) speak(acc);
        }
        return pump();
      }).catch(function () {
        typing(false);
        busy = false;
        addMsg('bot', esc(T.error));
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
      speak(cfg.welcome_message);
    }, 600);

    return { sendMessage: sendMessage };
  }

  // Resolve the UI language: data-lang attr wins, then the business's
  // default_language from /api/config, then the browser language.
  function resolveLang() {
    var nav = '';
    try { nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase().slice(0, 2); } catch (e) { nav = 'en'; }
    var code = LANG_ATTR || (cfg.default_language || '').toLowerCase().slice(0, 2) || nav || 'en';
    if (!STRINGS[code]) code = 'en';
    T = STRINGS[code];
    T.lang = code;
  }

  // load CSS then config then build
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = API_URL + '/widget/widget.css';
  document.head.appendChild(link);

  fetch(API_URL + '/api/config?key=' + encodeURIComponent(API_KEY))
    .then(function (r) { return r.json(); })
    .then(function (c) { if (!c.error) cfg = Object.assign(cfg, c); resolveLang(); build(); })
    .catch(function () { resolveLang(); build(); }); // still build with defaults if config fails
})();
