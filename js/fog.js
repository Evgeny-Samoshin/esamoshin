/* FogBackground — Vanta.FOG без three.js и без Vanta.
 *
 * Что это: тот же фоновый туман, что даёт VANTA.FOG, но своим WebGL-каркасом.
 * Фрагментный шейдер взят из vanta.fog.min.js дословно (© Vanta.js, MIT) —
 * картинка та же с точностью до пикселя. Всё остальное переписано, потому что
 * FOG — это ОДИН фуллскрин-квад: из three.js он трогал только WebGLRenderer,
 * Scene, Camera, PlaneGeometry и Color, а из VantaBase — размер, время и resize.
 *
 * Цена вопроса: 615 КБ (three) + 12 КБ (vanta) → этот файл.
 *
 * Применение (замена двух <script> на один):
 *   <script src="js/fog.js"></script>
 *   FogBackground.mount('#smoke', { blurFactor: .48, speed: .5, zoom: .4, … })
 * Возвращает { canvas, destroy } или null, если WebGL недоступен.
 * Ключи опций и их значения по умолчанию — как у VANTA.FOG, конфиг переносится
 * один в один. Проверка: ?fogtest — в консоли должно быть "fog selftest: ok".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FogBackground = factory();
})(globalThis, function () {
  'use strict';

  // Дефолты VANTA.FOG (c.prototype.defaultOptions) + minWidth/minHeight из VantaBase.
  var DEFAULTS = {
    highlightColor: 0xff8800, midtoneColor: 0xff3300, lowlightColor: 0x2d00ff, baseColor: 0xffebeb,
    blurFactor: 0.6, speed: 1, zoom: 1,
    scale: 2, scaleMobile: 4,        // делитель разрешения рендера: чем больше, тем дешевле и мягче
    minWidth: 200, minHeight: 200
  };

  var VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';

  // Дословно из vanta.fog.min.js. `iMouse` объявлен, но в main() не используется —
  // поэтому вся мышь/тач/гироскоп из VantaBase сюда не перенесены.
  var FRAG = 'precision highp float;\n' +
    'uniform vec2 iResolution;\nuniform vec2 iMouse;\nuniform float iTime;\n\nuniform float blurFactor;\nuniform vec3 baseColor;\nuniform vec3 lowlightColor;\nuniform vec3 midtoneColor;\nuniform vec3 highlightColor;\nuniform float zoom;\n\nfloat random (in vec2 _st) {\n  return fract(sin(dot(_st.xy,\n                     vec2(0.129898,0.78233)))*\n        437.585453123);\n}\n\n// Based on Morgan McGuire @morgan3d\n// https://www.shadertoy.com/view/4dS3Wd\nfloat noise (in vec2 _st) {\n  vec2 i = floor(_st);\n  vec2 f = fract(_st);\n\n  // Four corners in 2D of a tile\n  float a = random(i);\n  float b = random(i + vec2(1.0, 0.0));\n  float c = random(i + vec2(0.0, 1.0));\n  float d = random(i + vec2(1.0, 1.0));\n\n  vec2 u = f * f * (3.0 - 2.0 * f);\n\n  return mix(a, b, u.x) +\n          (c - a)* u.y * (1.0 - u.x) +\n          (d - b) * u.x * u.y;\n}\n\n#define NUM_OCTAVES 6\n\nfloat fbm ( in vec2 _st) {\n  float v = 0.0;\n  float a = blurFactor;\n  vec2 shift = vec2(100.0);\n  // Rotate to reduce axial bias\n  mat2 rot = mat2(cos(0.5), sin(0.5),\n                  -sin(0.5), cos(0.50));\n  for (int i = 0; i < NUM_OCTAVES; ++i) {\n      v += a * noise(_st);\n      _st = rot * _st * 2.0 + shift;\n      a *= (1. - blurFactor);\n  }\n  return v;\n}\n\nvoid main() {\n  vec2 st = gl_FragCoord.xy / iResolution.xy*3.;\n  st.x *= 0.7 * iResolution.x / iResolution.y ; // Still keep it more landscape than square\n  st *= zoom;\n\n  // st += st * abs(sin(iTime*0.1)*3.0);\n  vec3 color = vec3(0.0);\n\n  vec2 q = vec2(0.);\n  q.x = fbm( st + 0.00*iTime);\n  q.y = fbm( st + vec2(1.0));\n\n  vec2 dir = vec2(0.15,0.126);\n  vec2 r = vec2(0.);\n  r.x = fbm( st + 1.0*q + vec2(1.7,9.2)+ dir.x*iTime );\n  r.y = fbm( st + 1.0*q + vec2(8.3,2.8)+ dir.y*iTime);\n\n  float f = fbm(st+r);\n\n  color = mix(baseColor,\n              lowlightColor,\n              clamp((f*f)*4.0,0.0,1.0));\n\n  color = mix(color,\n              midtoneColor,\n              clamp(length(q),0.0,1.0));\n\n  color = mix(color,\n              highlightColor,\n              clamp(length(r.x),0.0,1.0));\n\n  vec3 finalColor = mix(baseColor, color, f*f*f+.6*f*f+.5*f);\n  gl_FragColor = vec4(finalColor,1.0);\n}\n';

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function mount(el, options) {
    el = typeof el === 'string' ? document.querySelector(el) : el;
    if (!el) return null;

    var P = Object.assign({}, DEFAULTS, options || {});

    var canvas = document.createElement('canvas');
    // applyCanvasStyles из VantaBase, один в один.
    canvas.style.cssText = 'position:absolute;z-index:0;top:0;left:0;background:none;';
    canvas.classList.add('vanta-canvas');
    // antialias:false — квад на весь экран, сглаживать нечего; на мобильных экономит MSAA-буфер.
    var gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    // Один треугольник с запасом покрывает клип-спейс (у Vanta был PlaneGeometry(2,2)).
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    function u(name) { return gl.getUniformLocation(prog, name); }
    // THREE.Color(hex).toVector() — это просто байты/255, без гамма-коррекции (outputEncoding = Linear).
    ['baseColor', 'lowlightColor', 'midtoneColor', 'highlightColor'].forEach(function (k) {
      var h = P[k];
      gl.uniform3f(u(k), (h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255);
    });
    gl.uniform1f(u('blurFactor'), P.blurFactor);
    gl.uniform1f(u('zoom'), P.zoom);
    var uTime = u('iTime'), uRes = u('iResolution');

    el.appendChild(canvas);

    var lastW = 0, lastH = 0, lastRatio = 0;
    function resize() {
      // setSize + setPixelRatio из VantaBase/three: CSS-размер = размер контейнера,
      // буфер = размер × dpr / scale, а iResolution = размер / scale (БЕЗ dpr).
      // Из-за этого рисунок тумана на retina мельче — так он и выглядел с Vanta,
      // поэтому воспроизведено как есть. Хочется крупнее — делить здесь на dpr.
      var mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || innerWidth < 600;
      var scale = mobile ? P.scaleMobile : P.scale;
      var w = Math.max(el.offsetWidth, P.minWidth);
      var h = Math.max(el.offsetHeight, P.minHeight);
      var ratio = (devicePixelRatio || 1) / scale;
      // Задание canvas.width чистит буфер даже если значение то же самое, а ResizeObserver
      // срабатывает и без реальной смены размера. Тот же урок, что в smoke.js.
      if (w === lastW && h === lastH && ratio === lastRatio) return;
      lastW = w; lastH = h; lastRatio = ratio;

      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.width = Math.floor(w * ratio);
      canvas.height = Math.floor(h * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, w / scale, h / scale);
    }
    // ResizeObserver вместо window.resize: ловит и смену вьюпорта, и полосу прокрутки.
    // Но сам ресайз делать в его колбэке НЕЛЬЗЯ: ResizeObserver доставляется ПОСЛЕ
    // колбэков rAF и до paint, а задание canvas.width чистит буфер — то есть стёрло бы
    // только что нарисованный кадр, и при протяжке рамки окна дым пропадал бы напрочь
    // (у Vanta этого не было: событие resize приходит ДО rAF). Поэтому здесь только флаг,
    // а ресайз — в начале frame(), вплотную перед отрисовкой.
    var needResize = true;
    var ro = new ResizeObserver(function () { needResize = true; });
    ro.observe(el);

    // animationLoop из VantaBase: время идёт в «кадрах при 60 fps», шаг зажат в [0.2, 5],
    // чтобы лаг или фоновая вкладка не телепортировали туман.
    var t = 0, prev = 0, req, tested = !location.search.includes('fogtest');
    function frame() {
      if (needResize) { needResize = false; resize(); }
      var now = performance.now();
      if (prev) t += P.speed * Math.max(0.2, Math.min((now - prev) / (1000 / 60), 5));
      prev = now;
      gl.uniform1f(uTime, t * 0.016667);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!tested) { tested = true; selftest(gl); }
      req = requestAnimationFrame(frame);
    }
    frame(); // первый кадр — синхронно, как в VantaBase: в фоновой вкладке rAF не вызовут вовсе

    return {
      canvas: canvas,
      destroy: function () {
        cancelAnimationFrame(req);
        ro.disconnect();
        canvas.remove();
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    };
  }

  // ponytail: одна проверка на всё — шейдер слинковался, юниформы дошли, кадр нарисовался.
  // Если сломается любое звено, пиксель будет чёрным или прозрачным.
  function selftest(gl) {
    var px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var ok = px[3] === 255 && (px[0] || px[1] || px[2]);
    console.log('fog selftest: ' + (ok ? 'ok' : 'FAIL') + ' rgba(' + px.join(',') + ')');
  }

  return { mount: mount, defaults: DEFAULTS };
});
