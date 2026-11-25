import { useEffect, useRef, useState } from 'react'
import type { Clip } from '@shared/types'
import { usePreviewBus } from '../lib/previewBus'

export default function LoopPreview({ projectId, clip }: { projectId: string; clip: Clip }): React.JSX.Element {
  const [seconds, setSeconds] = useState(2)
  const [repeat, setRepeat] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string; seam: number; notice?: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const request = useRef<string | null>(null)
  function cancel(): void {
    if (request.current) void window.cutawan.cancelLoopPreview(request.current)
    request.current = null
  }
  useEffect(() => {
    const unsubscribe = window.cutawan.onLoopProgress((id, fraction) => {
      if (id === request.current) setProgress(fraction)
    })
    return () => { cancel(); unsubscribe() }
  }, [])
  const pauseSource = (): void => { const bus = usePreviewBus.getState(); bus.scrub(bus.time) }
  useEffect(() => {
    if (!result) return
    let current = true
    const verify = (): void => {
      void window.cutawan.loopPreview(projectId, clip, seconds, crypto.randomUUID(), result.path).catch(err => {
        if (current) {
          setResult(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    }
    window.addEventListener('focus', verify)
    const player = video.current
    player?.addEventListener('play', verify)
    return () => {
      current = false
      window.removeEventListener('focus', verify)
      player?.removeEventListener('play', verify)
    }
  }, [projectId, clip, seconds, result])
  async function render(): Promise<void> {
    pauseSource()
    const id = crypto.randomUUID()
    request.current = id
    setBusy(true)
    setProgress(null)
    setError('')
    setResult(null)
    try {
      const preview = await window.cutawan.loopPreview(projectId, clip, seconds, id)
      if (request.current === id) setResult(preview)
    } catch (err) {
      if (request.current === id) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request.current === id) { request.current = null; setBusy(false) }
    }
  }
  return <details data-testid="loop-preview" className="my-2 text-xs">
    <summary>Preview end → start loop</summary>
    <p className="my-1">The first preview renders the finished Short locally. Platform players may add playback latency.</p>
    <label>Seconds per side <select value={seconds} disabled={busy} onChange={e => {
      setSeconds(Number(e.target.value)); setResult(null); setError('')
    }}>{[1,2,3,4,5].map(n => <option key={n}>{n}</option>)}</select></label>
    <button type="button" className="mx-2 rounded border px-2 py-1" disabled={busy} onClick={() => void render()}>
      {busy ? 'Rendering loop preview…' : 'Render loop preview'}</button>
    {busy && <progress aria-label="Loop render progress" value={progress ?? undefined} max={1} />}
    {busy && <button type="button" onClick={() => { cancel(); setBusy(false) }}>Cancel</button>}
    {error && <p role="alert">{error}</p>}
    {result && <div>
      {result.notice && <p role="status">{result.notice}</p>}
      <video ref={video} controls onPlay={pauseSource} loop={repeat} aria-label="Rendered end to start loop"
        className="max-h-64 w-full bg-black" src={window.cutawan.mediaUrl(result.path)} />
      <p className="text-center">End │ Start · {result.seam.toFixed(3)} s</p>
      <label><input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} /> Repeat preview</label>
    </div>}
  </details>
}
