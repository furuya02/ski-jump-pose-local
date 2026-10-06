"""
ffmpeg を subprocess で起動して動画を読み書きするモジュール。

**cv2.VideoCapture を使わない理由**

インターレース素材などで内部の swscale が変換を拒否しても `read()` は `True` を返し、
未初期化バッファ（＝全面ノイズ）がそのまま推論と playback に流れ込む。
しかもこの挙動は同梱 FFmpeg のビルド差で変わり、macOS では再現せずコンテナでだけ起きるため、
ローカル実行の検証をすり抜ける。

デコードは必ずここを通す。色変換・リサイズなど、デコード以外では OpenCV を使ってよい。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Iterator

import numpy as np

FFMPEG = shutil.which("ffmpeg") or "/Applications/ffmpeg"
FFPROBE = shutil.which("ffprobe")


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    duration_sec: float
    frame_count: int


def probe(path: str) -> VideoInfo:
    """動画のメタ情報を取得する。ffprobe が無い環境では ffmpeg -i の出力から拾う。"""
    if FFPROBE:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
             "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, text=True, check=True).stdout
        d = json.loads(out)
        st = d["streams"][0]
        num, den = (st["r_frame_rate"].split("/") + ["1"])[:2]
        fps = float(num) / float(den or 1)
        dur = float(st.get("duration") or d.get("format", {}).get("duration") or 0)
    else:
        # ffprobe が無い場合のフォールバック（ローカル検証用）
        err = subprocess.run([FFMPEG, "-i", path], capture_output=True, text=True).stderr
        m = re.search(r"(\d{2,5})x(\d{2,5})", err)
        w, h = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
        m = re.search(r"([\d.]+) fps", err)
        fps = float(m.group(1)) if m else 0.0
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
        dur = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))) if m else 0.0
        return VideoInfo(w, h, fps, dur, int(round(dur * fps)))

    return VideoInfo(int(st["width"]), int(st["height"]), fps, dur,
                     int(st["nb_frames"]) if st.get("nb_frames", "N/A").isdigit()
                     else int(round(dur * fps)))


def decode(path: str, width: int, height: int, fps: float | None = None,
           start_sec: float = 0.0, duration_sec: float | None = None) -> Iterator[np.ndarray]:
    """raw BGR フレームをパイプで受け取る。

    `fps` を渡すと固定フレームレートへ変換する。可変フレームレート（iPhone 撮影など）の動画は
    これを通さないと pose.json の添字と playback.mp4 のフレームがずれる。
    """
    vf = f"scale={width}:{height}"
    cmd = [FFMPEG, "-nostdin", "-v", "error"]
    if start_sec:
        cmd += ["-ss", f"{start_sec}"]     # -i の前に置いて高速シークさせる
    cmd += ["-i", path]
    if duration_sec:
        cmd += ["-t", f"{duration_sec}"]   # 踏切前後だけを解析するための終了位置
    if fps:
        cmd += ["-vsync", "cfr", "-r", f"{fps}"]
    cmd += ["-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]

    frame_bytes = width * height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=frame_bytes * 4)
    assert proc.stdout is not None
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
    finally:
        # 途中で打ち切ったときに ffmpeg 側が Broken pipe を出さないよう先に止める
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        proc.wait()


class Encoder:
    """raw BGR フレームを H.264 / yuv420p / +faststart の mp4 へ書き出す。

    **推論と同じフレーム列をそのまま渡すこと。** ここが崩れると
    ブラウザの `Math.round(currentTime * fps)` がフレームを引けなくなる。
    """

    def __init__(self, path: str, width: int, height: int, fps: float, crf: int = 20):
        self.proc = subprocess.Popen(
            [FFMPEG, "-nostdin", "-v", "error", "-y",
             "-f", "rawvideo", "-pix_fmt", "bgr24",
             "-s", f"{width}x{height}", "-r", f"{fps}", "-i", "-",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path],
            stdin=subprocess.PIPE)

    def write(self, frame: np.ndarray) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(frame.tobytes())

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        self.proc.wait()

    def __enter__(self): return self
    def __exit__(self, *_): self.close()
