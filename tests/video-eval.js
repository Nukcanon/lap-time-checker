"use strict";
// 실제 촬영 영상(video-prep.js로 준비한 프레임)을 감지 코드에 그대로 넣어 놓침·가짜 통과를 센다.
// 사용: node tests/video-eval.js <프레임 폴더> [이름 일부] [app.js 경로]
//   프레임 폴더에는 <이름>.rgba, <이름>.json과 정답을 적은 cases.json이 있어야 한다.
//   cases.json 예:
//   { "rois": { "가운데": [0.3, 0.35, 0.7, 0.65] },
//     "videos": { "v2": { "truths": [4.2, 10.8], "ignore": [22.3], "rois": ["가운데"] } } }
//   truths = 통과가 있어야 하는 시각(초), ignore = 감지돼도 안 돼도 괜찮은 시각, rois = 화면에 대한 비율(왼쪽, 위, 오른쪽, 아래).
// 환경 변수: TRACE=시작,끝(초) 프레임별 값 출력 / SENS=숫자(자동 기준 대신 수동 기준) / COOLDOWN=밀리초(기본 1000)
//           JSONL=1 한 줄 JSON 출력 / LIST=1 항목 이름만 출력 / EXACT=1 이름이 정확히 같은 항목만
// 넓은 감지 영역은 한 항목에 1분 넘게 걸린다. 여러 항목은 나눠서 동시에 돌리면 빠르다.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const [cacheDir, only, appArg] = process.argv.slice(2);
if (!cacheDir) {
  console.error("사용: node tests/video-eval.js <프레임 폴더> [이름 일부] [app.js 경로]");
  process.exit(1);
}
const appPath = appArg || path.join(__dirname, "..", "app.js");
const trace = process.env.TRACE ? process.env.TRACE.split(",").map(Number) : null;
const SENS = process.env.SENS || "auto";
const COOLDOWN = Number(process.env.COOLDOWN || 1000);
const config = JSON.parse(fs.readFileSync(path.join(cacheDir, "cases.json"), "utf8"));

const CASES = [];
for (const [video, info] of Object.entries(config.videos)) {
  for (const roiName of info.rois || Object.keys(config.rois)) CASES.push({ name: `${video}-${roiName}`, video, info, roi: config.rois[roiName] });
}

