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
  autoThresholdInput: document.querySelector("#autoThresholdInput"),
  ignoreShakeInput: document.querySelector("#ignoreShakeInput"),
  lockCameraInput: document.querySelector("#lockCameraInput"),
  historyInput: document.querySelector("#historyInput"),
  historyOutput: document.querySelector("#historyOutput"),
  cooldownInput: document.querySelector("#cooldownInput"),
  cameraSelect: document.querySelector("#cameraSelect"),
  lapList: document.querySelector("#lapList"),
  lapCount: document.querySelector("#lapCount"),
  toast: document.querySelector("#toast")
};

const STORAGE_KEY = "nukcanon_laptimecheck";
const MAX_SAVED_LAPS = 500;
const PROCESS_MAX_WIDTH = 360;
// requestVideoFrameCallback이 없는 브라우저에서만 쓰는 최소 처리 간격.
const RAF_MIN_INTERVAL_MS = 15;
const LEARNING_FRAMES = 30;

// 감지 영역 안의 미세 정렬과 전경 판정.
const MAX_ALIGNMENT_SHIFT = 2;
const ALIGNMENT_SAMPLE_STEP = 6;
const LUMA_BASE_THRESHOLD = 8;
const CHROMA_BASE_THRESHOLD = 7;
const NOISE_SIGMA_MULTIPLIER = 2.2;
const LUMA_OFFSET_LIMIT = 32;
// 주변 8칸 중 이만큼 이상 함께 변해야 "덩어리"로 센다. 흔들림이 남기는 가는 선과 잡음은 걸러진다.
const SOLID_NEIGHBOR_MIN = 6;

// 화면 전체로 카메라 흔들림과 조명 변화를 잰다.
const GLOBAL_SHIFT_RANGE = 12;
const GLOBAL_BAND_MARGIN = 4;
const PROFILE_DIFF_CAP = 20;
const SHIFT_JUMP_LIMIT = 3;
const SHIFT_JUMP_FACTOR = 2.5;
const DISTURB_HOLD_FRAMES = 2;
const LIGHT_GRID_X = 12;
const LIGHT_GRID_Y = 8;
const LIGHT_JUMP_LIMIT = 10;
const LIGHT_FAR_LIMIT = 28;
const DISTURB_RECOVER_FRAMES = 3;
const DISTURB_RELEARN_MS = 1000;
// 보정 범위 밖 밀림·큰 밝기 차가 이만큼 이어지면 일시적 흔들림이 아니므로 배경을 다시 배운다.
const STALE_REFERENCE_FRAMES = 15;
// 감지 영역의 최소 크기(처리 화면 기준 픽셀). 이보다 작으면 덩어리를 셀 자리가 없다.
const MIN_ROI_PROCESS_PIXELS = 24;
const VIDEO_READY_TIMEOUT_MS = 8000;

// 자동 감지 기준.
const AUTO_MIN_PERCENT = 3;
const AUTO_MIN_PIXELS = 40;
const AUTO_MAX_PERCENT = 40;

// 배경 적응. OpenCV MOG2처럼 초기화 직후에는 빨리, 이후에는 History까지 천천히 적응하고
// 같은 모습으로 머무는 변화는 적응 구간의 약 11% 프레임 뒤 배경으로 받아들인다.
const MODEL_MIN_WINDOW = 60;
const ABSORB_RATIO = 0.11;
const ABSORB_MIN_FRAMES = 8;
const INITIAL_VARIANCE_Y = 64;
const INITIAL_VARIANCE_C = 36;

// 영상 끊김 감시.
const STALL_MIN_MS = 150;
const STALL_INTERVAL_FACTOR = 4;
const STALL_RELEARN_MS = 1000;
const WATCHDOG_INTERVAL_MS = 500;
const WATCHDOG_FROZEN_MS = 1500;

const FLAG_LABELS = {
  missed: "통과 누락 의심",
  short: "오감지 의심",
  stall: "영상 끊김",
  shake: "흔들림"
};

let stream = null;
let backgroundY = null;
let backgroundCb = null;
let backgroundCr = null;
let varianceY = null;
let varianceCb = null;
let varianceCr = null;
let candidateY = null;
let candidateCb = null;
let candidateCr = null;
let candidateCount = null;
let currentY = null;
let currentCb = null;
let currentCr = null;
let rawMask = null;
let cleanMask = null;
let debugMask = null;
let detectorSizeKey = "";
let detectorState = "idle";
let learningFrameCount = 0;
let modelFrameCount = 0;
let lastDetectionAt = 0;
// true인 동안은 "실제 통과 직후" 재학습 단계다.
// 초기/수동 재학습과 구분해야 cooldown 때문에 평상시 배경이 반복 초기화되지 않는다.
let learningAfterDetection = false;
let roiRect = null;

// 화면 전체 측정값.
let globalKey = "";
let curCol = null;
let curRow = null;
let refCol = null;
let refRow = null;
let curBlock = null;
let prevBlock = null;
let refBlock = null;
let blockArea = null;
let blockCol = null;
let blockRow = null;
let blockDiff = null;
let globalDx = 0;
let globalDy = 0;
let frameStable = true;
let frameJolt = false;
let usualJump = 0;
let holdFrames = 0;
let staleFrames = 0;
let disturbedSince = 0;
let calmFrames = 0;
let noiseMean = 0;
let noiseDeviation = 0;
let shownThreshold = -1;
const lumaHistogram = new Int32Array(129); // -64..+64

let cameraSession = 0;
let processingLoopId = 0;
let processingLoopType = "raf";
let processingContext = null;
let timerFrameId = 0;
let watchdogId = 0;
let lastProcessAt = 0;
let lastFrameSeenAt = 0;
let frameIntervalMs = 33;
let captureLatencyMs = 0;
let wakeLock = null;
let wakeLockWanted = false;
let wakeLockPending = null;
let debugVisible = false;
let roi = null;
let drag = null;
let measuring = false;
let timerStarted = false;
let lapStartedAt = 0;
let lapFlags = new Set();
let sessionLapMs = [];

const saved = loadSavedState();
let laps = Array.isArray(saved.laps)
  ? saved.laps.filter((lap) => lap && typeof lap === "object" && typeof lap.time === "string")
  : [];
