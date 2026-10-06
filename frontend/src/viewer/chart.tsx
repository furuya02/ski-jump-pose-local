/**
 * 時系列グラフ（SVG）。現在位置に縦線を引き、クリックでその時刻へシークする。
 * 欠損区間は線を切る（0 として描かない）。
 *
 * 横軸は「秒」。1 本表示では動画の時刻、2 本比較では**踏切からの相対秒**を渡す。
 * こうすると fps の違う 2 本（例：60fps と 240fps）も同じ軸に重ねられる。
 */

export type Line = {
  label: string
  color: string
  dashed?: boolean
  t0: number              // 先頭フレームの時刻（秒）
  fps: number
  ys: (number | null)[]
}

export type Marker = { t: number; color: string; label: string }

export function Chart({ lines, domain, cur, markers = [], unit, onSeek, height = 130 }: {
  lines: Line[]
  domain: [number, number]
  cur: number
  markers?: Marker[]
  unit: string
  onSeek: (t: number) => void
  height?: number
}) {
  const W = 1000, H = height, pad = 6
  const [t0, t1] = domain
  if (!(t1 > t0)) return null

  // 縦軸は表示範囲の値から自動で決める。
  // 誤検出の 1 点で全体が潰れないよう、上下 1% ずつを外した範囲にする（はみ出た線は枠で切れる）
  const vals: number[] = []
  for (const l of lines) {
    l.ys.forEach((v, i) => {
      const t = l.t0 + i / l.fps
      if (v != null && t >= t0 && t <= t1) vals.push(v)
    })
  }
  vals.sort((a, b) => a - b)
  let lo = vals.length ? vals[Math.floor(vals.length * 0.01)] : 0
  let hi = vals.length ? vals[Math.ceil(vals.length * 0.99) - 1] : 1
  if (hi - lo < 1e-6) { hi += 1; lo -= 1 }
  const m = (hi - lo) * 0.08
  lo -= m; hi += m

  const X = (t: number) => ((t - t0) / (t1 - t0)) * W
  const Y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2)

  const path = (l: Line) => {
    let d = '', pen = false
    l.ys.forEach((v, i) => {
      const t = l.t0 + i / l.fps
      if (v == null || t < t0 || t > t1) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  return (
    <div>
      <svg className="ts" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           style={{ height }}
           onClick={(e) => {
             const r = (e.currentTarget as SVGElement).getBoundingClientRect()
             onSeek(t0 + ((e.clientX - r.left) / r.width) * (t1 - t0))
           }}>
        {lo < 0 && hi > 0 && (
          <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke="#d5dbdb" strokeWidth={1} />
        )}
        {markers.map((mk) => (
          <line key={mk.label} x1={X(mk.t)} x2={X(mk.t)} y1={0} y2={H}
                stroke={mk.color} strokeWidth={2} strokeDasharray="6 4" />
        ))}
        {lines.map((l) => (
          <path key={l.label} d={path(l)} fill="none" stroke={l.color} strokeWidth={2}
                strokeDasharray={l.dashed ? '8 5' : undefined}
                vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={X(cur)} x2={X(cur)} y1={0} y2={H} stroke="#0972d3" strokeWidth={2} />
      </svg>
      <div className="ts-legend">
        {lines.map((l) => (
          <span key={l.label}>
            <i style={{ background: l.dashed
              ? `repeating-linear-gradient(90deg, ${l.color} 0 5px, transparent 5px 8px)` : l.color }} />
            {l.label}
          </span>
        ))}
        {markers.map((mk) => (
          <span key={mk.label}><i style={{ background: mk.color }} />{mk.label}</span>
        ))}
        <span className="hint">
          縦軸 {lo.toFixed(1)}〜{hi.toFixed(1)} {unit}　／　クリックでその時刻へ移動
        </span>
      </div>
    </div>
  )
}
