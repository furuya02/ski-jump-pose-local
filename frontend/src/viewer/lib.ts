/**
 * ビューア共通の型・定数・純粋関数（UI 非依存）。
 *
 * **ここは推論ジョブとの契約です。** `docker/inference.py` が生成する pose.json を
 * そのまま受けます。片方だけ変えると、エラーにならないまま骨格がずれて描画されます。
 * 仕様は docs/pose-schema.md。
 */

export const SCHEMA_VERSION = 1

/** pose.json 内の 1 人分。kp は [x, y, score] × 17 のフラット配列（0..1 正規化） */
export type Person = {
  id: number
  score: number
  box: [number, number, number, number]   // [x, y, w, h]
  kp: number[]                            // 51 要素
}

/** 推論ジョブが生成する pose.json の全体構造 */
export type PoseData = {
  schemaVersion: number
  fps: number
  width: number
  height: number
  frameCount: number
  durationSec: number
  sourceWidth?: number
  sourceHeight?: number
  model: string
  confThreshold: number
  tracking: boolean
  keypointNames: string[]
  skeleton: [number, number][]
  detections: number
  frames: Person[][]
}

// ── COCO 17 キーポイントの添字 ────────────────────────────────
export const KP = {
  nose: 0, eyeL: 1, eyeR: 2, earL: 3, earR: 4,
  shoulderL: 5, shoulderR: 6, elbowL: 7, elbowR: 8,
  wristL: 9, wristR: 10, hipL: 11, hipR: 12,
  kneeL: 13, kneeR: 14, ankleL: 15, ankleR: 16,
} as const

/** 骨格線。pose.json に入っているが、古いデータ用のフォールバックとして持つ */
export const SKELETON: [number, number][] = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
]

/** 左半身・右半身・体幹で線の色を変える（左右の取り違えを目視で防ぐため） */
export const SIDE_COLOR = { left: '#00E5FF', right: '#FFD54F', center: '#7CFF6B' } as const

export function limbSide(a: number, b: number): keyof typeof SIDE_COLOR {
  const isL = (i: number) => [1, 3, 5, 7, 9, 11, 13, 15].includes(i)
  const isR = (i: number) => [2, 4, 6, 8, 10, 12, 14, 16].includes(i)
  if (isL(a) && isL(b)) return 'left'
  if (isR(a) && isR(b)) return 'right'
  return 'center'
}

export type Pt = { x: number; y: number; s: number }

/** i 番目のキーポイントを取り出す。score === 0 は未検出 */
export function kp(p: Person, i: number): Pt {
  return { x: p.kp[i * 3], y: p.kp[i * 3 + 1], s: p.kp[i * 3 + 2] }
}

/** 2 点の中点。どちらかが閾値未満なら null（欠損を勝手に埋めない） */
export function mid(p: Person, a: number, b: number, thr: number): Pt | null {
  const A = kp(p, a), B = kp(p, b)
  if (A.s < thr || B.s < thr) return null
  return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, s: Math.min(A.s, B.s) }
}

/**
 * 再生位置からフレーム番号を引く。
 * playback.mp4 と pose.json が同一フレーム列なのでこれが成立する。
 *
 * **round ではなく floor を使う。** フレーム i は [i/fps, (i+1)/fps) の間ずっと表示されて
 * いるので、round だと後半で 1 コマ先の骨格を出してしまう。
 */
export function frameIndexAt(currentTime: number, d: PoseData): number {
  const i = Math.floor(currentTime * d.fps + 1e-6)   // 境界の丸め誤差を吸収する
  return Math.max(0, Math.min(i, d.frameCount - 1))
}

/** 最も大きい bbox の人物＝手前の選手。ビューアの既定の追従対象 */
export function largestPerson(people: Person[]): Person | null {
  if (!people.length) return null
  return people.reduce((a, b) => (a.box[2] * a.box[3] >= b.box[2] * b.box[3] ? a : b))
}

/** 指定 ID の人物。見つからなければ null（ID が切れたことを画面に出すため補完しない） */
export function personById(people: Person[], id: number | null): Person | null {
  if (id == null) return null
  return people.find((p) => p.id === id) ?? null
}

/** 読み込み時の検証。外れていれば理由を返す（黙って描画しない） */
export function validate(d: PoseData): string | null {
  if (d.schemaVersion !== SCHEMA_VERSION)
    return `未知の schemaVersion です（${d.schemaVersion}）。ビューアの更新が必要です`
  if (!(d.fps > 0)) return 'fps が不正です'
  if (d.frames.length !== d.frameCount)
    return `frames の数（${d.frames.length}）が frameCount（${d.frameCount}）と一致しません`
  for (const f of d.frames)
    for (const p of f)
      if (p.kp.length % 51 !== 0) return 'kp の長さが 51 の倍数ではありません'
  return null
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec)) return '00:00.00'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}