els.sensitivityInput.value = String(saved.sensitivity ?? 20);
els.historyInput.value = String(saved.history ?? 1000);
els.cooldownInput.value = String(saved.cooldown ?? 2000);
els.autoThresholdInput.checked = saved.autoThreshold ?? true;
els.ignoreShakeInput.checked = saved.ignoreShake ?? true;
els.lockCameraInput.checked = saved.lockCamera ?? false;

function loadSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
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
      autoThreshold: els.autoThresholdInput.checked,
      ignoreShake: els.ignoreShakeInput.checked,
      lockCamera: els.lockCameraInput.checked,
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
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function updateSettingLabels() {
  els.sensitivityInput.disabled = els.autoThresholdInput.checked;
  els.historyOutput.value = String(Number(els.historyInput.value));
  shownThreshold = -1;
  updateThresholdLabel();
}

function updateThresholdLabel() {
  const threshold = currentThreshold();
  const rounded = Math.round(threshold * 10) / 10;
  if (rounded === shownThreshold) return;
  shownThreshold = rounded;
  els.sensitivityOutput.value = els.autoThresholdInput.checked
    ? `자동 ${rounded.toFixed(1)}%`
    : `${rounded.toFixed(0)}%`;
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
    const flags = document.createElement("span");
    flags.className = "lap-flags";
    (Array.isArray(lap.flags) ? lap.flags : []).forEach((flag) => {
      if (!FLAG_LABELS[flag]) return;
      const badge = document.createElement("span");
      badge.className = "lap-flag";
      badge.textContent = FLAG_LABELS[flag];
      flags.append(badge);
    });
    const time = document.createElement("span");
    time.className = "lap-time";
    time.textContent = lap.time;
    item.append(number, flags, time);
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
    // 화면 크기가 바뀌면 사각형이 가리키는 영상 위치도 달라지므로 배경을 다시 배운다.
    if (stream && roi) resetDetector();
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
  const previousRoi = roi;
  roi = nextRoi;
  const processRect = computeRoiRect();
  if (processRect && (processRect.width < MIN_ROI_PROCESS_PIXELS || processRect.height < MIN_ROI_PROCESS_PIXELS)) {
    roi = previousRoi;
    drawRoi();
    return showToast("감지 영역이 너무 작습니다. 차가 충분히 들어가도록 더 크게 드래그해주세요.");
  }
  drawRoi();
  resetDetector();
  updateMeasureAvailability();
  els.cameraHelp.textContent = "차가 한 차선으로 지나가는 곳을, 진행 방향으로 차 길이의 2~3배가 되게 잡으면 가장 안정적입니다.";
}

function cancelPointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  drawRoi();
}

function mapRoiToVideo() {
  if (!roi || !els.video.videoWidth || !els.video.videoHeight) return null;
  const display = els.roiCanvas.getBoundingClientRect();
  if (!display.width || !display.height) return null;
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

function computeRoiRect() {
  const mapped = mapRoiToVideo();
  const canvasWidth = els.processingCanvas.width;
  const canvasHeight = els.processingCanvas.height;
  if (!mapped || !canvasWidth || !canvasHeight) return null;
  const scaleX = canvasWidth / mapped.videoWidth;
  const scaleY = canvasHeight / mapped.videoHeight;
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(mapped.left * scaleX)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(mapped.top * scaleY)));
  const width = Math.max(1, Math.min(canvasWidth - x, Math.ceil((mapped.right - mapped.left) * scaleX)));
  const height = Math.max(1, Math.min(canvasHeight - y, Math.ceil((mapped.bottom - mapped.top) * scaleY)));
  return { x, y, width, height };
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
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (session !== cameraSession) return;
        stopCamera();
        setStatus("카메라 연결이 끊겼습니다", "detected");
        showToast("카메라 연결이 끊겼습니다. 카메라를 다시 시작해주세요.");
      }, { once: true });
    });
    els.video.srcObject = stream;
    await waitForVideoMetadata(els.video);
    await els.video.play();
    if (session !== cameraSession) return;
    els.cameraEmpty.hidden = true;
    els.cameraButton.lastChild.textContent = " 카메라 중지";
    els.cameraHelp.textContent = "영상 위에서 자동차가 통과할 영역을 드래그하세요.";
    await listCameras();
    if (session !== cameraSession) return;
    resizeProcessingCanvas();
    resetDetector();
    updateMeasureAvailability();
    lastFrameSeenAt = 0;
    captureLatencyMs = 0;
    startProcessingLoop();
    startWatchdog();
    const keptAwake = await requestWakeLock();
    if (!keptAwake && session === cameraSession && !("wakeLock" in navigator)) {
      showToast("이 브라우저는 화면 켜짐 유지를 지원하지 않습니다. 기기의 화면 자동 꺼짐을 꺼주세요.");
    }
  } catch (error) {
    if (session !== cameraSession) return;
    cancelProcessingLoop();
    stopWatchdog();
    releaseWakeLock();
    stopTracks();
    resetDetector();
    els.cameraEmpty.hidden = false;
    els.cameraButton.lastChild.textContent = " 카메라 시작";
    updateMeasureAvailability();
    setStatus("카메라를 열 수 없습니다", "detected");
    if (error?.name === "NotAllowedError") showToast("브라우저 설정에서 카메라 권한을 허용해주세요.");
    else if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") showToast("선택한 카메라를 사용할 수 없습니다.");
    else showToast("카메라를 시작하지 못했습니다. 다른 앱이 카메라를 쓰고 있는지 확인해주세요.");
  }
}

// 영상 정보가 준비될 때까지 기다린다. 끝없이 기다리지 않도록 시간 제한을 둔다.
function waitForVideoMetadata(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("video error")); };
    timer = window.setTimeout(() => { cleanup(); reject(new Error("video timeout")); }, VIDEO_READY_TIMEOUT_MS);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onError);
  });
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
  stopWatchdog();
  releaseWakeLock();
  stopTracks();
  resetDetector();
  els.cameraEmpty.hidden = false;
  els.cameraButton.lastChild.textContent = " 카메라 시작";
  els.measureButton.disabled = true;
  setStatus("카메라 대기", "loading");
  updateMotionMeter(0);
}

