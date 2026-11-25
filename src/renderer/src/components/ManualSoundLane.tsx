import { useRef, useState } from 'react'
import type { LibrarySound, SoundPlacement } from '@shared/manualSound'
import { usePreviewBus } from '../lib/previewBus'

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

function SecondsField({ label, value, min, max, change }: {
  label: string; value: number; min: number; max: number; change: (value: number) => void
}) {
  return <label className="grid gap-1">{label}
    <input key={value} className="w-20 rounded bg-surface-800 p-1" type="number" step="0.001" min={min} max={max}
      defaultValue={value} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onBlur={e => {
        const input = e.currentTarget
        const next = Number.isFinite(input.valueAsNumber) ? clamp(input.valueAsNumber, min, max) : value
        input.value = String(next)
        if (next !== value) change(next)
      }} />
  </label>
}

export default function ManualSoundLane({ library, placements, onImport, save, error }: {
  library: LibrarySound[]; placements: SoundPlacement[]; onImport: () => Promise<void>
  save: (placements: SoundPlacement[]) => void; error: string
}) {
  const time = usePreviewBus(s => s.outputTime)
  const duration = usePreviewBus(s => s.outputDuration)
  const [assetId, setAssetId] = useState('')
  const [selectedId, select] = useState('')
  const [busy, setBusy] = useState(false)
  const [auditionError, setAuditionError] = useState(false)
  const [drag, setDrag] = useState<{ id: string; start: number } | null>(null)
  const pointer = useRef<{ x: number; start: number; width: number } | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const sound = library.find(a => a.id === assetId) ?? library[0]
  const selected = placements.find(p => p.id === selectedId)
  const selectedAsset = library.find(a => a.id === selected?.assetId)
  const update = (id: string, patch: Partial<SoundPlacement>) => save(placements.map(p => p.id === id ? { ...p, ...patch } : p))
  const add = (placement: SoundPlacement) => { save([...placements, placement]); select(placement.id) }
  const button = 'rounded border border-surface-600 px-2 py-1 disabled:opacity-40'
  const position = (x: number) => {
    const origin = pointer.current!
    return Math.round(clamp(origin.start + (x - origin.x) / origin.width * duration, 0, duration) * 1000) / 1000
  }
  return <section className="my-3 grid gap-2 rounded border border-surface-600 p-2 text-xs" aria-label="Sound effects">
    <h3 className="font-semibold">Sound effects</h3>
    <div className="flex flex-wrap items-center gap-2">
      <button className={button} disabled={busy} onClick={async () => {
        setBusy(true)
        try { await onImport() } finally { setBusy(false) }
      }}>{busy ? 'Importing…' : 'Import sound effect (.mp3)'}</button>
      {sound && <>
        <select className="rounded border border-surface-600 bg-zinc-900 px-2 py-1 text-zinc-100 scheme-dark"
          aria-label="Sound library" value={sound.id} onChange={e => { setAssetId(e.target.value); setAuditionError(false) }}>
          {library.map(a => <option className="bg-zinc-900 text-zinc-100" key={a.id} value={a.id}>{a.name} · {a.duration.toFixed(2)} s{a.path ? '' : ' (missing)'}</option>)}
        </select>
        {sound.path && <audio key={sound.id} controls preload="metadata" aria-label="Audition sound effect"
          className="h-8 max-w-full" src={window.cutawan.mediaUrl(sound.path)} onError={() => setAuditionError(true)} />}
        <button className={button} disabled={!sound.path || !duration} onClick={() => add({
          id: crypto.randomUUID(), assetId: sound.id, startOutputSec: time, trimStartSec: 0, trimEndSec: sound.duration, gainDb: 0, enabled: true
        })}>Add at playhead</button>
      </>}
    </div>
    {(error || auditionError) && <p role="alert">{error || 'Cannot play this MP3. Import a working copy.'}</p>}
    <div className="flex justify-between"><span>Output · {time.toFixed(2)} s</span><span>{duration.toFixed(2)} s</span></div>
    <input type="range" aria-label="Sound effects output playhead" min={0} max={duration} step="0.001" value={time}
      onChange={e => usePreviewBus.getState().seekOutput?.(e.currentTarget.valueAsNumber)} />
    <div ref={track} className="relative min-h-7 overflow-hidden rounded bg-surface-800">
      <div className="pointer-events-none absolute inset-y-0 z-10 border-l border-white" style={{ left: (duration ? time / duration * 100 : 0) + '%' }} />
      {placements.map(p => {
        const a = library.find(item => item.id === p.assetId)
        const start = drag?.id === p.id ? drag.start : p.startOutputSec
        const pct = duration ? Math.min(100, start / duration * 100) : 0
        return <div key={p.id} className="relative h-6"><button type="button"
          className={'absolute h-6 touch-none truncate rounded px-1 text-left ' + (p.id === selectedId ? 'bg-blue-600' : 'bg-surface-600')}
          style={{ left: 'min(' + pct + '%, calc(100% - 8px))', minWidth: 8, width: Math.min(100 - pct, (p.trimEndSec - p.trimStartSec) / (duration || 1) * 100) + '%' }}
          title={(a?.name ?? 'Missing effect') + ' at ' + start.toFixed(3) + ' s'}
          onClick={() => select(p.id)} onPointerDown={e => {
            select(p.id)
            e.currentTarget.setPointerCapture(e.pointerId)
            pointer.current = { x: e.clientX, start: p.startOutputSec, width: track.current!.clientWidth || 1 }
          }} onPointerMove={e => { if (pointer.current && e.currentTarget.hasPointerCapture(e.pointerId)) setDrag({ id: p.id, start: position(e.clientX) }) }}
          onPointerCancel={() => { pointer.current = null; setDrag(null) }}
          onPointerUp={e => {
            if (pointer.current && e.clientX !== pointer.current.x) update(p.id, { startOutputSec: position(e.clientX) })
            pointer.current = null
            setDrag(null)
          }}>{p.enabled ? '' : 'Muted · '}{a?.name ?? 'Missing effect'}</button></div>
      })}
    </div>
    {selected && <div className="grid gap-2" key={selected.id}>
      <p>{selectedAsset?.name ?? 'Unknown sound'} · {selected.startOutputSec.toFixed(3)} s
        {!selectedAsset?.path && ' · Missing MP3. Reimport and replace this placement or mute it.'}
        {selected.startOutputSec >= duration && ' · Outside the current output'}</p>
      <div className="flex flex-wrap gap-2">
        <SecondsField label="Output start (s)" value={selected.startOutputSec} min={0} max={duration} change={startOutputSec => update(selected.id, { startOutputSec })} />
        <SecondsField label="Trim in (s)" value={selected.trimStartSec} min={0} max={selected.trimEndSec - 0.001} change={trimStartSec => update(selected.id, { trimStartSec })} />
        <SecondsField label="Trim out (s)" value={selected.trimEndSec} min={selected.trimStartSec + 0.001} max={selectedAsset?.duration ?? selected.trimEndSec} change={trimEndSec => update(selected.id, { trimEndSec })} />
        <SecondsField label="Volume (dB)" value={selected.gainDb} min={-60} max={0} change={gainDb => update(selected.id, { gainDb })} />
      </div>
      <div className="flex gap-2">
        <button className={button} onClick={() => update(selected.id, { enabled: !selected.enabled })}>{selected.enabled ? 'Mute' : 'Unmute'}</button>
        <button className={button} onClick={() => add({ ...selected, id: crypto.randomUUID() })}>Duplicate</button>
        <button className={button} onClick={() => save(placements.filter(p => p.id !== selected.id))}>Delete placement</button>
      </div>
    </div>}
    {!!placements.length && <p>Effects keep their output timestamps and stop at the end of the Short. MP4 includes this lane. NLE timeline exports omit it.</p>}
  </section>
}
