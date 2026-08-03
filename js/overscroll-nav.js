/* ═══════════════════════════════════════════════════════════════════
   overscroll-nav.js — физика overscroll-навигации для трекпада и тача.

   Экран «оттягивается» как резинка, когда локальный скролл упёрся в край,
   и переключается, если оттяг превысил порог. Ведёт себя как нативный
   overscroll на iOS: rubber-band сопротивление, пружинный возврат,
   игнор инерции трекпада и его scroll-acceleration.

   Выделено из проекта SAMOSHIN. Внешних зависимостей нет.

   createOverscrollNav({
     scrollBox,  // () => Element|null  локальный скролл-контейнер (для края)
     pullEl,     // () => Element|null  элемент, к которому писать CSS-сдвиг
     canGo,      // (dir) => boolean    есть ли куда идти (dir: -1 назад, +1 вперёд)
     onCommit,   // (dir) => void       жест засчитан — переключай экран
     active,     // () => boolean       модуль участвует (не оверлей и т.п.)  [опц.]
     busy,       // () => boolean       идёт анимация перехода — гасить ввод  [опц.]
     threshold, stepCap, releaseMs, rubberMax, coastMinPeak,  // числа        [опц.]
     pullVar,    // имя CSS-переменной сдвига, по умолчанию '--pull'          [опц.]
   }) => { drop, release, destroy }

   CSS на элементе pullEl:
     transform: translateY(var(--pull, 0px));
     &.is-releasing { transition: transform .5s cubic-bezier(.22, 1, .36, 1); }
═══════════════════════════════════════════════════════════════════ */
'use strict';

