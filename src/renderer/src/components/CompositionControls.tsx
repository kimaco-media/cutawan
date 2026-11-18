import { useState } from 'react'
import type { Clip, Composition, ContentRegion, VideoInfo } from '@shared/types'
import {
  compositionIssue,
  gamingComposition,
  gamingSplit,
  isPresenterComposition,
  presenterComposition,
  GAMING_SPLITS
} from '@shared/composition'
import { compositionHidesTitle, layoutReviewMessage, layoutShotAt, validLayoutShots } from '@shared/contentType'
import { usePreviewBus } from '../lib/previewBus'
import { useStore } from '../store'

const preferences = [
  ['auto', 'Automatic'], ['content-first', 'Content first'], ['stacked', 'Stacked'], ['content-only', 'Content only'], ['gaming', 'Gaming']
] as const
const startingRegions = presenterComposition({ x: .05, y: .35, width: .75, height: .6 },
  { x: .82, y: .02, width: .16, height: .28 })!
const startingGaming = gamingComposition({ x: .70, y: .03, width: .27, height: .30 },
  { x: .01, y: .01, width: .98, height: .98 })!

export default function CompositionControls({ clip, source }: { clip: Clip; source: VideoInfo }): React.JSX.Element | null {
  const [adding, setAdding] = useState<'presenter' | 'gaming' | null>(null)
  const shot = usePreviewBus(s => layoutShotAt(clip, s.time))
  const update = useStore(s => s.updateClip)
  const retry = useStore(s => s.ensureReframe)
  const busy = useStore(s => s.reframeBusy[clip.id])
  const error = useStore(s => s.reframeError[clip.id])
  const hasComposition = clip.visualLayout?.shots?.some(s => isPresenterComposition(s.composition))
  const hasSplits = clip.visualLayout?.shots?.some(s => s.composition?.preset === 'speakers')
  const splitsOn = clip.edit.speakerSplit !== false
  const issue = layoutReviewMessage(clip)
  const active = clip.edit.aspect === '9:16' && clip.edit.framing === 'auto' && clip.edit.reframeMode === 'crop'
  const composition = active ? shot?.composition : undefined
  const facecam = composition?.layers.find(l => l.role === 'presenter')
  const gameplay = composition?.layers.find(l => l.role === 'content')
  // The presenter presets need disjoint source regions; gaming deliberately
  // allows the facecam to sit inside the gameplay, so those switches wait
  // for adjusted regions instead of silently keeping the gaming layout.
  const presenterSwitch = composition?.preset === 'gaming'
    ? Boolean(facecam && gameplay && presenterComposition(gameplay.source, facecam.source))
    : true
  const gamingSwitch = !composition || Boolean(facecam && gameplay)
  const warning = composition?.preset === 'gaming' ? compositionIssue(composition, source) : undefined
  const saveRegions = (composition: Composition): void => {
    const layout = clip.visualLayout
    const existing = validLayoutShots(layout, clip.edit.start, clip.edit.end)
    const replacement = { start: shot?.start ?? clip.edit.start, end: shot?.end ?? clip.edit.end, mode: 'fit' as const,
      composition, review: { status: 'needs-review' as const, reason: 'Source regions adjusted manually; review this shot before exporting.' } }
    void update({ ...clip, edit: { ...clip.edit, layoutChosen: true, framing: 'auto', reframeMode: 'crop', autoZoom: false },
      visualLayout: { start: existing ? layout!.start : clip.edit.start, end: existing ? layout!.end : clip.edit.end,
        preserveContext: true, allowZoom: false, reason: 'Manually selected source regions.', revision: (layout?.revision ?? 0) + 1,
        shots: existing && shot ? layout!.shots!.map(s => s === shot ? replacement : s)
          : [{ ...replacement, start: clip.edit.start, end: clip.edit.end }] } })
    setAdding(null)
  }
  const changeSplit = (split: number): void => {
    if (!composition || !facecam || !gameplay) return
    const rebuilt = gamingComposition(facecam.source, gameplay.source, split)
    if (!rebuilt) return
    if (facecam.focus) rebuilt.layers[0].focus = facecam.focus
    if (gameplay.focus) rebuilt.layers[1].focus = gameplay.focus
    saveRegions(rebuilt)
  }
  return <div className="mt-3 space-y-2">
    {issue && <p className="text-xs text-amber-300">Review layout: {issue}</p>}
    {issue && !clip.edit.layoutChosen && !clip.visualLayout?.revision && <div className="space-y-1">
      <button type="button" disabled={busy} onClick={() => void retry(clip.id, true)}
        className="text-xs text-zinc-300 underline underline-offset-4 disabled:opacity-40">
        {busy ? 'Retrying layout…' : 'Retry automatic layout'}
      </button>
      <p className="text-[11px] text-zinc-500">Reviews this clip using your configured AI provider. Keeps the transcript and clip selection.</p>
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </div>}
    {hasSplits && clip.edit.aspect === '9:16' && <div className="space-y-1">
      <button type="button" aria-pressed={splitsOn}
        onClick={() => void update({ ...clip, edit: { ...clip.edit, speakerSplit: !splitsOn } })}
        className={`w-full rounded-lg border px-2 py-2 text-xs transition ${splitsOn ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
        Split screen during conversations: {splitsOn ? 'on' : 'off'}
      </button>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Stacks both people while they trade quick turns in the same shot. Off follows whoever is speaking.
      </p>
    </div>}
    {hasComposition && <>
      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Presenter and content layout">
        {preferences.map(([value, label]) => <button key={value} type="button"
          aria-pressed={active && (clip.edit.compositionPreference ?? 'auto') === value}
          disabled={clip.edit.aspect !== '9:16' || (value !== 'auto' && value !== 'gaming' && !presenterSwitch) || (value === 'gaming' && !gamingSwitch)}
          onClick={() => void update({ ...clip, edit: { ...clip.edit, layoutChosen: true, compositionPreference: value, framing: 'auto', reframeMode: 'crop', autoZoom: false } })}
          className={`rounded-lg border px-2 py-2 text-xs transition disabled:opacity-40 ${value === 'gaming' ? 'col-span-2' : ''} ${active && (clip.edit.compositionPreference ?? 'auto') === value ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
          {label}
        </button>)}
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        {clip.edit.aspect !== '9:16' ? 'Presenter layouts are available in 9:16. Other formats keep the full scene.' :
          'Separate crops from the original video. Automatic layouts are checked on sampled frames; review motion before exporting.'}
      </p>
      {composition?.preset === 'gaming' && <div className="space-y-1">
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Facecam and gameplay split">
          {GAMING_SPLITS.map(split => <button key={split} type="button"
            aria-pressed={Math.abs(gamingSplit(composition) - split) < 1e-6}
            onClick={() => changeSplit(split)}
            className={`rounded-lg border px-2 py-2 text-xs transition ${Math.abs(gamingSplit(composition) - split) < 1e-6 ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
            {Math.round(split * 100)}/{Math.round((1 - split) * 100)}
          </button>)}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Facecam strip on top, gameplay below — both fill their strips edge to edge; captions overlay the gameplay.
        </p>
        {warning && <p className="text-[11px] leading-relaxed text-amber-300">{warning}</p>}
      </div>}
      {compositionHidesTitle(clip) && clip.edit.showTitle && <p className="text-[11px] text-zinc-500">The hook title is hidden to keep the presenter clear.</p>}
      {active && isPresenterComposition(shot?.composition) && <RegionForm key={`${shot!.start}:${JSON.stringify(shot!.composition)}`}
        composition={shot!.composition!} onSave={saveRegions} />}
    </>}
    {clip.edit.aspect === '9:16' && !shot?.composition && <div className="space-y-1">
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button"
          onClick={() => setAdding(adding === 'presenter' ? null : 'presenter')}
          className={`rounded-lg border px-2 py-2 text-xs transition ${adding === 'presenter' ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
          {adding === 'presenter' ? 'Cancel presenter regions' : 'Set presenter + content regions'}
        </button>
        <button type="button"
          onClick={() => setAdding(adding === 'gaming' ? null : 'gaming')}
          className={`rounded-lg border px-2 py-2 text-xs transition ${adding === 'gaming' ? 'border-white/30 bg-white/[0.07] text-zinc-100' : 'border-surface-600 text-zinc-400 hover:bg-surface-800'}`}>
          {adding === 'gaming' ? 'Cancel gaming regions' : 'Set gaming regions'}
        </button>
      </div>
      {adding === 'presenter' && <>
        <p className="text-[11px] text-zinc-500">For a separate presenter inset and screen content. Adjust these starting regions to match your source; no AI analysis is needed.</p>
        <RegionForm composition={startingRegions} onSave={saveRegions} open />
      </>}
      {adding === 'gaming' && <>
        <p className="text-[11px] text-zinc-500">For a Let's Play: facecam strip on top of the gameplay, both filling the frame edge to edge. Adjust these starting regions to match your source; no AI analysis is needed.</p>
        <RegionForm composition={startingGaming} onSave={saveRegions} open />
      </>}
    </div>}
  </div>
}

function RegionForm({ composition, onSave, open }: { composition: Composition; onSave: (composition: Composition) => void; open?: boolean }): React.JSX.Element {
  const [error, setError] = useState('')
  const gaming = composition.preset === 'gaming'
  const preset = composition.preset === 'content-only' ? 'content-only' : composition.preset === 'stacked' ? 'stacked' : 'content-first'
  return <details open={open} className="text-xs text-zinc-400"><summary className="cursor-pointer py-1">Adjust source regions for this shot</summary>
    <form className="mt-2 space-y-3" onSubmit={event => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      const regions: Record<string, ContentRegion> = Object.fromEntries(composition.layers.map(layer => {
        const value = (field: string): number => Number(values.get(`${layer.role}-${field}`)) / 100
        return [layer.role, { x: value('x'), y: value('y'), width: value('width'), height: value('height') }]
      }))
      let updated: Composition | undefined
      if (gaming) {
        updated = gamingComposition(regions.presenter, regions.content)
        if (updated) for (const layer of updated.layers) {
          const value = (field: string): number => Number(values.get(`${layer.role}-focus-${field}`)) / 100
          layer.focus = { x: value('x'), y: value('y') }
        }
      } else {
        updated = regions.presenter && presenterComposition(regions.content, regions.presenter, preset)
      }
      if (!updated) { setError(gaming ? 'Keep both regions inside the source.' : 'Keep both regions inside the source and avoid overlapping the presenter with the content.'); return }
      setError('')
      onSave(updated)
    }}>
      {composition.layers.map(layer => <fieldset key={layer.role}>
        <legend className="mb-1">{gaming ? (layer.role === 'presenter' ? 'Facecam' : 'Gameplay') : <span className="capitalize">{layer.role}</span>} (% of source)</legend>
        <div className="grid grid-cols-4 gap-1">
          {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field} className="text-[10px]">
            {field}<input name={`${layer.role}-${field}`} type="number" required min={0} max={100} step={.1}
              defaultValue={Number((layer.source[field] * 100).toFixed(1))}
              className="mt-1 w-full rounded border border-surface-600 bg-surface-850 p-1 text-xs text-zinc-200" />
          </label>)}
        </div>
        {gaming && <div className="mt-1 grid grid-cols-2 gap-1">
          {(['x', 'y'] as const).map(field => <label key={field} className="text-[10px]">
            focus {field}<input name={`${layer.role}-focus-${field}`} type="number" required min={0} max={100} step={1}
              defaultValue={Math.round((layer.focus?.[field] ?? .5) * 100)}
              className="mt-1 w-full rounded border border-surface-600 bg-surface-850 p-1 text-xs text-zinc-200" />
          </label>)}
          <p className="col-span-2 text-[10px] leading-relaxed text-zinc-500">Which part of the region stays visible when the panel crops it.</p>
        </div>}
      </fieldset>)}
      {error && <p role="alert" className="text-amber-300">{error}</p>}
      <button type="submit" className="rounded border border-surface-600 px-3 py-1.5 text-zinc-200">Apply regions</button>
    </form>
  </details>
}