// 화면이 꺼지면 카메라와 측정이 함께 멈추므로 카메라가 켜진 동안 화면을 켜 둔다.
function requestWakeLock() {
  wakeLockWanted = true;
  if (wakeLock) return Promise.resolve(true);
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return Promise.resolve(false);
  // 요청이 겹치면 잠금이 두 개 잡혀 하나가 남으므로 진행 중인 요청을 함께 쓴다.
  if (wakeLockPending) return wakeLockPending;
  wakeLockPending = navigator.wakeLock.request("screen").then((lock) => {
    if (!wakeLockWanted) {
      lock.release().catch(() => {});
      return false;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
    return true;
  }).catch(() => false).finally(() => {
    wakeLockPending = null;
  });
  return wakeLockPending;
}

function releaseWakeLock() {
  wakeLockWanted = false;
  if (!wakeLock) return;
  const lock = wakeLock;
  wakeLock = null;
  lock.release().catch(() => {});
}

// 측정 중 카메라가 초점·색을 다시 맞추면 화면 전체가 변해 오감지가 생긴다. 지원 기기에서만 고정한다.
async function applyCameraLock(lock) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || typeof track.getCapabilities !== "function" || typeof track.applyConstraints !== "function") return false;
  let capabilities;
  let settings;
  try {
    capabilities = track.getCapabilities() || {};
    settings = (typeof track.getSettings === "function" && track.getSettings()) || {};
  } catch {
    return false;
  }
  const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  const whiteModes = Array.isArray(capabilities.whiteBalanceMode) ? capabilities.whiteBalanceMode : [];
  const advanced = {};
  if (lock) {
    // 현재 초점 거리를 알 수 있을 때만 고정한다. 모르면 초점이 엉뚱한 곳으로 갈 수 있다.
    if (focusModes.includes("manual") && Number.isFinite(settings.focusDistance)) {
      advanced.focusMode = "manual";
      advanced.focusDistance = settings.focusDistance;
    }
    if (whiteModes.includes("manual")) {
      advanced.whiteBalanceMode = "manual";
      if (Number.isFinite(settings.colorTemperature)) advanced.colorTemperature = settings.colorTemperature;
    }
  } else {
    if (focusModes.includes("continuous")) advanced.focusMode = "continuous";
    if (whiteModes.includes("continuous")) advanced.whiteBalanceMode = "continuous";
  }
  if (!Object.keys(advanced).length) return false;
  try {
    await track.applyConstraints({ advanced: [advanced] });
    return true;
  } catch {
    return false;
  }
}

function resizeProcessingCanvas() {
  if (!els.video.videoWidth || !els.video.videoHeight) return;
  const scale = Math.min(1, PROCESS_MAX_WIDTH / els.video.videoWidth);
  const width = Math.max(2, Math.round(els.video.videoWidth * scale));
  const height = Math.max(2, Math.round(els.video.videoHeight * scale));
  if (els.processingCanvas.width !== width) els.processingCanvas.width = width;
  if (els.processingCanvas.height !== height) els.processingCanvas.height = height;
}

function resetDetector({ afterDetection = false } = {}) {
  backgroundY = null;
  backgroundCb = null;
  backgroundCr = null;
  varianceY = null;
  varianceCb = null;
  varianceCr = null;
  candidateY = null;
  candidateCb = null;
  candidateCr = null;
  candidateCount = null;
  currentY = null;
  currentCb = null;
  currentCr = null;
  rawMask = null;
  cleanMask = null;
  debugMask = null;
  detectorSizeKey = "";
  roiRect = null;
  learningFrameCount = 0;
  modelFrameCount = 0;
  globalDx = 0;
  globalDy = 0;
  frameStable = true;
  frameJolt = false;
  disturbedSince = 0;
  calmFrames = 0;
  learningAfterDetection = afterDetection;
  // 실제 통과 직후에만 cooldown 시간을 유지한다.
  holdFrames = 0;
  staleFrames = 0;
  if (!afterDetection) {
    lastDetectionAt = 0;
    noiseMean = 0;
    noiseDeviation = 0;
    usualJump = 0;
  }
  detectorState = stream && roi ? "learning" : "idle";
  updateMotionMeter(0);
  updateThresholdLabel();
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
    if (disturbedSince) setStatus("흔들림·조명 변화 감지, 잠시 대기", "learning");
    else if (measuring && !timerStarted) setStatus("첫 통과 대기", "measuring");
    else if (measuring) setStatus("랩타임 측정 중", "measuring");
    else setStatus("감지 준비", "ready");
  } else if (stream) {
    setStatus("감지 영역을 선택해주세요", "loading");
  } else {
    setStatus("카메라 대기", "loading");
  }
}

// 테두리(정렬 여유 + 덩어리 판정 1칸)는 셀 수 없으므로 비율 계산에서 뺀다.
function countableArea(width, height) {
  const border = (MAX_ALIGNMENT_SHIFT + 1) * 2;
  return Math.max(1, (width - border) * (height - border));
}

function currentThreshold() {
  if (!els.autoThresholdInput.checked) return Number(els.sensitivityInput.value);
  const pixelCount = cleanMask && roiRect ? countableArea(roiRect.width, roiRect.height) : 0;
  const pixelFloor = pixelCount ? AUTO_MIN_PIXELS / pixelCount * 100 : 0;
  const floor = Math.max(AUTO_MIN_PERCENT, pixelFloor);
  // 평소에도 남는 변화(잔진동 등)가 있으면 그만큼 기준을 올린다.
  const noiseBased = noiseMean + noiseDeviation * 4 + 0.5;
  return Math.min(AUTO_MAX_PERCENT, Math.max(floor, noiseBased));
}

function allocateDetectorBuffers(width, height) {
  const pixelCount = width * height;
  backgroundY = new Float32Array(pixelCount);
  backgroundCb = new Float32Array(pixelCount);
  backgroundCr = new Float32Array(pixelCount);
  varianceY = new Float32Array(pixelCount);
  varianceCb = new Float32Array(pixelCount);
  varianceCr = new Float32Array(pixelCount);
  candidateY = new Float32Array(pixelCount);
  candidateCb = new Float32Array(pixelCount);
  candidateCr = new Float32Array(pixelCount);
  candidateCount = new Uint16Array(pixelCount);
  currentY = new Uint8Array(pixelCount);
  currentCb = new Uint8Array(pixelCount);
  currentCr = new Uint8Array(pixelCount);
  rawMask = new Uint8Array(pixelCount);
  cleanMask = new Uint8Array(pixelCount);
  debugMask = els.debugCanvas.getContext("2d").createImageData(width, height);
  learningFrameCount = 0;
  modelFrameCount = 0;
  for (let i = 3; i < debugMask.data.length; i += 4) debugMask.data[i] = 255;
}

function wholeFrameRect(frame) {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}

