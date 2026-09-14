"use strict";

const els = {
  video: document.querySelector("#cameraVideo"),
  roiCanvas: document.querySelector("#roiCanvas"),
  processingCanvas: document.querySelector("#processingCanvas"),
  debugCanvas: document.querySelector("#debugCanvas"),
  debugPanel: document.querySelector("#debugPanel"),
  debugSize: document.querySelector("#debugSize"),
  cameraEmpty: document.querySelector("#cameraEmpty"),
  cameraHelp: document.querySelector("#cameraHelp"),
  timer: document.querySelector("#timerDisplay"),
  motionValue: document.querySelector("#motionValue"),
  motionBar: document.querySelector("#motionBar"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  cameraButton: document.querySelector("#cameraButton"),
  measureButton: document.querySelector("#measureButton"),
  clearButton: document.querySelector("#clearButton"),
  debugButton: document.querySelector("#debugButton"),
  resetBackgroundButton: document.querySelector("#resetBackgroundButton"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  sensitivityOutput: document.querySelector("#sensitivityOutput"),
  historyInput: document.querySelector("#historyInput"),
  historyOutput: document.querySelector("#historyOutput"),
  cooldownInput: document.querySelector("#cooldownInput"),
  cameraSelect: document.querySelector("#cameraSelect"),
  lapList: document.querySelector("#lapList"),
  lapCount: document.querySelector("#lapCount"),
  toast: document.querySelector("#toast")
};

const STORAGE_KEY = "nukcanon-lap-time-checker-v3";
const PROCESS_MAX_WIDTH = 480;
const PROCESS_INTERVAL_MS = 16;
const LEARNING_FRAMES = 30;
const HUE_DIFF_THRESHOLD = 8;
const SATURATION_DIFF_THRESHOLD = 12;
const VALUE_DIFF_THRESHOLD = 10;

let stream = null;
let backgroundHsv = null;
let debugMask = null;
let detectorSizeKey = "";
let detectorState = "idle";
let learningFrameCount = 0;
let lastDetectionAt = 0;
let cameraSession = 0;
let processingLoopId = 0;
let processingLoopType = "raf";
let timerFrameId = 0;
let lastProcessAt = 0;
let debugVisible = false;
let roi = null;
let drag = null;
let measuring = false;
let timerStarted = false;
let lapStartedAt = 0;

const saved = loadSavedState();
let laps = Array.isArray(saved.laps) ? saved.laps : [];
els.sensitivityInput.value = String(saved.sensitivity ?? 27);
els.historyInput.value = String(saved.history ?? 1000);
els.cooldownInput.value = String(saved.cooldown ?? 2000);

function loadSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sensitivity: Number(els.sensitivityInput.value),
      history: Number(els.historyInput.value),
      cooldown: Number(els.cooldownInput.value),
      laps
    }));
  } catch {
    // 저장소가 막혀도 측정은 계속한다.
  }
}

function setStatus(text, state = "loading") {
  els.statusText.textContent = text;
  els.statusPill.dataset.state = state;
}

let toastTimer = 0;
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function updateSettingLabels() {
  els.sensitivityOutput.value = `${Number(els.sensitivityInput.value).toFixed(0)}%`;
  els.historyOutput.value = String(Number(els.historyInput.value));
}

