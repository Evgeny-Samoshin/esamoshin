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
  let locked = false;
  let prevDelta = 0, peakDelta = 0, fading = 0, lastWheel = 0;
  // Тянуть экран можно, только если список был у края в НАЧАЛЕ жеста. Решается один
  // раз (armed) и держится до паузы: жест, сам домотавший список до края, экран не тянет.
  let armed = false;
  let touchY = null, touchPending = false;

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

  /* После перехода глушим хвост инерции того же жеста, чтобы он не потянул уже новый
     экран. Держим до ПЕРВОЙ паузы в потоке (её ловит fresh в onWheel), а не по таймеру:
     иначе инерция бесконечно продлевала бы блокировку и новый экран «не реагировал».
     Новый жест (после паузы) разблокирует сразу. */
  function lockTail() { locked = true; touchY = null; }

  function pullBy(px) {
    pull = Math.max(0, pull + Math.min(px, STEP_CAP));
    setPull(rubber(pull) * -pullDir, false);   // тянешь вниз — контент идёт вверх
    clearTimeout(pullTimer);
    pullTimer = setTimeout(release, RELEASE_MS);
    if (pull < THRESHOLD) return;
    const dir = pullDir;
    drop();
    lockTail();
    onCommit(dir);
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
    const fresh = now - lastWheel > GESTURE_GAP;   // пауза = начался новый жест
    lastWheel = now;

    // Идёт анимация перехода — глушим всё до её конца.
    if (busy()) { e.preventDefault(); return; }

    // Блокировка после перехода: хвост инерции того же жеста (fresh=false) глушим,
    // но новый жест (пауза была) сразу разблокирует — иначе новый экран не реагирует.
    if (locked) {
      if (!fresh) { e.preventDefault(); return; }
      locked = false;
    }

    if (fresh) {
      prevDelta = peakDelta = fading = 0;
      armed = canGo(dir) && atEdge(dir);   // решаем по положению списка в НАЧАЛЕ жеста
    }

    if (!armed) return;          // жест листает список (или некуда идти) — экран не трогаем

    e.preventDefault();          // жест забираем целиком, чтобы поверх не шёл overscroll
    // Внутри armed-жеста инерция не должна докидывать до перехода — гасим её хвост.
    if (isCoasting(Math.abs(e.deltaY))) { release(); return; }
    aim(dir);
    pullBy(Math.abs(e.deltaY));
  };

  // палец на экране — однозначно новый жест: снимаем блокировку хвоста
  const onTouchStart = (e) => { touchY = e.touches[0].clientY; touchPending = true; locked = false; release(); };
  const onTouchMove = (e) => {
    if (touchY === null || locked || !active()) return;
    const dy = e.touches[0].clientY - touchY;
    const dir = dy > 0 ? -1 : 1;                        // палец вниз — уходим назад
    if (touchPending) {
      if (Math.abs(dy) < 4) return;                     // ждём заметного движения — узнать направление
      armed = canGo(dir) && atEdge(dir);                // решаем по положению списка в начале касания
      touchPending = false;
    }
    if (!armed) return;                                 // касание листает список — экран не трогаем
    aim(dir);
    pullBy(Math.abs(dy) - pull);
  };
  const onTouchEnd = () => { touchY = null; touchPending = false; release(); };

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