// 화면 전체 영상에서 감지 영역만 꺼내 YCbCr로 바꾼다. 카메라가 밀린 만큼(shift) 따라가서 꺼낸다.
function extractYcbcr(frame, rect = wholeFrameRect(frame), shiftX = 0, shiftY = 0) {
  const source = frame.data;
  const frameWidth = frame.width;
  const width = rect.width;
  const height = rect.height;
  const startX = Math.max(0, Math.min(frameWidth - width, rect.x + shiftX));
  const startY = Math.max(0, Math.min(frame.height - height, rect.y + shiftY));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    let i = ((startY + y) * frameWidth + startX) * 4;
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const r = source[i];
      const g = source[i + 1];
      const b = source[i + 2];
      // Hue는 저채도 영역에서 크게 튀므로 웹에서는 YCbCr로 비교한다.
      // 배열에 넣을 때 소수점이 버려지므로 0.5를 더해 반올림한다. 값은 항상 0 이상이다.
      currentY[p] = 0.299 * r + 0.587 * g + 0.114 * b + 0.5;
      currentCb[p] = Math.min(255, 128.5 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      currentCr[p] = Math.min(255, 128.5 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
}

function initializeDetector(frame, rect = wholeFrameRect(frame)) {
  const width = rect.width;
  const height = rect.height;
  allocateDetectorBuffers(width, height);
  detectorSizeKey = `${rect.x},${rect.y},${width}x${height}`;
  extractYcbcr(frame, rect);
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i += 1) {
    backgroundY[i] = currentY[i];
    backgroundCb[i] = currentCb[i];
    backgroundCr[i] = currentCr[i];
    // 첫 프레임에서 분산이 0이면 미세 압축 노이즈까지 전경으로 잡히므로 최소 노이즈 폭을 둔다.
    varianceY[i] = INITIAL_VARIANCE_Y;
    varianceCb[i] = INITIAL_VARIANCE_C;
    varianceCr[i] = INITIAL_VARIANCE_C;
  }
  rawMask.fill(0);
  cleanMask.fill(0);
  learningFrameCount = 1;
  modelFrameCount = 1;
  globalDx = 0;
  globalDy = 0;
  frameStable = true;
  measureGlobal(frame, rect);
  captureGlobalReference();
  updateDebugMask(width, height);
}

function allocateGlobalBuffers(width, height) {
  curCol = new Float32Array(width);
  curRow = new Float32Array(height);
  refCol = null;
  refRow = null;
  const blocks = LIGHT_GRID_X * LIGHT_GRID_Y;
  curBlock = new Float32Array(blocks);
  prevBlock = new Float32Array(blocks);
  refBlock = null;
  blockDiff = new Float32Array(blocks);
  blockArea = new Float32Array(blocks);
  blockCol = new Uint8Array(width);
  blockRow = new Uint8Array(height);
  for (let x = 0; x < width; x += 1) blockCol[x] = Math.min(LIGHT_GRID_X - 1, Math.floor(x * LIGHT_GRID_X / width));
  for (let y = 0; y < height; y += 1) blockRow[y] = Math.min(LIGHT_GRID_Y - 1, Math.floor(y * LIGHT_GRID_Y / height)) * LIGHT_GRID_X;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) blockArea[blockRow[y] + blockCol[x]] += 1;
  }
  globalKey = `${width}x${height}`;
}

// 화면 전체의 세로줄·가로줄 평균 밝기와 구역별 평균 밝기를 구한다.
// 차가 지나가는 띠(감지 영역의 가로·세로 범위)는 빼서, 차 때문에 흔들림으로 오해하지 않게 한다.
function measureGlobal(frame, rect) {
  const width = frame.width;
  const height = frame.height;
  const data = frame.data;
  if (globalKey !== `${width}x${height}` || !curCol) allocateGlobalBuffers(width, height);

  let bandTop = rect.y - GLOBAL_BAND_MARGIN;
  let bandBottom = rect.y + rect.height + GLOBAL_BAND_MARGIN;
  let bandLeft = rect.x - GLOBAL_BAND_MARGIN;
  let bandRight = rect.x + rect.width + GLOBAL_BAND_MARGIN;
  if (Math.max(0, bandTop) + Math.max(0, height - bandBottom) < height * 0.25) bandTop = bandBottom = -1;
  if (Math.max(0, bandLeft) + Math.max(0, width - bandRight) < width * 0.25) bandLeft = bandRight = -1;

  curCol.fill(0);
  curBlock.fill(0);
  let rowsUsed = 0;
  let colsUsed = 0;
  for (let x = 0; x < width; x += 1) if (x < bandLeft || x >= bandRight) colsUsed += 1;
  for (let y = 0; y < height; y += 1) {
    const rowOutside = y < bandTop || y >= bandBottom;
    if (rowOutside) rowsUsed += 1;
    const blockBase = blockRow[y];
    let rowSum = 0;
    let p = y * width * 4;
    for (let x = 0; x < width; x += 1, p += 4) {
      const luma = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      if (rowOutside) curCol[x] += luma;
      if (x < bandLeft || x >= bandRight) rowSum += luma;
      curBlock[blockBase + blockCol[x]] += luma;
    }
    curRow[y] = rowSum / Math.max(1, colsUsed);
  }
  const rowScale = 1 / Math.max(1, rowsUsed);
  for (let x = 0; x < width; x += 1) curCol[x] *= rowScale;
  for (let b = 0; b < curBlock.length; b += 1) curBlock[b] /= Math.max(1, blockArea[b]);
}

function captureGlobalReference() {
  refCol = Float32Array.from(curCol);
  refRow = Float32Array.from(curRow);
  refBlock = Float32Array.from(curBlock);
  prevBlock.set(curBlock);
}

