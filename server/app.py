"""
ローカルサーバ（FastAPI）。動画の登録・推論・一覧・配信・台の設定の保存を受け持つ。

**推論は 1 本ずつ順番に行う。** GPU（MPS）を取り合うと 2 本とも遅くなるため。
**同じ動画・同じ解析条件の登録は推論せず、保存済みの結果を返す**（store.py 参照）。

起動:
  python3 server/app.py            # http://127.0.0.1:8000/
"""

from __future__ import annotations

import hashlib
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).parent))
import inference  # noqa: E402
import store  # noqa: E402

MODEL_NAME = os.environ.get("MODEL_NAME", str(store.ROOT / "yolov8m-pose.pt"))
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.25"))
ALLOWED_EXT = {"mp4", "mov", "avi", "m4v"}
SERVED_FILES = {"pose.json", "playback.mp4"}
CHUNK = 1 << 20

app = FastAPI(title="ski-jump-pose-local")
jobs: "queue.Queue[str]" = queue.Queue()


# ── 推論ワーカー ──────────────────────────────────────────

def _worker() -> None:
    while True:
        aid = jobs.get()
        meta = store.get(aid)
        if not meta or meta["status"] != "queued":
            continue                         # 待っている間に削除された
        src = store.source_path(meta["sourceHash"], meta["sourceExt"])
        store.update(aid, status="processing", startedAt=store.now_iso(),
                     progress={"done": 0, "total": 0})
        started = time.time()
        try:
            data = inference.run(
                str(src), str(store.adir(aid)), MODEL_NAME, CONF_THRESHOLD,
                start_sec=meta["startSec"], end_sec=meta["endSec"],
                on_progress=lambda d, t: store.update(aid, progress={"done": d, "total": t}))
            store.update(aid, status="done", finishedAt=store.now_iso(),
                         elapsedSec=round(time.time() - started, 1),
                         fps=data["fps"], frameCount=data["frameCount"],
                         durationSec=data["durationSec"], device=data["device"],
                         detections=data["detections"])
        except Exception as e:  # noqa: BLE001 — 失敗理由を画面へ出す
            traceback.print_exc()
            store.update(aid, status="error", error=str(e), finishedAt=store.now_iso())


def _resume() -> None:
    """前回の起動中に終わらなかった解析をやり直す"""
    for m in reversed(store.list_all()):
        if m["status"] in ("queued", "processing"):
            store.update(m["id"], status="queued")
            jobs.put(m["id"])


# ── API ──────────────────────────────────────────────

@app.get("/api/analyses")
def list_analyses() -> dict:
    return {"items": store.list_all()}


@app.post("/api/analyses")
async def create_analysis(file: UploadFile = File(...),
                          startSec: str = Form(""), endSec: str = Form("")) -> dict:
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"対応していない形式です（{', '.join(sorted(ALLOWED_EXT))}）")
    try:
        start = max(0.0, float(startSec or 0))
        end = float(endSec) if endSec else None
    except ValueError:
        raise HTTPException(400, "開始・終了の秒は数値で入力してください")
    if end is not None and end <= start:
        raise HTTPException(400, "終了の秒は開始より後にしてください")

    # 受け取りながらハッシュを取る（大きな動画を 2 度読みしない）
    tmp = store.TMP / uuid.uuid4().hex
    h = hashlib.sha256()
    with tmp.open("wb") as f:
        while chunk := await file.read(CHUNK):
            h.update(chunk)
            f.write(chunk)
    sha = h.hexdigest()
    store.put_source(tmp, sha, ext)

    params = {"startSec": round(start, 3), "endSec": round(end, 3) if end else None,
              "model": Path(MODEL_NAME).name, "conf": CONF_THRESHOLD}
    aid = store.analysis_id(sha, params)

    # ★ 推論キャッシュ。同じ動画・同じ条件なら推論しない（失敗したものだけやり直す）
    existing = store.get(aid)
    if existing and existing["status"] != "error":
        return {"item": existing, "cached": True}

    meta = {
        "id": aid, "title": file.filename, "sourceHash": sha, "sourceExt": ext,
        "startSec": params["startSec"], "endSec": params["endSec"],
        "model": params["model"], "conf": CONF_THRESHOLD,
        "status": "queued", "progress": {"done": 0, "total": 0},
        "createdAt": existing["createdAt"] if existing else store.now_iso(),
    }
    store.create(meta)
    jobs.put(aid)
    return {"item": meta, "cached": False}


@app.delete("/api/analyses/{aid}")
def delete_analysis(aid: str) -> dict:
    meta = _get_or_404(aid)
    if meta["status"] == "processing":
        raise HTTPException(409, "解析中は削除できません。終わってから削除してください")
    store.delete(aid)
    return {"ok": True}


@app.get("/api/analyses/{aid}/files/{name}")
def get_file(aid: str, name: str) -> FileResponse:
    meta = _get_or_404(aid)
    if name not in SERVED_FILES or meta["status"] != "done":
        raise HTTPException(404)
    # FileResponse は Range に対応している（Safari の <video> はこれが無いと再生できない）
    return FileResponse(store.adir(aid) / name)


@app.get("/api/analyses/{aid}/settings")
def get_settings(aid: str) -> dict:
    _get_or_404(aid)
    return store.get_settings(aid)


@app.put("/api/analyses/{aid}/settings")
def put_settings(aid: str, body: dict) -> dict:
    _get_or_404(aid)
    return store.put_settings(aid, body)


def _get_or_404(aid: str) -> dict:
    try:
        meta = store.get(aid)
    except KeyError:
        meta = None
    if not meta:
        raise HTTPException(404, "解析が見つかりません")
    return meta


# ビルド済みの画面を同じポートで配る（開発時は Vite の 3200 番から /api をプロキシする）
DIST = store.ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")


def main() -> None:
    store.init()
    threading.Thread(target=_worker, daemon=True).start()
    _resume()
    port = int(os.environ.get("PORT", "8000"))
    print(f"[起動] http://127.0.0.1:{port}/  データ: {store.DATA}", flush=True)
    # 外部に公開しない（ローカル PC 専用）
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
