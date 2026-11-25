import type { ManualCue } from '@shared/manualSound'

/** Add the output-timed lane after overlaps and voice ducking have finished. */
export function withManualSounds<G extends { filterComplex: string; extraInputs: string[]; audioLabel: string | null }>(
  graph: G, cues: ManualCue[], duration: number, sourceInputs: number
): G {
  if (!cues.length) return graph
  const extraInputs = [...graph.extraInputs]
  const first = sourceInputs + extraInputs.filter(arg => arg === '-i').length
  const paths = [...new Set(cues.map(c => c.path))]
  for (const path of paths) extraInputs.push('-f', 'mp3', '-i', path)
  const filters = [graph.filterComplex]
  const labels: string[] = []
  if (graph.audioLabel) labels.push('[' + graph.audioLabel + ']')
  cues.forEach((cue, i) => {
    const input = first + paths.indexOf(cue.path)
    const delay = Math.round(cue.start * 48000)
    filters.push(`[${input}:a:0]atrim=start=${cue.offset}:duration=${cue.duration},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo,volume=${cue.gainDb}dB,adelay=${delay}S:all=1[manual${i}]`)
    labels.push(`[manual${i}]`)
  })
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,apad=whole_dur=${duration},atrim=duration=${duration},` +
    'alimiter=limit=0.95:level=0:latency=1[manualMix]')
  return { ...graph, filterComplex: filters.join(';'), extraInputs, audioLabel: 'manualMix' }
}
