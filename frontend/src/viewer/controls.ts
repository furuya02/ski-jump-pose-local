/**
 * 再生制御。`<video>` の状態を React 側へ橋渡しする。
 *
 * **再生位置は video 要素が正で、React state は写し**です。
 * state を正にすると、シーク中に双方向更新でループします。
 *
 * ★ **受け取るのは ref ではなく要素そのもの**です。
 *   `<video>` は pose.json の読み込み後に初めてマウントされるため、
 *   ref を依存に置くと（ref オブジェクトは不変なので effect が張り直されず）
 *   **イベントリスナーが一生登録されません**。
 *   実際に「再生ボタンが反応しない」「再生中でも一時停止にならない」
 *   「骨格が止まったまま映像だけ進む」の 3 症状すべての原因でした（2026/09/17）。
 */

import { useCallback, useEffect, useState } from 'react'

export const RATES = ['0.25', '0.5', '1', '1.5', '2'] as const

/** requestVideoFrameCallback の最小限の型（lib.dom に無いため） */
type FrameMeta = { mediaTime: number }
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

export function usePlayback(video: HTMLVideoElement | null, fps: number) {
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<string>('1')
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  // ── 表示中フレームの時刻を追う ──
  useEffect(() => {
    if (!video) return
    const v = video as VideoWithRvfc

    if (v.requestVideoFrameCallback) {
      // **mediaTime は「いま表示されているフレーム」の時刻**。
      // currentTime だと次フレームへ進んだ値を拾うことがあり、骨格が 1 コマずれる。
      let id = 0
      let alive = true
      const tick = (_now: number, meta: FrameMeta) => {
        if (!alive) return
        setCur(meta.mediaTime)
        id = v.requestVideoFrameCallback!(tick)
      }
      id = v.requestVideoFrameCallback(tick)
      // 比較の追従側は外から currentTime を変えられるので、シーク完了でも拾う
      const onSeeked = () => setCur(video.currentTime)
      video.addEventListener('seeked', onSeeked)
      return () => {
        alive = false
        v.cancelVideoFrameCallback?.(id)
        video.removeEventListener('seeked', onSeeked)
      }
    }

    const onTime = () => setCur(video.currentTime)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onTime)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onTime)
    }
  }, [video])

  // ── 再生状態・尺の同期 ──
  useEffect(() => {
    if (!video) return
    const sync = () => setPlaying(!video.paused && !video.ended)
    const onMeta = () => setDur(video.duration || 0)

    sync()                         // マウント済みの要素を後から受け取る場合に備えて初期同期
    if (video.readyState >= 1) onMeta()

    video.addEventListener('play', sync)
    video.addEventListener('playing', sync)
    video.addEventListener('pause', sync)
    video.addEventListener('ended', sync)
    video.addEventListener('loadedmetadata', onMeta)
    return () => {
      video.removeEventListener('play', sync)
      video.removeEventListener('playing', sync)
      video.removeEventListener('pause', sync)
      video.removeEventListener('ended', sync)
      video.removeEventListener('loadedmetadata', onMeta)
    }
  }, [video])

  // 再生速度は要素が入れ替わっても保つ
  useEffect(() => {
    if (video) video.playbackRate = parseFloat(rate)
  }, [video, rate])

  const play = useCallback(() => { video?.play().catch(() => {}) }, [video])
  const pause = useCallback(() => { video?.pause() }, [video])

  const seek = useCallback((t: number) => {
    if (!video) return
    video.currentTime = Math.max(0, Math.min(t, video.duration || t))
    setCur(video.currentTime)
  }, [video])

  const seekBy = useCallback((dt: number) =>
    seek((video?.currentTime ?? 0) + dt), [seek, video])

  /** コマ送り。一時停止してから 1/fps だけ動かす */
  const stepFrame = useCallback((dir: 1 | -1) => {
    pause()
    seekBy(dir / fps)
  }, [pause, seekBy, fps])

  const changeRate = useCallback((r: string) => setRate(r), [])

  const togglePlay = useCallback(() => {
    if (!video) return
    if (video.paused || video.ended) video.play().catch(() => {})
    else video.pause()
  }, [video])

  return { playing, rate, cur, dur, play, pause, seek, seekBy, stepFrame, changeRate, togglePlay }
}

/** キーボード操作。入力欄にフォーカスがあるときは無効にする */
export function useKeyboard(s: {
  togglePlay: () => void
  seekBy: (dt: number) => void
  stepFrame: (dir: 1 | -1) => void
}) {
  const { togglePlay, seekBy, stepFrame } = s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break
        case 'ArrowLeft': e.preventDefault(); seekBy(e.shiftKey ? -10 : -1); break
        case 'ArrowRight': e.preventDefault(); seekBy(e.shiftKey ? 10 : 1); break
        case ',': e.preventDefault(); stepFrame(-1); break
        case '.': e.preventDefault(); stepFrame(1); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekBy, stepFrame])
}
