"use strict";
// 가상 영상 모의 시험: 프로그램으로 그린 트랙·자동차 영상을 app.js의 실제 감지 코드에 넣어
// 통과를 몇 번 잡는지, 가짜 통과가 생기는지, 랩타임 오차가 얼마인지 센다.
// 사용: node tests/sim.js [app.js 경로] [이름에 들어간 글자로 고르기]
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PW = 360, PH = 202;   // 처리용 화면 크기(1280x720 → 가로 360)
const LANE_Y = 101;         // 차가 지나가는 세로 중심
const M = 48, TW = PW + M * 2, TH = PH + M * 2;

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// 잡음 표: 매 픽셀마다 난수를 만들지 않도록 미리 만들어 둔다.
const NOISE_SIZE = 1 << 18;
const noiseTable = new Float32Array(NOISE_SIZE);
{
  const r = mulberry32(99);
  for (let i = 0; i < NOISE_SIZE; i++) { let u = 0; while (!u) u = r(); noiseTable[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
}

function runScenario(appPath, o) {
  const s = Object.assign({
    name: "", pxPerCm: 3.6, roi: { x: 150, y: 78, w: 60, h: 46 }, fps: 30, exposure: 1 / 60, noise: 2,
    sensitivity: 20, auto: true, ignoreShake: true, cooldown: 2000, history: 1000,
    passes: [4, 9, 14, 19, 24], duration: 28, carBody: [200, 40, 40],
    shake: () => [0, 0], light: () => 0, dropWindow: null, extras: []
  }, o);
  const carL = Math.round(15 * s.pxPerCm), carH = Math.round(9 * s.pxPerCm), speed = 200 * s.pxPerCm;
  const laneHalf = Math.round(5.8 * s.pxPerCm);

  // 배경: 밝은 회색 트랙 + 차선 벽 2줄 + 이음매 1줄 + 잔무늬 + 트랙 밖 물건 몇 개
  const tex = new Float32Array(TW * TH);
  {
    const r = mulberry32(7);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const wx = x - M, wy = y - M;
      let v = 170 + 8 * Math.sin(wx * 0.11) * Math.cos(wy * 0.07) + (r() - 0.5) * 10;
      if (Math.abs(wy - (LANE_Y - laneHalf)) < 2 || Math.abs(wy - (LANE_Y + laneHalf)) < 2) v = 70;
      if (Math.abs(wx - 180) < 1) v = 115;
      if (wx > 40 && wx < 70 && wy > 10 && wy < 40) v = 95;        // 트랙 밖 상자
      if (wx > 250 && wx < 300 && wy > 160 && wy < 190) v = 215;   // 트랙 밖 밝은 물건
      tex[y * TW + x] = v;
    }
  }
  const rand = mulberry32(12345);
  let simT = 0;

  function render(x0, y0, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    const [ox, oy] = s.shake(simT);
    const g = s.light(simT);
    const whole = Number.isInteger(ox) && Number.isInteger(oy);
    const cxRoi = s.roi.x + s.roi.w / 2;
    const subs = 6, carX = [];
    for (const T of s.passes) {
      if (Math.abs(simT - T) > 1.5) continue;
      for (let k = 0; k < subs; k++) carX.push(cxRoi + speed * (simT - s.exposure * k / subs - T));
    }
    const extras = s.extras.map((e) => e(simT)).filter(Boolean);
    let n = (rand() * NOISE_SIZE) | 0;
    const sigma = s.noise;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wx = x0 + x + ox, wy = y0 + y + oy;
        let v;
        if (whole) {
          const tx = Math.max(0, Math.min(TW - 1, wx + M)), ty = Math.max(0, Math.min(TH - 1, wy + M));
          v = tex[ty * TW + tx];
        } else {
          const fxp = Math.max(0, Math.min(TW - 2, wx + M)), fyp = Math.max(0, Math.min(TH - 2, wy + M));
          const xi = Math.floor(fxp), yi = Math.floor(fyp), fx = fxp - xi, fy = fyp - yi, i = yi * TW + xi;
          v = (tex[i] * (1 - fx) + tex[i + 1] * fx) * (1 - fy) + (tex[i + TW] * (1 - fx) + tex[i + TW + 1] * fx) * fy;
        }
        let r = v, gch = v, b = v;
        for (const e of extras) if (wx >= e.x && wx < e.x + e.w && wy >= e.y && wy < e.y + e.h) { r = gch = b = e.v; }
        if (carX.length && Math.abs(wy - LANE_Y) <= carH / 2) {
          let a = 0;
          for (let c = 0; c < carX.length; c++) if (Math.abs(wx - carX[c]) <= carL / 2) a++;
          if (a) {
            a /= subs;
            const tire = Math.abs(wy - LANE_Y) > carH / 2 - 5;
            const cr = tire ? 30 : s.carBody[0], cg = tire ? 30 : s.carBody[1], cb = tire ? 30 : s.carBody[2];
            r = r * (1 - a) + cr * a; gch = gch * (1 - a) + cg * a; b = b * (1 - a) + cb * a;
          }
        }
        const i = (y * w + x) * 4;
        data[i] = r + g + noiseTable[n] * sigma; n = (n + 1) & (NOISE_SIZE - 1);
        data[i + 1] = gch + g + noiseTable[n] * sigma; n = (n + 1) & (NOISE_SIZE - 1);
        data[i + 2] = b + g + noiseTable[n] * sigma; n = (n + 1) & (NOISE_SIZE - 1);
        data[i + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  }

  const elements = new Map();
  function fakeElement() {
    return {
      value: "", textContent: "", hidden: false, disabled: false, checked: undefined, width: 0, height: 0, readyState: 4,
      videoWidth: 1280, videoHeight: 720, paused: false, dataset: {}, style: {}, lastChild: { textContent: "" },
      classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
      requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; },
      getContext() {
        return {
          setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {}, fillText() {}, drawImage() {}, putImageData() {},
          measureText() { return { width: 60 }; },
          createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
          getImageData: render
        };
      }
    };
  }
  const context = {
    console,
    document: {
      visibilityState: "visible", addEventListener() {},
      querySelector(sel) { if (!elements.has(sel)) elements.set(sel, fakeElement()); return elements.get(sel); },
      createElement: fakeElement
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {}, performance: { now: () => simT * 1000 },
    window: {
      devicePixelRatio: 1, clearTimeout() {}, setTimeout() { return 1; }, setInterval() { return 1; }, clearInterval() {},
      requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, addEventListener() {}
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(appPath, "utf8"), context);
  const ev = (src) => vm.runInContext(src, context);

  const detections = [], motionLog = [];
  let processed = 0;
  const origPass = context.handlePass, origUpd = context.updateBackgroundAndMask;
  context.handlePass = (now) => { detections.push(now / 1000); return origPass(now); };
  let lastAlign = null, lastMotion = 0;
  const origAlign = context.estimateAlignment;
  context.estimateAlignment = (w, h) => (lastAlign = origAlign(w, h));
  context.updateBackgroundAndMask = (f, learning, ...rest) => { const m = origUpd(f, learning, ...rest); processed++; lastMotion = m; motionLog.push([simT, learning ? -1 : m]); return m; };

  context.__roi = { left: s.roi.x / PW, top: s.roi.y / PH, right: (s.roi.x + s.roi.w) / PW, bottom: (s.roi.y + s.roi.h) / PH };
  ev(`stream = {}; roi = __roi; els.sensitivityInput.value = "${s.sensitivity}"; els.cooldownInput.value = "${s.cooldown}"; els.historyInput.value = "${s.history}";
      if (els.autoThresholdInput) els.autoThresholdInput.checked = ${s.auto};
      if (els.ignoreShakeInput) els.ignoreShakeInput.checked = ${s.ignoreShake};
      resizeProcessingCanvas(); resetDetector();`);

  const trace = process.env.SIM_TRACE ? process.env.SIM_TRACE.split(",").map(Number) : null;
  let started = false;
  for (let k = 0; k / s.fps < s.duration; k++) {
    simT = k / s.fps;
    if (s.dropWindow && simT >= s.dropWindow[0] && simT < s.dropWindow[1]) continue;  // 프로그램이 잠깐 멈춘 구간
    if (!started && simT >= 2) { ev("startMeasurement()"); started = true; }
    context.__now = simT * 1000;
    ev("processFrame(__now)");
    if (trace && simT >= trace[0] && simT <= trace[1]) {
      const [sx, sy] = s.shake(simT);
      console.log(simT.toFixed(3), `흔들림=${sx.toFixed(1)},${sy.toFixed(1)}`, ev("`밀림=${globalDx},${globalDy} 안정=${frameStable} 상태=${detectorState} 변화율=${els.motionValue.textContent} 기준=${currentThreshold().toFixed(1)}`"), JSON.stringify(lastAlign), `마지막변화율=${lastMotion.toFixed(1)}`);
    }
  }

  const matched = s.passes.map((T) => detections.find((d) => Math.abs(d - T) < 0.4));
  const falseHits = detections.filter((d) => !s.passes.some((T) => Math.abs(d - T) < 0.4));
  const hits = matched.filter((d) => d !== undefined).length;
  const idle = motionLog.filter(([t, m]) => m >= 0 && !s.passes.some((T) => Math.abs(t - T) < 0.6)).map(([, m]) => m);
  const lapErr = [];
  for (let i = 1; i < matched.length; i++) if (matched[i] !== undefined && matched[i - 1] !== undefined) lapErr.push(((matched[i] - matched[i - 1]) - (s.passes[i] - s.passes[i - 1])) * 1000);
  const flags = ev("laps.map((lap) => (lap.flags || []).join('+')).reverse().join(',')");
  return {
    이름: s.name,
    감지: `${hits}/${s.passes.length}`,
    가짜통과: falseHits.length,
    평상시최대변화율: idle.length ? Math.max(...idle).toFixed(1) : "-",
    랩오차ms: lapErr.length ? lapErr.map((v) => v.toFixed(0)).join(",") : "-",
    랩표시: flags || "-",
    초당처리: (processed / s.duration).toFixed(0),
    ok: hits === s.passes.length - (o.expectMiss || 0) && falseHits.length === 0
  };
}

const app = process.argv[2] || path.join(__dirname, "..", "app.js");
const only = process.argv[3];
const tight = { x: 150, y: 78, w: 60, h: 46 };
const mid = { x: 120, y: 61, w: 120, h: 80 };
const big = { x: 80, y: 41, w: 200, h: 120 };
const long = { x: 80, y: 78, w: 200, h: 46 };
// 랩 간격을 프레임 간격의 배수가 아니게 두어 시간 오차를 본다
const P = [4.000, 9.013, 14.021, 19.007, 24.026];
const sin = (amp, hz) => (t) => [amp * Math.sin(2 * Math.PI * hz * t), amp * 0.6 * Math.sin(2 * Math.PI * hz * 1.3 * t)];
const bump = (t0, amp) => (t) => t < t0 ? [0, 0] : [amp * Math.exp(-(t - t0) / 0.25) * Math.sin(2 * Math.PI * 9 * (t - t0)), amp * 0.5 * Math.exp(-(t - t0) / 0.25) * Math.cos(2 * Math.PI * 9 * (t - t0))];
const shiftAt = (t0, d) => (t) => t < t0 ? [0, 0] : [d, Math.round(d * 0.5)];
// 트랙 밖(위쪽)에서 사람이 지나가는 상황: 큰 어두운 물체가 가로로 이동
const walker = (t) => (t > 10.5 && t < 13.5) ? { x: -80 + (t - 10.5) * 170, y: 0, w: 60, h: 62, v: 60 } : null;

const scenarios = [
  { name: "기본(좁은 영역,30fps)", roi: tight },
  { name: "60fps 카메라", roi: tight, fps: 60, exposure: 1 / 120 },
  { name: "어두움(15fps,긴 노출,잡음↑)", roi: tight, fps: 15, exposure: 1 / 15, noise: 5 },
  { name: "중간 영역 120x80", roi: mid },
  { name: "큰 영역 200x120", roi: big },
  { name: "큰 영역+어두움", roi: big, fps: 15, exposure: 1 / 15, noise: 5 },
  { name: "진행방향 긴 영역 200x46", roi: long },
  { name: "회색 차(트랙과 비슷한 색)", roi: tight, carBody: [140, 140, 140] },
  { name: "가까이 촬영(화면 폭 50cm)", roi: { x: 110, y: 50, w: 140, h: 102 }, pxPerCm: 7.2 },
  { name: "계속 흔들림 ±1px", roi: tight, shake: sin(1, 7) },
  { name: "계속 흔들림 ±3px", roi: tight, shake: sin(3, 7) },
  { name: "계속 흔들림 ±6px", roi: tight, shake: sin(6, 7) },
  { name: "큰 영역 흔들림 ±3px", roi: big, shake: sin(3, 7) },
  { name: "책상 침 12px", roi: tight, shake: bump(11.5, 12) },
  { name: "책상 침 25px", roi: tight, shake: bump(11.5, 25) },
  { name: "책상 침 12px, 큰 영역", roi: big, shake: bump(11.5, 12) },
  { name: "책상 침 12px, 긴 영역", roi: long, shake: bump(11.5, 12) },
  { name: "책상 침(통과 0.5초 전)", roi: tight, shake: bump(13.5, 12) },
  { name: "카메라 위치 밀림 2px", roi: tight, shake: shiftAt(11.5, 2) },
  { name: "카메라 위치 밀림 6px", roi: tight, shake: shiftAt(11.5, 6) },
  { name: "카메라 위치 밀림 20px", roi: tight, shake: shiftAt(11.5, 20) },
  { name: "통과 순간 0.12초 멈춤(좁은 영역)", roi: tight, dropWindow: [13.96, 14.08] },
  { name: "통과 순간 0.12초 멈춤(긴 영역)", roi: long, dropWindow: [13.96, 14.08] },
  { name: "통과 순간 0.25초 멈춤(좁은 영역)", roi: tight, dropWindow: [13.90, 14.15], expectMiss: 1 },
  { name: "조명 갑자기 +25", roi: tight, light: (t) => t > 11.5 ? 25 : 0 },
  { name: "조명 갑자기 +50", roi: tight, light: (t) => t > 11.5 ? 50 : 0 },
  { name: "조명 서서히 +50(10초 동안)", roi: tight, light: (t) => Math.max(0, Math.min(50, (t - 6) * 5)) },
  { name: "조명 깜빡임 ±12", roi: tight, light: (t) => 12 * Math.sin(2 * Math.PI * 3.3 * t) },
  { name: "트랙 밖에서 사람 지나감", roi: tight, extras: [walker] }
];

const rows = scenarios.filter((s) => !only || s.name.includes(only)).map((s) => runScenario(app, Object.assign({ passes: P }, s)));
console.table(rows.map(({ ok, ...rest }) => rest));
const failed = rows.filter((row) => !row.ok);
console.log(failed.length ? `기대와 다른 항목 ${failed.length}개: ${failed.map((row) => row.이름).join(" / ")}` : "sim: 전 항목 기대대로 동작");
process.exitCode = failed.length ? 1 : 0;
