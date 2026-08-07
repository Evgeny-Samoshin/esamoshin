/* ═══════════════════════════════════════════════
   SAMOSHIN — поведение страниц.
   Роутер (nav.js) вызывает PAGES[data-page](root) при входе на страницу;
   возвращённая функция — teardown, вызывается при уходе.
   Историей владеет роутер — здесь её не трогаем.
   ═══════════════════════════════════════════════ */
'use strict';

window.PAGES = (function () {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const CONFIG = { email: 'hello@samoshin.ru' };

  /* ───────── Погружение (главная): старт ↔ бриф ↔ подтверждение ───────── */
  function initHome(root) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const DUR = { dive: 790, back: 520, none: 0 };
    const scr = (n) => $('#s-' + n, root);
    let screen = 'start';
    let finish = null;               // не null, пока идёт переход между экранами

    function show(next, mode) {
      if (finish) finish();          // новый переход обрывает текущий
      if (next === screen) return;
      const to = scr(next); if (!to) return;
      const from = scr(screen);
      from.classList.remove('is-first');
      screen = next;
      if (reduced.matches) mode = 'none';

      const pair = { dive: ['dive-out', 'dive-in'], back: ['back-out', 'back-in'] }[mode];
      to.hidden = false; to.classList.add('is-active');
      if (pair) { from.dataset.anim = pair[0]; to.dataset.anim = pair[1]; }
      else to.dataset.anim = 'plain-in';
      from.classList.add('is-leaving');

      const t = setTimeout(() => finish && finish(), DUR[mode] ?? 200);
      finish = () => {
        clearTimeout(t); finish = null;
        from.classList.remove('is-leaving');
        delete from.dataset.anim; delete to.dataset.anim;
        from.hidden = true; from.classList.remove('is-active');
        const h = to.querySelector('h1, h2') || to;
        h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true });
        if (to.dataset.screen === 'brief') $('#brief-scroll', root).scrollTop = 0;
      };
    }

    function back() { if (screen !== 'start') { overscroll.drop(); show('start', 'back'); } }

    /* ── FAQ-слой (dialog) ── */
    const faq = $('#ov-faq', root);
    let faqOpen = false;
    const openFaq  = () => { faqOpen = true; faq.showModal(); requestAnimationFrame(() => faq.classList.add('is-on')); };
    const closeFaq = () => { if (!faqOpen) return; faqOpen = false; faq.classList.remove('is-on'); setTimeout(() => faq.close(), 400); };
    const onCancel = (e) => { e.preventDefault(); closeFaq(); };
    faq.addEventListener('cancel', onCancel);

    /* ── Клики внутри погружения (кнопки; ссылки берёт роутер) ── */
    const onClick = (e) => {
      const go = e.target.closest('[data-go]');
      if (go) return void show(go.dataset.go, go.dataset.go === 'brief' ? 'dive' : 'back');
      if (e.target.closest('[data-back]')) return void back();
      if (e.target.closest('#faq-open')) return void openFaq();
      if (e.target.closest('[data-close-overlay]')) return void closeFaq();
      if (faqOpen && !e.target.closest('.overlay-inner')) closeFaq();
    };
    root.addEventListener('click', onClick);

    /* ── Скролл за верхний край брифа → назад на старт ── */
    const screenEl = () => scr(screen);
    const overscroll = createOverscrollNav({
      scrollBox: () => screenEl().querySelector('.brief-scroll, .pane'),
      pullEl:    () => screenEl().querySelector('.brief, .pane'),
      active:    () => screen !== 'start' && !faqOpen,
      busy:      () => !!finish,
      canGo:     (dir) => dir < 0 && screen === 'brief',
      onCommit:  (dir) => { if (dir < 0) back(); },
    });

    /* ── Бриф: сохранение, валидация, документ, отправка ── */
    const form = $('#brief-form', root);
    const STORE = 'samoshin-brief';
    const WEEK = 7 * 24 * 3600 * 1000;

    const LABELS = {
      business: 'Чем занимается бизнес', clients: 'Кто клиенты',
      goal: 'Что должен делать сайт', blocks: 'Что должно быть на сайте',
      style: 'Как сайт должен выглядеть', assets: 'Что уже есть из материалов',
      cms: 'Менять тексты и фото сам', domain: 'Домен',
      name: 'Имя', phone: 'Телефон или мессенджер', email: 'Email',
      contact_way: 'Удобный способ связи',
    };
    const REQUIRED = ['business', 'clients', 'goal', 'blocks', 'style', 'assets', 'cms', 'domain', 'name', 'phone', 'contact_way'];

    function save() {
      const data = {};
      for (const [k, v] of new FormData(form)) data[k] = data[k] === undefined ? v : [].concat(data[k], v);
      try { localStorage.setItem(STORE, JSON.stringify({ ts: Date.now(), data })); } catch { /* приватный режим */ }
    }

    function restore() {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return; }
      if (!saved || Date.now() - saved.ts > WEEK) return void localStorage.removeItem(STORE);
      for (const [k, v] of Object.entries(saved.data)) {
        const values = [].concat(v);
        $$(`[name="${k}"]`, form).forEach(f => {
          if (f.type === 'radio' || f.type === 'checkbox') f.checked = values.includes(f.value);
          else f.value = values[0] ?? '';
        });
      }
      $$('.step', form).forEach(step => {
        const own = step.querySelector('.opt--own input');
        const input = step.querySelector('.own-input');
        if (own && input) input.hidden = !own.checked;
      });
    }

    function answers() {
      const fd = new FormData(form);
      const out = {};
      for (const key of Object.keys(LABELS)) {
        let vals = fd.getAll(key).map(v => v.trim()).filter(Boolean);
        if (vals.includes('__own')) {
          const own = (fd.get(key + '_own') || '').trim();
          vals = vals.filter(v => v !== '__own');
          if (own) vals.push(own);
        }
        out[key] = vals;
      }
      return out;
    }

    const clearBad = (step) => { step.classList.remove('is-bad'); $$('[name]', step).forEach(f => f.removeAttribute('aria-invalid')); };

    function validate(a) {
      $$('.step.is-bad', form).forEach(clearBad);
      const missing = REQUIRED.filter(k => a[k].length === 0);
      if (!missing.length) return true;
      missing.forEach(k => {
        const field = $(`[name="${k}"]`, form);
        field.setAttribute('aria-invalid', 'true');
        field.closest('.step').classList.add('is-bad');
      });
      const err = $('#form-error', root);
      err.textContent = missing.length === 1
        ? `Остался один вопрос: «${LABELS[missing[0]]}». Он ниже, помечен.`
        : `Не хватает ответов: ${missing.length}. Начни с «${LABELS[missing[0]]}» — он помечен ниже.`;
      err.hidden = false;
      $(`[name="${missing[0]}"]`, form).closest('.step').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }

    function toDoc(a) {
      const rows = Object.entries(LABELS).filter(([k]) => a[k].length)
        .map(([k, label]) => `<tr><td style="padding:8px 16px 8px 0;color:#6B7078;vertical-align:top;width:220px">${label}</td>
           <td style="padding:8px 0"><b>${a[k].join(', ')}</b></td></tr>`).join('');
      return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
        <head><meta charset="utf-8"><title>Бриф</title></head>
        <body style="font-family:Georgia,serif;color:#1C1E22">
          <h1 style="font-weight:normal">Бриф на сайт</h1>
          <p style="color:#6B7078">${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">${rows}</table>
        </body></html>`;
    }

    function downloadDoc(a) {
      const url = URL.createObjectURL(new Blob(['﻿' + toDoc(a)], { type: 'application/msword' }));
      Object.assign(document.createElement('a'), { href: url, download: `Бриф — ${(a.name[0] || 'сайт')}.doc` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function mailtoLink(a) {
      const body = Object.entries(LABELS).filter(([k]) => a[k].length).map(([k, label]) => `${label}: ${a[k].join(', ')}`).join('\n');
      return `mailto:${CONFIG.email}?subject=${encodeURIComponent('Бриф на сайт — ' + (a.name[0] || ''))}&body=${encodeURIComponent(body + '\n\nДокумент с брифом приложен отдельным файлом.')}`;
    }

    let lastBrief = null;

    const onChange = (e) => {
      const group = e.target.closest('.step');
      const ownBox = group?.querySelector('.opt--own input');
      const ownInput = group?.querySelector('.own-input');
      if (ownBox && ownInput) { ownInput.hidden = !ownBox.checked; if (e.target.closest('.opt--own')) ownInput.focus(); }
      save();
    };
    const onInput = (e) => {
      save();
      const step = e.target.closest('.step.is-bad');
      if (step && !REQUIRED.some(k => $(`[name="${k}"]`, step) && answers()[k].length === 0)) clearBad(step);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const a = answers();
      if (!validate(a)) return;
      $('#form-error', root).hidden = true;
      lastBrief = a;
      downloadDoc(a);
      // ponytail: mailto — почтовый клиент клиента. Нужна отправка без него — Formspree/Web3Forms сюда же.
      location.href = mailtoLink(a);
      try { localStorage.removeItem(STORE); } catch { /* приватный режим */ }
      show('brief-done', 'none');
    };
    form.addEventListener('change', onChange);
    form.addEventListener('input', onInput);
    form.addEventListener('submit', onSubmit);
    $('#done-download', root).addEventListener('click', () => lastBrief && downloadDoc(lastBrief));

    restore();
    selftest(form, { validate, answers, toDoc, mailtoLink, CONFIG });

    // teardown: снять то, что вне root (overscroll висит на window). Слушатели на root/form
    // уходят с самим узлом при подмене #page.
    return () => { overscroll.destroy(); if (finish) finish(); };
  }

  /* ───────── Примеры работ: фильтр по типу ───────── */
  function initWorks(root) {
    const cards = $$('.case', root), pills = $$('.filter', root), empty = $('#cases-empty', root);
    function apply(type) {
      let shown = 0;
      cards.forEach(c => { const ok = type === 'all' || c.dataset.type === type; c.hidden = !ok; shown += ok ? 1 : 0; });
      pills.forEach(p => p.classList.toggle('is-on', p.dataset.filter === type));
      empty.hidden = shown > 0;
    }
    $('.filters', root).addEventListener('click', (e) => { const b = e.target.closest('.filter'); if (b) apply(b.dataset.filter); });
    const f = new URLSearchParams(location.search).get('f');
    apply(['landing', 'card', 'corp', 'shop'].includes(f) ? f : 'all');
  }

  /* ───────── Самопроверка логики брифа: /?selftest ───────── */
  function selftest(form, api) {
    if (!location.search.includes('selftest')) return;
    const $f = (s) => form.querySelector(s);
    const ok = (cond, what) => { if (!cond) throw new Error('selftest: ' + what); };
    const set = (n, v) => { $f(`[name="${n}"]`).value = v; };
    const pick = (n, v) => { $f(`[name="${n}"][value="${v}"]`).checked = true; };

    form.reset();
    ok(api.validate(api.answers()) === false, 'пустой бриф должен не пройти');
    ok(form.querySelectorAll('.step.is-bad').length === 7, 'должны подсветиться все 7 шагов');
    set('business', 'Мебель'); set('clients', 'Люди');
    pick('goal', '__own'); set('goal_own', 'Собрать заявки с рекламы');
    pick('blocks', 'Отзывы'); pick('blocks', '__own'); set('blocks_own', 'Калькулятор');
    pick('style', 'Дорого и престижно'); pick('assets', 'Логотип');
    pick('cms', 'Да, хочу сам'); pick('domain', 'Да, есть');
    set('name', 'Пётр'); set('phone', '+79000000000'); pick('contact_way', 'Telegram');
    const a = api.answers();
    ok(a.goal[0] === 'Собрать заявки с рекламы', '«свой вариант» подменяет __own');
    ok(a.blocks.length === 2 && !a.blocks.includes('__own'), '__own не должен попасть в ответы');
    ok(api.validate(a) === true, 'заполненный бриф должен пройти');
    ok(api.toDoc(a).includes('Калькулятор'), 'документ содержит ответы');
    ok(api.mailtoLink(a).startsWith('mailto:' + api.CONFIG.email), 'mailto собирается');
    form.reset();
    console.log('selftest: ok');
  }

  return { home: initHome, works: initWorks };
})();
