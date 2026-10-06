/**
 * 動画ごとの設定（台の角度・台の先端など）。サーバの settings.json に保存する。
 *
 * **角度の符号は「進行方向に向かって上りが＋、下りが−」で統一する。**
 * 入力した角度の線を映像に重ねて描くので、符号を間違えても見て気づける。
 */

export type Settings = {
  /** 台の面の角度（度）。水平から、進行方向に上りが＋ */
  rampAngleDeg: number
  /** 台の先端（映像上の正規化座標）。踏切の判定に使う。未設定なら null */
  edge: { x: number; y: number } | null
  /** 腕の角度の基準。平地（水平）か斜面か */
  armRef: 'flat' | 'slope'
  /** 腕の基準にする斜面の角度（度）。符号は rampAngleDeg と同じ */
  slopeAngleDeg: number
  /** 腕が「上がっている」とみなす角度（度）。未設定なら判定しない */
  armThresholdDeg: number | null
  /** 映像の横幅が実際に何メートルか。未設定なら速度は画面幅比（%/s）で出す */
  frameWidthM: number | null
  /** 踏切フレームの手動指定。null なら台の先端から自動で求める（動画ごと・既定に引き継がない） */
  takeoffFrame: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  rampAngleDeg: 0,
  edge: null,
  armRef: 'flat',
  slopeAngleDeg: -30,
  armThresholdDeg: null,
  frameWidthM: null,
  takeoffFrame: null,
}

/** サーバから来た値に既定を補う（項目を後から足しても古い保存データで壊れないように） */
export function withDefaults(s: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...s }
}