function formatTime(milliseconds) {
  const safe = Math.max(0, milliseconds);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const hundredths = Math.floor((safe % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function renderLaps() {
  els.lapCount.textContent = `${laps.length} LAP`;
  els.lapList.replaceChildren();
  if (!laps.length) {
    const empty = document.createElement("li");
    empty.className = "empty-row";
    empty.textContent = "아직 기록된 랩타임이 없습니다.";
    els.lapList.append(empty);
    return;
  }
  laps.forEach((lap) => {
    const item = document.createElement("li");
    item.className = "lap-row";
    const number = document.createElement("span");
    number.className = "lap-number";
    number.textContent = String(lap.number);
    const time = document.createElement("span");
    time.className = "lap-time";
    time.textContent = lap.time;
    item.append(number, time);
    els.lapList.append(item);
  });
}

function resizeRoiCanvas() {
  const rect = els.roiCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (els.roiCanvas.width !== width || els.roiCanvas.height !== height) {
    els.roiCanvas.width = width;
    els.roiCanvas.height = height;
  }
  drawRoi();
}

function canvasPoint(event) {
  const rect = els.roiCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    width: rect.width,
    height: rect.height
  };
}

function normalizedRect(start, end) {
  return {
    left: Math.min(start.x, end.x) / start.width,
    top: Math.min(start.y, end.y) / start.height,
    right: Math.max(start.x, end.x) / start.width,
    bottom: Math.max(start.y, end.y) / start.height
  };
}

function drawRoi(previewRect = null) {
  const canvas = els.roiCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, rect.width);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const selected = previewRect || roi;
  if (!selected) return;
  const left = selected.left * rect.width;
  const top = selected.top * rect.height;
  const width = (selected.right - selected.left) * rect.width;
  const height = (selected.bottom - selected.top) * rect.height;
  ctx.fillStyle = "rgba(3, 169, 244, .10)";
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = "#35e58a";
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 6]);
  ctx.strokeRect(left + 1.5, top + 1.5, Math.max(0, width - 3), Math.max(0, height - 3));
  ctx.setLineDash([]);
  const label = "감지 영역";
  ctx.font = "700 13px sans-serif";
  const labelWidth = ctx.measureText(label).width + 16;
  const labelY = top >= 32 ? top - 28 : top + 6;
  ctx.fillStyle = "rgba(10, 24, 37, .84)";
  ctx.fillRect(left, labelY, labelWidth, 23);
  ctx.fillStyle = "#dfffee";
  ctx.fillText(label, left + 8, labelY + 16);
}

function onPointerDown(event) {
  if (!stream) return showToast("먼저 카메라를 시작해주세요.");
  if (measuring) return showToast("측정을 중지한 후 감지 영역을 바꿔주세요.");
  const point = canvasPoint(event);
  drag = { pointerId: event.pointerId, start: point, end: point };
  els.roiCanvas.setPointerCapture(event.pointerId);
  drawRoi(normalizedRect(point, point));
}

function onPointerMove(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.end = canvasPoint(event);
  drawRoi(normalizedRect(drag.start, drag.end));
}

function finishPointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.end = canvasPoint(event);
  const nextRoi = normalizedRect(drag.start, drag.end);
  const widthPixels = (nextRoi.right - nextRoi.left) * drag.start.width;
  const heightPixels = (nextRoi.bottom - nextRoi.top) * drag.start.height;
  drag = null;
  if (widthPixels < 20 || heightPixels < 20) {
    drawRoi();
    return showToast("감지 영역을 조금 더 크게 드래그해주세요.");
  }
  roi = nextRoi;
  drawRoi();
  resetDetector();
  updateMeasureAvailability();
  els.cameraHelp.textContent = "초록색 사각형과 실제 감지 영역을 같은 좌표로 처리합니다.";
}

function cancelPointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  drawRoi();
}

function mapRoiToVideo() {
  if (!roi || !els.video.videoWidth || !els.video.videoHeight) return null;
  const display = els.roiCanvas.getBoundingClientRect();
  const videoWidth = els.video.videoWidth;
  const videoHeight = els.video.videoHeight;
  const scale = Math.max(display.width / videoWidth, display.height / videoHeight);
  const offsetX = (display.width - videoWidth * scale) / 2;
  const offsetY = (display.height - videoHeight * scale) / 2;
  const screenLeft = roi.left * display.width;
  const screenTop = roi.top * display.height;
  const screenRight = roi.right * display.width;
  const screenBottom = roi.bottom * display.height;
  const left = Math.max(0, Math.min(videoWidth - 1, (screenLeft - offsetX) / scale));
  const top = Math.max(0, Math.min(videoHeight - 1, (screenTop - offsetY) / scale));
  const right = Math.max(left + 1, Math.min(videoWidth, (screenRight - offsetX) / scale));
  const bottom = Math.max(top + 1, Math.min(videoHeight, (screenBottom - offsetY) / scale));
  return { left, top, right, bottom, videoWidth, videoHeight };
}

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const selected = els.cameraSelect.value;
    els.cameraSelect.replaceChildren();
    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `카메라 ${index + 1}`;
      els.cameraSelect.append(option);
    });
    els.cameraSelect.disabled = cameras.length < 2;
    if (cameras.some((camera) => camera.deviceId === selected)) els.cameraSelect.value = selected;
  } catch {
    els.cameraSelect.disabled = true;
  }
}

