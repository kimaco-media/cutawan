import { useEffect, useMemo, useState } from 'react'
import { Redo2, Scissors, SplitSquareHorizontal, Trash2, Undo2 } from 'lucide-react'
import type { Clip, TimelineData, TimeRange } from '@shared/types'
import { autoRemovedRanges, editedClipDuration, normalizeRanges, clipKeptSegments, TimeMap } from '@shared/tighten'
import { cutRange, orderedPieces, movePiece, keepsPlayback, pieceAt, setTrimEdge, splitAt, timelinePieces, toggleRestored, uncutAt } from '@shared/editOps'
import { outputJoins } from '@shared/transitions'
import { historyState } from '@shared/editHistory'
import { usePreviewBus } from '../lib/previewBus'
import { useStore } from '../store'
import TrimBar, { type TimelineMark } from './TrimBar'

/** Keyboard shortcuts must not fire while the user is typing. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
}

const SHORTCUTS = 'Space/K play · J/L ±1 s · ←/→ frame · I/O in/out · S split · Delete cut piece · ⌘Z undo'

/**
 * Timeline editing on top of the trim bar: razor splits, ripple-deleting a
 * piece, restoring automatically removed pauses, undo/redo and
 * Premiere-style shortcuts. Every change goes through the shared edit ops
 * and `clipKeptSegments`, so preview and export stay identical.
 */
