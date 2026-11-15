"use strict";
// 실제 촬영 영상을 브라우저가 처리하는 것과 같은 크기·방식으로 줄여 저장한다(video-eval.js의 입력).
// 브라우저는 1280x720(세로로 들면 720x1280)을 받아 가로 360으로 줄여 쓰므로 그 과정을 그대로 흉내 낸다.
// 사용: node tests/video-prep.js <영상 파일> <출력 폴더/이름>
//   → <이름>.rgba(프레임 묶음, 30fps)와 <이름>.json(크기·프레임 수)이 생긴다. 10초에 약 0.3GB(세로 영상은 약 0.9GB).
// ffmpeg가 필요하다. 경로는 환경 변수 FFMPEG로 줄 수 있다.
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

const [videoPath, outBase] = process.argv.slice(2);
if (!videoPath || !outBase) {
  console.error("사용: node tests/video-prep.js <영상 파일> <출력 폴더/이름>");
  process.exit(1);
}
const FF = process.env.FFMPEG || "ffmpeg";
const probe = spawnSync(FF, ["-hide_banner", "-i", videoPath], { encoding: "utf8" });
if (probe.error) {
  console.error(`ffmpeg를 실행할 수 없습니다(${probe.error.message}). 환경 변수 FFMPEG에 경로를 넣어주세요.`);
  process.exit(1);
}
const size = /, (\d{3,5})x(\d{3,5})/.exec(probe.stderr);
if (!size) {
  console.error("영상 크기를 읽지 못했습니다. 파일을 확인해주세요.");
  process.exit(1);
}
let videoWidth = Number(size[1]);
let videoHeight = Number(size[2]);
if (/rotation of -?90/.test(probe.stderr)) [videoWidth, videoHeight] = [videoHeight, videoWidth];

const FPS = 30;
const srcW = videoWidth > videoHeight ? 1280 : 720;
const srcH = videoWidth > videoHeight ? 720 : 1280;
const outW = 360;
const outH = Math.round(srcH * (outW / srcW));
const scaleX = srcW / outW;
const scaleY = srcH / outH;
const frame = Buffer.alloc(outW * outH * 4);

// 브라우저 기본(낮은 품질) 축소와 같은 2x2 보간. 촘촘한 무늬가 어른거리는 현상까지 재현된다.
function downscale(src) {
  for (let y = 0; y < outH; y += 1) {
    const fy = Math.max(0, (y + 0.5) * scaleY - 0.5);
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x += 1) {
      const fx = Math.max(0, (x + 0.5) * scaleX - 0.5);
      const x0 = Math.floor(fx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * srcW + x0) * 4;
      const b = (y0 * srcW + x1) * 4;
      const c = (y1 * srcW + x0) * 4;
      const d = (y1 * srcW + x1) * 4;
      const o = (y * outW + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        frame[o + k] = Math.round((src[a + k] * (1 - wx) + src[b + k] * wx) * (1 - wy) + (src[c + k] * (1 - wx) + src[d + k] * wx) * wy);
      }
      frame[o + 3] = 255;
    }
  }
}

const out = fs.openSync(`${outBase}.rgba`, "w");
const bytes = srcW * srcH * 4;
const ffmpeg = spawn(FF, ["-v", "error", "-i", videoPath, "-vf", `fps=${FPS},scale=${srcW}:${srcH}:flags=bicubic`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdio: ["ignore", "pipe", "inherit"] });
let pending = Buffer.alloc(0);
let frames = 0;
ffmpeg.stdout.on("data", (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= bytes) {
    downscale(pending.subarray(0, bytes));
    fs.writeSync(out, frame);
    frames += 1;
    pending = pending.subarray(bytes);
  }
});
ffmpeg.on("close", (code) => {
  fs.closeSync(out);
  if (code !== 0 || !frames) {
    console.error("영상을 읽지 못했습니다.");
    process.exit(1);
  }
  fs.writeFileSync(`${outBase}.json`, JSON.stringify({ width: outW, height: outH, capW: srcW, capH: srcH, fps: FPS, frames }));
  console.log(`${outBase}: ${outW}x${outH}, ${frames}프레임`);
});
