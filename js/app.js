/* ═══════════════════════════════════════════════
   SAMOSHIN — состояние, роутер, переходы, бриф
   ═══════════════════════════════════════════════ */
'use strict';

// TODO: подставь свои контакты
const CONFIG = {
  email: 'hello@samoshin.ru',
  phone: '+7 900 000-00-00',
};

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const stage   = $('#stage');
const veil    = $('.veil');
const corners = $('#corners');

const BRANCH = ['branch-intro', 'phases', 'site-types'];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  screen: 'start',
  briefEntry: null,   // 'start-button' | 'corner-icon' | 'walked'
  returnScreen: null, // куда вернуться при briefEntry === 'corner-icon'
  overlay: null,
};

/* ═══════════════ переходы ═══════════════ */

const DUR = { dive: 790, back: 520, flight: 830, blink: 620, none: 0 };
let finishTransition = null; // не null, пока переход идёт

// Стек пройденных экранов. Режим возврата диктует язык переходов:
// пришёл шагом (погружение) — уходишь шагом назад; пришёл переносом — морганием.
const trace = [];
const BACK_OF = { dive: 'back', back: 'blink', flight: 'blink', blink: 'blink', none: 'none' };

function go(next, mode = 'dive', push = true) {
  if (next === state.screen) return;
  const to = $('#s-' + next);
  if (!to) return;
  if (finishTransition) finishTransition();       // новый переход обрывает текущий
  if (reduced.matches) mode = 'none';

  const from = $('#s-' + state.screen);
  from.classList.remove('is-first');
  if (push) trace.push({ screen: state.screen, mode });
  state.screen = next;
  syncChrome();

  if (mode === 'blink') return blink(from, to);

  const pair = { dive: ['dive-out', 'dive-in'], back: ['back-out', 'back-in'], flight: ['flight-out', 'flight-in'] }[mode];
  show(to);
  if (pair) {
    from.dataset.anim = pair[0];
    to.dataset.anim = pair[1];
    if (mode === 'flight') stage.classList.add('is-flying');
  } else {
    to.dataset.anim = 'plain-in';
  }
  from.classList.add('is-leaving');

  const t = setTimeout(() => finishTransition && finishTransition(), DUR[mode] || 200);
  finishTransition = () => {
    clearTimeout(t);
    finishTransition = null;
    stage.classList.remove('is-flying');
    from.classList.remove('is-leaving');
    delete from.dataset.anim;
    delete to.dataset.anim;
    hide(from);
    enter(to, mode);
  };
}

function blink(from, to) {
  veil.classList.add('is-on');
  const t = setTimeout(() => finishTransition && finishTransition(), DUR.blink / 2);
  const swap = () => {
    clearTimeout(t);
    show(to);
    hide(from);
    enter(to, 'blink');
    veil.classList.remove('is-on');
    finishTransition = null;
  };
  finishTransition = swap;
}

function show(el) { el.hidden = false; el.classList.add('is-active'); }
function hide(el) { el.hidden = true;  el.classList.remove('is-active'); }

function enter(el, mode) {
  // фокус в начало нового экрана — для клавиатуры и скринридера
  const first = el.querySelector('h1, h2, [autofocus]') || el;
  first.setAttribute('tabindex', '-1');
  first.focus({ preventScroll: true });
  // возврат назад оставляет список фаз там, где его бросили
  if (el.dataset.screen === 'phases') resetTrack(mode === 'dive' || mode === 'none');
  if (el.dataset.screen === 'brief') $('#brief-scroll').scrollTop = 0;
}

const trail = $('#trail');

function syncChrome() {
  const inBranch = BRANCH.includes(state.screen);
  corners.hidden = !inBranch;
  trail.hidden = !inBranch;
  if (!inBranch) return;

  const at = BRANCH.indexOf(state.screen);
  $$('.trail-tick', trail).forEach((tick, i) => {
    tick.classList.toggle('is-here', i === at);
    tick.classList.toggle('is-passed', i < at);
  });
}

/* фон реагирует на курсор — одно свечение, обновляется по кадру */
if (!reduced.matches) {
  const glow = $('#glow');
  let px = 0, py = 0, queued = false;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    px = e.clientX; py = e.clientY;
    glow.classList.add('is-on');
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      glow.style.setProperty('--mx', px + 'px');
      glow.style.setProperty('--my', py + 'px');
    });
  }, { passive: true });
}

// тап во время полёта — прерывает
addEventListener('pointerdown', () => {
  if (stage.classList.contains('is-flying') && finishTransition) finishTransition();
});