export default function TimelineEditor({ clip, windowStart, windowEnd, fps, timeline, onSave, onLocal }: {
  clip: Clip
  windowStart: number
  windowEnd: number
  fps: number
  timeline: TimelineData | null
  onSave: (edit: Clip['edit']) => void
  onLocal: (edit: Clip['edit']) => void
}): React.JSX.Element {
  const transcript = useStore((s) => s.project?.transcript ?? null)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  useStore((s) => s.historyVersion) // re-render undo/redo availability
  const { canUndo, canRedo } = historyState(clip.id)
  const [selected, setSelected] = useState<TimeRange | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [insertion, setInsertion] = useState<string | null>(null)
  const time = usePreviewBus(s => s.time)
  const edit = clip.edit
  const map = new TimeMap(clipKeptSegments(clip, transcript) ?? [{ start: edit.start, end: edit.end }])
  const ordered = orderedPieces(edit).filter(p => map.segments.some(r => r.start < p.end && r.end > p.start))
  const joins = outputJoins(clip, transcript)
  const setTransition = (fromId: string, toId: string, duration: number): void => {
    const transitions = (edit.transitions ?? []).filter(t => t.fromId !== fromId || t.toId !== toId)
    if (duration > 0) transitions.push({ fromId, toId, kind: 'fade-black', duration })
    onSave({ ...edit, transitions })
  }
  const move = (id: string, before: string | null): void => {
    if (!edit.autoZoom) onSave(movePiece(edit, id, before))
    setDragged(null)
    setInsertion(null)
  }

  const marks = useMemo<TimelineMark[]>(() => {
    const restored = normalizeRanges(edit.restored, edit.start, edit.end)
    const auto = autoRemovedRanges(clip, transcript)
      .filter((r) => !restored.some((k) => k.start < r.end && k.end > r.start))
    return [
      ...auto.map((range) => ({ range, kind: 'auto' as const })),
      ...(edit.tightenCuts ? restored.map((range) => ({ range, kind: 'restored' as const })) : []),
      ...normalizeRanges(edit.cuts, edit.start, edit.end).map((range) => ({ range, kind: 'cut' as const }))
    ]
  }, [clip, transcript, edit.restored, edit.cuts, edit.start, edit.end, edit.tightenCuts])

  const pieces = timelinePieces(edit)
  // A selection only means something once the timeline has been split, and
  // only while it is still exactly one of the current pieces (a split, trim
  // or undo since the click would otherwise leave a stale range to cut).
  const selection = selected && pieces.length > 1 &&
    pieces.some((p) => Math.abs(p.start - selected.start) < 1e-6 && Math.abs(p.end - selected.end) < 1e-6)
    ? selected : null

  const cutSelected = (): void => {
    if (!selection) return
    const next = cutRange(edit, selection)
    // Never cut away everything that plays.
    if (keepsPlayback({ ...clip, edit: next }, transcript)) onSave(next)
    setSelected(null)
  }
  // Trims and re-removed pauses go through the same guard as cuts: they could
  // otherwise leave nothing to play.
  const saveTrim = (next: Clip['edit']): void => {
    if (keepsPlayback({ ...clip, edit: next }, transcript)) onSave(next)
  }
  const split = (): void => {
    const next = splitAt(edit, usePreviewBus.getState().time)
    if (next !== edit) onSave(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target) || e.altKey || e.defaultPrevented) return
      const bus = usePreviewBus.getState()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      // Holding a key auto-repeats it: stepping should continue, but play,
      // split, cut, in/out and undo must fire once per press.
      if (e.repeat && !['j', 'l', 'arrowleft', 'arrowright'].includes(key)) {
        if ([' ', 'k', 's', 'i', 'o', 'delete', 'backspace', 'z', 'y'].includes(key)) e.preventDefault()
        return
      }
      const step = (dt: number): void => bus.seek(map.toSource(Math.max(0, Math.min(map.outputDuration, map.toOutput(bus.time) + dt))))
      let handled = true
      if (mod && key === 'z') void (e.shiftKey ? redo(clip.id) : undo(clip.id))
      else if (mod && key === 'y') void redo(clip.id)
      else if (mod && key === 'k') split()
      else if (mod) handled = false
      else if (key === ' ' && (e.target as HTMLElement)?.tagName === 'BUTTON') handled = false
      else if (key === ' ' || key === 'k') bus.togglePlay()
      else if (key === 'j') step(-1)
      else if (key === 'l') step(1)
      else if (key === 'arrowleft') step(e.shiftKey ? -1 : -1 / fps)
      else if (key === 'arrowright') step(e.shiftKey ? 1 : 1 / fps)
      else if (key === 'i') saveTrim(setTrimEdge(edit, 'start', Math.max(windowStart, bus.time)))
      else if (key === 'o') saveTrim(setTrimEdge(edit, 'end', Math.min(windowEnd, bus.time)))
      else if (key === 's') split()
      else if (key === 'delete' || key === 'backspace') cutSelected()
      else if (key === 'escape') setSelected(null)
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const button = 'flex items-center gap-1 rounded-md border border-surface-600 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-surface-800 disabled:opacity-40'
  return (
    <div>
      <p className="mb-1 text-xs text-zinc-400">Source trim · I/O changes source in/out points</p>
      <TrimBar
        windowStart={windowStart}
        windowEnd={windowEnd}
        start={edit.start}
        end={edit.end}
        timeline={timeline}
        onChange={(start, end) => onLocal({ ...edit, start, end })}
        onCommit={() => {
          // Read the live clip: the drag closure was created at drag start,
          // so `edit` here is the pre-drag trim to snap back to if refused.
          const current = useStore.getState().project?.clips.find((c) => c.id === clip.id)
          if (!current) return
          if (keepsPlayback(current, transcript)) onSave(current.edit)
          else onLocal(edit)
        }}
        marks={marks}
        splits={edit.splits}
        selected={selection}
        onPieceClick={(t) => setSelected(pieceAt(edit, t) ?? null)}
        playsFor={editedClipDuration(clip, transcript)}
        onMarkClick={(mark) => {
          if (mark.kind === 'cut') onSave(uncutAt(edit, (mark.range.start + mark.range.end) / 2))
          else saveTrim(toggleRestored(edit, mark.range))
        }}
      />
      <section aria-label="Output sequence" className="mt-3 rounded border border-surface-600 p-2">
        <p className="text-xs text-zinc-300">Output sequence · {map.toOutput(time).toFixed(2)} / {map.outputDuration.toFixed(2)} s</p>
        <input aria-label="Output playhead" type="range" min={0} max={map.outputDuration} step={1 / fps}
          value={Math.min(map.outputDuration, map.toOutput(time))} className="w-full"
          onChange={e => usePreviewBus.getState().seek(map.toSource(Number(e.target.value)))} />
        {edit.autoZoom && <p className="text-xs text-amber-300">Reordering requires Auto zoom to be off: zoom curves cannot yet cross reordered joins.
          <button className={button} onClick={() => onSave({ ...edit, autoZoom: false })}>Turn off Auto zoom</button></p>}
        <div className="flex gap-2 overflow-x-auto py-2" onDragOver={e => e.preventDefault()}>
          {ordered.map((p, i) => {
            const spans = map.segments.filter(r => r.start < p.end && r.end > p.start)
            const frame = timeline?.frames[Math.max(0, Math.min(timeline.frames.length - 1,
              Math.floor((p.start - windowStart) / (windowEnd - windowStart) * timeline.frames.length)))]
            const join = joins.find(j => j.fromId === p.id && j.toId === ordered[i + 1]?.id)
            const active = spans.some(r => time >= r.start && time < r.end)
            return <div key={p.id} className={`w-40 shrink-0 rounded border p-1 ${insertion === p.id ? 'border-l-4 border-amber-300' : active ? 'border-blue-400' : 'border-surface-600'}`}
              onDragOver={e => { e.preventDefault(); setInsertion(p.id) }}
              onDrop={e => { e.preventDefault(); if (dragged) move(dragged, p.id) }}>
              <button type="button" className="w-full text-left text-xs" draggable={!edit.autoZoom}
                aria-label={`Select segment ${i + 1}: source ${p.start.toFixed(2)} to ${p.end.toFixed(2)} seconds`}
                onDragStart={e => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; setDragged(p.id) }}
                onDragEnd={() => { setDragged(null); setInsertion(null) }}
                onClick={() => { setSelected({ start: Math.max(edit.start, p.start), end: Math.min(edit.end, p.end) }); usePreviewBus.getState().seek(spans[0].start) }}>
                {frame && <img src={window.cutawan.mediaUrl(frame)} className="h-16 w-full object-cover" draggable={false} />}
                {i + 1}. Source {p.start.toFixed(2)}–{p.end.toFixed(2)} s<br />
                {spans.reduce((sum, r) => sum + r.end - r.start, 0).toFixed(2)} s
              </button>
              <div className="mt-1 flex gap-1">
                <button className={button} disabled={i === 0 || edit.autoZoom} onClick={() => move(p.id, ordered[i - 1].id)} aria-label={`Move segment ${i + 1} left`}>←</button>
                <button className={button} disabled={i === ordered.length - 1 || edit.autoZoom} onClick={() => move(p.id, ordered[i + 2]?.id ?? null)} aria-label={`Move segment ${i + 1} right`}>→</button>
              </div>
              {join && <details className="mt-2 border-t border-surface-600 pt-1 text-xs">
                <summary className="cursor-pointer" aria-label={`Transition after segment ${i + 1}`}>
                  ◇ {join.duration ? 'Fade through black' : 'Cut'} →
                </summary>
                <label className="mt-2 block">Transition
                  <select className="mt-1 w-full bg-surface-800" value={join.duration ? 'fade-black' : 'cut'}
                    onChange={e => setTransition(join.fromId, join.toId, e.target.value === 'cut' ? 0 : Math.min(0.4, join.maxDuration))}>
                    <option value="cut">None / Cut</option>
                    <option value="fade-black" disabled={join.maxDuration < 0.1}>Fade through black</option>
                  </select>
                </label>
                {join.duration > 0 && <label className="mt-2 block">Duration (seconds)
                  <input aria-label={`Transition duration after segment ${i + 1}`} type="number" min={0.1} max={join.maxDuration}
                    step="any" value={Number(join.duration.toFixed(3))} className="w-full bg-surface-800"
                    onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) setTransition(join.fromId, join.toId, Math.max(0.1, Math.min(join.maxDuration, value))) }} />
                </label>}
                <p className="mt-1 text-zinc-500">{join.maxDuration < 0.1 ? 'Pieces are too short for a fade.' : `Maximum ${join.maxDuration.toFixed(2)} s for these pieces.`}</p>
                <button type="button" className={button} onClick={() => usePreviewBus.getState().seek(map.toSource(Math.max(0, join.time - join.duration / 2)))}>Preview join</button>
                <button type="button" className={button} onClick={() => setTransition(join.fromId, join.toId, 0)}>Reset to Cut</button>
              </details>}
            </div>
          })}
          <div className={`min-w-12 self-stretch border-l-2 text-xs ${insertion === 'end' ? 'border-amber-300' : 'border-transparent'}`}
            onDragOver={e => { e.preventDefault(); setInsertion('end') }}
            onDrop={e => { e.preventDefault(); if (dragged) move(dragged, null) }}>Drop last</div>
        </div>
        <p className="text-[10px] text-zinc-500">Drag a thumbnail before a segment, or use Move left/right. Select a piece, then S to split or Delete to remove. Arrow keys step through output.</p>
      </section>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={button} onClick={split} title="Split at playhead (S or ⌘K)">
          <SplitSquareHorizontal size={12} /> Split
        </button>
        <button type="button" className={button} onClick={cutSelected} disabled={!selection} title="Cut the selected piece (Delete)">
          <Trash2 size={12} /> Cut piece
        </button>
        <button type="button" className={button} disabled={!selection || time <= selection.start || time >= selection.end}
          onClick={() => { if (selection) saveTrim(cutRange(edit, { start: selection.start, end: time })) }}>Trim piece start to playhead</button>
        <button type="button" className={button} disabled={!selection || time <= selection.start || time >= selection.end}
          onClick={() => { if (selection) saveTrim(cutRange(edit, { start: time, end: selection.end })) }}>Trim piece end to playhead</button>
        <button type="button" className={button} onClick={() => void undo(clip.id)} disabled={!canUndo} title="Undo (⌘Z)">
          <Undo2 size={12} /> Undo
        </button>
        <button type="button" className={button} onClick={() => void redo(clip.id)} disabled={!canRedo} title="Redo (⇧⌘Z)">
          <Redo2 size={12} /> Redo
        </button>
        {(edit.cuts?.length ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Scissors size={11} /> {edit.cuts!.length} cut{edit.cuts!.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">{SHORTCUTS}</p>
    </div>
  )
}
