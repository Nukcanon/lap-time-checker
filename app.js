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

const STORAGE_KEY = "nukcanon-lap-time-checker-v4";
const PROCESS_MAX_WIDTH = 360;
const PROCESS_INTERVAL_MS = 24;
const LEARNING_FRAMES = 30;
const DETECTION_CONFIRM_FRAMES = 1;

// Android 앱의 MOG2 동작감에 맞추기 위한 웹용 안정화 파라미터.
// 픽셀 차이를 바로 비교하지 않고, 작은 카메라 이동/자동노출을 먼저 보정한다.
const MAX_ALIGNMENT_SHIFT = 2;
const ALIGNMENT_SAMPLE_STEP = 6;
const LUMA_BASE_THRESHOLD = 8;
const CHROMA_BASE_THRESHOLD = 7;
const NOISE_SIGMA_MULTIPLIER = 2.2;
const MASK_NEIGHBOR_MIN = 1;

let stream = null;
let backgroundY = null;
let backgroundCb = null;
let backgroundCr = null;
let varianceY = null;
let varianceCb = null;
let varianceCr = null;
let currentY = null;
let currentCb = null;
let currentCr = null;
let rawMask = null;
let cleanMask = null;
let debugMask = null;
let detectorSizeKey = "";
let detectorState = "idle";
let learningFrameCount = 0;
let detectionConfirmCount = 0;
let lastDetectionAt = 0;
// true인 동안은 "실제 통과 직후" 재학습 단계다.
// 초기/수동 재학습과 구분해야 cooldown 때문에 평상시 배경이 반복 초기화되지 않는다.
let learningAfterDetection = false;
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
els.sensitivityInput.value = String(saved.sensitivity ?? 20);
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
  // 같은 상태는 다시 그리지 않는다.
  if (els.statusText.textContent !== text) els.statusText.textContent = text;
  if (els.statusPill.dataset.state !== state) els.statusPill.dataset.state = state;
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

function resetDetector({ afterDetection = false } = {}) {
  backgroundY = null;
  backgroundCb = null;
  backgroundCr = null;
  varianceY = null;
  varianceCb = null;
  varianceCr = null;
  currentY = null;
  currentCb = null;
  currentCr = null;
  rawMask = null;
  cleanMask = null;
  debugMask = null;
  detectorSizeKey = "";
  learningFrameCount = 0;
  detectionConfirmCount = 0;
  learningAfterDetection = afterDetection;
  // 실제 통과 직후에만 cooldown 시간을 유지한다.
  if (!afterDetection) lastDetectionAt = 0;
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
    if (learningAfterDetection && learningFrameCount >= LEARNING_FRAMES) {
      setStatus("통과 후 배경 안정화 중", "learning");
    } else {
      setStatus(`배경 학습 중 ${Math.min(learningFrameCount, LEARNING_FRAMES)}/${LEARNING_FRAMES}`, "learning");
    }
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

function allocateDetectorBuffers(width, height) {
  const pixelCount = width * height;
  backgroundY = new Float32Array(pixelCount);
  backgroundCb = new Float32Array(pixelCount);
  backgroundCr = new Float32Array(pixelCount);
  varianceY = new Float32Array(pixelCount);
  varianceCb = new Float32Array(pixelCount);
  varianceCr = new Float32Array(pixelCount);
  currentY = new Uint8Array(pixelCount);
  currentCb = new Uint8Array(pixelCount);
  currentCr = new Uint8Array(pixelCount);
  rawMask = new Uint8Array(pixelCount);
  cleanMask = new Uint8Array(pixelCount);
  debugMask = els.debugCanvas.getContext("2d").createImageData(width, height);
  detectorSizeKey = `${width}x${height}`;
  learningFrameCount = 0;
  detectionConfirmCount = 0;
  for (let i = 3; i < debugMask.data.length; i += 4) debugMask.data[i] = 255;
}

function extractYcbcr(frame) {
  const source = frame.data;
  const pixelCount = frame.width * frame.height;
  for (let i = 0, p = 0; p < pixelCount; p += 1, i += 4) {
    const r = source[i];
    const g = source[i + 1];
    const b = source[i + 2];
    // Hue는 저채도 영역에서 크게 튀므로 웹에서는 YCbCr로 비교한다.
    // Android의 H/S/V MOG2와 목적은 같지만 브라우저 카메라 노이즈에 더 안정적이다.
    currentY[p] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    currentCb[p] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
    currentCr[p] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
  }
}

function initializeDetector(frame, width, height) {
  allocateDetectorBuffers(width, height);
  extractYcbcr(frame);
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i += 1) {
    backgroundY[i] = currentY[i];
    backgroundCb[i] = currentCb[i];
    backgroundCr[i] = currentCr[i];
    // 첫 프레임에서 분산이 0이면 미세 압축 노이즈까지 전경으로 잡히므로 최소 노이즈 폭을 둔다.
    varianceY[i] = 64;
    varianceCb[i] = 36;
    varianceCr[i] = 36;
  }
  rawMask.fill(0);
  cleanMask.fill(0);
  learningFrameCount = 1;
  updateDebugMask(width, height);
}

