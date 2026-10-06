/**
 * Canvas 2D への描画。**動画には焼き込まない。**
 *
 * 描くもの：対象選手の骨格、計算に使っている膝（黄色）、台の先端と台面の線、腕の基準線。
 * 台の線を映像に重ねるのは、入力した角度（符号を含む）が合っているかを目で確かめられるようにするため。
 */

import { SIDE_COLOR, limbSide, kp, type Person, type PoseData } from './lib'
import { THRESHOLD, jointsOf, lineDir, type Metrics } from './metrics'
import type { Settings } from './settings'

const DIM = 'rgba(255,255,255,0.28)'
const KNEE_COLOR = '#FFE14D'
const RAMP_COLOR = 'rgba(255,109,180,0.95)'
const ARM_REF_COLOR = 'rgba(124,255,107,0.9)'

export function draw(ctx: CanvasRenderingContext2D, d: PoseData, people: Person[],
                     target: Person | null, m: Metrics, st: Settings, frame: number): void {
  const W = ctx.canvas.width, H = ctx.canvas.height
  ctx.clearRect(0, 0, W, H)

  // 太さは短辺比（映像の解像度に左右されない）、文字は CSS ピクセル基準
  const scale = Math.min(W, H)
  const lw = Math.max(1.5, scale * 0.004)
  const dpr = ctx.canvas.clientWidth > 0 ? W / ctx.canvas.clientWidth : 1
  const J = jointsOf(m.side)
  ctx.lineCap = 'round'

  // ── 骨格（対象以外は薄く） ──
  for (const p of people) {
    const isTarget = p === target
    ctx.lineWidth = lw * (isTarget ? 1 : 0.6)
    for (const [a, b] of d.skeleton) {
      const A = kp(p, a), B = kp(p, b)
      if (A.s < THRESHOLD || B.s < THRESHOLD) continue
      ctx.strokeStyle = isTarget ? SIDE_COLOR[limbSide(a, b)] : DIM
      ctx.beginPath()
      ctx.moveTo(A.x * W, A.y * H)
      ctx.lineTo(B.x * W, B.y * H)
      ctx.stroke()
    }
  }

  if (target) {
    for (let i = 0; i < 17; i++) {
      const P = kp(target, i)
      if (P.s < THRESHOLD) continue
      const isKnee = i === J.knee
      ctx.fillStyle = isKnee ? KNEE_COLOR : '#FFFFFF'
      ctx.beginPath()
      ctx.arc(P.x * W, P.y * H, lw * (isKnee ? 1.8 : 0.9), 0, Math.PI * 2)
      ctx.fill()
    }

    // 腕の基準線（肩を通る）。腕の角度はこの線から上が＋
    const S = kp(target, J.shoulder)
    if (S.s >= THRESHOLD) {
      const f = lineDir(st.armRef === 'slope' ? st.slopeAngleDeg : 0, m.dir)
      const L = 0.06 * W
      ctx.strokeStyle = ARM_REF_COLOR
      ctx.lineWidth = 1.5 * dpr
      ctx.setLineDash([6 * dpr, 4 * dpr])
      ctx.beginPath()
      // f は「画面幅単位」なので、y は W を掛けて px にする
      ctx.moveTo(S.x * W - f.x * L, S.y * H - f.y * L)
      ctx.lineTo(S.x * W + f.x * L, S.y * H + f.y * L)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // ── 台の先端と台面 ──
  if (st.edge) {
    const ex = st.edge.x * W, ey = st.edge.y * H
    const f = lineDir(st.rampAngleDeg, m.dir)
    const L = 0.3 * W
    ctx.strokeStyle = RAMP_COLOR
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.moveTo(ex - f.x * L, ey - f.y * L)     // 助走側へ伸ばす
    ctx.lineTo(ex, ey)
    ctx.stroke()
    ctx.setLineDash([4 * dpr, 4 * dpr])        // 先端の位置（踏切の判定線）
    ctx.beginPath()
    ctx.moveTo(ex, 0)
    ctx.lineTo(ex, H)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = RAMP_COLOR
    ctx.beginPath()
    ctx.arc(ex, ey, 4 * dpr, 0, Math.PI * 2)
    ctx.fill()
  }

  // ── 踏切・伸び切りのフレームで目印を出す ──
  const tags: string[] = []
  if (m.takeoff && Math.round(m.takeoff.frame) === frame) tags.push('踏切')
  if (m.extension && m.extension.frame === frame) tags.push('伸び切り')
  if (tags.length) {
    ctx.font = `700 ${16 * dpr}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    const text = tags.join(' / ')
    ctx.fillRect(8 * dpr, 8 * dpr, ctx.measureText(text).width + 16 * dpr, 26 * dpr)
    ctx.fillStyle = KNEE_COLOR
    ctx.fillText(text, 16 * dpr, 13 * dpr)
  }
}
