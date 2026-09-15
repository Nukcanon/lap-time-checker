"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fakeElement() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
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
  Uint8Array,
  Uint8ClampedArray,
  Float32Array,
  Int32Array,
  Math,
  Number,
  JSON,
  document: {
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
    clearTimeout() {}, setTimeout() { return 1; },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    addEventListener() {}
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/../app.js`, "utf8"), context);

const evaluate = (source) => vm.runInContext(source, context);
evaluate('stream = {}; roi = { left: 0, top: 0, right: 1, bottom: 1 }; els.sensitivityInput.value = "20"; els.cooldownInput.value = "2000";');

evaluate('detectorState = "ready"; measuring = false; detectionConfirmCount = 0; advanceDetectorState(1000, 100);');
assert.equal(evaluate("detectorState"), "ready");
assert.equal(evaluate("learningFrameCount"), 0);

evaluate('detectorState = "learning"; learningFrameCount = 30; learningAfterDetection = false; advanceDetectorState(1000, 0);');
assert.equal(evaluate("detectorState"), "ready");

evaluate('detectorState = "ready"; measuring = true; timerStarted = false; advanceDetectorState(3000, 25);');
assert.equal(evaluate("detectorState"), "learning");
assert.equal(evaluate("learningAfterDetection"), true);
assert.equal(evaluate("lastDetectionAt"), 3000);

evaluate('learningFrameCount = 30; advanceDetectorState(4000, 0);');
assert.equal(evaluate("detectorState"), "learning");
evaluate('advanceDetectorState(5000, 0);');
assert.equal(evaluate("detectorState"), "ready");

function frame(width, height, patch = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const changed = patch && x >= patch.x && x < patch.x + patch.width && y >= patch.y && y < patch.y + patch.height;
      data[i] = changed ? 25 : 120;
      data[i + 1] = changed ? 30 : 120;
      data[i + 2] = changed ? 35 : 120;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

context.baseFrame = frame(60, 40);
context.objectFrame = frame(60, 40, { x: 20, y: 10, width: 20, height: 20 });
evaluate("initializeDetector(baseFrame, 60, 40);");
for (let i = 1; i < 30; i += 1) evaluate("updateBackgroundAndMask(baseFrame, true, true);");
assert.equal(evaluate("learningFrameCount"), 30);
assert.ok(evaluate("updateBackgroundAndMask(baseFrame, false, true)") < 0.1);
assert.ok(evaluate("updateBackgroundAndMask(objectFrame, false, false)") > 10);
let settledMotion = 100;
for (let i = 0; i < 300; i += 1) settledMotion = evaluate("updateBackgroundAndMask(objectFrame, false, true)");
assert.ok(settledMotion < 1);

console.log("state-test: ok");
