/* ═══════════════════════════════════════════════
   SAMOSHIN — клиентский роутер.
   Владеет историей. Мягкая навигация: fetch страницы → подмена #page и <head>
   → same-document View Transition (нырок dive). Реальные <a href> и файлы на месте,
   так что боты и «без JS» получают обычную навигацию — SEO не страдает.
   ═══════════════════════════════════════════════ */
'use strict';

(function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const page = () => document.getElementById('page');
  let teardown = null;

  // Инициализировать поведение текущей страницы; синхронизировать data-page на <html>.
  function enter() {
    const el = page();
    document.documentElement.dataset.page = el.dataset.page || '';
    const init = window.PAGES && window.PAGES[el.dataset.page];
    teardown = init ? init(el) : null;
    if (window.__initSmokeBackground) window.__initSmokeBackground();
    const h = el.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  // Перенести из загруженного документа только SEO-значимые узлы <head>; стили/шрифты одни на всех.
  function swapHead(doc) {
    const sel = 'title, meta[name="description"], meta[name="theme-color"], link[rel="canonical"],'
      + ' meta[property^="og:"], meta[name^="twitter:"], script[type="application/ld+json"]';
    document.head.querySelectorAll(sel).forEach(n => n.remove());
    doc.head.querySelectorAll(sel).forEach(n => document.head.appendChild(document.importNode(n, true)));
  }

  function apply(doc) {
    if (teardown) teardown();
    swapHead(doc);
    page().replaceWith(document.importNode(doc.getElementById('page'), true));
    window.scrollTo(0, 0);
    enter();
  }

  /* Нырок анимируем на самом #page, а не через View Transitions: те снимают весь кадр
     вместе с дымом, и туман замирает на время перехода. Здесь дым не участвует — живёт своей жизнью.
     На время анимации #page фиксируем во вьюпорте (компенсируя скролл), иначе scale тянул бы
     всю длинную страницу от её середины. */
  const DUR = 700;                                  // = --t-dive
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function freeze(el) {
    const y = window.scrollY;
    el.style.cssText = 'display:block;position:fixed;left:0;right:0;overflow:hidden;'
      + `top:${-y}px;height:calc(100vh + ${y}px);transform-origin:50% calc(${y}px + 50vh);`;
  }
  const thaw = (el) => { el.classList.remove('is-out', 'is-in'); el.style.cssText = ''; };

  let token = 0;                                    // новый переход отменяет анимацию прежнего

  async function go(url, push) {
    let doc;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (!doc.getElementById('page')) throw 0;
    } catch { location.href = url; return; }        // не смогли — обычный переход
    if (push) history.pushState({}, '', url);
    if (reduced.matches) return void apply(doc);

    const my = ++token;
    const out = page();
    freeze(out); out.classList.add('is-out');
    await wait(DUR);
    if (my !== token) return;                       // обогнал следующий переход
    apply(doc);
    const el = page();
    freeze(el); el.classList.add('is-in');
    await wait(DUR);
    if (my === token) thaw(el);
  }

  const sameOrigin = (a) => { try { return new URL(a.href).origin === location.origin; } catch { return false; } };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || 'native' in a.dataset) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || !sameOrigin(a)) return;
    const url = new URL(a.href);
    if (url.pathname === location.pathname && url.hash) return;   // якорь на этой же странице
    e.preventDefault();
    go(url.href, true);
  });

  addEventListener('popstate', () => go(location.href, false));

  enter();   // текущая (уже загруженная) страница
})();
