/**
 * ビューア。1 本なら単独表示、2 本なら**左右に並べて同期再生**する。
 *
 * 同期の考え方：
 *   - 2 本とも「踏切の時刻」を 0 秒とする相対時刻 τ で揃える（踏切が無い動画は先頭が 0 秒）。
 *   - 操作するのは左（A）だけ。右（B）は A の τ に追従させる。
 *   - 自動の踏切がずれていたら、B をコマ単位で前後に補正できる。
 *   fps が違う 2 本（例：60fps と 240fps）でも、秒で揃えるので同じ瞬間が並ぶ。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'

import type { Analysis } from './api'
import { useClip, type Clip } from './viewer/clip'
import { Chart, type Line, type Marker } from './viewer/chart'
import { RATES, useKeyboard, usePlayback } from './viewer/controls'
import { fmtTime, frameIndexAt } from './viewer/lib'
import { ANGVEL_LABEL, type AngVelKey } from './viewer/metrics'
import { draw } from './viewer/overlay'
import { SettingsForm, ValuesTable } from './viewer/panels'

const NAMES = ['A', 'B']
const ANGLE_KEYS = { knee: '膝角度', shank: 'すね−台面', arm: '腕の高さ' } as const
type AngleKey = keyof typeof ANGLE_KEYS
const COLORS = ['#0972d3', '#037f0c', '#8b4513', '#c33d69', '#7d50c0']
const TAKEOFF_COLOR = '#d91515'
const EXT_COLOR = '#b8860b'

export default function Analyzer({ items, onBack }: { items: Analysis[]; onBack: () => void }) {
  const A = useClip(items[0])
  const B = useClip(items[1] ?? null)
  const compare = items.length > 1

  const [vA, setVA] = useState<HTMLVideoElement | null>(null)
  const [vB, setVB] = useState<HTMLVideoElement | null>(null)
  const pbA = usePlayback(vA, A.clip?.data.fps ?? 30)
  const pbB = usePlayback(vB, B.clip?.data.fps ?? 30)
  useKeyboard(pbA)

  const [nudge, setNudge] = useState(0)                 // B の補正（コマ）
  const [picking, setPicking] = useState<number | null>(null)   // 台の先端を指定中の動画
  const [angleKeys, setAngleKeys] = useState<AngleKey[]>(['knee'])
  const [velKeys, setVelKeys] = useState<AngVelKey[]>(['kneeJoint', 'shank'])

  const cA = A.clip, cB = B.clip
  const clips = [cA, cB].filter((c): c is Clip => !!c)
  const ready = cA && (!compare || cB)

  // ── 同期の基準（秒） ──
  const anchorA = compare ? (cA?.metrics.takeoff?.t ?? 0) : 0
  const anchorB = (cB?.metrics.takeoff?.t ?? 0) + nudge / (cB?.data.fps ?? 30)
  const anchors = [anchorA, anchorB]
  const tau = pbA.cur - anchorA

  const domain = useMemo<[number, number]>(() => {
    if (!cA) return [0, 1]
    if (!compare || !cB) return [0, cA.data.durationSec]
    // 両方の映像がある範囲だけを動かせるようにする
    return [Math.max(-anchorA, -anchorB),
            Math.min(cA.data.durationSec - anchorA, cB.data.durationSec - anchorB)]
  }, [cA, cB, compare, anchorA, anchorB])

  const seekTau = (t: number) => pbA.seek(Math.max(domain[0], Math.min(t, domain[1])) + anchorA)

  // ── B を A に追従させる ──
  useEffect(() => {
    if (!compare || !vB || !cB) return
    const fpsB = cB.data.fps
    const target = Math.max(0, Math.min(tau + anchorB, cB.data.durationSec))
    if (pbA.playing) {
      // 直後に pause されると play() は AbortError で reject される（想定内なので握りつぶす）
      if (vB.paused) vB.play().catch(() => {})
      // 再生中は 2 コマ以上ずれたときだけ合わせる（毎フレーム合わせるとカクつく）
      if (Math.abs(vB.currentTime - target) > 2 / fpsB) vB.currentTime = target
    } else {
      if (!vB.paused) vB.pause()
      if (Math.abs(vB.currentTime - target) > 0.25 / fpsB) vB.currentTime = target
    }
  }, [compare, vB, cB, tau, anchorB, pbA.playing])

  useEffect(() => { if (compare) pbB.changeRate(pbA.rate) }, [compare, pbA.rate, pbB.changeRate])

  // 比較では、どちらかの映像が尽きたところで止める
  useEffect(() => {
    if (compare && pbA.playing && tau >= domain[1]) pbA.pause()
  }, [compare, pbA, tau, domain])

  // 開いたら、比較は踏切の少し前、単独は先頭から
  const positioned = useRef(false)
  useEffect(() => {
    if (positioned.current || !vA || !cA || (compare && !cB)) return
    positioned.current = true
    if (compare) {
      const go = () => seekTau(Math.max(domain[0], -1))
      if (vA.readyState >= 1) go()
      else vA.addEventListener('loadedmetadata', go, { once: true })
    }
  })

  const error = A.error ?? B.error
  if (error) {
    return (
      <SpaceBetween size="m">
        <Button onClick={onBack}>一覧へ戻る</Button>
        <StatusIndicator type="error">{error}</StatusIndicator>
      </SpaceBetween>
    )
  }
  if (!ready || !cA) return <StatusIndicator type="loading">解析結果を読み込んでいます…</StatusIndicator>

  const frames = [frameIndexAt(pbA.cur, cA.data), cB ? frameIndexAt(pbB.cur, cB.data) : 0]
  const fpsA = cA.data.fps

  // ── グラフ用の線 ──
  const t0s = clips.map((_, i) => (compare ? -anchors[i] : 0))
  const lineOf = (i: number, label: string, ys: (number | null)[], color: string): Line => ({
    label: compare ? `${label}（${NAMES[i]}）` : label, color, dashed: i === 1,
    t0: t0s[i], fps: clips[i].data.fps, ys,
  })
  const markers: Marker[] = []
  clips.forEach((c, i) => {
    const sfx = compare ? `（${NAMES[i]}）` : ''
    // 比較では踏切が 0 秒に揃うので 1 本だけ引く
    if (c.metrics.takeoff && (!compare || i === 0))
      markers.push({ t: c.metrics.takeoff.t + t0s[i], color: TAKEOFF_COLOR, label: '踏切' })
    if (c.metrics.extension)
      markers.push({ t: c.metrics.extension.t + t0s[i], color: EXT_COLOR, label: `伸び切り${sfx}` })
  })

  const angleLines = clips.flatMap((c, i) => angleKeys.map((k) =>
    lineOf(i, ANGLE_KEYS[k], c.metrics[k], COLORS[Object.keys(ANGLE_KEYS).indexOf(k)])))
  const velLines = clips.flatMap((c, i) => velKeys.map((k) =>
    lineOf(i, ANGVEL_LABEL[k], c.metrics.angVel[k], COLORS[Object.keys(ANGVEL_LABEL).indexOf(k)])))
  // 横幅（m）が全部に入っていれば m/s、そうでなければ %/s に揃える
  const useMeters = clips.every((c) => c.settings.frameWidthM)
  const speedLines = clips.map((c, i) => lineOf(i, '足首の速度',
    c.metrics.ankleSpeed.map((v) => (v == null ? null
      : useMeters ? v * c.settings.frameWidthM! : v * 100)), COLORS[0]))

  const curT = compare ? tau : pbA.cur
  const onSeek = compare ? seekTau : pbA.seek
  const chartProps = { domain, cur: curT, markers, onSeek }

  const toggle = <K,>(cur: K[], k: K, max: number) =>
    cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k].slice(-max)

  const onCanvasClick = (i: number) => (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (picking !== i) { if (i === 0) pbA.togglePlay(); return }
    const r = e.currentTarget.getBoundingClientRect()
    clips[i].update({ edge: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } })
    setPicking(null)
  }

  return (
    <SpaceBetween size="m">
      <Header variant="h1" actions={<Button onClick={onBack}>一覧へ戻る</Button>}
              description={clips.map((c, i) =>
                `${compare ? `${NAMES[i]}: ` : ''}${c.item.title}（${rangeText(c.item)} / ${c.data.fps}fps）`).join('　')}>
        {compare ? '2 本の比較' : cA.item.title}
      </Header>

      <div className={compare ? 'compare-layout' : 'viewer-layout'}>
        <div className="viewer-main">
          <div className={compare ? 'stages two' : 'stages'}>
            {clips.map((c, i) => (
              <Stage key={c.item.id} clip={c} frame={frames[i]}
                     label={compare ? NAMES[i] : undefined}
                     setVideo={i === 0 ? setVA : setVB}
                     picking={picking === i} onClick={onCanvasClick(i)} />
            ))}
          </div>

          {/* ── 再生操作（A を操作し、B は追従する） ── */}
          <div className="controls">
            <Button variant="icon" iconName={pbA.playing ? 'pause' : 'play'}
                    ariaLabel="再生/一時停止" onClick={pbA.togglePlay} />
            <Button variant="icon" iconName="angle-left" ariaLabel="1コマ戻す"
                    onClick={() => pbA.stepFrame(-1)} />
            <Button variant="icon" iconName="angle-right" ariaLabel="1コマ進める"
                    onClick={() => pbA.stepFrame(1)} />
            <input className="seek" type="range" min={domain[0]} max={domain[1]} step={1 / fpsA}
                   value={curT} onChange={(e) => onSeek(parseFloat(e.target.value))} />
            <span className="time">
              {compare ? `踏切から ${curT >= 0 ? '+' : '−'}${Math.abs(curT).toFixed(3)} 秒`
                       : `${fmtTime(pbA.cur)} / ${fmtTime(cA.data.durationSec)}`}
              <small>　{frames.slice(0, clips.length).map((f) => f + 1).join(' / ')} フレーム</small>
            </span>
            <div className="rate">
              <Select selectedOption={{ label: `${pbA.rate}×`, value: pbA.rate }}
                      options={RATES.map((r) => ({ label: `${r}×`, value: r }))}
                      onChange={({ detail }) => pbA.changeRate(detail.selectedOption.value!)} />
            </div>
          </div>
          {compare && (
            <div className="sync">
              <span>同期：{cA.metrics.takeoff && cB?.metrics.takeoff ? '踏切で揃えています'
                : '踏切が未設定の動画は先頭で揃えています'}</span>
              <Button onClick={() => setNudge((n) => n - 1)}>B を 1 コマ前へ</Button>
              <Button onClick={() => setNudge((n) => n + 1)}>B を 1 コマ後へ</Button>
              <Button disabled={nudge === 0} onClick={() => setNudge(0)}>補正を戻す</Button>
              <small>補正 {nudge > 0 ? '+' : ''}{nudge} コマ</small>
            </div>
          )}
          <Box fontSize="body-s" color="text-body-secondary">
            Space 再生/停止　←→ 1秒（Shift で 10秒）　, . コマ送り　／　黄色い点が計算に使っている膝です
          </Box>

          <Container header={<Header variant="h3">角度の推移</Header>}>
            <SpaceBetween size="xs">
              <div className="graph-picker">
                {(Object.keys(ANGLE_KEYS) as AngleKey[]).map((k) => (
                  <Button key={k} variant={angleKeys.includes(k) ? 'primary' : 'normal'}
                          onClick={() => setAngleKeys((c) => toggle(c, k, 3))}>{ANGLE_KEYS[k]}</Button>
                ))}
              </div>
              <Chart {...chartProps} lines={angleLines} unit="°" />
            </SpaceBetween>
          </Container>

          <Container header={<Header variant="h3"
                     description="膝を中心に、各部位の向きが 1 秒に何ラジアン回るか。膝関節は伸びる向き、それ以外は前回りが＋">
                     角速度（rad/s）</Header>}>
            <SpaceBetween size="xs">
              <div className="graph-picker">
                {(Object.keys(ANGVEL_LABEL) as AngVelKey[]).map((k) => (
                  <Button key={k} variant={velKeys.includes(k) ? 'primary' : 'normal'}
                          onClick={() => setVelKeys((c) => toggle(c, k, 3))}>{ANGVEL_LABEL[k]}</Button>
                ))}
              </div>
              <Chart {...chartProps} lines={velLines} unit="rad/s" />
            </SpaceBetween>
          </Container>

          <Container header={<Header variant="h3">足首の速度</Header>}>
            <Chart {...chartProps} lines={speedLines} unit={useMeters ? 'm/s' : '%/s'} />
          </Container>
        </div>

        {/* ── 数値と設定 ── */}
        <SpaceBetween size="m">
          <Container header={<Header variant="h3">数値</Header>}>
            <ValuesTable clips={clips} frames={frames} names={NAMES} />
          </Container>
          {clips.map((c, i) => (
            <Container key={c.item.id}>
              <ExpandableSection headerText={`台の設定${compare ? `（${NAMES[i]}）` : ''}`}
                                 defaultExpanded={!c.settings.edge}>
                <SettingsForm clip={c} frame={frames[i]} pickingEdge={picking === i}
                              onPickEdge={(on) => setPicking(on ? i : null)} />
              </ExpandableSection>
            </Container>
          ))}
        </SpaceBetween>
      </div>
    </SpaceBetween>
  )
}

