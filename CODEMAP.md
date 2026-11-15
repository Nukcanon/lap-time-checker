# CODEMAP

## 목적
카메라 영상의 감지 영역을 지나가는 미니카를 잡아 랩타임을 기록하는 정적 웹앱(GitHub Pages). 안드로이드 원본 앱의 웹 이식판.

## 실행·시험
- 실행: 정적 파일. `python -m http.server 8080` 후 `http://localhost:8080` (카메라는 HTTPS 또는 localhost만 가능)
- 단위 시험: `node tests/state-test.js`
- 모의 시험: `node tests/sim.js [app.js 경로] [이름 일부]` — 가상 영상으로 감지·가짜 통과·랩 오차를 센다. 전체는 수 분.
  - 추적: `SIM_TRACE=11.4,12.6 node tests/sim.js app.js "책상 침 12px"`
- 배포: `main`에 올리면 `.github/workflows/pages.yml`이 Pages로 배포. `index.html`의 `?v=` 값을 함께 올린다.

## 파일
- `index.html` — 화면 구조. 설정 항목의 id가 `app.js`의 `els`와 1:1.
- `style.css` — 색·간격 변수는 `:root`에 정의.
- `app.js` — 전체 로직(빌드 없음, 전역 함수).
- `tests/state-test.js` — vm으로 `app.js`를 가짜 DOM에 올려 규칙 확인.
- `tests/sim.js` — 가상 영상 장면 목록과 기대 결과.

## app.js 흐름
`processFrame(now, metadata)` (requestVideoFrameCallback, 없으면 rAF)
1. `trackFrameGap` — 프레임 끊김 감시, 랩에 `stall` 표시
2. `frameTimestamp` — 촬영 시각(captureTime) 우선
3. 화면 전체를 360폭으로 그려 `getImageData`
4. `updateBackgroundAndMask(frame, learning, roiRect)`
   - `updateGlobalMotion` → `measureGlobal`(줄무늬·구역 밝기) + `bestProfileShift` → `globalDx/Dy`, `frameStable`
   - `extractYcbcr`(밀림만큼 따라가서 감지 영역 추출) → `estimateAlignment`(±2 미세 정렬, 밝기 보정)
   - 전경 판정 → `filterMotionMask`(덩어리만) → 배경 갱신 / `absorbForegroundPixel`(머무는 변화 흡수)
5. `advanceDetectorState(time, motion, stable)` — learning → ready, 충격 차단, 통과 판정
6. `handlePass(time)` — 랩 기록, `classifyLap`으로 누락·오감지 표시

상태: `idle` → `learning`(30프레임 + 통과 직후면 재감지 대기) → `ready`. 통과하면 `resetDetector({afterDetection:true})`.

## 함정
- 감지 기준(%)은 "덩어리로 변한 면적 / 감지 영역 면적". 영역이 크면 같은 차도 비율이 작다(자동 기준 최소 3%).
- 화면 밀림은 감지 영역의 가로·세로 띠를 뺀 나머지로 잰다. 차가 지나가도 흔들림으로 오해하지 않기 위함.
- 충격 차단은 "변화율이 기준을 넘은 순간"과 "불안정 프레임"이 겹칠 때만 건다. 흔들림만으로 감지를 멈추면 잔진동 환경에서 전혀 감지되지 않는다.
- 미세 정렬은 0,0보다 뚜렷이 좋을 때만 옮긴다. 작은 영역에서 엉뚱하게 맞춰져 가짜 통과가 났던 적이 있다.
- 화면이 꺼지거나 탭이 가려지면 프레임 콜백이 멈춘다. 화면 켜짐 유지(wakeLock)와 끊김 표시로 대응.
- 시험의 vm 안 배열은 바깥과 원형이 달라 `deepEqual`이 실패한다. JSON 문자열로 비교.
- 초점·색 고정은 실제 기기에서 검증되지 않았다(기본 꺼짐).
