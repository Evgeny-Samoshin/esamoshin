/* Фон-дым (Vanta.FOG) + курсорный след (FluidSmoke). Общий для всех страниц сайта.
   Требует #smoke в DOM и загруженные fog.js + smoke.js ДО этого файла.
   Уважает prefers-reduced-motion; ?nofog / ?notrail — выключатели для сравнения. */
(function () {
  'use strict';
  var state = window.__smokeBgState || (window.__smokeBgState = {});

  function initSmokeBackground() {
    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var smokeEl = document.getElementById('smoke');

    if (!smokeEl) return;

    // Если эффект уже жив и контейнер всё ещё доступен — не пересоздаём его.
    if (state.fogEffect && state.fogEffect.canvas.isConnected) {
      return;
    }

    // Фон-туман. Не падаем, если библиотека/WebGL недоступны — остаётся CSS-градиент .smoke.
    if (window.FogBackground && !reduced && !location.search.includes('nofog') && !state.fogEffect) {
      try {
        state.fogEffect = FogBackground.mount('#smoke', {
          highlightColor: 0x9d9c99,
          midtoneColor: 0xcacaca,
          lowlightColor: 0x5f5b70,
          baseColor: 0xffffff,
          blurFactor: 0.48,
          speed: 0.50,
          zoom: 0.40
        });
      } catch (e) { /* нет WebGL — живём с градиентом */ }
    }

    // Курсорный дым-след. mount вернёт null под reduced-motion / без WebGL2 — тогда просто нет следа.
    if (window.FluidSmoke && !location.search.includes('notrail') && !state.fluidSmoke) {
      state.fluidSmoke = FluidSmoke.mount(document.body, {
        transparent: true,
        sourceCount: 0,          // без фонового дыма — фон даёт Vanta
        smokeLight: '#fafafa',
        smokeDark: '#b8b8b8',
        cursorColor: '#AAAAAA',
        accentMix: 1
      });
      // canvas создаёт библиотека — разметки для него нет, класс вешаем здесь (см. .trail в CSS).
      if (state.fluidSmoke) state.fluidSmoke.canvas.classList.add('trail');
    }
  }

  window.__initSmokeBackground = initSmokeBackground;
  initSmokeBackground();
})();
