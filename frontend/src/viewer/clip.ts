/**
 * 1 本分の解析結果（pose.json）と設定を読み込み、指標を計算するフック。
 * 設定は変えたらすぐサーバへ保存する（台の設定は次の動画の既定にもなる）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileUrl, getSettings, putSettings, type Analysis } from '../api'
import { validate, type PoseData } from './lib'
import { computeMetrics, type Metrics } from './metrics'
import { withDefaults, type Settings } from './settings'

export type Clip = {
  item: Analysis
  data: PoseData
  settings: Settings
  metrics: Metrics
  videoUrl: string
  update: (patch: Partial<Settings>) => void
}

export function useClip(item: Analysis | null): { clip: Clip | null; error: string | null } {
  const [data, setData] = useState<PoseData | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef(false)

  useEffect(() => {
    if (!item) return
    let alive = true
    Promise.all([
      fetch(fileUrl(item.id, 'pose.json')).then((r) => {
        if (!r.ok) throw new Error(`pose.json の取得に失敗（${r.status}）`)
        return r.json() as Promise<PoseData>
      }),
      getSettings(item.id),
    ]).then(([d, s]) => {
      if (!alive) return
      const msg = validate(d)
      if (msg) { setError(msg); return }
      setData(d)
      setSettings(withDefaults(s))
    }).catch((e) => alive && setError(String(e.message ?? e)))
    return () => { alive = false }
  }, [item])

  // 画面で変えたときだけ保存する（読み込み直後の値を書き戻さない）
  useEffect(() => {
    if (!item || !settings || !dirty.current) return
    putSettings(item.id, settings).catch((e) => setError(`設定の保存に失敗しました: ${e.message}`))
  }, [item, settings])

  const update = useCallback((patch: Partial<Settings>) => {
    dirty.current = true
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur))
  }, [])

  const metrics = useMemo(
    () => (data && settings ? computeMetrics(data, settings) : null), [data, settings])

  const clip = useMemo<Clip | null>(() => {
    if (!item || !data || !settings || !metrics) return null
    return { item, data, settings, metrics, update, videoUrl: fileUrl(item.id, 'playback.mp4') }
  }, [item, data, settings, metrics, update])

  return { clip, error }
}