/* ═══════════════ навигация ═══════════════ */

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-go]');
  if (nav) return void navigate(nav.dataset.go, nav.dataset.entry);

  const pf = e.target.closest('[data-portfolio]');
  if (pf) return void openOverlay('portfolio', pf.dataset.portfolio);

  if (e.target.closest('[data-back]')) return void back();
  if (e.target.closest('#faq-open')) return void openOverlay('faq');
  if (e.target.closest('[data-close-overlay]')) return void closeOverlay();
  if (state.overlay && !e.target.closest('.overlay-inner')) closeOverlay();
});

function navigate(next, entry) {
  // старт — корень: возвращаться из него некуда, стек обнуляем
  if (next === 'start') { trace.length = 0; return void go('start', 'blink', false); }
  if (next !== 'brief') return void go(next, 'dive');

  state.briefEntry = entry;
  state.returnScreen = state.screen;
  go('brief', entry === 'corner-icon' ? 'flight' : 'dive');
}

/* Шаг назад — одна точка входа для кнопки, свайпа и «назад» браузера. */
function back() {
  if (state.screen === 'brief') return leaveBrief();  // у брифа свои правила возврата
  const prev = trace.pop();
  if (prev) go(prev.screen, BACK_OF[prev.mode] || 'blink', false);
}

function leaveBrief() {
  nav.drop();                                         // экран уезжает — пружина не нужна
  trace.pop();                                        // запись о входе в бриф
  if (state.briefEntry === 'walked') return void go('site-types', 'back', false);
  if (state.briefEntry === 'corner-icon') return void go(state.returnScreen || 'branch-intro', 'blink', false);
  // вошёл кнопкой со старта — пересаживаем на вторую ветку, назад оттуда ведёт на старт
  trace.push({ screen: 'start', mode: 'dive' });
  go('branch-intro', 'blink', false);
}

/* Свайп двумя пальцами и кнопка «назад» браузера идут по экранам, а не с сайта.
   Держим одну запись-ловушку и возвращаем её на место; на старте — отпускаем. */
history.replaceState({ trap: 1 }, '');
history.pushState({ trap: 1 }, '');
addEventListener('popstate', () => {
  if (!trace.length && state.screen !== 'brief') return void history.back();
  history.pushState({ trap: 1 }, '');
  back();
});

/* ═══════════════ слои: FAQ и портфолио ═══════════════ */

// ponytail: <dialog>. Ловушка фокуса, Escape и модальность — родные, писать нечего.
const overlayEl = (kind) => $(kind === 'faq' ? '#ov-faq' : '#ov-portfolio');

function openOverlay(kind, filter) {
  const el = overlayEl(kind);
  state.overlay = kind;
  if (filter) applyFilter(filter);
  el.showModal();
  requestAnimationFrame(() => el.classList.add('is-on'));
}

function closeOverlay() {
  if (!state.overlay) return;
  const el = overlayEl(state.overlay);
  state.overlay = null;
  el.classList.remove('is-on');
  setTimeout(() => el.close(), 400);
}

// Escape гасим сами, чтобы слой уходил с той же скоростью, что пришёл
$$('.overlay').forEach(el => el.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeOverlay();
}));

function applyFilter(type) {
  $$('#pf-filters .filter').forEach(b => b.classList.toggle('is-on', b.dataset.filter === type));
  let shown = 0;
  $$('#pf-works .work').forEach(w => {
    const ok = type === 'all' || w.dataset.type === type;
    w.hidden = !ok;
    shown += ok;
  });
  $('#pf-empty').hidden = shown > 0;
}
$('#pf-filters').addEventListener('click', (e) => {
  const b = e.target.closest('.filter');
  if (b) applyFilter(b.dataset.filter);
});

/* ═══════════════ фазы: скролл с магнитом ═══════════════ */

const track = $('#track');
const hint = $('#hint-scroll');

/* Карточки уходят вверх-на-зрителя. Позиции меряем один раз и считаем от scrollTop:
   чтение getBoundingClientRect в цикле после записи transform заставляло браузер
   пересчитывать layout на каждую карточку в каждом кадре. */
let cardTops = [];

function measureTrack() {
  cardTops = [...track.children].map(c => c.offsetTop);
}