// 기준 줄무늬(ref)에 대해 현재 줄무늬(cur)가 몇 픽셀 밀렸는지 찾는다.
// 밝기 자체가 아니라 변화량을 비교해 조명 변화에 영향받지 않고, 차이에 상한을 둬 움직이는 물체에 끌려가지 않는다.
function bestProfileShift(cur, ref, previous) {
  const range = GLOBAL_SHIFT_RANGE;
  const start = range + 1;
  const end = cur.length - range - 1;
  if (end - start < 24) return 0;
  let bestShift = previous;
  let bestCost = Number.POSITIVE_INFINITY;
  let previousCost = Number.POSITIVE_INFINITY;
  for (let shift = -range; shift <= range; shift += 1) {
    let cost = 0;
    for (let i = start; i < end; i += 1) {
      const diff = (cur[i + shift + 1] - cur[i + shift - 1]) - (ref[i + 1] - ref[i - 1]);
      const magnitude = diff < 0 ? -diff : diff;
      cost += magnitude > PROFILE_DIFF_CAP ? PROFILE_DIFF_CAP : magnitude;
    }
    if (shift === previous) previousCost = cost;
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  // 뚜렷하게 더 잘 맞을 때만 옮긴다. 무늬가 약한 화면에서 값이 떠도는 것을 막는다.
  return bestCost < previousCost * 0.85 ? bestShift : previous;
}

function medianBlockDifference(a, b) {
  for (let i = 0; i < blockDiff.length; i += 1) blockDiff[i] = a[i] - b[i];
  blockDiff.sort();
  return blockDiff[blockDiff.length >> 1];
}

// 카메라 밀림(globalDx, globalDy)을 갱신하고, 이번 프레임이 안정적인지 돌려준다.
// 불안정 = 카메라가 급하게 움직였거나, 보정 범위를 벗어났거나, 조명이 크게 바뀐 경우.
function updateGlobalMotion(frame, rect, adaptRate) {
  measureGlobal(frame, rect);
  if (!refCol || refCol.length !== curCol.length || refRow.length !== curRow.length) {
    captureGlobalReference();
    globalDx = 0;
    globalDy = 0;
    return true;
  }
  const nextDx = bestProfileShift(curCol, refCol, globalDx);
  const nextDy = bestProfileShift(curRow, refRow, globalDy);
  const jump = Math.max(Math.abs(nextDx - globalDx), Math.abs(nextDy - globalDy));
  // 늘 있는 잔진동은 배경 학습에 이미 들어 있다. 평소보다 훨씬 큰 움직임만 "급한 움직임"으로 본다.
  const jumpLimit = Math.max(SHIFT_JUMP_LIMIT, usualJump * SHIFT_JUMP_FACTOR);
  usualJump += (jump - usualJump) * 0.05;
  globalDx = nextDx;
  globalDy = nextDy;
  const lightStep = medianBlockDifference(curBlock, prevBlock);
  const lightFar = medianBlockDifference(curBlock, refBlock);
  prevBlock.set(curBlock);
  const atEdge = Math.abs(globalDx) >= GLOBAL_SHIFT_RANGE || Math.abs(globalDy) >= GLOBAL_SHIFT_RANGE;
  // 감지 영역이 화면 끝에 가까우면 밀린 만큼 따라가지 못한다. 그때도 보정 한계로 본다.
  const clipped = rect.x + globalDx < 0 || rect.x + rect.width + globalDx > frame.width
    || rect.y + globalDy < 0 || rect.y + rect.height + globalDy > frame.height;
  const beyondLimit = atEdge || clipped || Math.abs(lightFar) >= LIGHT_FAR_LIMIT;
  staleFrames = beyondLimit ? staleFrames + 1 : 0;
  // 급한 움직임·밝기 변화(jolt)는 다음 프레임까지 잔상이 남을 수 있어 따로 기억한다.
  frameJolt = jump >= jumpLimit || Math.abs(lightStep) >= LIGHT_JUMP_LIMIT;
  const stable = !frameJolt && !beyondLimit;
  // 기준 밝기는 배경 모델과 같은 속도로 따라가야 "배경 대비 밝기 차"를 뜻하게 된다.
  for (let b = 0; b < refBlock.length; b += 1) refBlock[b] += (curBlock[b] - refBlock[b]) * adaptRate;
  return stable;
}

function estimateAlignment(width, height) {
  // 배경 좌표에 대해 현재 프레임이 몇 픽셀 이동했는지 찾는다.
  // 밝기 자체가 아니라 수평/수직 경계(gradient)를 비교하므로 자동노출 변화에 강하다.
  // 큰 물체가 ROI 일부를 가려도 한 영역이 정렬 전체를 끌고 가지 않도록 오차를 cap한다.
  const margin = MAX_ALIGNMENT_SHIFT + 3;
  if (width <= margin * 2 + 2 || height <= margin * 2 + 2) return { dx: 0, dy: 0, lumaOffset: 0 };
  // 작은 영역은 표본이 모자라 엉뚱한 위치로 맞춰지기 쉬우므로 더 촘촘히 본다.
  const sampleStep = Math.max(2, Math.min(ALIGNMENT_SAMPLE_STEP, Math.floor(Math.min(width, height) / 12)));

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let zeroScore = Number.POSITIVE_INFINITY;

  for (let dy = -MAX_ALIGNMENT_SHIFT; dy <= MAX_ALIGNMENT_SHIFT; dy += 1) {
    for (let dx = -MAX_ALIGNMENT_SHIFT; dx <= MAX_ALIGNMENT_SHIFT; dx += 1) {
      let scoreSum = 0;
      let count = 0;
      for (let y = margin; y < height - margin; y += sampleStep) {
        const bgRow = y * width;
        const bgRowUp = (y - 1) * width;
        const bgRowDown = (y + 1) * width;
        const cy = y + dy;
        const curRowIndex = cy * width;
        const curRowUp = (cy - 1) * width;
        const curRowDown = (cy + 1) * width;
        for (let x = margin; x < width - margin; x += sampleStep) {
          const cx = x + dx;
          const bgGx = backgroundY[bgRow + x + 1] - backgroundY[bgRow + x - 1];
          const bgGy = backgroundY[bgRowDown + x] - backgroundY[bgRowUp + x];
          const curGx = currentY[curRowIndex + cx + 1] - currentY[curRowIndex + cx - 1];
          const curGy = currentY[curRowDown + cx] - currentY[curRowUp + cx];
          const dgx = curGx - bgGx;
          const dgy = curGy - bgGy;
          scoreSum += Math.min(900, dgx * dgx + dgy * dgy);
          count += 1;
        }
      }
      if (!count) continue;
      const score = scoreSum / count + (Math.abs(dx) + Math.abs(dy)) * 0.2;
      if (!dx && !dy) zeroScore = score;
      if (score < bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // 큰 밀림은 화면 전체 기준으로 이미 맞췄다. 여기서는 뚜렷하게 더 잘 맞을 때만 옮긴다.
  if (bestScore > zeroScore * 0.8) {
    bestDx = 0;
    bestDy = 0;
  }

  // 선택된 정렬 위치에서 밝기 차이의 median을 구해 자동노출/조명 변화를 보정한다.
  // 움직이는 물체는 이상치가 되므로 평균보다 median이 훨씬 안정적이다.
  lumaHistogram.fill(0);
  let sampleCount = 0;
  for (let y = margin; y < height - margin; y += sampleStep) {
    const bgRow = y * width;
    const curRowIndex = (y + bestDy) * width;
    for (let x = margin; x < width - margin; x += sampleStep) {
      const diff = Math.max(-64, Math.min(64, Math.round(currentY[curRowIndex + x + bestDx] - backgroundY[bgRow + x])));
      lumaHistogram[diff + 64] += 1;
      sampleCount += 1;
    }
  }
  let lumaOffset = 0;
  if (sampleCount) {
    const middle = Math.floor(sampleCount / 2);
    let accumulated = 0;
    for (let i = 0; i < lumaHistogram.length; i += 1) {
      accumulated += lumaHistogram[i];
      if (accumulated > middle) {
        lumaOffset = i - 64;
        break;
      }
    }
  }

  return {
    dx: bestDx,
    dy: bestDy,
    lumaOffset: Math.max(-LUMA_OFFSET_LIMIT, Math.min(LUMA_OFFSET_LIMIT, lumaOffset))
  };
}

// 변한 픽셀 중 주변도 함께 변한 "덩어리"만 남긴다.
function filterMotionMask(width, height) {
  cleanMask.fill(0);
  let changed = 0;
  const border = MAX_ALIGNMENT_SHIFT + 1;
  for (let y = border; y < height - border; y += 1) {
    const row = y * width;
    for (let x = border; x < width - border; x += 1) {
      const i = row + x;
      if (!rawMask[i]) continue;
      const up = i - width;
      const down = i + width;
      const neighbors = rawMask[up - 1] + rawMask[up] + rawMask[up + 1]
        + rawMask[i - 1] + rawMask[i + 1]
        + rawMask[down - 1] + rawMask[down] + rawMask[down + 1];
      if (neighbors >= SOLID_NEIGHBOR_MIN) {
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

// 전경으로 남아 있는 픽셀: 같은 모습이 충분히 오래 이어지면 새 배경으로 받아들인다.
function absorbForegroundPixel(i, luma, cb, cr, absorbFrames) {
  const count = candidateCount[i];
  if (count
    && Math.abs(luma - candidateY[i]) < LUMA_BASE_THRESHOLD * 1.5
    && Math.abs(cb - candidateCb[i]) < CHROMA_BASE_THRESHOLD * 1.5
    && Math.abs(cr - candidateCr[i]) < CHROMA_BASE_THRESHOLD * 1.5) {
    candidateY[i] += (luma - candidateY[i]) * 0.2;
    candidateCb[i] += (cb - candidateCb[i]) * 0.2;
    candidateCr[i] += (cr - candidateCr[i]) * 0.2;
    if (count + 1 >= absorbFrames) {
      backgroundY[i] = candidateY[i];
      backgroundCb[i] = candidateCb[i];
      backgroundCr[i] = candidateCr[i];
      varianceY[i] = INITIAL_VARIANCE_Y;
      varianceCb[i] = INITIAL_VARIANCE_C;
      varianceCr[i] = INITIAL_VARIANCE_C;
      candidateCount[i] = 0;
    } else {
      candidateCount[i] = count + 1;
    }
  } else {
    candidateY[i] = luma;
    candidateCb[i] = cb;
    candidateCr[i] = cr;
    candidateCount[i] = 1;
  }
}

function updateDebugMask(width, height) {
  if (!debugVisible) return;
  const pixelCount = width * height;
  for (let p = 0, i = 0; p < pixelCount; p += 1, i += 4) {
    const value = cleanMask[p] ? 255 : 0;
    debugMask.data[i] = value;
    debugMask.data[i + 1] = value;
    debugMask.data[i + 2] = value;
  }
}

function modelWindowFrames() {
  const history = Math.max(1, Number(els.historyInput.value) || 1000);
  return Math.min(Math.max(modelFrameCount * 2, MODEL_MIN_WINDOW), Math.max(history, 2));
}

// 한 프레임을 처리해 "덩어리로 변한 면적"의 비율(%)을 돌려준다. 학습 중에는 0.
function updateBackgroundAndMask(frame, learning, rect = wholeFrameRect(frame)) {
  const width = rect.width;
  const height = rect.height;
  const pixelCount = width * height;
  const learningAlpha = 1 / Math.min(Math.max(2, learningFrameCount + 1), 20);
  const readyAlpha = 1 / modelWindowFrames();
  frameStable = updateGlobalMotion(frame, rect, learning ? learningAlpha : readyAlpha);
  extractYcbcr(frame, rect, globalDx, globalDy);
  const alignment = estimateAlignment(width, height);
  modelFrameCount += 1;

  rawMask.fill(0);
  cleanMask.fill(0);

  if (learning) {
    // MOG2의 초기 빠른 적응을 흉내낸다. 20프레임 이후에도 0.05로 계속 학습하여
    // 통과 직후 자동차가 아직 ROI에 남아 있더라도 cooldown 동안 새 배경으로 회복한다.
    for (let y = 0; y < height; y += 1) {
      const cy = y + alignment.dy;
      if (cy < 0 || cy >= height) continue;
      const row = y * width;
      const curRowIndex = cy * width;
      for (let x = 0; x < width; x += 1) {
        const cx = x + alignment.dx;
        if (cx < 0 || cx >= width) continue;
        const i = row + x;
        const curIndex = curRowIndex + cx;
        const lumaResidual = currentY[curIndex] - backgroundY[i] - alignment.lumaOffset;
        const cbResidual = currentCb[curIndex] - backgroundCb[i];
        const crResidual = currentCr[curIndex] - backgroundCr[i];
        updateBackgroundPixel(i, curIndex, learningAlpha, lumaResidual, cbResidual, crResidual);
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
    const curRowIndex = cy * width;
    for (let x = MAX_ALIGNMENT_SHIFT; x < width - MAX_ALIGNMENT_SHIFT; x += 1) {
      const cx = x + alignment.dx;
      if (cx < 0 || cx >= width) continue;
      const i = row + x;
      const curIndex = curRowIndex + cx;
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

  // 2) 덩어리로 변한 면적만 센다.
  const changedPixels = filterMotionMask(width, height);

  // 3) 배경은 천천히 따라가고, 전경은 같은 모습으로 머물면 배경으로 받아들인다.
  const absorbFrames = Math.max(ABSORB_MIN_FRAMES, Math.round(modelWindowFrames() * ABSORB_RATIO));
  for (let y = 0; y < height; y += 1) {
    const cy = y + alignment.dy;
    if (cy < 0 || cy >= height) continue;
    const row = y * width;
    const curRowIndex = cy * width;
    for (let x = 0; x < width; x += 1) {
      const cx = x + alignment.dx;
      if (cx < 0 || cx >= width) continue;
      const i = row + x;
      const curIndex = curRowIndex + cx;
      if (rawMask[i]) {
        absorbForegroundPixel(i, currentY[curIndex] - alignment.lumaOffset, currentCb[curIndex], currentCr[curIndex], absorbFrames);
        continue;
      }
      candidateCount[i] = 0;
      const lumaResidual = currentY[curIndex] - backgroundY[i] - alignment.lumaOffset;
      const cbResidual = currentCb[curIndex] - backgroundCb[i];
      const crResidual = currentCr[curIndex] - backgroundCr[i];
      updateBackgroundPixel(i, curIndex, readyAlpha, lumaResidual, cbResidual, crResidual);
    }
  }

  updateDebugMask(width, height);
  return Math.min(100, changedPixels / countableArea(width, height) * 100);
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

function markLap(flag) {
  if (measuring && timerStarted) lapFlags.add(flag);
}

function advanceDetectorState(time, motion, stable = true) {
  if (detectorState === "learning") {
    const learnedEnough = learningFrameCount >= LEARNING_FRAMES;
    const cooldown = Number(els.cooldownInput.value);
    const cooldownComplete = !learningAfterDetection || (time - lastDetectionAt >= cooldown);
    if (learnedEnough && cooldownComplete) {
      detectorState = "ready";
      learningAfterDetection = false;
      disturbedSince = 0;
      calmFrames = 0;
    }
    return;
  }

  if (detectorState !== "ready") return;
  const threshold = currentThreshold();

  // 카메라가 보정 범위 밖으로 밀렸거나 밝기가 크게 달라진 채로 머물면, 그 상태를 새 배경으로 다시 배운다.
  if (staleFrames >= STALE_REFERENCE_FRAMES) {
    markLap("shake");
    resetDetector();
    return;
  }

  // 화면 전체가 급하게 흔들리거나 조명이 바뀐 순간에 생긴 변화는 통과로 치지 않는다.
  // 흔들려도 변화율이 기준 아래면(보정이 된 것) 아무 일도 하지 않으므로 감지가 끊기지 않는다.
  if (els.ignoreShakeInput.checked) {
    if (!stable && frameJolt) holdFrames = DISTURB_HOLD_FRAMES;
    const shaky = !stable || holdFrames > 0;
    if (stable && holdFrames > 0) holdFrames -= 1;
    if (!disturbedSince && shaky && motion > threshold) {
      disturbedSince = time;
      calmFrames = 0;
      markLap("shake");
    } else if (disturbedSince) {
      calmFrames = motion <= threshold ? calmFrames + 1 : 0;
      if (calmFrames >= DISTURB_RECOVER_FRAMES) disturbedSince = 0;
    }
    if (disturbedSince) {
      // 화면이 원래대로 돌아오지 않으면 배경을 다시 배운다.
      if (time - disturbedSince >= DISTURB_RELEARN_MS) {
        resetDetector();
        if (measuring) showToast("화면이 크게 바뀌어 배경을 다시 학습합니다.");
      }
      return;
    }
  } else {
    disturbedSince = 0;
    holdFrames = 0;
  }

  if (measuring && motion > threshold) {
    lastDetectionAt = time;
    handlePass(time);
    resetDetector({ afterDetection: true });
    return;
  }

  if (stable && holdFrames === 0 && motion <= threshold) {
    noiseMean += (motion - noiseMean) * 0.02;
    noiseDeviation += (Math.abs(motion - noiseMean) - noiseDeviation) * 0.02;
  }
}

// 프레임이 찍힌 시각. 처리 지연이 랩타임에 섞이지 않게 촬영 시각을 우선 쓴다.
function frameTimestamp(now, metadata) {
  const candidate = metadata
    ? (Number.isFinite(metadata.captureTime) ? metadata.captureTime : metadata.presentationTime)
    : Number.NaN;
  if (Number.isFinite(candidate) && candidate <= now + 5 && now - candidate < 500) {
    captureLatencyMs += ((now - candidate) - captureLatencyMs) * 0.1;
    return candidate;
  }
  return now - captureLatencyMs;
}

// 프레임 사이가 평소보다 길게 벌어졌으면 그 사이에 차가 지나갔을 수 있다.
function trackFrameGap(now) {
  if (lastFrameSeenAt) {
    const gap = now - lastFrameSeenAt;
    if (gap > Math.max(STALL_MIN_MS, frameIntervalMs * STALL_INTERVAL_FACTOR)) {
      if (measuring && timerStarted) {
        lapFlags.add("stall");
        showToast(`영상이 ${(gap / 1000).toFixed(1)}초 끊겼습니다. 이번 랩은 정확하지 않을 수 있습니다.`);
      } else if (gap >= STALL_RELEARN_MS && roi) {
        showToast(`영상이 ${(gap / 1000).toFixed(1)}초 끊겨 배경을 다시 학습합니다.`);
      }
      if (gap >= STALL_RELEARN_MS) resetDetector();
    } else {
      frameIntervalMs += (gap - frameIntervalMs) * 0.1;
    }
  }
  lastFrameSeenAt = now;
}

function processFrame(now, metadata) {
  scheduleNextFrame();
  if (!stream || els.video.readyState < 2) return;
  if (processingLoopType === "raf" && now - lastProcessAt < RAF_MIN_INTERVAL_MS) return;
  lastProcessAt = now;
  trackFrameGap(now);
  if (!roi) return;
  const time = frameTimestamp(now, metadata);
  try {
    if (!els.processingCanvas.width || !els.processingCanvas.height) resizeProcessingCanvas();
    const canvasWidth = els.processingCanvas.width;
    const canvasHeight = els.processingCanvas.height;
    if (!canvasWidth || !canvasHeight) return;
    if (!processingContext) processingContext = els.processingCanvas.getContext("2d", { willReadFrequently: true });
    if (!roiRect) roiRect = computeRoiRect();
    if (!roiRect) return;
    processingContext.drawImage(els.video, 0, 0, canvasWidth, canvasHeight);
    const frame = processingContext.getImageData(0, 0, canvasWidth, canvasHeight);
    const sizeKey = `${roiRect.x},${roiRect.y},${roiRect.width}x${roiRect.height}`;
    if (!backgroundY || detectorSizeKey !== sizeKey) {
      initializeDetector(frame, roiRect);
      detectorState = "learning";
      updateMotionMeter(0);
      drawDebugMask(roiRect.width, roiRect.height);
      updateDetectorStatus();
      return;
    }
    const learning = detectorState === "learning";
    const width = roiRect.width;
    const height = roiRect.height;
    const motion = updateBackgroundAndMask(frame, learning, roiRect);
    updateMotionMeter(motion);
    drawDebugMask(width, height);
    advanceDetectorState(time, motion, frameStable);
    updateThresholdLabel();
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

// 영상이 아예 멈춘 경우(프레임이 오지 않음)는 프레임 처리 쪽에서 알 수 없으므로 따로 지켜본다.
function startWatchdog() {
  stopWatchdog();
  watchdogId = window.setInterval(() => {
    if (!stream || document.visibilityState !== "visible" || !lastFrameSeenAt) return;
    if (performance.now() - lastFrameSeenAt > WATCHDOG_FROZEN_MS) {
      setStatus("카메라 영상이 멈췄습니다", "detected");
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (!watchdogId) return;
  window.clearInterval(watchdogId);
  watchdogId = 0;
}

// 최근 랩과 비교해 통과를 놓쳤거나(약 2배) 잘못 감지한(절반 이하) 랩을 가려낸다.
function classifyLap(elapsed) {
  if (sessionLapMs.length < 2) return "";
  const recent = sessionLapMs.slice(-7).sort((a, b) => a - b);
  const median = recent[Math.floor((recent.length - 1) / 2)];
  if (elapsed > median * 1.7) return "missed";
  if (elapsed < median * 0.6) return "short";
  return "";
}

function handlePass(time) {
  if (!measuring) return;
  if (!timerStarted) {
    timerStarted = true;
    lapStartedAt = time;
    lapFlags.clear();
    updateTimer();
    showToast("첫 통과를 기준으로 타이머를 시작했습니다.");
    return;
  }
  const elapsed = time - lapStartedAt;
  if (elapsed < 500) return;
  const flags = Array.from(lapFlags);
  const suspicion = classifyLap(elapsed);
  if (suspicion) flags.push(suspicion);
  sessionLapMs.push(elapsed);
  const nextNumber = (Number(laps[0]?.number) || laps.length) + 1;
  laps.unshift({ number: nextNumber, time: formatTime(elapsed), ms: Math.round(elapsed), flags });
  if (laps.length > MAX_SAVED_LAPS) laps.length = MAX_SAVED_LAPS;
  lapStartedAt = time;
  lapFlags.clear();
  renderLaps();
  saveState();
}

function updateTimer(now = performance.now()) {
  if (!measuring || !timerStarted) return;
  els.timer.textContent = formatTime(now - captureLatencyMs - lapStartedAt);
  timerFrameId = window.requestAnimationFrame(updateTimer);
}

function startMeasurement() {
  if (!stream || !roi) return;
  measuring = true;
  timerStarted = false;
  lapStartedAt = 0;
  lapFlags.clear();
  sessionLapMs = [];
  els.timer.textContent = "00:00.00";
  els.measureButton.classList.add("running");
  els.measureButton.lastChild.textContent = " 측정 중지";
  // 측정 시작은 배경모델을 초기화할 이유가 없다. 원본 Android 동작과
  // 동일하게 현재 학습된 배경을 그대로 사용한다.
  updateDetectorStatus();
  requestWakeLock();
  if (els.lockCameraInput.checked) {
    applyCameraLock(true).then((locked) => {
      if (locked) resetDetector();
      else if (measuring) showToast("이 기기·브라우저는 초점·색 고정을 지원하지 않습니다.");
    });
  }
}

function stopMeasurement() {
  const wasMeasuring = measuring;
  measuring = false;
  timerStarted = false;
  lapStartedAt = 0;
  lapFlags.clear();
  window.cancelAnimationFrame(timerFrameId);
  timerFrameId = 0;
  els.timer.textContent = "00:00.00";
  els.measureButton.classList.remove("running");
  els.measureButton.lastChild.textContent = " 측정 시작";
  updateDetectorStatus();
  if (wasMeasuring && els.lockCameraInput.checked) applyCameraLock(false);
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
  sessionLapMs = [];
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
els.autoThresholdInput.addEventListener("change", () => {
  updateSettingLabels();
  saveState();
});
els.ignoreShakeInput.addEventListener("change", saveState);
els.lockCameraInput.addEventListener("change", () => {
  saveState();
  if (!measuring) return;
  const lock = els.lockCameraInput.checked;
  applyCameraLock(lock).then((applied) => {
    if (applied) resetDetector();
    else if (lock) showToast("이 기기·브라우저는 초점·색 고정을 지원하지 않습니다.");
  });
});
els.historyInput.addEventListener("input", updateSettingLabels);
els.historyInput.addEventListener("change", () => {
  saveState();
  resetDetector();
});
els.cooldownInput.addEventListener("change", saveState);
els.cameraSelect.addEventListener("change", () => {
  if (stream) startCamera(els.cameraSelect.value);
});
els.video.addEventListener("resize", () => {
  // 기기를 돌리면 영상 크기가 바뀐다. 처리용 화면과 배경을 새로 맞춘다.
  if (!stream) return;
  resizeProcessingCanvas();
  resetDetector();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !stream) return;
  // 화면이 꺼지면 화면 켜짐 유지가 풀리므로 돌아왔을 때 다시 요청한다.
  requestWakeLock();
  if (els.video.paused) els.video.play().catch(() => {});
});
window.addEventListener("resize", resizeRoiCanvas);
window.addEventListener("orientationchange", () => window.setTimeout(resizeRoiCanvas, 150));
window.addEventListener("pagehide", () => {
  // 페이지를 떠날 때 카메라·타이머·화면 켜짐 유지를 모두 해제한다.
  if (stream) stopCamera();
});

updateSettingLabels();
renderLaps();
resizeRoiCanvas();
setStatus("카메라 대기", "loading");
updateMeasureAvailability();
