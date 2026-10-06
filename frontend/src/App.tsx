/**
 * 一覧画面。動画の登録・解析状態・削除と、ビューア（1 本）／比較（2 本）への導線を持つ。
 * 解析待ち・解析中のものがある間だけ 2 秒ごとに状態を取り直す。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import AppLayout from '@cloudscape-design/components/app-layout'
import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import ProgressBar from '@cloudscape-design/components/progress-bar'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'

import { listAnalyses, register, removeAnalysis, type Analysis } from './api'
import Analyzer from './Analyzer'

const POLL_MS = 2000

export default function App() {
  const [items, setItems] = useState<Analysis[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Analysis[]>([])
  // 開いた時点の項目を固定で持つ（ポーリングで差し替わると読み込み直しになるため）
  const [opened, setOpened] = useState<Analysis[] | null>(null)

  const reload = useCallback(async () => {
    try {
      setItems(await listAnalyses())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const busy = items.some((x) => x.status === 'queued' || x.status === 'processing')
  useEffect(() => {
    if (!busy || opened) return
    const id = window.setInterval(reload, POLL_MS)
    return () => window.clearInterval(id)
  }, [busy, opened, reload])

  // ?a=<id>&b=<id> で開き直せるようにする
  const open = useCallback((list: Analysis[]) => {
    setOpened(list)
    const q = new URLSearchParams({ a: list[0].id, ...(list[1] ? { b: list[1].id } : {}) })
    history.replaceState(null, '', `?${q}`)
  }, [])
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || !items.length) return
    autoOpened.current = true
    const q = new URLSearchParams(location.search)
    const list = [q.get('a'), q.get('b')]
      .map((id) => items.find((x) => x.id === id && x.status === 'done'))
      .filter((x): x is Analysis => !!x)
    if (list.length) open(list)
  }, [items, open])

  const remove = async (v: Analysis) => {
    if (!confirm(`「${v.title}」の解析結果を削除しますか？`)) return
    try {
      await removeAnalysis(v.id)
      setSelected((s) => s.filter((x) => x.id !== v.id))
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const doneSelected = selected.filter((x) => x.status === 'done')

  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout header={<Header variant="h1">ski-jump-pose-local</Header>}>
          <SpaceBetween size="l">
            {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}

            {opened ? (
              <Analyzer key={opened.map((x) => x.id).join('+')} items={opened}
                        onBack={() => {
                          setOpened(null)
                          history.replaceState(null, '', location.pathname)
                          void reload()
                        }} />
            ) : (
              <>
                <RegisterForm onDone={(msg) => { setNotice(msg); void reload() }}
                              onError={setError} />
                {notice && <Alert type="success" dismissible onDismiss={() => setNotice(null)}>{notice}</Alert>}

                <Table
                  loading={loading}
                  loadingText="読み込み中"
                  items={items}
                  variant="container"
                  trackBy="id"
                  selectionType="multi"
                  selectedItems={selected}
                  isItemDisabled={(v) => v.status !== 'done'}
                  // 比較は 2 本まで。3 本目を選んだら古いものから外す
                  onSelectionChange={({ detail }) => setSelected(detail.selectedItems.slice(-2))}
                  ariaLabels={{
                    selectionGroupLabel: '比較する動画',
                    itemSelectionLabel: (_, v) => v.title,
                    allItemsSelectionLabel: () => 'すべて',
                  }}
                  header={
                    <Header
                      counter={`(${items.length})`}
                      description="2 本にチェックを入れると、並べて比較できます"
                      actions={
                        <Button variant="primary" disabled={doneSelected.length !== 2}
                                onClick={() => open(doneSelected)}>
                          2 本を比較
                        </Button>
                      }
                    >
                      解析済みの動画
                    </Header>
                  }
                  empty={<Box textAlign="center" padding="m">まだ動画がありません</Box>}
                  columnDefinitions={[
                    { id: 'title', header: 'ファイル名', cell: (v) => v.title, isRowHeader: true },
                    {
                      id: 'range', header: '解析範囲',
                      cell: (v) => (!v.startSec && v.endSec == null ? '全体' : `${v.startSec} 〜 ${v.endSec ?? '最後'} 秒`),
                    },
                    {
                      id: 'frames', header: 'フレーム',
                      cell: (v) => (v.frameCount ? `${v.frameCount}（${v.fps}fps）` : '—'),
                    },
                    {
                      id: 'created', header: '登録日時',
                      cell: (v) => new Date(v.createdAt).toLocaleString('ja-JP'),
                    },
                    { id: 'status', header: '状態', cell: (v) => <StatusCell v={v} />, minWidth: 220 },
                    {
                      id: 'actions', header: '',
                      cell: (v) => (
                        <SpaceBetween direction="horizontal" size="xs">
                          <Button disabled={v.status !== 'done'} onClick={() => open([v])}>開く</Button>
                          <Button variant="icon" iconName="remove" ariaLabel="削除"
                                  disabled={v.status === 'processing'} onClick={() => void remove(v)} />
                        </SpaceBetween>
                      ),
                    },
                  ]}
                />
              </>
            )}
          </SpaceBetween>
        </ContentLayout>
      }
    />
  )
}

function StatusCell({ v }: { v: Analysis }) {
  if (v.status === 'done') {
    return <StatusIndicator type="success">解析済み{v.elapsedSec ? `（${v.elapsedSec} 秒・${v.device}）` : ''}</StatusIndicator>
  }
  if (v.status === 'error') {
    return (
      <SpaceBetween size="xxxs">
        <StatusIndicator type="error">エラー</StatusIndicator>
        <Box fontSize="body-s" color="text-status-error">{v.error}</Box>
      </SpaceBetween>
    )
  }
  if (v.status === 'queued') return <StatusIndicator type="pending">順番待ち</StatusIndicator>
  const { done, total } = v.progress
  return (
    <ProgressBar value={total ? Math.min(100, (done / total) * 100) : 0}
                 additionalInfo={`${done} / ${total || '?'} フレーム`} label="解析中" />
  )
}

const VIDEO_EXT = /\.(mp4|mov|avi|m4v)$/i

/**
 * 登録フォーム。**踏切の前後数秒だけを解析する**のが基本（ローカルの推論は 1 フレームあたり数十ミリ秒かかる）。
 * 同じ動画・同じ範囲を登録し直しても、推論せずに保存済みの結果を使う。
 *
 * フォーム全体がドラッグ＆ドロップの受け口。複数の動画をまとめて落とすと、同じ開始・終了の秒で全部登録する。
 */