function paintTrack() {
  const h = track.clientHeight;
  if (!h || !cardTops.length) return;   // экран фаз ещё скрыт
  const top = track.scrollTop;
  [...track.children].forEach((card, i) => {
    const d = (cardTops[i] - top) / h;
    if (d < 0) {
      const k = Math.min(1, -d * 2.2);   // 0…1 — насколько ушла за верхний край
      card.style.transform = `translateY(${-k * 40}px) scale(${1 + k * 0.26})`;
      card.style.opacity = String(Math.max(0, 1 - k * 1.15));
    } else {
      card.style.transform = '';
      card.style.opacity = '';
    }
  });
}

function resetTrack(toStart = true) {
  if (toStart) track.scrollTop = 0;
  measureTrack();
  paintTrack();
}

let painting = false;
track.addEventListener('scroll', () => {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; paintTrack(); });
}, { passive: true });

track.addEventListener('pointerdown', touched, { once: true });
track.addEventListener('scroll', touched, { once: true, passive: true });
function touched() {
  track.classList.add('is-touched');
  hint.classList.add('is-off');
}
addEventListener('resize', () => { measureTrack(); paintTrack(); });

/* ═══════════════ бриф ═══════════════ */

const form = $('#brief-form');
const STORE = 'samoshin-brief';
const WEEK = 7 * 24 * 3600 * 1000;

// «свой вариант» открывает поле ввода
form.addEventListener('change', (e) => {
  const group = e.target.closest('.step');
  const ownBox = group?.querySelector('.opt--own input');
  const ownInput = group?.querySelector('.own-input');
  if (ownBox && ownInput) {
    ownInput.hidden = !ownBox.checked;
    if (e.target.closest('.opt--own')) ownInput.focus();
  }
  save();
});
form.addEventListener('input', save);