function runCase(c) {
  const { width: PW, height: PH, capW, capH, fps, frames } = JSON.parse(fs.readFileSync(path.join(cacheDir, `${c.video}.json`), "utf8"));
  const fd = fs.openSync(path.join(cacheDir, `${c.video}.rgba`), "r");
  const frameBuffer = Buffer.alloc(PW * PH * 4);
  const frameData = new Uint8ClampedArray(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.length);
  let simT = 0;
  const elements = new Map();
  function fakeElement() {
    return {
      value: "", textContent: "", hidden: false, disabled: false, checked: undefined, width: 0, height: 0, readyState: 4,
      videoWidth: capW, videoHeight: capH, paused: false, dataset: {}, style: {}, lastChild: { textContent: "" },
      classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
      requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: capW / 2, height: capH / 2 }; },
      getContext() {
        return {
          setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {}, fillText() {}, drawImage() {}, putImageData() {},
          measureText() { return { width: 60 }; },
          createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
          getImageData() { return { width: PW, height: PH, data: frameData }; }
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

  const detections = [];
  let lastMotion = 0;
  let relearn = 0;
  let before = "";
  const origPass = context.handlePass;
  context.handlePass = (now) => { detections.push({ t: now / 1000, m: lastMotion }); return origPass(now); };
  const origUpdate = context.updateBackgroundAndMask;
  context.updateBackgroundAndMask = (...args) => (lastMotion = origUpdate(...args));
  const origAdvance = context.advanceDetectorState;
  context.advanceDetectorState = (...args) => {
    // 통과가 나면 값들이 초기화되므로 판정 직전 값을 적어 둔다.
    if (trace) before = ev("`기준=${currentThreshold().toFixed(1)} 움직임=${moveMotion.toFixed(1)} 밀림=${globalDx + trackBiasX},${globalDy + trackBiasY} 흔들림=${frameShake ? 1 : 0} 밝기급변=${frameBright ? 1 : 0} 범위밖=${frameBeyond ? 1 : 0} 가림=${coverSince ? 1 : 0} 대기=${disturbedSince ? 1 : 0} 최근최대=${recentPeak.toFixed(1)}`");
    return origAdvance(...args);
  };
  const origReset = context.resetDetector;
  context.resetDetector = (o) => { if (!(o && o.afterDetection) && simT > 0.3) relearn += 1; return origReset(o); };

  const [left, top, right, bottom] = c.roi;
  context.__roi = { left, top, right, bottom };
  ev(`stream = {}; roi = __roi; els.cooldownInput.value = "${COOLDOWN}"; els.historyInput.value = "1000";
      els.autoThresholdInput.checked = ${SENS === "auto"}; els.sensitivityInput.value = "${SENS === "auto" ? 20 : SENS}";
      els.ignoreShakeInput.checked = true; resizeProcessingCanvas(); resetDetector();`);

  const truths = c.info.truths || [];
  const ignore = c.info.ignore || [];
  const near = (time, list, tolerance) => list.some((T) => Math.abs(time - T) < tolerance);
  let started = false;
  let idlePeak = 0;
  let idlePeakAt = 0;
  for (let k = 0; k < frames; k += 1) {
    simT = k / fps;
    fs.readSync(fd, frameBuffer, 0, frameBuffer.length, k * frameBuffer.length);
    if (!started && simT >= 1.2) { ev("startMeasurement()"); started = true; }
    context.__now = simT * 1000;
    const stateBefore = ev("detectorState");
    ev("processFrame(__now)");
    if (stateBefore === "ready" && !near(simT, truths, 0.6) && !near(simT, ignore, 0.6) && lastMotion > idlePeak) {
      idlePeak = lastMotion;
      idlePeakAt = simT;
    }
    if (trace && simT >= trace[0] && simT <= trace[1]) console.log(simT.toFixed(3), stateBefore, `변화율=${lastMotion.toFixed(1)}`, before);
  }
  fs.closeSync(fd);

  const used = new Set();
  let hits = 0;
  for (const T of truths) {
    const d = detections.find((x) => !used.has(x) && Math.abs(x.t - T) < 0.5);
    if (d) { used.add(d); hits += 1; }
  }
  const falses = detections.filter((x) => !used.has(x) && !near(x.t, ignore, 0.6));
  return {
    이름: c.name, 영역: ev("`${roiRect.width}x${roiRect.height}`"), 감지: `${hits}/${truths.length}`, 가짜통과: falses.length,
    가짜시각: falses.map((x) => `${x.t.toFixed(2)}(${x.m.toFixed(0)}%)`).join(" ") || "-",
    평상시최대: `${idlePeak.toFixed(1)}%@${idlePeakAt.toFixed(1)}`, 다시학습: relearn,
    ok: hits === truths.length && falses.length === 0
  };
}

if (process.env.LIST) {
  for (const c of CASES) console.log(c.name);
  process.exit(0);
}
const rows = CASES.filter((c) => !only || (process.env.EXACT ? c.name === only : c.name.includes(only))).map(runCase);
if (process.env.JSONL) {
  for (const row of rows) console.log(JSON.stringify(row));
} else {
  console.table(rows.map(({ ok, ...rest }) => ({ ...rest, 판정: ok ? "통과" : "문제" })));
  const missed = rows.reduce((n, r) => n + Number(r.감지.split("/")[1]) - Number(r.감지.split("/")[0]), 0);
  console.log(`합계(${rows.length}건): 놓침 ${missed}, 가짜 통과 ${rows.reduce((n, r) => n + r.가짜통과, 0)}, 문제 항목 ${rows.filter((r) => !r.ok).length}`);
}
process.exit(rows.every((r) => r.ok) ? 0 : 1);
