/**
 * 指標の計算。**pose.json には入れず、ブラウザで全フレーム分を 1 度だけ計算する。**
 * 定義を見直しても再推論が要らないようにするため。定義の詳細は docs/metrics.md。
 *
 * 座標の扱い：pose.json は x を画面幅、y を画面高さで 0..1 に正規化している。
 * そのままでは縦横の縮尺が違い角度が歪むので、**y を画面幅の単位へ換算（y / アスペクト比）**してから計算する。
 * 速度の単位も「画面幅 / 秒」になる。
 */

import { KP, kp, type Person, type PoseData } from './lib'
import type { Settings } from './settings'

/** これ未満の信頼度のキーポイントは使わない（欠損として扱い、補間しない） */
export const THRESHOLD = 0.3

export type Side = 'L' | 'R'
type V = { x: number; y: number }
type Series = (number | null)[]

/** 左右それぞれの関節番号 */
const JOINTS = {
  L: { shoulder: KP.shoulderL, elbow: KP.elbowL, wrist: KP.wristL,
       hip: KP.hipL, knee: KP.kneeL, ankle: KP.ankleL },
  R: { shoulder: KP.shoulderR, elbow: KP.elbowR, wrist: KP.wristR,
       hip: KP.hipR, knee: KP.kneeR, ankle: KP.ankleR },
} as const
export const jointsOf = (s: Side) => JOINTS[s]

/** 膝を中心にした角速度の対象。膝 → 各部位 の向きの回転速度 */
export type AngVelKey = 'kneeJoint' | 'thigh' | 'shank' | 'trunk' | 'arm'
export const ANGVEL_LABEL: Record<AngVelKey, string> = {
  kneeJoint: '膝関節（伸展）',
  thigh: '腰（膝→腰）',
  shank: '足首（膝→足首）',
  trunk: '肩（膝→肩）',
  arm: '手首（膝→手首）',
}

export type Metrics = {
  fps: number
  frameCount: number
  /** 計算に使う脚の側。信頼度の高い側（＝カメラに近い側）を動画単位で 1 つに決める */
  side: Side
  /** 進行方向。画面の右へ進むなら +1、左へ進むなら -1 */
  dir: 1 | -1
  targets: (Person | null)[]
  /** 膝角度（腰-膝-足首、度） */
  knee: Series
  /** すね（足首→膝）と台面のなす角（度）。90 = 台に垂直、小さいほど前傾 */
  shank: Series
  /** 腕（肩→手首）の高さ（度）。基準線に対して上が＋、−90〜90 */
  arm: Series
  /** 足首の速度（画面幅 / 秒） */
  ankleSpeed: Series
  /** 角速度（rad/s）。膝関節は伸びる向きが＋、それ以外は前回り（進行方向へ倒れる向き）が＋ */
  angVel: Record<AngVelKey, Series>
  /** 踏切。frame は小数（フレーム間を線形補間）。auto=false は手動指定 */
  takeoff: { frame: number; t: number; auto: boolean } | null
  /** 脚が伸び切った瞬間（踏切の前後 EXT_WINDOW_SEC の膝角度最大） */
  extension: { frame: number; t: number; kneeDeg: number; diffSec: number } | null
}

/** 伸び切りを探す範囲（踏切の前後・秒） */
export const EXT_WINDOW_SEC = 0.5

// ── ベクトル ────────────────────────────────────────────

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y
const len = (a: V) => Math.hypot(a.x, a.y)
const DEG = 180 / Math.PI

/** 2 ベクトルのなす角（度、0〜180） */
function between(a: V, b: V): number | null {
  const la = len(a), lb = len(b)
  if (la < 1e-9 || lb < 1e-9) return null
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * DEG
}

/**
 * 基準線の「進行方向の向き」の単位ベクトル。y は下向きが＋なので、上りは y を負にする。
 * `deg` は進行方向に上りが＋。
 */
export function lineDir(deg: number, dir: 1 | -1): V {
  const a = deg / DEG
  return { x: dir * Math.cos(a), y: -Math.sin(a) }
}

/** 基準線に垂直で、上を向いた単位ベクトル */
function upNormal(f: V): V {
  const n = { x: -f.y, y: f.x }
  return n.y < 0 ? n : { x: -n.x, y: -n.y }
}

// ── 系列の処理 ──────────────────────────────────────────

/**
 * 平滑化の窓（奇数フレーム）。約 0.17 秒。240fps でも 24fps でも同じ時間幅にする。
 * 骨格検出の揺れは 1〜2 コマ単位で出るので、これより狭いと微分（速度・角速度）が揺れで埋まる。
 */
export function smoothWindow(fps: number): number {
  return Math.max(3, 2 * Math.round(fps * 0.085) + 1)
}

/** 中心移動平均。窓の過半が欠けていたら null（検出できていないことを見えるようにする） */
export function smooth(s: Series, w: number): Series {
  const half = Math.floor(w / 2)
  return s.map((_, i) => {
    let sum = 0, n = 0
    for (let j = i - half; j <= i + half; j++) {
      const v = s[j]
      if (v != null) { sum += v; n++ }
    }
    return n > half ? sum / n : null
  })
}

