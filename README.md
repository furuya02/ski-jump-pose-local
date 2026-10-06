# ski-jump-pose-local

English | [日本語](README.ja.md)

A **local, on-PC** tool for analyzing the take-off of ski jumps.
Register a video and YOLOv8-Pose detects the skeleton on your own machine (MPS on Apple Silicon, CUDA on NVIDIA).
The result is shown in the browser with the skeleton overlaid on the video, and you can **put two attempts side by side, synchronized at the take-off**.

- No cloud services are used, so there is no running cost.
- **A video is never inferred twice.** Registering the same video with the same range again reuses the saved result instantly.

## Requirements

| Item | Tested version |
|---|---|
| Python | 3.10 |
| ffmpeg / ffprobe | `brew install ffmpeg` |
| Node.js + pnpm | Node 22 / pnpm 10 (used to build the UI) |

```bash
# Python dependencies (first time only; installs torch, so it takes a few minutes)
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

The model `yolov8m-pose.pt` is downloaded automatically on the first inference.

## Run

```bash
./scripts/start.sh
# → open http://127.0.0.1:8000/
```

The UI is rebuilt automatically only when its source has changed.
The server listens on `127.0.0.1` only, so it is not reachable from other machines.

For development, run the two processes in separate terminals (Vite proxies `/api` to port 8000):
```bash
python3 server/app.py
cd frontend && pnpm dev
# → http://localhost:3200/
```

## Usage

1. **Register**: drag and drop video files onto the "動画を登録" (Register) panel, or pick them with the file button. Several files can be dropped at once.
   Optionally enter the start / end seconds, then press the register button. When several files are registered, the same range is used for all of them.
   Analyzing only the few seconds around the take-off makes it much faster.
2. **Open**: when the analysis is done, press "開く" (Open). First fill in the ramp settings ("台の設定"):
   - Ramp angle (degrees): uphill in the direction of travel is positive, downhill is negative.
   - Ramp edge: click its position on the video.
   - Reference for the arm angle: flat ground or a slope, plus an optional threshold angle.
   - Frame width (m): if entered, speeds are shown in m/s.

   The ramp surface (pink line) and the arm reference (green dotted line) are drawn over the video, so you can check the values visually.
   The ramp settings are saved and become the **defaults for the next video** (this assumes a fixed camera).
3. **Compare**: tick two videos in the list and press "2 本を比較" (Compare two).
   The videos are aligned at their take-off times. If they are off, nudge video B one frame earlier or later.

Keys: `Space` play / pause, `←` `→` 1 s (10 s with `Shift`), `,` `.` step one frame

## Metrics

See [docs/metrics.md](docs/metrics.md) (Japanese) for the exact definitions.

| Metric | Description |
|---|---|
| Knee angle | Angle at the knee formed by hip, knee and ankle. Computed on **one leg only**, the side with the higher keypoint confidence |
| Shank vs. ramp | Angle between the ankle→knee vector and the ramp surface. 90° is perpendicular to the ramp; smaller values mean more forward lean |
| Arm elevation | How far the shoulder→wrist vector rises above the reference line (flat or slope). With a threshold set, it also shows whether the arm is "up" |
| Ankle speed | In % of the frame width per second, or in m/s once the frame width is entered |
| Angular velocity (rad/s) | How fast the hip, ankle, shoulder and wrist rotate around the knee, plus the knee extension speed |
| Take-off | The moment the ankle passes the ramp edge (interpolated between frames). Can also be set manually |
| Full extension | The frame with the maximum knee angle within ±0.5 s of the take-off, shown as "x s early / late" relative to the take-off |

## Processing time

Measured on an Apple M2 with 1920x1080, 23.98 fps videos: **about 20 frames per second**. A 15-second clip takes about 20 seconds.

## Layout

```
server/      FastAPI, inference (inference.py), storage and cache (store.py), ffmpeg I/O (videoio.py)
frontend/    React + Cloudscape UI
docs/        Metric definitions and the pose.json format (Japanese)
data/        Analysis results (created automatically; not tracked by git)
```

The UI labels and the documents under `docs/` are in Japanese.
