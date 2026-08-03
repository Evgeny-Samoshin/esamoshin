/* FluidSmoke — фоновый дым на WebGL2 (Stable Fluids + vorticity confinement).
 *
 * Подключение:
 *   <script src="smoke.js"></script>          → глобальный объект FluidSmoke
 *   import './smoke.js'                        → side-effect, тот же глобал
 *   const FluidSmoke = require('./smoke.js')   → CommonJS / бандлеры
 *
 * Использование:
 *   const smoke = FluidSmoke.mount(document.body, { sourceCount: 3, bgColor: '#111' });
 *   if (!smoke) { ...показать статичный фолбэк... }  // нет WebGL2 или prefers-reduced-motion
 *   smoke.params.curl = 40;      // живые настройки (см. FluidSmoke.defaults())
 *   smoke.rebuild();             // пересоздать буферы после смены simRes/dyeRes
 *   smoke.stats;                 // { fps, simW, simH, dyeW, dyeH }, обновляется раз в секунду
 *   smoke.destroy();             // снять слушатели, остановить цикл, убрать canvas
 *
 * Опция onContextLost: колбэк на потерю WebGL-контекста (показать фолбэк на стороне хозяина).
 * Опция transparent: true — канвас прозрачен там, где нет дыма (bgColor не используется);
 *   работает только при mount(), на лету не переключается (свойство GL-контекста).
 * sourceCount: 0 — режим «только след курсора», без фонового дыма.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FluidSmoke = factory();
})(globalThis, function () {
'use strict';

function defaults() {
  const isMobile = matchMedia('(pointer: coarse)').matches;
  return {
    simRes: isMobile ? 64 : 128,
    dyeRes: isMobile ? 256 : 512,
    pressureIters: isMobile ? 10 : 20,
    densityDissipation: 0.985,
    velocityDissipation: 0.99,
    curl: 30,
    // дым
    amplitude: 4,
    threshold: 0.02,
    exponent: 1.6,
    driftAngle: 10,      // градусы, 0 = вправо
    driftStrength: 6,
    sourceIntensity: 0.6,
    sourceCount: 1,
    sourceRadius: 64.3, // % экрана; 64.3 в новой линейной шкале = прежним 41.3 в шкале-дисперсии
    sourceForce: 90,
    // цвета
    transparent: false, // прозрачный фон вместо bgColor; применяется только при mount()
    bgColor: '#828282',
    smokeLight: '#ffffff',
    smokeDark: '#b8b8b8',
    cursorColor: '#000000',
    sourceColor: '#e3e3e3',
    // взаимодействие
    splatRadius: 0.05,
    splatForce: 3217.5,
    clapForce: 500,
    clapRadius: 0.8,
    accentMix: 0.57,
    // отладка
    view: 'smoke',
  };
}

const VIEW_MODES = { smoke: 0, density: 1, velocity: 2, pressure: 3 };

// пул точек эмиссии; первые sourceCount активны. Порядок — от центра наружу,
// чтобы малое число источников всё равно покрывало середину. p — фаза блуждания
const SOURCE_POOL = [
  { cx: 0.50, cy: 0.50, p: 4.2 },
  { cx: 0.25, cy: 0.28, p: 0.0 },
  { cx: 0.75, cy: 0.72, p: 3.4 },
  { cx: 0.75, cy: 0.28, p: 2.1 },
  { cx: 0.25, cy: 0.72, p: 1.3 },
  { cx: 0.50, cy: 0.22, p: 5.0 },
  { cx: 0.50, cy: 0.78, p: 2.7 },
  { cx: 0.18, cy: 0.50, p: 0.9 },
  { cx: 0.82, cy: 0.50, p: 3.9 },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// ---------- шейдеры ----------

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAG_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 frag;
`;

const SHADERS = {
  splat: `
    uniform sampler2D uTarget;
    uniform float aspectRatio, radius, uRadial;
    uniform vec2 point;
    uniform vec3 uColor;
    void main () {
      vec2 p = vUv - point;
      p.x *= aspectRatio;
      vec3 add = uColor;
      if (uRadial > 0.5) add = vec3(normalize(p + 1e-5) * uColor.x, 0.0);
      float g = exp(-dot(p, p) / radius);
      frag = vec4(texture(uTarget, vUv).xyz + g * add, 1.0);
    }`,

  advection: `
    uniform sampler2D uVelocity, uSource;
    uniform vec2 uTexelSize;   // сетки скоростей
    uniform vec2 uForce;       // постоянный дрейф (только для velocity-прохода)
    uniform float dt, dissipation;
    void main () {
      vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * uTexelSize;
      float decay = pow(dissipation, dt * 60.0);
      frag = vec4(texture(uSource, coord).xyz * decay + vec3(uForce * dt, 0.0), 1.0);
    }`,

  divergence: `
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).x;
      float R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y;
      float B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;
      if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;
      if (vB.y < 0.0) B = -C.y;
      frag = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,

  curl: `
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).y;
      float R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x;
      float B = texture(uVelocity, vB).x;
      frag = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,

  vorticity: `
    uniform sampler2D uVelocity, uCurl;
    uniform float curl, dt;
    void main () {
      float L = texture(uCurl, vL).x;
      float R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x;
      float B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 1e-4;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
      frag = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
    }`,

  pressure: `
    uniform sampler2D uPressure, uDivergence;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      float divergence = texture(uDivergence, vUv).x;
      frag = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }`,

  gradientSubtract: `
    uniform sampler2D uPressure, uVelocity;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
      frag = vec4(velocity, 0.0, 1.0);
    }`,

  clear: `
    uniform sampler2D uTexture;
    uniform float value;
    void main () {
      frag = value * texture(uTexture, vUv);
    }`,

  display: `
    uniform sampler2D uDye, uVelocity, uPressure;
    uniform float uAmplitude, uThreshold, uExponent, uAccentMix, uTransparent;
    uniform vec3 uBg, uSmokeLight, uSmokeDark, uCursorColor, uSourceColor;
    uniform int uMode;
    void main () {
      // dye: x — плотность, y — акцент курсора, z — акцент источников
      vec3 d = texture(uDye, vUv).xyz;
      if (uMode == 1) { frag = vec4(vec3(clamp(d.x, 0.0, 1.0)), 1.0); return; }
      if (uMode == 2) { frag = vec4(0.5 + texture(uVelocity, vUv).xy * 0.02, 0.5, 1.0); return; }
      if (uMode == 3) { frag = vec4(vec3(0.5 + texture(uPressure, vUv).x * 2.0), 1.0); return; }
      float dens = pow(max(d.x, 0.0) * uAmplitude, uExponent);
      float alpha = smoothstep(uThreshold, uThreshold + 0.25, dens); // мягкий ореол, ниже порога — пустота
      vec3 smoke = mix(uSmokeLight, uSmokeDark, clamp(dens, 0.0, 1.0));
      float accC = clamp(d.y / max(d.x, 0.001), 0.0, 1.0) * uAccentMix;
      float accS = clamp(d.z / max(d.x, 0.001), 0.0, 1.0) * uAccentMix;
      smoke = mix(smoke, uCursorColor, accC * 0.35);
      smoke = mix(smoke, uSourceColor, accS * 0.35);
      // прозрачный режим: alpha уходит в канвас (premultiplied), фон хозяина виден сквозь
      if (uTransparent > 0.5) frag = vec4(smoke * alpha, alpha);
      else frag = vec4(mix(uBg, smoke, alpha), 1.0);
    }`,
};

// ---------- монтирование ----------

function mount(container = document.body, options = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
  const gl = canvas.getContext('webgl2', { alpha: !!options.transparent, depth: false, stencil: false, antialias: false });
  const floatExt = gl && gl.getExtension('EXT_color_buffer_float');
  if (!gl || !floatExt) return null;

  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.prepend(canvas); // фон: контент хозяина, идущий в DOM позже, рисуется поверх

  const P = Object.assign(defaults(), options);

  // ---------- GL-каркас ----------

  function compileShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const vertShader = compileShader(gl.VERTEX_SHADER, VERT);

  function makeProgram(fragSource) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vertShader);
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, FRAG_HEADER + fragSource));
    gl.bindAttribLocation(prog, 0, 'aPosition');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog));
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      uniforms[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, uniforms, bind() { gl.useProgram(prog); } };
  }

  const progs = {};
  for (const name in SHADERS) progs[name] = makeProgram(SHADERS[name]);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function createFBO(w, h, internalFormat, format) {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h,
      texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format) {
    let a = createFBO(w, h, internalFormat, format);
    let b = createFBO(w, h, internalFormat, format);
    return {
      get read() { return a; },
      get write() { return b; },
      texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      width: w, height: h,
      swap() { [a, b] = [b, a]; },
    };
  }

  function getResolution(base) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const max = Math.round(base * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { w: max, h: base } : { w: base, h: max };
  }

  let velocity, dye, pressure, divergence, curlFBO;

  function initFramebuffers() {
    // ponytail: при resize/смене разрешения дым сбрасывается; копирование старого состояния — если начнёт мешать
    const sim = getResolution(P.simRes);
    const dyeR = getResolution(P.dyeRes);
    velocity   = createDoubleFBO(sim.w, sim.h, gl.RG16F, gl.RG);
    pressure   = createDoubleFBO(sim.w, sim.h, gl.R16F, gl.RED);
    divergence = createFBO(sim.w, sim.h, gl.R16F, gl.RED);
    curlFBO    = createFBO(sim.w, sim.h, gl.R16F, gl.RED);
    dye        = createDoubleFBO(dyeR.w, dyeR.h, gl.RGBA16F, gl.RGBA); // x = плотность, y = акцент курсора, z = акцент источников
  }

  function resizeCanvas() {
    canvas.width = canvas.clientWidth || 1;   // ponytail: 1x без dpr — дым размытый, ретина не нужна
    canvas.height = canvas.clientHeight || 1;
    initFramebuffers();
  }
  resizeCanvas();
  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(container);

  // ---------- splat ----------

  function correctRadius(r) {
    const aspect = canvas.width / canvas.height;
    return aspect > 1 ? r * aspect : r;
  }

  function splat(x, y, velColor, dyeColor, radius, radial = false) {
    const p = progs.splat;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1f(p.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform1f(p.uniforms.radius, correctRadius(radius / 100));
    gl.uniform1f(p.uniforms.uRadial, radial ? 1 : 0);

    gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform3f(p.uniforms.uColor, velColor[0], velColor[1], 0);
    blit(velocity.write);
    velocity.swap();

    if (dyeColor) {
      gl.uniform1f(p.uniforms.uRadial, 0);
      gl.uniform1i(p.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(p.uniforms.uColor, dyeColor[0], dyeColor[1], dyeColor[2] || 0);
      blit(dye.write);
      dye.swap();
    }
  }

  // ---------- ввод ----------

  const pointer = { x: 0, y: 0, px: 0, py: 0, moved: false, inited: false };
  const claps = [];

  function pointerUv(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,
    };
  }

  function onPointerMove(e) {
    const { x, y } = pointerUv(e);
    if (!pointer.inited) { pointer.px = x; pointer.py = y; pointer.inited = true; }
    else { pointer.px = pointer.x; pointer.py = pointer.y; }
    pointer.x = x; pointer.y = y;
    pointer.moved = true;
  }
  function onPointerDown(e) {
    claps.push(pointerUv(e));
  }
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerdown', onPointerDown);

  function applyInputs(dt, t) {
    if (pointer.moved) {
      pointer.moved = false;
      const dx = pointer.x - pointer.px;
      const dy = pointer.y - pointer.py;
      const amount = Math.min(Math.hypot(dx, dy) * 30, 0.25);
      splat(pointer.x, pointer.y,
        [dx * P.splatForce, dy * P.splatForce],
        [amount, amount],                        // акцент курсора — канал y
        P.splatRadius);
    }
    for (const c of claps.splice(0)) {
      splat(c.x, c.y, [P.clapForce, 0], [0.15, 0.05], P.clapRadius, true);
    }
    // источники: блуждающие точки по всему экрану, дуют радиально «из глубины».
    // Пишут и в акцентный канал, поэтому их дым красится в sourceColor через accentMix
    const n = Math.min(P.sourceCount, SOURCE_POOL.length);
    for (let i = 0; i < n; i++) {
      const s = SOURCE_POOL[i];
      const ex = s.cx + 0.09 * Math.sin(t * 0.21 + s.p) + 0.04 * Math.sin(t * 0.53 + s.p * 2.0);
      const ey = s.cy + 0.07 * Math.sin(t * 0.17 + s.p);
      // sourceRadius — линейный радиус в % экрана; в гауссиану уходит квадрат (она ждёт дисперсию),
      // иначе ползунок ощущается неравномерно: слева пятно растёт резко, справа еле-еле.
      // Плотность на пиксель гасим ~1/радиус, иначе большой источник насыщает поле до белого
      const d = P.sourceIntensity * dt * Math.min(1, 17.3 / P.sourceRadius);
      splat(ex, ey, [P.sourceForce * dt, 0], [d, 0, d], P.sourceRadius ** 2 / 100, true);
    }
  }

  // ---------- шаг симуляции ----------

  function step(dt) {
    gl.disable(gl.BLEND);
    const tsX = velocity.texelSizeX, tsY = velocity.texelSizeY;

    let p = progs.curl;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(curlFBO);

    p = progs.vorticity;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uCurl, curlFBO.attach(1));
    gl.uniform1f(p.uniforms.curl, P.curl);
    gl.uniform1f(p.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    p = progs.divergence;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    p = progs.clear;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(p.uniforms.value, 0.8);
    blit(pressure.write);
    pressure.swap();

    p = progs.pressure;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < P.pressureIters; i++) {
      gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    p = progs.gradientSubtract;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    p = progs.advection;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, tsX, tsY);
    gl.uniform2f(p.uniforms.uTexelSize, tsX, tsY);
    gl.uniform1f(p.uniforms.dt, dt);
    const a = P.driftAngle * Math.PI / 180;
    gl.uniform2f(p.uniforms.uForce, Math.cos(a) * P.driftStrength, Math.sin(a) * P.driftStrength);
    gl.uniform1f(p.uniforms.dissipation, P.velocityDissipation);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, velocity.read.attach(0));
    blit(velocity.write);
    velocity.swap();

    gl.uniform2f(p.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform2f(p.uniforms.uForce, 0, 0);
    gl.uniform1f(p.uniforms.dissipation, P.densityDissipation);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, dye.read.attach(1));
    blit(dye.write);
    dye.swap();
  }

  function render() {
    const p = progs.display;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(p.uniforms.uDye, dye.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(1));
    gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(2));
    gl.uniform1f(p.uniforms.uAmplitude, P.amplitude);
    gl.uniform1f(p.uniforms.uThreshold, P.threshold);
    gl.uniform1f(p.uniforms.uExponent, P.exponent);
    gl.uniform1f(p.uniforms.uAccentMix, P.accentMix);
    gl.uniform1f(p.uniforms.uTransparent, P.transparent ? 1 : 0);
    gl.uniform3f(p.uniforms.uBg, ...hexToRgb(P.bgColor));
    gl.uniform3f(p.uniforms.uSmokeLight, ...hexToRgb(P.smokeLight));
    gl.uniform3f(p.uniforms.uSmokeDark, ...hexToRgb(P.smokeDark));
    gl.uniform3f(p.uniforms.uCursorColor, ...hexToRgb(P.cursorColor));
    gl.uniform3f(p.uniforms.uSourceColor, ...hexToRgb(P.sourceColor));
    gl.uniform1i(p.uniforms.uMode, VIEW_MODES[P.view] || 0);
    blit(null);
  }

  // ---------- цикл ----------

  const stats = { fps: 0, simW: 0, simH: 0, dyeW: 0, dyeH: 0 };
  let lastTime = performance.now();
  let frames = 0, fpsTime = 0;
  let firstFrame = true;
  let rafId = 0;

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30); // rAF сам стоит в фоновой вкладке; кламп гасит скачок при возврате
    lastTime = now;
    applyInputs(dt, now / 1000);
    step(dt);
    render();

    if (firstFrame) {
      firstFrame = false;
      console.assert(gl.getError() === gl.NO_ERROR, 'FluidSmoke: GL error after first frame');
    }

    frames++;
    fpsTime += dt;
    if (fpsTime >= 1) {
      stats.fps = Math.round(frames / fpsTime);
      stats.simW = velocity.width; stats.simH = velocity.height;
      stats.dyeW = dye.width; stats.dyeH = dye.height;
      frames = 0; fpsTime = 0;
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);

  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    if (options.onContextLost) options.onContextLost();
  });

  function destroy() {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerdown', onPointerDown);
    canvas.remove();
  }

  return { canvas, params: P, stats, rebuild: initFramebuffers, destroy };
}

return { mount, defaults };
});
