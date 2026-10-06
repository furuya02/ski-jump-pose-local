"""
YOLO-Pose による骨格検出。**ローカル PC 上で実行する**（Apple Silicon なら MPS、NVIDIA なら CUDA）。

**骨格は描画しない。** 出力は次の 2 つで、どちらも同一のフレーム列から作る。

  <outdir>/pose.json      骨格データ（docs/pose-schema.md の契約）
  <outdir>/playback.mp4   再生用動画（H.264 / yuv420p / +faststart）

同一フレーム列から作るのは、ブラウザが `Math.floor(currentTime * fps)` で
pose.json の添字を引けるようにするため。ここが崩れるとシークや倍速で骨格がずれる。

通常はサーバ（server/app.py）のワーカーから呼ばれる。単体でも実行できる:
  python3 server/inference.py --input in.mp4 --outdir out [--start-sec 3 --end-sec 6]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import videoio  # noqa: E402

SCHEMA_VERSION = 1

# COCO 17 キーポイント
KEYPOINT_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

# 骨格線（16 本）
SKELETON = [
    [0, 1], [0, 2], [1, 3], [2, 4],
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
    [5, 11], [6, 12], [11, 12],
    [11, 13], [13, 15], [12, 14], [14, 16],
]

# playback.mp4 の長辺。4K 原本でも再生が重くならないようにする
MAX_LONG_SIDE = 1920

# 進捗の通知間隔（フレーム）
PROGRESS_EVERY = 10

Progress = Callable[[int, int], None]


def _r4(v: float) -> float:
    """0..1 正規化座標を小数 4 桁へ。1920px で 0.2px 未満の誤差に収まる。"""
    return round(float(v), 4)


def _playback_size(w: int, h: int) -> tuple[int, int]:
    """長辺を MAX_LONG_SIDE に収める。H.264 のため偶数へ丸める。"""
    scale = min(1.0, MAX_LONG_SIDE / max(w, h))
    return (int(w * scale) // 2 * 2, int(h * scale) // 2 * 2)


def pick_device() -> str:
    """CUDA → MPS → CPU の順に選ぶ。Mac では MPS になる。"""
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def run(input_path: str, outdir: str, model_name: str, conf: float,
        start_sec: float = 0.0, end_sec: float | None = None,
        on_progress: Progress | None = None) -> dict:
    from ultralytics import YOLO

    info = videoio.probe(input_path)
    pw, ph = _playback_size(info.width, info.height)
    Path(outdir).mkdir(parents=True, exist_ok=True)

    start_sec = max(0.0, start_sec)
    end = min(end_sec, info.duration_sec) if end_sec else info.duration_sec
    span = max(0.0, end - start_sec)
    expected = max(1, int(round(span * info.fps)))

    print(f"[入力] {input_path}", flush=True)
    print(f"  {info.width}x{info.height} / {info.fps:.3f}fps / {info.duration_sec:.2f}s", flush=True)
    print(f"[範囲] {start_sec:.2f}s 〜 {end:.2f}s（約{expected}フレーム）", flush=True)

    device = pick_device()
    print(f"[デバイス] {device}", flush=True)
    # 動画ごとに作り直す。ByteTrack の状態がモデルに残るため、使い回すと前の動画の ID を引きずる
    model = YOLO(model_name)
    frames: list[list[dict]] = []
    detections = 0
    started = time.time()

    with videoio.Encoder(str(Path(outdir) / "playback.mp4"), pw, ph, info.fps) as enc:
        for i, frame in enumerate(videoio.decode(input_path, pw, ph, fps=info.fps,
                                                    start_sec=start_sec,
                                                    duration_sec=span if end_sec else None)):
            # ByteTrack で ID を振る。選手以外も映るため、添字では同一人物を追えない
            res = model.track(frame, persist=True, conf=conf, verbose=False,
                              classes=[0], tracker="bytetrack.yaml", device=device)[0]

            people: list[dict] = []
            if res.keypoints is not None and res.boxes is not None and len(res.boxes) > 0:
                kps = res.keypoints.data.cpu().numpy()          # (N, 17, 3)
                boxes = res.boxes.xyxy.cpu().numpy()            # (N, 4)
                scores = res.boxes.conf.cpu().numpy()           # (N,)
                ids = (res.boxes.id.cpu().numpy().astype(int)
                       if res.boxes.id is not None else np.arange(len(boxes)))

                for n in range(len(boxes)):
                    x1, y1, x2, y2 = boxes[n]
                    flat: list[float] = []
                    for kx, ky, ks in kps[n]:
                        # 未検出は [0,0,0]。score === 0 で判定する
                        flat += ([0.0, 0.0, 0.0] if ks <= 0
                                 else [_r4(kx / pw), _r4(ky / ph), _r4(ks)])
                    people.append({
                        "id": int(ids[n]),
                        "score": _r4(scores[n]),
                        "box": [_r4(x1 / pw), _r4(y1 / ph),
                                _r4((x2 - x1) / pw), _r4((y2 - y1) / ph)],
                        "kp": flat,
                    })
                detections += len(people)

            frames.append(people)   # 検出 0 人でも [] を必ず置く（添字 = フレーム番号）
            enc.write(frame)

            if on_progress and i % PROGRESS_EVERY == 0:
                on_progress(i, expected)

    if not frames:
        raise RuntimeError("フレームを 1 枚もデコードできませんでした（開始・終了の秒を確認してください）")

    data = {
        "schemaVersion": SCHEMA_VERSION,
        "fps": round(info.fps, 3),
        "width": pw,
        "height": ph,
        "frameCount": len(frames),
        "durationSec": round(len(frames) / info.fps, 3),
        "sourceWidth": info.width,
        "sourceHeight": info.height,
        "startSec": round(start_sec, 3),
        "model": model_name,
        "confThreshold": conf,
        "tracking": True,
        "device": device,
        "keypointNames": KEYPOINT_NAMES,
        "skeleton": SKELETON,
        "detections": detections,
        "frames": frames,
    }

    raw = json.dumps(data, separators=(",", ":")).encode()
    (Path(outdir) / "pose.json").write_bytes(raw)

    el = time.time() - started
    print(f"[完了] {len(frames)}フレーム / 検出{detections} / {el:.1f}s "
          f"({len(frames)/max(el,0.001):.1f}fps) / pose.json {len(raw)/1e6:.2f}MB", flush=True)
    if on_progress:
        on_progress(len(frames), len(frames))
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--model", default="yolov8m-pose.pt")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--start-sec", type=float, default=0.0)
    ap.add_argument("--end-sec", type=float, default=None)
    a = ap.parse_args()
    run(a.input, a.outdir, a.model, a.conf, a.start_sec, a.end_sec)


if __name__ == "__main__":
    main()
