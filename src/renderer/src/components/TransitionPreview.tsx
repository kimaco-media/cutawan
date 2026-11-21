import { useState } from 'react'
import type { Clip } from '@shared/types'
import { usePreviewBus } from '../lib/previewBus'
import type { OutputJoin } from '@shared/transitions'

/** Render only on request, not while browsing the picker. Parent keys this by
 * the render inputs so an edit never displays a stale cached preview. */
export default function TransitionPreview({ projectId, clip, join }: {
  projectId: string; clip: Clip; join: OutputJoin
}): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pauseSource = (): void => { const bus = usePreviewBus.getState(); bus.scrub(bus.time) }
  const render = async (): Promise<void> => {
    pauseSource()
    setBusy(true)
    setError(null)
    try { setPath(await window.cutawan.transitionPreview(projectId, clip, join.fromId, join.toId)) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <div data-transition-preview className="mt-2">
    <button type="button" disabled={busy || !join.duration} onClick={() => void render()}
      className="rounded border border-surface-600 px-2 py-1 disabled:opacity-40">
      {busy ? 'Rendering join…' : 'Render join preview'}
    </button>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {path && <video aria-label="Rendered transition preview" controls preload="metadata" onPlay={pauseSource}
      className="mt-2 max-h-64 w-full bg-black" src={window.cutawan.mediaUrl(path)} />}
  </div>
}