const rangeText = (v: Analysis) =>
  !v.startSec && v.endSec == null ? '動画全体' : `元動画の ${v.startSec}〜${v.endSec ?? '最後'} 秒`

/** 映像と骨格。stage の縦横比は映像と一致させる（食い違うと骨格がずれる） */
function Stage({ clip, frame, label, setVideo, picking, onClick }: {
  clip: Clip; frame: number; label?: string
  setVideo: (v: HTMLVideoElement | null) => void
  picking: boolean; onClick: (e: React.MouseEvent<HTMLCanvasElement>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(0)
  const { data, metrics, settings } = clip

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    draw(ctx, data, data.frames[frame] ?? [], metrics.targets[frame] ?? null, metrics, settings, frame)
  }, [data, metrics, settings, frame, size])

  // canvas の解像度を表示サイズに合わせる（ぼやけ防止）。サイズを変えると中身が消えるので再描画させる
  useEffect(() => {
    const wrap = wrapRef.current, cv = canvasRef.current
    if (!wrap || !cv) return
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr)
      if (cv.width === w && cv.height === h) return
      cv.width = w
      cv.height = h
      setSize(w * 10000 + h)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="stage" ref={wrapRef} style={{ aspectRatio: `${data.width} / ${data.height}` }}>
      <video ref={setVideo} src={clip.videoUrl} playsInline preload="auto" muted />
      <canvas ref={canvasRef} onClick={onClick} className={picking ? 'calib' : ''} />
      {label && <span className="stage-label">{label}</span>}
    </div>
  )
}
