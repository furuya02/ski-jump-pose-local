"""
解析結果の保存場所と、**推論キャッシュ**。

一度推論した動画は二度と推論しない。判定は次の 2 段で行う。

1. **元動画は内容のハッシュ（SHA-256）で 1 本だけ保存する。**
   ファイル名が違っても、中身が同じなら同じ動画として扱う。
2. **解析 ID = 元動画のハッシュ ＋ 解析条件のハッシュ。**
   解析条件（開始・終了の秒、モデル、検出閾値、スキーマ版）が同じなら同じ ID になり、
   既に結果があれば推論せずにそれを返す。範囲を変えたときだけ推論し直す。

  data/
    sources/<sha>.<ext>              元動画（内容ハッシュで重複排除）
    analyses/<id>/meta.json          状態・進捗・解析条件
    analyses/<id>/pose.json          骨格データ
    analyses/<id>/playback.mp4       再生用動画
    analyses/<id>/settings.json      台の設定など（画面から保存）
    defaults.json                    台の設定の既定（最後に保存した値。カメラ固定のため使い回す）
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from inference import SCHEMA_VERSION

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data"))
SOURCES = DATA / "sources"
ANALYSES = DATA / "analyses"
TMP = DATA / "tmp"
DEFAULTS = DATA / "defaults.json"

# 解析ロジックを変えて結果が変わるときは上げる（古いキャッシュを使わせないため）
INFERENCE_VERSION = 1

# 動画ごとに持つが、既定値（defaults.json）へは引き継がない項目
PER_VIDEO_KEYS = {"takeoffFrame"}

_lock = threading.Lock()


def init() -> None:
    for d in (SOURCES, ANALYSES, TMP):
        d.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _write_json(path: Path, obj: Any) -> None:
    """途中で落ちても壊れたファイルが残らないよう、一時ファイル経由で置き換える"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text())


# ── 元動画 ──────────────────────────────────────────────

def source_path(sha: str, ext: str) -> Path:
    return SOURCES / f"{sha}.{ext}"


def put_source(tmp_path: Path, sha: str, ext: str) -> Path:
    """一時ファイルを元動画として登録する。既にあれば一時ファイルを捨てる"""
    dst = source_path(sha, ext)
    if dst.exists():
        tmp_path.unlink(missing_ok=True)
    else:
        os.replace(tmp_path, dst)
    return dst


# ── 解析 ──────────────────────────────────────────────

def analysis_id(sha: str, params: dict) -> str:
    key = json.dumps({**params, "schema": SCHEMA_VERSION, "inference": INFERENCE_VERSION},
                     sort_keys=True)
    return f"{sha[:16]}-{hashlib.sha256(key.encode()).hexdigest()[:8]}"


def adir(aid: str) -> Path:
    # パス操作を防ぐ（ID は 16 進とハイフンだけ）
    if not aid or any(c not in "0123456789abcdef-" for c in aid):
        raise KeyError(aid)
    return ANALYSES / aid


def get(aid: str) -> dict | None:
    p = adir(aid) / "meta.json"
    return _read_json(p) if p.exists() else None


def create(meta: dict) -> None:
    d = adir(meta["id"])
    d.mkdir(parents=True, exist_ok=True)
    with _lock:
        _write_json(d / "meta.json", meta)


def update(aid: str, **patch: Any) -> dict | None:
    with _lock:
        p = adir(aid) / "meta.json"
        if not p.exists():
            return None          # 解析中に削除された
        meta = {**_read_json(p), **patch}
        _write_json(p, meta)
        return meta


def list_all() -> list[dict]:
    out = []
    for d in ANALYSES.iterdir() if ANALYSES.exists() else []:
        p = d / "meta.json"
        if p.exists():
            try:
                out.append(_read_json(p))
            except json.JSONDecodeError:
                continue
    return sorted(out, key=lambda m: m.get("createdAt", ""), reverse=True)


def delete(aid: str) -> None:
    meta = get(aid)
    shutil.rmtree(adir(aid), ignore_errors=True)
    if not meta:
        return
    # 同じ元動画を使う解析が残っていなければ、元動画も消す
    sha = meta["sourceHash"]
    if not any(m["sourceHash"] == sha for m in list_all()):
        source_path(sha, meta["sourceExt"]).unlink(missing_ok=True)


# ── 台の設定 ──────────────────────────────────────────────

def get_settings(aid: str) -> dict:
    p = adir(aid) / "settings.json"
    if p.exists():
        return _read_json(p)
    return get_defaults()


def get_defaults() -> dict:
    return _read_json(DEFAULTS) if DEFAULTS.exists() else {}


def put_settings(aid: str, settings: dict) -> dict:
    with _lock:
        _write_json(adir(aid) / "settings.json", settings)
        # カメラは固定なので、次に開く動画でも同じ台の設定を使えるようにする
        _write_json(DEFAULTS, {k: v for k, v in settings.items() if k not in PER_VIDEO_KEYS})
    return settings
