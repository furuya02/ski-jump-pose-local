/**
 * 数値パネルと設定フォーム。1 本表示でも 2 本比較でも同じ部品を使う（比較では列が 2 つになる）。
 */

import { useEffect, useState } from 'react'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import FormField from '@cloudscape-design/components/form-field'
import Input from '@cloudscape-design/components/input'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { Clip } from './clip'
import { fmtDeg, fmtSpeed, fmtTiming } from './metrics'

const at = (s: (number | null)[], i: number) => s[i] ?? null

/**
 * 現在フレームの値と、踏切まわりの値。
 * 現在値は再生中は毎フレーム更新され、一時停止すれば固定される。
 */
export function ValuesTable({ clips, frames, names }: {
  clips: Clip[]; frames: number[]; names: string[]
}) {
  type Row = [string, (c: Clip, f: number) => React.ReactNode]
  const now: Row[] = [
    ['膝角度', (c, f) => fmtDeg(at(c.metrics.knee, f))],
    ['すね−台面', (c, f) => fmtDeg(at(c.metrics.shank, f))],
    ['腕の高さ', (c, f) => {
      const v = at(c.metrics.arm, f)
      const thr = c.settings.armThresholdDeg
      if (v == null || thr == null) return fmtDeg(v)
      return <>{fmtDeg(v)} <b className={v >= thr ? 'ok' : 'ng'}>{v >= thr ? '上がっている' : '上がっていない'}</b></>
    }],
    ['足首の速度', (c, f) => fmtSpeed(at(c.metrics.ankleSpeed, f), c.settings.frameWidthM)],
  ]
  const events: Row[] = [
    ['踏切', (c) => {
      const t = c.metrics.takeoff
      if (!t) {
        return <span className="na">{c.settings.edge
          ? '足首が台の先端を越えていません（手動で指定してください）' : '台の先端が未設定'}</span>
      }
      return `${t.t.toFixed(3)} 秒（${t.auto ? '自動' : '手動'}）`
    }],
    ['伸び切り', (c) => {
      const e = c.metrics.extension
      return e ? fmtTiming(e.diffSec, c.metrics.fps) : '—'
    }],
    ['伸び切り時の膝', (c) => fmtDeg(c.metrics.extension?.kneeDeg)],
    ['踏切時の膝', (c) => {
      const t = c.metrics.takeoff
      return t ? fmtDeg(at(c.metrics.knee, Math.round(t.frame))) : '—'
    }],
    ['踏切時の足首速度', (c) => {
      const t = c.metrics.takeoff
      return t ? fmtSpeed(at(c.metrics.ankleSpeed, Math.round(t.frame)), c.settings.frameWidthM) : '—'
    }],
    ['計算に使う脚', (c) => (c.metrics.side === 'L' ? '左（自動）' : '右（自動）')],
  ]

  const body = (rows: Row[]) => rows.map(([label, f]) => (
    <tr key={label}>
      <th>{label}</th>
      {clips.map((c, i) => <td key={i}>{f(c, frames[i])}</td>)}
    </tr>
  ))

  return (
    <table className="metrics">
      {clips.length > 1 && (
        <thead><tr><th />{names.map((n) => <th key={n}>{n}</th>)}</tr></thead>
      )}
      <tbody>
        <tr className="group"><th colSpan={clips.length + 1}>現在のフレーム</th></tr>
        {body(now)}
        <tr className="group"><th colSpan={clips.length + 1}>踏切</th></tr>
        {body(events)}
      </tbody>
    </table>
  )
}

/** 数値入力。入力途中（"-" や空欄）を許し、数値として読めたときだけ反映する */
function NumberField({ label, value, onChange, placeholder, description }: {
  label: string; value: number | null; onChange: (v: number | null) => void
  placeholder?: string; description?: string
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => {
    // 外から値が変わったとき（別の動画の設定を読み込んだときなど）だけ表示を合わせる
    setText((t) => (parseFloat(t) === value || (t === '' && value == null) ? t
                   : value == null ? '' : String(value)))
  }, [value])
  return (
    <FormField label={label} description={description}>
      <Input type="number" value={text} placeholder={placeholder}
             onChange={({ detail }) => {
               setText(detail.value)
               if (detail.value.trim() === '') { onChange(null); return }
               const v = parseFloat(detail.value)
               if (isFinite(v)) onChange(v)
             }} />
    </FormField>
  )
}

/** 台の設定。カメラは固定なので、保存した値が次に開く動画の既定になる */
export function SettingsForm({ clip, frame, pickingEdge, onPickEdge }: {
  clip: Clip; frame: number; pickingEdge: boolean; onPickEdge: (on: boolean) => void
}) {
  const s = clip.settings
  const u = clip.update
  return (
    <SpaceBetween size="s">
      <div className="form-grid">
        <NumberField label="台の角度（度）" value={s.rampAngleDeg}
                     description="進行方向に上り＋／下り−"
                     onChange={(v) => u({ rampAngleDeg: v ?? 0 })} />
        <FormField label="台の先端" description={s.edge ? '設定済み' : '未設定'}>
          <Button variant={pickingEdge ? 'primary' : 'normal'} onClick={() => onPickEdge(!pickingEdge)}>
            {pickingEdge ? '映像をクリック…' : 'クリックで指定'}
          </Button>
        </FormField>
      </div>

      <FormField label="腕の角度の基準">
        <SegmentedControl selectedId={s.armRef}
          options={[{ id: 'flat', text: '平地（水平）' }, { id: 'slope', text: '斜面' }]}
          onChange={({ detail }) => u({ armRef: detail.selectedId as 'flat' | 'slope' })} />
      </FormField>
      <div className="form-grid">
        {s.armRef === 'slope' && (
          <NumberField label="斜面の角度（度）" value={s.slopeAngleDeg}
                       description="進行方向に上り＋／下り−"
                       onChange={(v) => u({ slopeAngleDeg: v ?? 0 })} />
        )}
        <NumberField label="腕の判定角度（度）" value={s.armThresholdDeg}
                     placeholder="未設定（判定しない）"
                     onChange={(v) => u({ armThresholdDeg: v })} />
        <NumberField label="映像の横幅（m）" value={s.frameWidthM}
                     placeholder="未設定（%/s で表示）"
                     onChange={(v) => u({ frameWidthM: v && v > 0 ? v : null })} />
      </div>

      <FormField label="踏切フレーム"
                 description={s.takeoffFrame != null ? `手動：${s.takeoffFrame + 1} フレーム目`
                              : '自動（足首が台の先端を越えた瞬間）'}>
        <SpaceBetween direction="horizontal" size="xs">
          <Button onClick={() => u({ takeoffFrame: frame })}>表示中のフレームを踏切にする</Button>
          <Button disabled={s.takeoffFrame == null} onClick={() => u({ takeoffFrame: null })}>
            自動に戻す
          </Button>
        </SpaceBetween>
      </FormField>
      <Box fontSize="body-s" color="text-body-secondary">
        桃色の線が台面、緑の点線が腕の基準です。角度の符号が違うと線の傾きが逆になります。
      </Box>
    </SpaceBetween>
  )
}
