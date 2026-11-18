import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, RotateCcw, X } from 'lucide-react'
import type { Clip, Composition, ContentRegion, VideoInfo } from '@shared/types'
import {
  compositionDraftIssue,
  draftComposition,
  draftFromComposition,
  dragRegion,
  initialSelectedRole,
  nudgeRegion,
  pointerToSource,
  resizeRegion,
  RESIZE_HANDLES,
  type RegionDraft,
  type ResizeHandle
} from '@shared/regionEditor'
import { drawCompositionFrame } from '../lib/previewVideo'
import { usePreviewBus } from '../lib/previewBus'
import { formatTimecode } from '../lib/format'

/**
 * Visual source-region editor: the full, uncropped source frame with the
 * facecam/presenter and gameplay/content rectangles dragged and resized on
 * top of it, a live 9:16 mini preview drawn with the exact export geometry,
 * and the percentage fields as an advanced precision mode. Apply flows
 * through the caller's save (revisions, history, per-shot replacement);
 * Cancel and Reset never touch the saved clip.
 */

type Role = 'presenter' | 'content'

const RECT_COLORS: Record<Role, string> = { presenter: '#f87171', content: '#38bdf8' }

const HANDLE_POSITIONS: Record<ResizeHandle, React.CSSProperties> = {
  nw: { left: -5, top: -5, cursor: 'nwse-resize' },
  n: { left: 'calc(50% - 5px)', top: -5, cursor: 'ns-resize' },
  ne: { right: -5, top: -5, cursor: 'nesw-resize' },
  e: { right: -5, top: 'calc(50% - 5px)', cursor: 'ew-resize' },
  se: { right: -5, bottom: -5, cursor: 'nwse-resize' },
  s: { left: 'calc(50% - 5px)', bottom: -5, cursor: 'ns-resize' },
  sw: { left: -5, bottom: -5, cursor: 'nesw-resize' },
  w: { left: -5, top: 'calc(50% - 5px)', cursor: 'ew-resize' }
}

