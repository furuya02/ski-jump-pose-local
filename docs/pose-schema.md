# pose.json の形式

推論（`server/inference.py`）が書き出し、ビューア（`frontend/src/viewer/lib.ts`）が読む契約です。
**片方だけ変えると、エラーにならないまま骨格がずれて描画されます。** 変えるときは `schemaVersion` を上げてください。

```jsonc
{
  "schemaVersion": 1,
  "fps": 23.976,             // playback.mp4 と同じ
  "width": 1920, "height": 1080,   // playback.mp4 の解像度（長辺 1920 まで縮小）
  "frameCount": 377,
  "durationSec": 15.724,
  "sourceWidth": 1920, "sourceHeight": 1080,
  "startSec": 0,             // 元動画のどこから解析したか
  "model": "yolov8m-pose.pt",
  "confThreshold": 0.25,
  "tracking": true,          // ByteTrack で id を付けている
  "device": "mps",
  "keypointNames": ["nose", ...],      // COCO 17 点
  "skeleton": [[0, 1], ...],           // 骨格線 16 本
  "detections": 412,
  "frames": [                // 添字 = フレーム番号。検出 0 人でも [] を置く
    [
      {
        "id": 1,                         // 追跡 ID
        "score": 0.91,
        "box": [x, y, w, h],             // 0..1 正規化
        "kp": [x, y, s, x, y, s, ...]    // 17 点 × 3。未検出は [0, 0, 0]
      }
    ]
  ]
}
```

## フレームの対応

`playback.mp4` と `pose.json` は**同じフレーム列**から作ります。
ブラウザは `Math.floor(currentTime * fps)` で `frames` の添字を引きます。
可変フレームレートの動画（スマートフォンで撮ったものなど）は、デコードの時点で固定フレームレートに直しています（`videoio.decode` の `fps`）。

## 角度・速度は入れない

ブラウザ側で計算します（`docs/metrics.md`）。定義を変えても再推論しなくて済むようにするためです。
