/**
 * ローカルサーバ（server/app.py）の API クライアント。
 * 開発時は Vite のプロキシ経由、本番相当（python3 server/app.py）では同一オリジンで呼ぶ。
 */

import type { Settings } from './viewer/settings'

export type Status = 'queued' | 'processing' | 'done' | 'error'

export type Analysis = {
  id: string
  title: string
  sourceHash: string
  startSec: number
  endSec: number | null
  status: Status
  progress: { done: number; total: number }
  createdAt: string
  finishedAt?: string
  elapsedSec?: number
  fps?: number
  frameCount?: number
  durationSec?: number
  device?: string
  detections?: number
  error?: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  if (!r.ok) {
    // FastAPI の HTTPException は { detail } を返す。理由をそのまま画面へ出す
    const detail = await r.json().then((j) => j.detail).catch(() => '')
    throw new Error(detail || `${init?.method ?? 'GET'} ${path} が失敗しました（${r.status}）`)
  }
  return r.json() as Promise<T>
}

export async function listAnalyses(): Promise<Analysis[]> {
  return (await call<{ items: Analysis[] }>('/api/analyses')).items
}

/**
 * 動画を登録する。**同じ動画・同じ範囲なら推論せず、保存済みの結果が返る**（cached: true）。
 */
export async function register(file: File, startSec: string, endSec: string):
  Promise<{ item: Analysis; cached: boolean }> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('startSec', startSec)
  fd.append('endSec', endSec)
  return call('/api/analyses', { method: 'POST', body: fd })
}

export async function removeAnalysis(id: string): Promise<void> {
  await call(`/api/analyses/${id}`, { method: 'DELETE' })
}

export const fileUrl = (id: string, name: 'pose.json' | 'playback.mp4') =>
  `/api/analyses/${id}/files/${name}`

export async function getSettings(id: string): Promise<Partial<Settings>> {
  return call(`/api/analyses/${id}/settings`)
}

export async function putSettings(id: string, s: Settings): Promise<void> {
  await call(`/api/analyses/${id}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s),
  })
}
