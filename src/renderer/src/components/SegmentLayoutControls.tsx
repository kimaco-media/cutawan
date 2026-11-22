import { useState } from 'react'
import type { Clip, Composition, GamingProfile, ReframeMode, SegmentLayout, VideoInfo } from '@shared/types'
import { gamingComposition, GAMING_SPLITS, gamingSplit, presenterComposition, rebuildGaming } from '@shared/composition'
import RegionEditor from './RegionEditor'
import { useStore } from '../store'

const face = { x: .7, y: .03, width: .27, height: .30 }
const game = { x: .01, y: .01, width: .98, height: .98 }
const content = { x: .05, y: .35, width: .9, height: .6 }
const modes = { crop: 'Fill (crop) · Manual', 'fit-blur': 'Fit · Blur', 'fit-letterbox': 'Fit · Letterbox' }
const presets = ['gaming', 'content-first', 'stacked', 'content-only'] as const

export default function SegmentLayoutControls({ clip, piece, source, position, onChange }: {
  clip: Clip
  piece: NonNullable<Clip['edit']['sequence']>[number]
  source: VideoInfo
  position: number
  onChange: (layout?: SegmentLayout) => void
}): React.JSX.Element {
  const profiles = useStore(s => s.settings?.gamingProfiles) ?? []
  const saveSettings = useStore(s => s.saveSettings)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState('')
  const profile = profiles.find(p => p.name === picked)
  const [warning, setWarning] = useState('')
  const layout = piece.layout
  const composition = layout?.composition
  const unique = name.trim() && !profiles.some(p => p.name.toLowerCase() === name.trim().toLowerCase())
  const save = (next: GamingProfile[]) => void saveSettings({ gamingProfiles: next })
  const setComposition = (c: Composition, profileName?: string) => onChange({ mode: 'crop', focusX: .5, composition: c, profileName })
  const changePreset = (value: string) => {
    if (!value) return onChange()
    if (value in modes) return onChange({ mode: value as ReframeMode, focusX: layout?.focusX ?? clip.edit.focusX })
    const c = value === 'gaming' ? gamingComposition(face, game) :
      presenterComposition(content, face, value as 'stacked' | 'content-first' | 'content-only')
    if (c) setComposition(c)
  }
  return <fieldset className="space-y-2 rounded border border-blue-400 p-3 text-xs">
    <legend>Layout for selected segment</legend>
    <p>{piece.id} · Source {piece.start.toFixed(2)}–{piece.end.toFixed(2)} s · Output {position.toFixed(2)} s</p>
    <select aria-label="Segment layout" className="bg-surface-800" disabled={clip.edit.autoZoom}
      value={composition?.preset ?? layout?.mode ?? ''} onChange={e => changePreset(e.target.value)}>
      <option value="">Use clip default</option>
      {Object.entries(modes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      {presets.map(p => <option key={p} disabled={clip.edit.aspect !== '9:16'}>{p}</option>)}
    </select>
    {clip.edit.autoZoom && <p>Turn off Auto zoom to customize an output segment.</p>}
    {layout?.mode === 'crop' && !composition && <label>Horizontal focus
      <input type="range" min="0" max="1" step=".01" value={layout.focusX}
        onChange={e => onChange({ ...layout, focusX: Number(e.target.value) })} /></label>}
    {composition && <button onClick={() => setEditing(true)}>Edit source crops and focus</button>}
    {editing && composition && <RegionEditor clip={{ ...clip, edit: { ...clip.edit, start: piece.start, end: piece.end } }}
      source={source} composition={composition} onSave={c => setComposition(c)} onClose={() => setEditing(false)} />}
    {composition?.preset === 'gaming' && <label> Facecam split <select className="bg-surface-800" value={gamingSplit(composition)}
      onChange={e => {
        const f = composition.layers.find(l => l.role === 'presenter')!
        const g = composition.layers.find(l => l.role === 'content')!
        const c = rebuildGaming(f.source, g.source, { split: Number(e.target.value), presenterFocus: f.focus, contentFocus: g.focus })
        if (c) setComposition(c)
      }}>{GAMING_SPLITS.map(s => <option key={s} value={s}>{Math.round(s * 100)}/{Math.round((1-s)*100)}</option>)}</select></label>}
    <details><summary>Gaming profiles</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Saved Gaming profile" className="bg-surface-800" value={picked}
          onChange={e => setPicked(e.target.value)}><option value="">Select profile</option>
          {profiles.map(p => <option key={p.name}>{p.name}</option>)}</select>
        <button disabled={!profile || clip.edit.autoZoom || clip.edit.aspect !== '9:16'} onClick={() => {
          if (!profile) return
          setComposition(structuredClone(profile.composition), profile.name)
          setWarning(profile.sourcePath === source.path ? '' : 'Saved on a different video. Check facecam placement in the crop editor.')
        }}>Apply to segment</button>
        <input aria-label="Unique profile name" placeholder="Unique profile name" value={name} onChange={e => setName(e.target.value)} />
        <button disabled={!unique || composition?.preset !== 'gaming'} onClick={() => {
          if (composition) { save([...profiles, { name: name.trim(), sourcePath: source.path, composition }]); setPicked(name.trim()) }
        }}>Save current Gaming layout as profile</button>
        <button disabled={!profile || !unique} onClick={() => { save(profiles.map(p => p === profile ? { ...p, name: name.trim() } : p)); setPicked(name.trim()) }}>Rename</button>
        <button disabled={!profile || !unique} onClick={() => { if (profile) { save([...profiles, { ...profile, name: name.trim() }]); setPicked(name.trim()) } }}>Duplicate</button>
        <button disabled={!profile || composition?.preset !== 'gaming'} onClick={() => {
          if (composition) save(profiles.map(p => p === profile ? { ...p, composition, sourcePath: source.path } : p))
        }}>Update profile from segment</button>
        <button disabled={!profile} onClick={() => { save(profiles.filter(p => p !== profile)); setPicked('') }}>Delete profile</button>
      </div>
    </details>
    {warning && <p role="status">{warning}</p>}
  </fieldset>
}