/** 中央差分（/秒）。前後どちらかが欠ければ null */
function deriv(s: Series, fps: number): Series {
  return s.map((_, i) => {
    const a = s[i - 1], b = s[i + 1]
    return a != null && b != null ? ((b - a) * fps) / 2 : null
  })
}

/** 角度（rad）の 2π の飛びを取り除く。欠損をまたいでも直前の有効値に合わせる */
function unwrap(s: Series): Series {
  let prev: number | null = null
  return s.map((v) => {
    if (v == null) return null
    if (prev != null) {
      while (v - prev > Math.PI) v -= 2 * Math.PI
      while (v - prev < -Math.PI) v += 2 * Math.PI
    }
    prev = v
    return v
  })
}

// ── 本体 ──────────────────────────────────────────────

export function computeMetrics(d: PoseData, st: Settings): Metrics {
  const asp = d.width / d.height
  const fps = d.fps
  const n = d.frameCount
  const w = smoothWindow(fps)

  const targets = trackAthlete(d.frames)
  const pt = (p: Person | null, i: number): V | null => {
    if (!p) return null
    const k = kp(p, i)
    return k.s >= THRESHOLD ? { x: k.x, y: k.y / asp } : null
  }

  const side = chooseSide(targets)
  const J = JOINTS[side]
  const dir = travelDir(targets.map((p) => pt(p, J.hip)))
  const ramp = lineDir(st.rampAngleDeg, dir)
  const armUp = upNormal(lineDir(st.armRef === 'slope' ? st.slopeAngleDeg : 0, dir))

  const knee: Series = [], shank: Series = [], arm: Series = []
  const ankleX: Series = [], ankleY: Series = []
  const orient: Record<Exclude<AngVelKey, 'kneeJoint'>, Series> =
    { thigh: [], shank: [], trunk: [], arm: [] }

  targets.forEach((p) => {
    const H = pt(p, J.hip), K = pt(p, J.knee), A = pt(p, J.ankle)
    const S = pt(p, J.shoulder), Wr = pt(p, J.wrist)

    knee.push(H && K && A ? between(sub(H, K), sub(A, K)) : null)
    shank.push(K && A ? between(ramp, sub(K, A)) : null)

    if (S && Wr) {
      const u = sub(Wr, S), l = len(u)
      arm.push(l > 1e-9 ? Math.asin(Math.max(-1, Math.min(1, dot(u, armUp) / l))) * DEG : null)
    } else arm.push(null)

    ankleX.push(A?.x ?? null)
    ankleY.push(A?.y ?? null)

    const o = (X: V | null) => (K && X ? Math.atan2(X.y - K.y, X.x - K.x) : null)
    orient.thigh.push(o(H))
    orient.shank.push(o(A))
    orient.trunk.push(o(S))
    orient.arm.push(o(Wr))
  })

  // 速度・角速度は平滑化してから微分する（生の差分は数値が暴れて読めない）
  const ax = smooth(ankleX, w), ay = smooth(ankleY, w)
  const vx = deriv(ax, fps), vy = deriv(ay, fps)
  const ankleSpeed = vx.map((x, i) => (x != null && vy[i] != null ? Math.hypot(x, vy[i]!) : null))

  const kneeSm = smooth(knee, w)
  // 画面座標は y が下向きなので atan2 の増加は「画面上で時計回り」。
  // 右へ進むときは時計回りが前回り、左へ進むときは反時計回りが前回りなので dir を掛ける
  const rot = (s: Series) => deriv(smooth(unwrap(s), w), fps).map((v) => (v == null ? null : v * dir))
  const angVel: Record<AngVelKey, Series> = {
    kneeJoint: deriv(kneeSm.map((v) => (v == null ? null : v / DEG)), fps),
    thigh: rot(orient.thigh),
    shank: rot(orient.shank),
    trunk: rot(orient.trunk),
    arm: rot(orient.arm),
  }

  // 踏切：手動指定を優先。無ければ足首が台の先端の x を進行方向へ越えた瞬間
  let takeoff: Metrics['takeoff'] = null
  if (st.takeoffFrame != null && st.takeoffFrame >= 0 && st.takeoffFrame < n) {
    takeoff = { frame: st.takeoffFrame, t: st.takeoffFrame / fps, auto: false }
  } else if (st.edge) {
    const f = crossing(ax, st.edge.x, dir)
    if (f != null) takeoff = { frame: f, t: f / fps, auto: true }
  }

  let extension: Metrics['extension'] = null
  if (takeoff) {
    const r = Math.round(EXT_WINDOW_SEC * fps)
    const c = Math.round(takeoff.frame)
    let best = -1
    for (let i = Math.max(0, c - r); i <= Math.min(n - 1, c + r); i++) {
      const v = kneeSm[i]
      if (v != null && (best < 0 || v > kneeSm[best]!)) best = i
    }
    if (best >= 0) {
      extension = { frame: best, t: best / fps, kneeDeg: kneeSm[best]!,
                    diffSec: best / fps - takeoff.t }
    }
  }

  return { fps, frameCount: n, side, dir, targets, knee, shank, arm,
           ankleSpeed, angVel, takeoff, extension }
}