function estimateAlignment(width, height) {
  // 배경 좌표에 대해 현재 프레임이 몇 픽셀 이동했는지 찾는다.
  // 밝기 자체가 아니라 수평/수직 경계(gradient)를 비교하므로 자동노출 변화에 강하다.
  // 큰 물체가 ROI 일부를 가려도 한 영역이 정렬 전체를 끌고 가지 않도록 오차를 cap한다.
  const margin = MAX_ALIGNMENT_SHIFT + 3;
  if (width <= margin * 2 + 2 || height <= margin * 2 + 2) return { dx: 0, dy: 0, lumaOffset: 0 };

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let dy = -MAX_ALIGNMENT_SHIFT; dy <= MAX_ALIGNMENT_SHIFT; dy += 1) {
    for (let dx = -MAX_ALIGNMENT_SHIFT; dx <= MAX_ALIGNMENT_SHIFT; dx += 1) {
      let scoreSum = 0;
      let count = 0;
      for (let y = margin; y < height - margin; y += ALIGNMENT_SAMPLE_STEP) {
        const bgRow = y * width;
        const bgRowUp = (y - 1) * width;
        const bgRowDown = (y + 1) * width;
        const cy = y + dy;
        const curRow = cy * width;
        const curRowUp = (cy - 1) * width;
        const curRowDown = (cy + 1) * width;
        for (let x = margin; x < width - margin; x += ALIGNMENT_SAMPLE_STEP) {
          const cx = x + dx;
          const bgGx = backgroundY[bgRow + x + 1] - backgroundY[bgRow + x - 1];
          const bgGy = backgroundY[bgRowDown + x] - backgroundY[bgRowUp + x];
          const curGx = currentY[curRow + cx + 1] - currentY[curRow + cx - 1];
          const curGy = currentY[curRowDown + cx] - currentY[curRowUp + cx];
          const dgx = curGx - bgGx;
          const dgy = curGy - bgGy;
          scoreSum += Math.min(900, dgx * dgx + dgy * dgy);
          count += 1;
        }
      }
      if (!count) continue;
      const score = scoreSum / count + (Math.abs(dx) + Math.abs(dy)) * 0.2;
      if (score < bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // 선택된 정렬 위치에서 밝기 차이의 median을 구해 자동노출/조명 변화를 보정한다.
  // 움직이는 물체는 이상치가 되므로 평균보다 median이 훨씬 안정적이다.
  const histogram = new Int32Array(129); // -64..+64
  let sampleCount = 0;
  for (let y = margin; y < height - margin; y += ALIGNMENT_SAMPLE_STEP) {
    const bgRow = y * width;
    const curRow = (y + bestDy) * width;
    for (let x = margin; x < width - margin; x += ALIGNMENT_SAMPLE_STEP) {
      const diff = Math.max(-64, Math.min(64, Math.round(currentY[curRow + x + bestDx] - backgroundY[bgRow + x])));
      histogram[diff + 64] += 1;
      sampleCount += 1;
    }
  }
  let lumaOffset = 0;
  if (sampleCount) {
    const middle = Math.floor(sampleCount / 2);
    let accumulated = 0;
    for (let i = 0; i < histogram.length; i += 1) {
      accumulated += histogram[i];
      if (accumulated > middle) {
        lumaOffset = i - 64;
        break;
      }
    }
  }

  return {
    dx: bestDx,
    dy: bestDy,
    lumaOffset: Math.max(-32, Math.min(32, lumaOffset))
  };
}

function filterMotionMask(width, height) {
  cleanMask.fill(0);
  let changed = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      if (!rawMask[i]) continue;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if ((ox || oy) && rawMask[i + oy * width + ox]) neighbors += 1;
        }
      }
      if (neighbors >= MASK_NEIGHBOR_MIN) {
        cleanMask[i] = 1;
        changed += 1;
      }
    }
  }
  return changed;
}