function RegisterForm({ onDone, onError }: {
  onDone: (msg: string) => void; onError: (msg: string) => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [sending, setSending] = useState(false)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 子要素への出入りでも dragenter/leave が飛ぶので、入れ子の深さで「枠の外に出たか」を判定する
  const depth = useRef(0)

  // 受け口の外に落としたとき、ブラウザが動画ファイルを開いて画面ごと置き換わるのを防ぐ
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  const pick = (list: FileList | null) => {
    const all = Array.from(list ?? [])
    const ok = all.filter((f) => VIDEO_EXT.test(f.name))
    if (all.length > ok.length) {
      onError(`動画以外のファイルは除外しました（${all.filter((f) => !ok.includes(f)).map((f) => f.name).join(', ')}）`)
    }
    if (!ok.length) return
    setFiles(ok)
    // ファイル欄の表示（「選択されていません」「n ファイル」）も、除外後の動画だけに合わせる
    if (inputRef.current) {
      const dt = new DataTransfer()
      ok.forEach((f) => dt.items.add(f))
      inputRef.current.files = dt.files
    }
  }

  const submit = async () => {
    if (!files.length) return
    setSending(true)
    const msgs: string[] = []
    try {
      // サーバの推論は 1 本ずつなので、登録も順番に送る（並列にしても速くならない）
      for (const f of files) {
        const { item, cached } = await register(f, start, end)
        msgs.push(cached ? `「${item.title}」は同じ範囲で解析済みのため、保存済みの結果を使います`
                         : `「${f.name}」を登録しました`)
      }
      onDone(msgs.join(' ／ '))
      setFiles([])
      if (inputRef.current) inputRef.current.value = ''
    } catch (e) {
      if (msgs.length) onDone(msgs.join(' ／ '))
      onError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`dropzone${over ? ' over' : ''}`}
         onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true) }}
         onDragOver={(e) => e.preventDefault()}
         onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false) } }}
         onDrop={(e) => {
           e.preventDefault()
           depth.current = 0
           setOver(false)
           pick(e.dataTransfer.files)
         }}>
      <Container header={<Header variant="h2"
                   description="動画をここへドラッグ＆ドロップできます（複数可）。開始・終了を空欄にすると動画全体を解析します">
                   動画を登録</Header>}>
        <ColumnLayout columns={4}>
          <FormField label="動画ファイル（mp4 / mov / avi）"
                     description={files.length > 1 ? `${files.length} 本：${files.map((f) => f.name).join(', ')}`
                                  : files.length === 1 ? files[0].name : 'ドロップするか、選択してください'}>
            <input ref={inputRef} type="file" multiple accept=".mp4,.mov,.avi,.m4v,video/*"
                   onChange={(e) => pick(e.target.files)} />
          </FormField>
          <FormField label="開始（秒）">
            <Input type="number" value={start} placeholder="0" onChange={({ detail }) => setStart(detail.value)} />
          </FormField>
          <FormField label="終了（秒）">
            <Input type="number" value={end} placeholder="最後まで" onChange={({ detail }) => setEnd(detail.value)} />
          </FormField>
          <FormField label=" ">
            <Button variant="primary" disabled={!files.length} loading={sending} onClick={() => void submit()}>
              {files.length > 1 ? `${files.length} 本を登録して解析` : '登録して解析'}
            </Button>
          </FormField>
        </ColumnLayout>
      </Container>
    </div>
  )
}