async function startCamera(deviceId = "") {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("이 브라우저는 카메라를 지원하지 않습니다", "detected");
    return showToast("HTTPS에서 최신 브라우저로 열어주세요.");
  }
  const session = ++cameraSession;
  if (measuring) stopMeasurement();
  cancelProcessingLoop();
  stopTracks();
  resetDetector();
  setStatus("카메라 권한 확인 중", "loading");
  try {
    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } };
    const nextStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    if (session !== cameraSession) {
      nextStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = nextStream;
    els.video.srcObject = stream;
    await new Promise((resolve, reject) => {
      if (els.video.readyState >= 1) resolve();
      else {
        els.video.addEventListener("loadedmetadata", resolve, { once: true });
        els.video.addEventListener("error", reject, { once: true });
      }
    });
    await els.video.play();
    els.cameraEmpty.hidden = true;
    els.cameraButton.lastChild.textContent = " 카메라 중지";
    els.cameraHelp.textContent = "영상 위에서 자동차가 통과할 영역을 드래그하세요.";
    await listCameras();
    resizeProcessingCanvas();
    resetDetector();
    updateMeasureAvailability();
    startProcessingLoop();
  } catch (error) {
    if (session !== cameraSession) return;
    stream = null;
    els.video.srcObject = null;
    els.cameraEmpty.hidden = false;
    setStatus("카메라를 열 수 없습니다", "detected");
    if (error?.name === "NotAllowedError") showToast("브라우저 설정에서 카메라 권한을 허용해주세요.");
    else if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") showToast("선택한 카메라를 사용할 수 없습니다.");
    else showToast("카메라를 시작하지 못했습니다.");
  }
}

function stopTracks() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  els.video.srcObject = null;
}

function stopCamera() {
  cameraSession += 1;
  stopMeasurement();
  cancelProcessingLoop();
  stopTracks();
  resetDetector();
  els.cameraEmpty.hidden = false;
  els.cameraButton.lastChild.textContent = " 카메라 시작";
  els.measureButton.disabled = true;
  setStatus("카메라 대기", "loading");
  updateMotionMeter(0);
}

function resizeProcessingCanvas() {
  if (!els.video.videoWidth || !els.video.videoHeight) return;
  const scale = Math.min(1, PROCESS_MAX_WIDTH / els.video.videoWidth);
  els.processingCanvas.width = Math.max(2, Math.round(els.video.videoWidth * scale));
  els.processingCanvas.height = Math.max(2, Math.round(els.video.videoHeight * scale));
}

function resetDetector() {
  backgroundHsv = null;
  debugMask = null;
  detectorSizeKey = "";
  learningFrameCount = 0;
  detectorState = stream && roi ? "learning" : "idle";
  updateMotionMeter(0);
  updateDetectorStatus();
}

function updateMotionMeter(value) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  els.motionValue.textContent = `${safe.toFixed(1)}%`;
  els.motionBar.style.width = `${Math.min(100, safe)}%`;
}

function updateDetectorStatus() {
  if (detectorState === "learning") {
    const text = learningFrameCount >= LEARNING_FRAMES
      ? "재감지 대기"
      : `배경 학습 중 ${learningFrameCount}/${LEARNING_FRAMES}`;
    setStatus(text, "learning");
  } else if (detectorState === "ready") {
    if (measuring && !timerStarted) setStatus("첫 통과 대기", "measuring");
    else if (measuring) setStatus("랩타임 측정 중", "measuring");
    else setStatus("감지 준비", "ready");
  } else if (stream) {
    setStatus("감지 영역을 선택해주세요", "loading");
  } else {
    setStatus("카메라 대기", "loading");
  }
}

function initializeDetector(frame, width, height) {
  const pixelCount = width * height;
  backgroundHsv = new Float32Array(pixelCount * 3);
  debugMask = els.debugCanvas.getContext("2d").createImageData(width, height);
  detectorSizeKey = `${width}x${height}`;
  learningFrameCount = 0;
  for (let dataIndex = 3; dataIndex < debugMask.data.length; dataIndex += 4) debugMask.data[dataIndex] = 255;
  updateBackgroundAndMask(frame, true);
}