function createOverscrollNav(opts) {
  const scrollBox = opts.scrollBox;
  const pullElFn  = opts.pullEl;
  const canGo     = opts.canGo;
  const onCommit  = opts.onCommit;
  const active    = opts.active || (() => true);
  const busy      = opts.busy   || (() => false);
  const THRESHOLD = opts.threshold    ?? 200;   // накопленный путь для перехода
  const STEP_CAP  = opts.stepCap      ?? 28;    // потолок вклада одного события
  const RELEASE_MS = opts.releaseMs   ?? 60;    // пауза, после которой пружина возвращает
  const RUBBER    = opts.rubberMax    ?? 96;    // предел визуального оттяга
  const COAST_MIN_PEAK = opts.coastMinPeak ?? 25; // ниже этого пика жест не инерция
  const GESTURE_GAP = opts.gestureGap ?? 140;   // пауза в потоке = начался новый жест
  const PULL_VAR  = opts.pullVar || '--pull';

  let pull = 0, pullTimer = 0, pullDir = 0;
  let prevDelta = 0, peakDelta = 0, fading = 0, lastWheel = 0, wasCoasting = false;
  // Тянуть экран можно, только если список у края в НАЧАЛЕ жеста. Решается один раз
  // (armed) в начале жеста: жест, сам домотавший список до края, экран не тянет.
  let armed = false;
  let touchY = null, touchPending = false, touchLive = false;

  /* Сопротивление как на iOS: чем дальше тянешь, тем меньше идёт.
     Линейный сдвиг с упором в потолок читался как рывок. */
  const rubber = (x) => (1 - 1 / (x / RUBBER + 1)) * RUBBER;

  // упёрся ли местный скролл в край по направлению dir (-1 вверх/назад, +1 вниз/вперёд)
  function atEdge(dir) {
    const box = scrollBox();
    if (!box) return true;
    // контейнер без собственной прокрутки — край достигнут по определению
    if (!/(auto|scroll)/.test(getComputedStyle(box).overflowY)) return true;
    return dir < 0 ? box.scrollTop <= 2
                   : box.scrollTop >= box.scrollHeight - box.clientHeight - 2;
  }

  function setPull(px, springBack) {
    const el = pullElFn();
    if (!el) return;
    el.classList.toggle('is-releasing', !!springBack);
    el.style.setProperty(PULL_VAR, px + 'px');
  }

  // отпустили — пружина возвращает на место
  function release() { clearTimeout(pullTimer); if (!pull) return; pull = 0; setPull(0, true); }
  // жест сработал — экран уезжает, отдачу снимаем мгновенно, без пружины
  function drop()    { clearTimeout(pullTimer); pull = 0; setPull(0, false); }

  // Возвращает true, если жест дотянул до перехода (для тача — прекратить текущее касание).
  function pullBy(px) {
    pull = Math.max(0, pull + Math.min(px, STEP_CAP));
    setPull(rubber(pull) * -pullDir, false);   // тянешь вниз — контент идёт вверх
    clearTimeout(pullTimer);
    pullTimer = setTimeout(release, RELEASE_MS);
    if (pull < THRESHOLD) return false;
    const dir = pullDir;
    drop();
    onCommit(dir);
    return true;
  }

  function aim(dir) { if (dir !== pullDir) { drop(); pullDir = dir; } }  // развернулся — без пружины

  /* У трекпада нет сигнала «пальцы убрали»: macOS шлёт инерцию тем же потоком wheel.
     Отличаем по форме — живая тяга то ускоряется, то держит плато, инерция только
     затухает. Путь по затухающему хвосту не копим, иначе экран уедет сам собой. */
  function isCoasting(mag) {
    if (mag > peakDelta) peakDelta = mag;
    // Счётчик сбрасывает только заметный рывок вверх — так живая рука и толкает.
    // «Строго меньше предыдущей» нельзя: в хвосте дельты квантуются равными парами.
    fading = mag > prevDelta * 1.02 ? 0 : fading + 1;
    prevDelta = mag;
    // Затухает, слабее пика жеста, и жест реально разгонялся — иначе медленное
    // ведение (мелкие ровные дельты) ложно ловилось как инерция и дёргало экран.
    return fading >= 4 && mag < peakDelta * .85 && peakDelta >= COAST_MIN_PEAK;
  }

  const onWheel = (e) => {
    const dir = Math.sign(e.deltaY);
    if (!dir || !active()) return;

    const now = performance.now();
    const mag = Math.abs(e.deltaY);
    const fresh = now - lastWheel > GESTURE_GAP;   // пауза = начался новый жест
    lastWheel = now;
    if (fresh) { prevDelta = peakDelta = fading = 0; }

    // Детектор кормим ВСЕГДА (в т.ч. пока идёт анимация перехода), чтобы к концу
    // анимации инерция уже опознавалась как затухающая и не тянула новый экран.
    const coasting = isCoasting(mag);
    // Новый жест начинается с паузы ИЛИ когда после затухания палец толкнул снова
    // (нарастание сбросило coasting). Тогда — и только тогда — переоцениваем край.
    const starting = fresh || (wasCoasting && !coasting);
    wasCoasting = coasting;

    if (busy()) { e.preventDefault(); return; }   // идёт анимация перехода

    if (starting) armed = canGo(dir) && atEdge(dir);  // край ТЕКУЩЕГО экрана

    if (!armed) return;   // список листается сам — его и его инерцию не трогаем (нативный скролл)

    e.preventDefault();   // armed-жест забираем целиком, чтобы поверх не шёл overscroll
    // Инерция armed-жеста: гасим — не переход и не унос на новый экран. Но НЕ блокируем:
    // нарастающий новый жест выше уже сбросил coasting и переармил armed, и пройдёт сюда.
    if (coasting) { release(); return; }
    aim(dir);
    pullBy(mag);
  };

  const onTouchStart = (e) => { touchY = e.touches[0].clientY; touchPending = true; touchLive = true; release(); };
  const onTouchMove = (e) => {
    if (!touchLive || touchY === null || !active()) return;
    const dy = e.touches[0].clientY - touchY;
    const dir = dy > 0 ? -1 : 1;                        // палец вниз — уходим назад
    if (touchPending) {
      if (Math.abs(dy) < 4) return;                     // ждём заметного движения — узнать направление
      armed = canGo(dir) && atEdge(dir);                // решаем по положению списка в начале касания
      touchPending = false;
    }
    if (!armed) return;                                 // касание листает список — экран не трогаем
    aim(dir);
    if (pullBy(Math.abs(dy) - pull)) touchLive = false; // дошло до перехода — остаток касания игнорируем
  };
  const onTouchEnd = () => { touchY = null; touchPending = false; touchLive = false; release(); };

  addEventListener('wheel', onWheel, { passive: false });
  addEventListener('touchstart', onTouchStart, { passive: true });
  addEventListener('touchmove', onTouchMove, { passive: true });
  addEventListener('touchend', onTouchEnd, { passive: true });

  function destroy() {
    removeEventListener('wheel', onWheel);
    removeEventListener('touchstart', onTouchStart);
    removeEventListener('touchmove', onTouchMove);
    removeEventListener('touchend', onTouchEnd);
    clearTimeout(pullTimer);
  }

  return { drop, release, destroy };
}