function save() {
  const data = {};
  for (const [k, v] of new FormData(form)) {
    if (data[k] === undefined) data[k] = v;
    else data[k] = [].concat(data[k], v);
  }
  try {
    localStorage.setItem(STORE, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* приватный режим — прогресс просто не переживёт перезагрузку */ }
}

function restore() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return; }
  if (!saved || Date.now() - saved.ts > WEEK) return void localStorage.removeItem(STORE);

  for (const [k, v] of Object.entries(saved.data)) {
    const values = [].concat(v);
    const fields = $$(`[name="${k}"]`, form);
    fields.forEach(f => {
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

// имя поля → вопрос в документе
const LABELS = {
  business: 'Чем занимается бизнес',
  clients: 'Кто клиенты',
  goal: 'Что должен делать сайт',
  blocks: 'Что должно быть на сайте',
  style: 'Как сайт должен выглядеть',
  assets: 'Что уже есть из материалов',
  cms: 'Менять тексты и фото сам',
  domain: 'Домен',
  name: 'Имя',
  phone: 'Телефон или мессенджер',
  email: 'Email',
  contact_way: 'Удобный способ связи',
};
const REQUIRED = ['business', 'clients', 'goal', 'blocks', 'style', 'assets', 'cms', 'domain', 'name', 'phone', 'contact_way'];

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

function clearBad(step) {
  step.classList.remove('is-bad');
  $$('[name]', step).forEach(f => f.removeAttribute('aria-invalid'));
}

function validate(a) {
  $$('.step.is-bad', form).forEach(clearBad);
  const missing = REQUIRED.filter(k => a[k].length === 0);
  if (!missing.length) return true;

  missing.forEach(k => {
    const field = $(`[name="${k}"]`, form);
    field.setAttribute('aria-invalid', 'true');
    field.closest('.step').classList.add('is-bad');
  });
  const first = $(`[name="${missing[0]}"]`, form).closest('.step');
  const err = $('#form-error');
  err.textContent = missing.length === 1
    ? `Остался один вопрос: «${LABELS[missing[0]]}». Он ниже, помечен.`
    : `Не хватает ответов: ${missing.length}. Начни с «${LABELS[missing[0]]}» — он помечен ниже.`;
  err.hidden = false;
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

// подсветка снимается, как только шаг заполнили — а не на следующем сабмите
form.addEventListener('input', (e) => {
  const step = e.target.closest('.step.is-bad');
  if (step && !REQUIRED.some(k => $(`[name="${k}"]`, step) && answers()[k].length === 0)) clearBad(step);
});

function toDoc(a) {
  const rows = Object.entries(LABELS)
    .filter(([k]) => a[k].length)
    .map(([k, label]) => `<tr><td style="padding:8px 16px 8px 0;color:#6B7078;vertical-align:top;width:220px">${label}</td>
       <td style="padding:8px 0"><b>${a[k].join(', ')}</b></td></tr>`)
    .join('');
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
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: `Бриф — ${(a.name[0] || 'сайт')}.doc`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mailtoLink(a) {
  const body = Object.entries(LABELS)
    .filter(([k]) => a[k].length)
    .map(([k, label]) => `${label}: ${a[k].join(', ')}`)
    .join('\n');
  return `mailto:${CONFIG.email}?subject=${encodeURIComponent('Бриф на сайт — ' + (a.name[0] || ''))}&body=${encodeURIComponent(body + '\n\nДокумент с брифом приложен отдельным файлом.')}`;
}

let lastBrief = null;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const a = answers();
  if (!validate(a)) return;

  $('#form-error').hidden = true;
  lastBrief = a;
  downloadDoc(a);
  // ponytail: mailto — почтовый клиент клиента. Нужна отправка без него — Formspree/Web3Forms сюда же.
  location.href = mailtoLink(a);
  try { localStorage.removeItem(STORE); } catch {}
  trace.length = 0;                          // назад из подтверждения — только на старт
  trace.push({ screen: 'start', mode: 'blink' });
  go('brief-done', 'none', false);
});

$('#done-download').addEventListener('click', () => lastBrief && downloadDoc(lastBrief));

/* ═══════════════ навигация скроллом за край ═══════════════
   Физика — в overscroll-nav.js. Здесь только привязка к экранам проекта. */

const FORWARD = {                       // куда ведёт скролл вниз; где не указано — вперёд некуда
  'branch-intro': () => go('phases', 'dive'),
  'phases':       () => go('site-types', 'dive'),
  'site-types':   () => navigate('brief', 'walked'),
};

const screenEl = () => $('#s-' + state.screen);

const nav = createOverscrollNav({
  // .track приоритетнее .pane: на фазах есть оба, а край считаем по внутреннему списку
  scrollBox: () => { const s = screenEl(); return s.querySelector('.track') || s.querySelector('.brief-scroll, .pane'); },
  pullEl:    () => screenEl().querySelector('.brief, .pane'),
  active:    () => state.screen !== 'start' && !state.overlay,
  busy:      () => !!finishTransition,
  canGo:     (dir) => dir > 0 ? !!FORWARD[state.screen] : (trace.length > 0 || state.screen === 'brief'),
  onCommit:  (dir) => dir < 0 ? back() : FORWARD[state.screen]?.(),
});

/* ═══════════════ старт ═══════════════ */

/* ═══════════════ самопроверка: /?selftest ═══════════════ */
// ponytail: одна проверка на всю нетривиальную логику брифа. Открой /?selftest — упадёт, если сломано.
if (location.search.includes('selftest')) {
  const ok = (cond, what) => { if (!cond) throw new Error('selftest: ' + what); };
  const set = (n, v) => { $(`[name="${n}"]`, form).value = v; };
  const pick = (n, v) => { $(`[name="${n}"][value="${v}"]`, form).checked = true; };

  form.reset();
  ok(validate(answers()) === false, 'пустой бриф должен не пройти');
  ok($$('.step.is-bad', form).length === 7, 'должны подсветиться все 7 шагов');

  set('business', 'Мебель'); set('clients', 'Люди');
  pick('goal', '__own'); set('goal_own', 'Собрать заявки с рекламы');
  pick('blocks', 'Отзывы'); pick('blocks', '__own'); set('blocks_own', 'Калькулятор');
  pick('style', 'Дорого и престижно');
  pick('assets', 'Логотип');
  pick('cms', 'Да, хочу сам'); pick('domain', 'Да, есть');
  set('name', 'Пётр'); set('phone', '+79000000000'); pick('contact_way', 'Telegram');

  const a = answers();
  ok(a.goal[0] === 'Собрать заявки с рекламы', '«свой вариант» подменяет __own');
  ok(a.blocks.length === 2 && !a.blocks.includes('__own'), '__own не должен попасть в ответы');
  ok(validate(a) === true, 'заполненный бриф должен пройти');
  ok(toDoc(a).includes('Калькулятор'), 'документ содержит ответы');
  ok(mailtoLink(a).startsWith('mailto:' + CONFIG.email), 'mailto собирается');

  form.reset();
  console.log('selftest: ok');
}

$('#call-link').href = 'tel:' + CONFIG.phone.replace(/[^\d+]/g, '');
$('#call-link').setAttribute('aria-label', 'Позвонить ' + CONFIG.phone);
restore();
syncChrome();
paintTrack();
