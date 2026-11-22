import { useEffect, useRef, useState } from 'react'
import type { Clip } from '@shared/types'
import type { OutputJoin } from '@shared/transitions'

/** Keep the source transport as the editor clock. During an overlap the
 * bounded export supplies both composed pictures, overlays and mixed audio. */
export default function ComposedJoin({ clip, projectId, join, time, playing, source, setMixedAudio }: {
  clip: Clip
  projectId: string
  join: OutputJoin
  time: number
  playing: boolean
  setMixedAudio: (enabled: boolean) => void
  source: React.RefObject<HTMLVideoElement | null>
}): React.JSX.Element | null {
  const video = useRef<HTMLVideoElement>(null)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const left = Math.min(join.leftDuration, join.duration * 2 + .35)
  const elapsed = time - (join.time + join.overlap / 2 - left)
  const active = Math.abs(time - join.time) <= join.overlap / 2
  useEffect(() => {
    let cancelled = false
    window.cutawan.transitionPreview(projectId, clip, join.fromId, join.toId).then(result => {
      if (!cancelled) setPath(result)
    }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [projectId, clip, join.fromId, join.toId])
  useEffect(() => {
    const player = video.current
    if (!player || !ready) return
    if (!active) { player.pause(); return }
    if (!playing || player.paused || Math.abs(player.currentTime - elapsed) > .10) {
      player.currentTime = Math.max(0, elapsed)
    }
    if (playing && player.paused) void player.play().catch(e => setError(String(e)))
    else if (!playing) player.pause()
  }, [active, ready, playing, elapsed])
  useEffect(() => {
    setMixedAudio(active && ready && !error)
    return () => setMixedAudio(false)
  }, [active, ready, error, setMixedAudio])
  useEffect(() => {
    const original = source.current
    if (!original || !playing) return
    if (active && !ready && !error) original.pause()
    else if (original.paused) void original.play().catch(() => {})
  }, [active, ready, error, playing, source])
  if (error) return active ? <p role="alert" className="absolute inset-x-0 top-0 bg-black text-xs">{error}</p> : null
  if (!path) return active ? <p role="status" className="absolute inset-x-0 top-0 bg-black text-xs">Preparing transition preview…</p> : null
  return <video ref={video} preload="auto" onLoadedData={() => setReady(true)}
    className={active && ready ? 'pointer-events-none absolute inset-0 h-full w-full' : 'hidden'}
    src={window.cutawan.mediaUrl(path)} />
}
