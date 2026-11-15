"use strict";
// 감지기의 상태 전환과 핵심 규칙을 가짜 화면으로 확인한다. 실행: node tests/state-test.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const toasts = [];

function fakeElement() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: undefined,
    width: 640,
    height: 360,
    readyState: 0,
    dataset: {},
    style: {},
    lastChild: { textContent: "" },
    classList: { add() {}, remove() {} },
    addEventListener() {},
    setAttribute() {},
    replaceChildren() {},
    append() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; },
    getContext() {
      return {
        setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {}, fillText() {},
        measureText() { return { width: 60 }; },
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; }
      };
    }
  };
}

const elements = new Map();
const context = {
  console,
  document: {
    visibilityState: "visible",
    addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
    createElement: fakeElement
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  navigator: {},
  performance: { now() { return 0; } },
  window: {
    devicePixelRatio: 1,
    clearTimeout() {}, setTimeout() { return 1; }, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    addEventListener() {}
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/../app.js`, "utf8"), context);

const evaluate = (source) => vm.runInContext(source, context);
elements.get("#toast").classList.add = () => toasts.push(elements.get("#toast").textContent);

// --- 기본값 ---
assert.equal(evaluate("els.autoThresholdInput.checked"), true, "감지 기준 자동이 기본");
assert.equal(evaluate("els.ignoreShakeInput.checked"), true, "충격·조명 변화 무시가 기본");
assert.equal(evaluate("els.lockCameraInput.checked"), false, "초점·색 고정은 기본으로 꺼짐");

evaluate('stream = {}; roi = { left: 0, top: 0, right: 1, bottom: 1 }; els.cooldownInput.value = "2000"; els.autoThresholdInput.checked = false; els.sensitivityInput.value = "20";');

// --- 상태 전환 ---
evaluate('detectorState = "ready"; measuring = false; advanceDetectorState(1000, 100);');
assert.equal(evaluate("detectorState"), "ready", "측정 중이 아니면 통과로 치지 않는다");

evaluate('detectorState = "learning"; learningFrameCount = 30; learningAfterDetection = false; advanceDetectorState(1000, 0);');
assert.equal(evaluate("detectorState"), "ready");

evaluate('detectorState = "ready"; measuring = true; timerStarted = false; advanceDetectorState(3000, 25);');
assert.equal(evaluate("detectorState"), "learning");
assert.equal(evaluate("learningAfterDetection"), true);
assert.equal(evaluate("lastDetectionAt"), 3000);
assert.equal(evaluate("timerStarted"), true, "첫 통과가 타이머를 시작한다");

evaluate("learningFrameCount = 30; advanceDetectorState(4000, 0);");
assert.equal(evaluate("detectorState"), "learning", "재감지 대기시간 전에는 준비되지 않는다");
evaluate("advanceDetectorState(5000, 0);");
assert.equal(evaluate("detectorState"), "ready");

// --- 충격·조명 변화 무시 ---
evaluate('detectorState = "ready"; measuring = true; disturbedSince = 0; holdFrames = 0; advanceDetectorState(6000, 50, false);');
assert.equal(evaluate("detectorState"), "ready", "불안정한 프레임의 큰 변화는 통과가 아니다");
assert.ok(evaluate("disturbedSince") > 0);
evaluate("advanceDetectorState(6033, 50, true);");
assert.equal(evaluate("detectorState"), "ready", "변화가 가라앉기 전에는 통과로 치지 않는다");
evaluate("advanceDetectorState(6066, 0, true); advanceDetectorState(6100, 0, true); advanceDetectorState(6133, 0, true);");
assert.equal(evaluate("disturbedSince"), 0, "변화가 3프레임 가라앉으면 감지를 다시 시작한다");
evaluate("advanceDetectorState(6166, 0, true); advanceDetectorState(6200, 0, true);");
evaluate("advanceDetectorState(8000, 50, true);");
assert.equal(evaluate("lastDetectionAt"), 8000, "안정된 프레임의 큰 변화는 통과다");

evaluate('detectorState = "ready"; disturbedSince = 0; holdFrames = 0; advanceDetectorState(9000, 1, false); advanceDetectorState(9033, 1, false);');
assert.equal(evaluate("disturbedSince"), 0, "흔들려도 변화율이 기준 아래면 감지를 멈추지 않는다");

evaluate('detectorState = "ready"; disturbedSince = 0; holdFrames = 0; advanceDetectorState(10000, 50, false); advanceDetectorState(10500, 50, true); advanceDetectorState(11001, 50, true);');
assert.equal(evaluate("detectorState"), "learning", "1초 넘게 돌아오지 않으면 배경을 다시 배운다");
assert.equal(evaluate("learningAfterDetection"), false);

evaluate('els.ignoreShakeInput.checked = false; detectorState = "ready"; measuring = true; advanceDetectorState(13000, 50, false);');
assert.equal(evaluate("lastDetectionAt"), 13000, "기능을 끄면 예전처럼 바로 통과로 친다");
evaluate("els.ignoreShakeInput.checked = true;");

// --- 랩 기록과 표시 ---
evaluate("stopMeasurement(); laps = []; startMeasurement(); handlePass(1000); handlePass(13000); handlePass(25100); handlePass(37000);");
assert.equal(evaluate("JSON.stringify(laps.map((lap) => lap.ms))"), JSON.stringify([11900, 12100, 12000]));
assert.equal(evaluate("JSON.stringify(laps.map((lap) => lap.number))"), JSON.stringify([3, 2, 1]));
assert.ok(evaluate("laps.every((lap) => lap.flags.length === 0)"));
evaluate("handlePass(61000);");
assert.equal(evaluate("JSON.stringify(laps[0].flags)"), JSON.stringify(["missed"]), "평소의 약 2배 랩은 통과 누락 의심");
evaluate("handlePass(65000);");
assert.equal(evaluate("JSON.stringify(laps[0].flags)"), JSON.stringify(["short"]), "평소의 절반 이하 랩은 오감지 의심");
evaluate('lapFlags.add("stall"); handlePass(77000);');
assert.equal(evaluate("JSON.stringify(laps[0].flags)"), JSON.stringify(["stall"]));
assert.equal(evaluate("lapFlags.size"), 0, "표시는 해당 랩에만 붙는다");
assert.equal(evaluate("laps[0].time"), "00:12.00");

// --- 영상 끊김 ---
evaluate("lastFrameSeenAt = 0; frameIntervalMs = 33; trackFrameGap(100000); trackFrameGap(100033); trackFrameGap(100066);");
assert.equal(evaluate("lapFlags.size"), 0);
evaluate("trackFrameGap(100300);");
assert.equal(evaluate("lapFlags.has('stall')"), true, "프레임이 평소보다 길게 끊기면 랩에 표시한다");
assert.ok(toasts.some((text) => text.includes("끊겼습니다")));
evaluate("lapFlags.clear(); stopMeasurement();");

// --- 촬영 시각 ---
assert.equal(evaluate("captureLatencyMs = 0; frameTimestamp(1000, { captureTime: 960 })"), 960);
assert.equal(evaluate("frameTimestamp(1000, undefined)"), 1000 - evaluate("captureLatencyMs"));
assert.equal(evaluate("captureLatencyMs = 0; frameTimestamp(1000, { captureTime: 5 })"), 1000, "말이 안 되는 촬영 시각은 쓰지 않는다");

// --- 감지 기준 ---
evaluate('els.autoThresholdInput.checked = false; els.sensitivityInput.value = "17";');
assert.equal(evaluate("currentThreshold()"), 17);
evaluate("els.autoThresholdInput.checked = true; noiseMean = 0; noiseDeviation = 0;");
assert.equal(evaluate("currentThreshold()"), 3, "자동 기준의 최솟값");
evaluate("noiseMean = 2; noiseDeviation = 1;");
assert.equal(evaluate("currentThreshold()"), 6.5, "평소 변화가 크면 기준을 올린다");
evaluate("noiseMean = 90;");
assert.equal(evaluate("currentThreshold()"), 40, "자동 기준의 최댓값");
evaluate("noiseMean = 0; noiseDeviation = 0;");

// --- 배경 모델 ---
function frame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}
const flat = () => [120, 120, 120];
const patch = (px, py, size) => (x, y) => (x >= px && x < px + size && y >= py && y < py + size) ? [25, 30, 35] : [120, 120, 120];

context.baseFrame = frame(60, 40, flat);
context.objectFrame = frame(60, 40, patch(20, 10, 20));
evaluate("initializeDetector(baseFrame);");
for (let i = 1; i < 30; i += 1) evaluate("updateBackgroundAndMask(baseFrame, true);");
assert.equal(evaluate("learningFrameCount"), 30);
assert.ok(evaluate("updateBackgroundAndMask(baseFrame, false)") < 0.1);
assert.ok(evaluate("updateBackgroundAndMask(objectFrame, false)") > 10, "덩어리로 변한 면적을 센다");
let settledMotion = 100;
for (let i = 0; i < 300; i += 1) settledMotion = evaluate("updateBackgroundAndMask(objectFrame, false)");
assert.ok(settledMotion < 1, "머물러 있는 변화는 배경으로 받아들인다");

// 가는 선(흔들림이 남기는 모양)은 덩어리로 세지 않는다
context.lineFrame = frame(60, 40, (x, y) => (y === 20 || x === 30) ? [25, 30, 35] : [120, 120, 120]);
evaluate("initializeDetector(baseFrame);");
for (let i = 1; i < 30; i += 1) evaluate("updateBackgroundAndMask(baseFrame, true);");
assert.ok(evaluate("updateBackgroundAndMask(lineFrame, false)") < 0.5, "가는 선은 통과로 세지 않는다");

// 화면 전체가 옆으로 밀려도 따라가서 비교한다
const scene = (shift) => (x, y) => {
  const sx = x - shift;
  const base = 120 + 40 * Math.sin(sx * 0.35) + 25 * Math.cos(y * 0.5) + ((sx * 7 + y * 13) % 11);
  return [base, base, base];
};
context.sceneFrame = frame(160, 100, scene(0));
context.shiftedFrame = frame(160, 100, scene(5));
context.sceneRoi = { x: 50, y: 30, width: 60, height: 40 };
evaluate("initializeDetector(sceneFrame, sceneRoi);");
for (let i = 1; i < 30; i += 1) evaluate("updateBackgroundAndMask(sceneFrame, true, sceneRoi);");
const shiftedMotion = evaluate("updateBackgroundAndMask(shiftedFrame, false, sceneRoi)");
assert.equal(evaluate("globalDx"), 5, "화면 밀림 5px를 찾는다");
assert.equal(evaluate("frameStable"), false, "갑작스러운 밀림은 불안정으로 본다");
assert.ok(shiftedMotion < 1, `밀림을 따라가면 변화율이 거의 없다 (실제 ${shiftedMotion.toFixed(2)}%)`);

console.log("state-test: ok");