function updateBackgroundAndMask(frame, learning) {
  const pixelCount = frame.width * frame.height;
  const history = Math.max(1, Number(els.historyInput.value));
  const alpha = learning ? 1 / Math.max(1, learningFrameCount + 1) : 1 / history;
  let changedPixels = 0;
  for (let pixel = 0, dataIndex = 0, bgIndex = 0; pixel < pixelCount; pixel += 1, dataIndex += 4, bgIndex += 3) {
    const red = frame.data[dataIndex] / 255;
    const green = frame.data[dataIndex + 1] / 255;
    const blue = frame.data[dataIndex + 2] / 255;
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const delta = high - low;
    let hue = 0;
    if (delta > 0) {
      if (high === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (high === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
      if (hue < 0) hue += 360;
    }
    const saturation = high === 0 ? 0 : delta / high * 255;
    const value = high * 255;
    if (learningFrameCount === 0 && learning) {
      backgroundHsv[bgIndex] = hue;
      backgroundHsv[bgIndex + 1] = saturation;
      backgroundHsv[bgIndex + 2] = value;
    }
    let hueDelta = hue - backgroundHsv[bgIndex];
    if (hueDelta > 180) hueDelta -= 360;
    else if (hueDelta < -180) hueDelta += 360;
    const saturationDelta = saturation - backgroundHsv[bgIndex + 1];
    const valueDelta = value - backgroundHsv[bgIndex + 2];
    const changed = !learning && (
      Math.abs(hueDelta) >= HUE_DIFF_THRESHOLD ||
      Math.abs(saturationDelta) >= SATURATION_DIFF_THRESHOLD ||
      Math.abs(valueDelta) >= VALUE_DIFF_THRESHOLD
    );
    if (changed) changedPixels += 1;
    const maskValue = changed ? 255 : 0;
    debugMask.data[dataIndex] = maskValue;
    debugMask.data[dataIndex + 1] = maskValue;
    debugMask.data[dataIndex + 2] = maskValue;
    backgroundHsv[bgIndex] = (backgroundHsv[bgIndex] + hueDelta * alpha + 360) % 360;
    backgroundHsv[bgIndex + 1] += saturationDelta * alpha;
    backgroundHsv[bgIndex + 2] += valueDelta * alpha;
  }
  if (learning) learningFrameCount += 1;
  return changedPixels / pixelCount * 100;
}

function drawDebugMask(width, height) {
  if (!debugVisible || !debugMask) return;
  if (els.debugCanvas.width !== width || els.debugCanvas.height !== height) {
    els.debugCanvas.width = width;
    els.debugCanvas.height = height;
  }
  els.debugCanvas.getContext("2d").putImageData(debugMask, 0, 0);
  els.debugSize.textContent = `${width} × ${height}`;
}

function processFrame(now) {
  scheduleNextFrame();
  if (!stream || !roi || now - lastProcessAt < PROCESS_INTERVAL_MS || els.video.readyState < 2) return;
  lastProcessAt = now;
  try {
    if (!els.processingCanvas.width) resizeProcessingCanvas();
    const ctx = els.processingCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(els.video, 0, 0, els.processingCanvas.width, els.processingCanvas.height);
    const mapped = mapRoiToVideo();
    if (!mapped) return;
    const scaleX = els.processingCanvas.width / mapped.videoWidth;
    const scaleY = els.processingCanvas.height / mapped.videoHeight;
    const x = Math.max(0, Math.floor(mapped.left * scaleX));
    const y = Math.max(0, Math.floor(mapped.top * scaleY));
    const width = Math.max(1, Math.min(els.processingCanvas.width - x, Math.ceil((mapped.right - mapped.left) * scaleX)));
    const height = Math.max(1, Math.min(els.processingCanvas.height - y, Math.ceil((mapped.bottom - mapped.top) * scaleY)));
    const frame = ctx.getImageData(x, y, width, height);
    const sizeKey = `${width}x${height}`;
    if (!backgroundHsv || detectorSizeKey !== sizeKey) {
      initializeDetector(frame, width, height);
      detectorState = "learning";
      updateMotionMeter(0);
      drawDebugMask(width, height);
      updateDetectorStatus();
      return;
    }
    const learning = detectorState === "learning";
    const motion = updateBackgroundAndMask(frame, learning);
    updateMotionMeter(motion);
    drawDebugMask(width, height);
    if (learning) {
      const cooldown = Number(els.cooldownInput.value);
      if (learningFrameCount >= LEARNING_FRAMES && now - lastDetectionAt >= cooldown) detectorState = "ready";
    } else if (motion > Number(els.sensitivityInput.value)) {
      lastDetectionAt = now;
      handlePass(now);
      resetDetector();
    }
    updateDetectorStatus();
  } catch (error) {
    console.error(error);
    setStatus("프레임 처리 오류", "detected");
  }
}

function scheduleNextFrame() {
  if (!stream) return;
  if (typeof els.video.requestVideoFrameCallback === "function") {
    processingLoopType = "video";
    processingLoopId = els.video.requestVideoFrameCallback(processFrame);
  } else {
    processingLoopType = "raf";
    processingLoopId = window.requestAnimationFrame(processFrame);
  }
}

function startProcessingLoop() {
  cancelProcessingLoop();
  lastProcessAt = 0;
  scheduleNextFrame();
}

function cancelProcessingLoop() {
  if (!processingLoopId) return;
  if (processingLoopType === "video" && typeof els.video.cancelVideoFrameCallback === "function") {
    els.video.cancelVideoFrameCallback(processingLoopId);
  } else {
    window.cancelAnimationFrame(processingLoopId);
  }
  processingLoopId = 0;
}

function handlePass(now) {
  if (!measuring) return;
  if (!timerStarted) {
    timerStarted = true;
    lapStartedAt = now;
    updateTimer();
    showToast("첫 통과를 기준으로 타이머를 시작했습니다.");
    return;
  }
  const elapsed = now - lapStartedAt;
  if (elapsed < 500) return;
  laps.unshift({ number: laps.length + 1, time: formatTime(elapsed) });
  lapStartedAt = now;
  renderLaps();
  saveState();
}

function updateTimer(now = performance.now()) {
  if (!measuring || !timerStarted) return;
  els.timer.textContent = formatTime(now - lapStartedAt);
  timerFrameId = window.requestAnimationFrame(updateTimer);
}

function startMeasurement() {
  if (!stream || !roi) return;
  measuring = true;
  timerStarted = false;
  lapStartedAt = 0;
  els.timer.textContent = "00:00.00";
  els.measureButton.classList.add("running");
  els.measureButton.lastChild.textContent = " 측정 중지";
  resetDetector();
}

function stopMeasurement() {
  measuring = false;
  timerStarted = false;
  lapStartedAt = 0;
  window.cancelAnimationFrame(timerFrameId);
  timerFrameId = 0;
  els.timer.textContent = "00:00.00";
  els.measureButton.classList.remove("running");
  els.measureButton.lastChild.textContent = " 측정 시작";
  updateDetectorStatus();
}

function updateMeasureAvailability() {
  els.measureButton.disabled = !(stream && roi);
}

els.roiCanvas.addEventListener("pointerdown", onPointerDown);
els.roiCanvas.addEventListener("pointermove", onPointerMove);
els.roiCanvas.addEventListener("pointerup", finishPointer);
els.roiCanvas.addEventListener("pointercancel", cancelPointer);
els.cameraButton.addEventListener("click", () => stream ? stopCamera() : startCamera(els.cameraSelect.value));
els.measureButton.addEventListener("click", () => measuring ? stopMeasurement() : startMeasurement());
els.clearButton.addEventListener("click", () => {
  laps = [];
  renderLaps();
  saveState();
  showToast("랩타임 기록을 초기화했습니다.");
});
els.debugButton.addEventListener("click", () => {
  debugVisible = !debugVisible;
  els.debugPanel.hidden = !debugVisible;
  els.debugButton.setAttribute("aria-pressed", String(debugVisible));
});
els.resetBackgroundButton.addEventListener("click", () => {
  resetDetector();
  showToast("배경을 다시 학습합니다. 카메라를 잠시 고정해주세요.");
});
els.sensitivityInput.addEventListener("input", updateSettingLabels);
els.sensitivityInput.addEventListener("change", saveState);
els.historyInput.addEventListener("input", updateSettingLabels);
els.historyInput.addEventListener("change", () => {
  saveState();
  resetDetector();
});
els.cooldownInput.addEventListener("change", saveState);
els.cameraSelect.addEventListener("change", () => {
  if (stream) startCamera(els.cameraSelect.value);
});
window.addEventListener("resize", resizeRoiCanvas);
window.addEventListener("orientationchange", () => window.setTimeout(resizeRoiCanvas, 150));
window.addEventListener("pagehide", () => {
  cancelProcessingLoop();
  stopTracks();
});

updateSettingLabels();
renderLaps();
resizeRoiCanvas();
setStatus("카메라 대기", "loading");
updateMeasureAvailability();