function updateBackgroundPixel(i, curIndex, alpha, lumaResidual, cbResidual, crResidual) {
  const oldY = backgroundY[i];
  const oldCb = backgroundCb[i];
  const oldCr = backgroundCr[i];

  backgroundY[i] = oldY + (currentY[curIndex] - oldY) * alpha;
  backgroundCb[i] = oldCb + (currentCb[curIndex] - oldCb) * alpha;
  backgroundCr[i] = oldCr + (currentCr[curIndex] - oldCr) * alpha;

  varianceY[i] = Math.max(25, (1 - alpha) * (varianceY[i] + alpha * lumaResidual * lumaResidual));
  varianceCb[i] = Math.max(16, (1 - alpha) * (varianceCb[i] + alpha * cbResidual * cbResidual));
  varianceCr[i] = Math.max(16, (1 - alpha) * (varianceCr[i] + alpha * crResidual * crResidual));
}

function updateDebugMask(width, height) {
  const pixelCount = width * height;
  for (let p = 0, i = 0; p < pixelCount; p += 1, i += 4) {
    const value = cleanMask[p] ? 255 : 0;
    debugMask.data[i] = value;
    debugMask.data[i + 1] = value;
    debugMask.data[i + 2] = value;
  }
}

function updateBackgroundAndMask(frame, learning, fastIdleAdaptation = false) {
  const width = frame.width;
  const height = frame.height;
  const pixelCount = width * height;
  extractYcbcr(frame);
  const alignment = estimateAlignment(width, height);
  const history = Math.max(1, Number(els.historyInput.value));

  rawMask.fill(0);
  cleanMask.fill(0);

  if (learning) {
    // MOG2의 초기 빠른 적응을 흉내낸다. 20프레임 이후에도 0.05로 계속 학습하여
    // 통과 직후 자동차가 아직 ROI에 남아 있더라도 cooldown 동안 새 배경으로 회복한다.
    const alpha = 1 / Math.min(Math.max(2, learningFrameCount + 1), 20);
    for (let y = 0; y < height; y += 1) {
      const cy = y + alignment.dy;
      if (cy < 0 || cy >= height) continue;
      const row = y * width;
      const curRow = cy * width;
      for (let x = 0; x < width; x += 1) {
        const cx = x + alignment.dx;
        if (cx < 0 || cx >= width) continue;
        const i = row + x;
        const curIndex = curRow + cx;
        const lumaResidual = currentY[curIndex] - backgroundY[i] - alignment.lumaOffset;
        const cbResidual = currentCb[curIndex] - backgroundCb[i];
        const crResidual = currentCr[curIndex] - backgroundCr[i];
        updateBackgroundPixel(i, curIndex, alpha, lumaResidual, cbResidual, crResidual);
      }
    }
    learningFrameCount += 1;
    updateDebugMask(width, height);
    return 0;
  }

  // 1) 전경 후보 생성. 배경 분산이 큰 픽셀은 자동으로 임계값을 높인다.
  for (let y = MAX_ALIGNMENT_SHIFT; y < height - MAX_ALIGNMENT_SHIFT; y += 1) {
    const cy = y + alignment.dy;
    if (cy < 0 || cy >= height) continue;
    const row = y * width;
    const curRow = cy * width;
    for (let x = MAX_ALIGNMENT_SHIFT; x < width - MAX_ALIGNMENT_SHIFT; x += 1) {
      const cx = x + alignment.dx;
      if (cx < 0 || cx >= width) continue;
      const i = row + x;
      const curIndex = curRow + cx;
      const dY = currentY[curIndex] - backgroundY[i] - alignment.lumaOffset;
      const dCb = currentCb[curIndex] - backgroundCb[i];
      const dCr = currentCr[curIndex] - backgroundCr[i];

      const yThreshold = Math.max(LUMA_BASE_THRESHOLD, Math.sqrt(varianceY[i]) * NOISE_SIGMA_MULTIPLIER);
      const cbThreshold = Math.max(CHROMA_BASE_THRESHOLD, Math.sqrt(varianceCb[i]) * NOISE_SIGMA_MULTIPLIER);
      const crThreshold = Math.max(CHROMA_BASE_THRESHOLD, Math.sqrt(varianceCr[i]) * NOISE_SIGMA_MULTIPLIER);
      const chromaChanged = (dCb * dCb + dCr * dCr) > (cbThreshold * cbThreshold + crThreshold * crThreshold);

      if (Math.abs(dY) > yThreshold || chromaChanged) rawMask[i] = 1;
    }
  }

  // 2) Android 원본처럼 전경 마스크를 그대로 최종 변화율에 사용.
  const changedPixels = filterMotionMask(width, height);

  // 3) 모든 픽셀을 적응시킨다. 대기 중 전경은 조금 더 빨리 안정화한다.
  const alpha = 1 / history;
  for (let y = 0; y < height; y += 1) {
    const cy = y + alignment.dy;
    if (cy < 0 || cy >= height) continue;
    const row = y * width;
    const curRow = cy * width;
    for (let x = 0; x < width; x += 1) {
      const cx = x + alignment.dx;
      if (cx < 0 || cx >= width) continue;
      const i = row + x;
      const curIndex = curRow + cx;
      const lumaResidual = currentY[curIndex] - backgroundY[i] - alignment.lumaOffset;
      const cbResidual = currentCb[curIndex] - backgroundCb[i];
      const crResidual = currentCr[curIndex] - backgroundCr[i];
      const pixelAlpha = cleanMask[i] && fastIdleAdaptation ? Math.max(alpha, 0.01) : alpha;
      updateBackgroundPixel(i, curIndex, pixelAlpha, lumaResidual, cbResidual, crResidual);
    }
  }

  updateDebugMask(width, height);
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

function advanceDetectorState(now, motion) {
  if (detectorState === "learning") {
    const learnedEnough = learningFrameCount >= LEARNING_FRAMES;
    const cooldown = Number(els.cooldownInput.value);
    const cooldownComplete = !learningAfterDetection || (now - lastDetectionAt >= cooldown);
    if (learnedEnough && cooldownComplete) {
      detectorState = "ready";
      detectionConfirmCount = 0;
      learningAfterDetection = false;
    }
    return;
  }

  if (detectorState !== "ready") return;
  if (!measuring) {
    detectionConfirmCount = 0;
    return;
  }

  if (motion > Number(els.sensitivityInput.value)) detectionConfirmCount += 1;
  else detectionConfirmCount = 0;

  if (detectionConfirmCount >= DETECTION_CONFIRM_FRAMES) {
    lastDetectionAt = now;
    detectionConfirmCount = 0;
    handlePass(now);
    resetDetector({ afterDetection: true });
  }
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
    if (!backgroundY || detectorSizeKey !== sizeKey) {
      initializeDetector(frame, width, height);
      detectorState = "learning";
      updateMotionMeter(0);
      drawDebugMask(width, height);
      updateDetectorStatus();
      return;
    }
    const learning = detectorState === "learning";
    const motion = updateBackgroundAndMask(frame, learning, !measuring);
    updateMotionMeter(motion);
    drawDebugMask(width, height);
    advanceDetectorState(now, motion);
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
  // 측정 시작은 배경모델을 초기화할 이유가 없다. 원본 Android 동작과
  // 동일하게 현재 학습된 배경을 그대로 사용한다.
  updateDetectorStatus();
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
