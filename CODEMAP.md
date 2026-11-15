# CODEMAP

## 목적
카메라 영상의 감지 영역을 지나가는 미니카를 잡아 랩타임을 기록하는 정적 웹앱(GitHub Pages). 안드로이드 원본 앱의 웹 이식판.

## 실행·시험
- 실행: 정적 파일. `python -m http.server 8080` 후 `http://localhost:8080` (카메라는 HTTPS 또는 localhost만 가능)
- 단위 시험: `node tests/state-test.js [app.js 경로]`
- 모의 시험: `node tests/sim.js [app.js 경로] [이름 일부]` — 가상 영상(자동차 크기 물체, 충격, 조명)으로 감지·가짜 통과·랩 오차를 센다. 전체 5~6분.
  - 추적: `SIM_TRACE=11.4,12.6 node tests/sim.js app.js "책상 침 12px"`
- 실제 영상 시험: `node tests/video-prep.js <영상> <폴더>/<이름>` → `node tests/video-eval.js <폴더> [이름 일부]`. 정답 시각은 폴더의 `cases.json`. 넓은 영역은 항목당 1분 이상(vm이 느림), 추적은 `TRACE=4.8,5.0`.
- 배포: `main`에 올리면 `.github/workflows/pages.yml`이 Pages로 배포. `index.html`의 `?v=` 값을 함께 올린다.

## 파일
- `index.html` — 화면 구조. 설정 항목의 id가 `app.js`의 `els`와 1:1.
- `style.css` — 색·간격 변수는 `:root`에 정의.
- `app.js` — 전체 로직(빌드 없음, 전역 함수).
- `tests/state-test.js` — vm으로 `app.js`를 가짜 DOM에 올려 규칙 확인.
- `tests/sim.js` — 가상 영상 장면 목록과 기대 결과.
- `tests/video-prep.js`, `tests/video-eval.js` — 실제 촬영 영상으로 놓침·가짜 통과 집계.

## app.js 흐름
`processFrame(now, metadata)` (requestVideoFrameCallback, 없으면 rAF)
1. `trackFrameGap` — 프레임 끊김 감시, 랩에 `stall` 표시
2. `frameTimestamp` — 촬영 시각(captureTime) 우선
3. 화면 전체를 360폭으로 그려 `getImageData`
4. `updateBackgroundAndMask(frame, learning, roiRect)` → 물체로 센 면적(%) 반환, `moveMotion`(움직이는 면적) 갱신
   - `updateGlobalMotion` → `measureGlobal` + `bestProfileShift` → `globalDx/Dy`, `frameShake`(급한 흔들림)·`frameBright`(화면 전체 밝기 급변)·`frameBeyond`(보정 범위 밖)
   - `recenterModel`(요청이 있으면 배경을 밀린 만큼 옮김) → `extractYcbcr`(밀림 + `trackBias`만큼 따라가 추출) → `estimateAlignment`(±2 미세 정렬, 밝기 보정)
   - 픽셀 판정: 배경 이웃 3×3 범위 밖이면 `rawMask` 1(옅은 변화) 또는 2(뚜렷한 변화), 앞 프레임과도 다르면 `moveMask`
   - `filterMotionMask` — 덩어리만 남기고, 뚜렷한 픽셀이 충분한 덩어리만 셈(`cleanMask` 2)
   - 배경 갱신 / `absorbForegroundPixel`(머무는 변화 흡수) / `rememberFrame`
5. `advanceDetectorState(time, motion)` — 판정 순서: 가림 확인 중(`coverSince`) → 흔들림 대기(`disturbedSince`) → 밝기 급변이면 가림 시작 → 움직임이 있으면 `firePass` → 없으면 `slowSince`
6. `handlePass(time)` — 랩 기록, `classifyLap`으로 누락·오감지 표시

상태: `idle` → `learning`(30프레임, 마지막 8프레임과 통과 뒤 대기 시간은 감지하듯 처리하며 잔떨림만 잼) → `ready`. 통과하면 `resetDetector({afterDetection:true})`.

## 함정
- 감지 기준(%)은 "물체로 센 면적 / 감지 영역 면적". 영역이 크면 같은 차도 비율이 작다(자동 기준 최소 3%).
- 자동 기준의 `recentPeak`는 값이 오르는 동안 반영을 미룬다(`pendingPeak`). 바로 반영하면 들어오는 물체를 따라 기준이 올라가 60fps에서 차를 놓친다.
- 그림자 허용 폭(`SHADOW_DARK_RATIO`, `SHADOW_LIGHT_RATIO`)을 넓히면 그림자에 강해지지만 뚜렷한 부분으로 치는 조건이 까다로워진다. 옅은 부분은 뚜렷한 덩어리에 붙어 있으면 세므로 면적 손실은 작다.
- 화면 전체가 가려지는 통과(손)는 밝기 급변과 구별이 안 되므로 "돌아오는지"로 가른다. 통과 시각은 가려지기 시작한 때로 소급한다.
- 화면 밀림은 감지 영역의 가로·세로 띠를 뺀 나머지로 잰다. 차가 지나가도 흔들림으로 오해하지 않기 위함.
- 흔들림 차단은 "변화율이 기준을 넘은 순간"과 "흔들린 프레임"이 겹칠 때만 건다. 흔들림만으로 감지를 멈추면 잔진동 환경에서 전혀 감지되지 않는다.
- 미세 정렬은 0,0보다 뚜렷이 좋을 때만 옮긴다. 작은 영역에서 엉뚱하게 맞춰져 가짜 통과가 났던 적이 있다.
- 화면이 꺼지거나 탭이 가려지면 프레임 콜백이 멈춘다. 화면 켜짐 유지(wakeLock)와 끊김 표시로 대응.
- 시험의 vm 안 배열은 바깥과 원형이 달라 `deepEqual`이 실패한다. JSON 문자열로 비교. vm 안에서는 전역 변수 접근이 느려 실제 브라우저보다 10배쯤 느리다.
- 크롬의 가짜 카메라(`--use-file-for-fake-video-capture`)는 mjpeg를 1/4 속도로 재생한다. 통과 횟수를 셀 때 주의.
- 초점·색 고정은 실제 기기에서 검증되지 않았다(기본 꺼짐).