// ── 対象選手の追跡 ──────────────────────────────────────

/** 追跡が途切れてから、近くの人物を同じ選手とみなして拾い直すまでの猶予（フレーム） */
const LOST_FRAMES = 12
/** 予測位置からこの距離（画面幅比）以内の人物だけを同じ選手とみなす */
const GATE = 0.12

const center = (p: Person) => ({ x: p.box[0] + p.box[2] / 2, y: p.box[1] + p.box[3] / 2 })

/**
 * 選手を全フレームで追う。
 *
 * **「一番大きく映っている人」を毎フレーム選び直すと、台の上の係員などに入れ替わり、
 * 角度や速度に大きなスパイクが出る。** そこで次のようにする。
 *   1. 最初の手がかりは「最もよく動いた追跡 ID」（静止している人は選手ではない）。
 *   2. 以降は同じ ID を追う。ID が切れたら（宙返りなどで起きやすい）、
 *      直前の位置と速度から予測した位置に最も近い人物を引き継ぐ。
 */
export function trackAthlete(frames: Person[][]): (Person | null)[] {
  // 1. ID ごとの移動量（中心の移動距離の合計）
  const travel = new Map<number, number>()
  const last = new Map<number, { x: number; y: number }>()
  for (const ppl of frames) {
    for (const p of ppl) {
      const c = center(p), prev = last.get(p.id)
      if (prev) travel.set(p.id, (travel.get(p.id) ?? 0) + Math.hypot(c.x - prev.x, c.y - prev.y))
      last.set(p.id, c)
    }
  }
  let seed: number | null = null
  for (const [id, t] of travel) if (seed == null || t > travel.get(seed)!) seed = id

  // 2. 追う
  const out: (Person | null)[] = []
  let id = seed
  let pos: { x: number; y: number } | null = null
  let vel = { x: 0, y: 0 }
  let lost = 0
  for (const ppl of frames) {
    let p = ppl.find((q) => q.id === id) ?? null
    if (!p && pos && lost < LOST_FRAMES) {
      const pred = { x: pos.x + vel.x * (lost + 1), y: pos.y + vel.y * (lost + 1) }
      let best = GATE
      for (const q of ppl) {
        const c = center(q), dist = Math.hypot(c.x - pred.x, c.y - pred.y)
        if (dist < best) { best = dist; p = q }
      }
      if (p) id = p.id
    }
    if (p) {
      const c = center(p)
      if (pos) vel = { x: (c.x - pos.x) / (lost + 1), y: (c.y - pos.y) / (lost + 1) }
      pos = c
      lost = 0
    } else {
      lost++
    }
    out.push(p)
  }
  return out
}

/** 左右のうち、動画全体で信頼度の合計が高い側。真横から撮ればカメラに近い脚になる */
export function chooseSide(targets: (Person | null)[]): Side {
  let l = 0, r = 0
  const keys = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'] as const
  for (const p of targets) {
    if (!p) continue
    for (const k of keys) {
      l += kp(p, JOINTS.L[k]).s
      r += kp(p, JOINTS.R[k]).s
    }
  }
  return l >= r ? 'L' : 'R'
}

/** 進行方向。腰の x の前半 2 割と後半 2 割の平均を比べる。判断できなければ右向き */
function travelDir(hips: (V | null)[]): 1 | -1 {
  const xs = hips.filter((h): h is V => !!h).map((h) => h.x)
  if (xs.length < 4) return 1
  const k = Math.max(1, Math.floor(xs.length * 0.2))
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  return avg(xs.slice(-k)) >= avg(xs.slice(0, k)) ? 1 : -1
}

/** 系列が値 `x0` を進行方向へ最初に越えるフレーム（小数、線形補間） */
function crossing(xs: Series, x0: number, dir: 1 | -1): number | null {
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1]
    if (a == null || b == null) continue
    if ((a - x0) * dir < 0 && (b - x0) * dir >= 0) return i + (x0 - a) / (b - a)
  }
  return null
}

// ── 表示 ──────────────────────────────────────────────

export const fmtDeg = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}°`)
export const fmtRad = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)} rad/s`)

/** 足首の速度。映像の横幅（m）が入っていれば m/s と km/h、無ければ画面幅比 */
export function fmtSpeed(v: number | null | undefined, frameWidthM: number | null): string {
  if (v == null) return '—'
  if (!frameWidthM) return `${(v * 100).toFixed(1)} %/s`
  const ms = v * frameWidthM
  return `${ms.toFixed(1)} m/s（${(ms * 3.6).toFixed(1)} km/h）`
}

/** 伸び切りのタイミング。負＝台の手前で伸び切った（早い）、正＝台を出てから（遅い） */
export function fmtTiming(diffSec: number, fps: number): string {
  if (Math.abs(diffSec) < 0.5 / fps) return '踏切と同時'
  const s = Math.abs(diffSec).toFixed(3)
  return diffSec < 0 ? `${s} 秒 早い（台の手前で伸び切り）` : `${s} 秒 遅い（台を出てから伸び切り）`
}