export default function RegionEditor({
  clip,
  source,
  composition,
  onSave,
  onClose
}: {
  clip: Clip
  source: VideoInfo
  composition: Composition
  onSave: (composition: Composition) => void
  onClose: () => void
}): React.JSX.Element {
  const gaming = composition.preset === 'gaming'
  const hasPresenter = composition.layers.some(l => l.role === 'presenter')
  const label = (role: Role): string =>
    gaming ? (role === 'presenter' ? 'Facecam' : 'Gameplay') : (role === 'presenter' ? 'Presenter' : 'Content')
  const busTime = usePreviewBus(s => s.time)
  const [draft, setDraft] = useState<RegionDraft>(() => draftFromComposition(composition))
  const [selected, setSelected] = useState<Role>(() => initialSelectedRole(composition))
  const [hidden, setHidden] = useState<ReadonlySet<Role>>(new Set())
  const [advanced, setAdvanced] = useState(false)
  const [frameTime, setFrameTime] = useState(() =>
    Math.max(clip.edit.start, Math.min(clip.edit.end - .05, busTime)))
  const [videoAspect, setVideoAspect] = useState(source.width / Math.max(1, source.height))
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ mode: 'move' | ResizeHandle; role: Role; grab?: { x: number; y: number } } | null>(null)
  const issue = compositionDraftIssue(draft, composition)
  const built = draftComposition(draft, composition)

  const sourcePoint = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    return pointerToSource(
      { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) },
      { width: rect?.width ?? 1, height: rect?.height ?? 1 }
    )
  }

  const startDrag = (role: Role, mode: 'move' | ResizeHandle, event: React.PointerEvent): void => {
    event.stopPropagation()
    setSelected(role)
    const point = sourcePoint(event)
    dragRef.current = mode === 'move'
      ? { mode, role, grab: { x: point.x - draft[role].x, y: point.y - draft[role].y } }
      : { mode, role }
    stageRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    const point = sourcePoint(event)
    setDraft(current => ({ ...current, [drag.role]: drag.mode === 'move'
      ? dragRegion(current[drag.role], drag.grab!, point)
      : resizeRegion(current[drag.role], drag.mode, point) }))
  }

  const endDrag = (): void => { dragRef.current = null }

  // The mini preview redraws on every draft change and on every decoded frame
  // while scrubbing — same shared geometry the export uses.
  const redrawPreview = useCallback((): void => {
    const video = videoRef.current
    const canvas = previewRef.current
    if (video && canvas && built) drawCompositionFrame(canvas, video, built)
  }, [built])
  useEffect(() => { redrawPreview() }, [redrawPreview])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let handle: number
    const delivered = (): void => {
      redrawPreview()
      handle = video.requestVideoFrameCallback(delivered)
    }
    handle = video.requestVideoFrameCallback(delivered)
    return () => video.cancelVideoFrameCallback(handle)
  }, [redrawPreview])

  useEffect(() => {
    const video = videoRef.current
    if (video && Math.abs(video.currentTime - frameTime) > .01) video.currentTime = frameTime
  }, [frameTime])

  // Escape cancels (nothing is saved); arrows nudge the selected rectangle —
  // but never steal them from focused form fields and the scrub slider.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      const step = event.shiftKey ? .02 : .005
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
      }
      const delta = deltas[event.key]
      if (!delta) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      const role = hidden.has(selected) ? (selected === 'presenter' ? 'content' : 'presenter') : selected
      setDraft(current => ({ ...current, [role]: nudgeRegion(current[role], delta[0], delta[1]) }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, selected, hidden])

  const commit = (role: Role, patch: Partial<ContentRegion>): void => {
    setDraft(current => ({ ...current, [role]: { ...current[role], ...patch } }))
  }

  const apply = (): void => {
    if (!built) return
    onSave(built)
    onClose()
  }

  const toggleHidden = (role: Role): void => {
    setHidden(current => {
      const next = new Set(current)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })
  }

  const visibleRoles: Role[] = (['content', 'presenter'] as const)
    .filter(role => role === 'content' || hasPresenter)
    .filter(role => !hidden.has(role))

  return <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label="Edit source regions"
      className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-surface-700 bg-surface-900 p-4 text-zinc-200 shadow-2xl"
      onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Edit source regions — {gaming ? 'Gaming' : label('presenter') + ' + ' + label('content')}</h2>
        <button type="button" aria-label="Close without saving" onClick={onClose}
          className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-surface-800 hover:text-zinc-200">
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          <div ref={stageRef}
            className="relative mx-auto w-full select-none touch-none overflow-hidden rounded-xl border border-surface-700 bg-black"
            style={{ aspectRatio: String(videoAspect), maxWidth: `min(100%, calc(56vh * ${videoAspect}))` }}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}>
            <video
              ref={videoRef}
              src={window.cutawan.mediaUrl(source.path)}
              className="pointer-events-none absolute inset-0 h-full w-full"
              preload="auto"
              onLoadedMetadata={event => {
                const video = event.currentTarget
                if (video.videoWidth > 0) setVideoAspect(video.videoWidth / video.videoHeight)
                video.currentTime = frameTime
              }}
            />
            {visibleRoles.map(role => {
              const region = draft[role]
              const isSelected = selected === role
              return <div key={role}
                onPointerDown={event => startDrag(role, 'move', event)}
                className={`absolute cursor-move rounded-sm transition-[background-color] ${isSelected ? '' : 'opacity-80'} ${role === 'presenter' ? 'z-10' : ''}`}
                style={{
                  left: `${region.x * 100}%`, top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`, height: `${region.height * 100}%`,
                  border: `2px ${isSelected ? 'solid' : 'dashed'} ${RECT_COLORS[role]}`,
                  backgroundColor: `${RECT_COLORS[role]}${isSelected ? '26' : '12'}`
                }}>
                <span className="pointer-events-none absolute left-1 top-1 whitespace-nowrap rounded px-1 text-[10px] font-medium"
                  style={{ color: RECT_COLORS[role], backgroundColor: 'rgba(0,0,0,.55)' }}>
                  {label(role)}
                </span>
                {isSelected && RESIZE_HANDLES.map(handle => <span key={handle}
                  onPointerDown={event => startDrag(role, handle, event)}
                  className="absolute h-2.5 w-2.5 rounded-sm border border-black/60"
                  style={{ ...HANDLE_POSITIONS[handle], backgroundColor: RECT_COLORS[role] }} />)}
              </div>
            })}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input type="range" min={clip.edit.start} max={clip.edit.end} step={.05} value={frameTime}
              aria-label="Preview a different moment of the clip"
              onChange={event => setFrameTime(Number(event.target.value))}
              className="min-w-0 flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-zinc-500">{formatTimecode(frameTime)}</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Drag the rectangles to move them, drag their handles to resize, use the arrow keys to nudge
            {gaming ? ' — they may overlap; hide one to edit the other comfortably.' : '.'}
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3 lg:w-72">
          <canvas ref={previewRef} aria-label="Live 9:16 preview"
            className="aspect-[9/16] w-full rounded-xl border border-surface-700 bg-black" />
          <div className="grid grid-cols-2 gap-1.5">
            {((['presenter', 'content'] as const).filter(role => role === 'content' || hasPresenter)).map(role => (
              <div key={role} className="flex items-stretch gap-1">
                <button type="button" aria-pressed={selected === role} onClick={() => setSelected(role)}
                  className={`min-w-0 flex-1 truncate rounded-lg border px-2 py-1.5 text-xs transition ${selected === role ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
                  {label(role)}
                </button>
                <button type="button" aria-label={`${hidden.has(role) ? 'Show' : 'Hide'} ${label(role)}`}
                  aria-pressed={hidden.has(role)} onClick={() => toggleHidden(role)}
                  className="rounded-lg border border-surface-600 px-2 text-zinc-400 transition hover:bg-surface-800">
                  {hidden.has(role) ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            ))}
          </div>
          <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}
            className="rounded-lg border border-surface-700">
            <summary className="cursor-pointer px-2 py-1.5 text-xs text-zinc-400">
              Advanced: percentage fields
            </summary>
            <div className="space-y-2 p-2">
              {(['presenter', 'content'] as const).filter(role => role === 'content' || hasPresenter).map(role => (
                <fieldset key={role}>
                  <legend className="mb-1 text-[11px]" style={{ color: RECT_COLORS[role] }}>{label(role)} (% of source)</legend>
                  <div className="grid grid-cols-4 gap-1">
                    {(['x', 'y', 'width', 'height'] as const).map(field => (
                      <PercentField key={field} label={field} value={draft[role][field]}
                        onCommit={v => commit(role, { [field]: v })} />
                    ))}
                  </div>
                  {gaming && <div className="mt-1 grid grid-cols-2 gap-1">
                    {(['x', 'y'] as const).map(field => (
                      <PercentField key={field} label={`focus ${field}`}
                        value={draft[role === 'presenter' ? 'presenterFocus' : 'contentFocus']?.[field] ?? .5}
                        onCommit={v => setDraft(current => ({
                          ...current,
                          [role === 'presenter' ? 'presenterFocus' : 'contentFocus']: {
                            x: role === 'presenter' ? current.presenterFocus?.x ?? .5 : current.contentFocus?.x ?? .5,
                            y: role === 'presenter' ? current.presenterFocus?.y ?? .5 : current.contentFocus?.y ?? .5,
                            [field]: v
                          }
                        }))} />
                    ))}
                  </div>}
                </fieldset>
              ))}
              <p className="text-[10px] leading-relaxed text-zinc-500">
                Each side is at least 2% of the source; regions stay inside the frame.
              </p>
            </div>
          </details>
          {issue && <p role="alert" className="text-[11px] leading-relaxed text-amber-300">{issue}</p>}
          <div className="mt-auto grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => setDraft(draftFromComposition(composition))}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-surface-600 px-2 py-2 text-xs text-zinc-300 transition hover:bg-surface-800">
              <RotateCcw size={13} /> Reset
            </button>
            <button type="button" onClick={onClose}
              className="rounded-lg border border-surface-600 px-2 py-2 text-xs text-zinc-300 transition hover:bg-surface-800">
              Cancel
            </button>
            <button type="button" onClick={apply} disabled={!built}
              className="col-span-2 rounded-lg bg-white px-2 py-2 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:opacity-40">
              Apply regions
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
}

/** Percentage input that stays typable: local text, committed when parseable. */
function PercentField({
  label, value, onCommit
}: { label: string; value: number; onCommit: (value: number) => void }): React.JSX.Element {
  const shown = (v: number): string => String(Math.round(v * 1000) / 10)
  const [text, setText] = useState(shown(value))
  const [seen, setSeen] = useState(value)
  const [focused, setFocused] = useState(false)
  // Drag updates arrive as new props; follow them while the user is not typing
  // (state adjusted during render, never through an effect).
  if (seen !== value) {
    setSeen(value)
    if (!focused) setText(shown(value))
  }
  return <label className="text-[10px] text-zinc-500">
    {label}
    <input type="number" min={0} max={100} step={.1} value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        setText(String(Math.round(value * 1000) / 10))
      }}
      onChange={event => {
        setText(event.target.value)
        const parsed = Number(event.target.value)
        if (Number.isFinite(parsed)) onCommit(parsed / 100)
      }}
      className="mt-1 w-full rounded border border-surface-600 bg-surface-850 p-1 text-xs text-zinc-200" />
  </label>
}
