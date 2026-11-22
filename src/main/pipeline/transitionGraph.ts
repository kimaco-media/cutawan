import { isOverlap, type OutputJoin } from '@shared/transitions'

/** Blend the fully composed frames and crossfade the same audio intervals.
 * Point effects were already applied in base-output time. xfade removes the
 * exact same overlap that playbackTimeMap removes from preview/seek time.
 */
export function overlapGraph(joins: OutputJoin[], duration: number, fps: number, video: string, audio: string | null): {
  filters: string[]; video: string; audio: string | null
} {
  const active = joins.filter(j => isOverlap(j.kind) && j.overlap > 0)
  if (!active.length) return { filters: [], video, audio }
  const rate = Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30
  const bounds = [0, ...active.map(j => j.baseTime), duration]
  const count = bounds.length - 1
  const filters = [`[${video}]split=${count}${Array.from({ length: count }, (_, i) => `[transitionInput${i}]`).join('')}`]
  if (audio) filters.push(`[${audio}]asetpts=PTS-STARTPTS,asplit=${count}${Array.from({ length: count }, (_, i) => `[transitionAudio${i}]`).join('')}`)
  // Padding one frame before the FPS conversion preserves the last frame's
  // display interval for decoded files whose EOF timestamp equals its PTS.
  // A second pad covers concat streams with unknown input frame rate. The
  // duration trim limits both pads to the requested final-frame interval.
  for (let i = 0; i < count; i++) {
    filters.push(`[transitionInput${i}]trim=start=${bounds[i]}:end=${bounds[i + 1]},tpad=stop_mode=clone:stop=1,setpts=PTS-STARTPTS,fps=${rate},tpad=stop_mode=clone:stop=1,trim=duration=${bounds[i + 1] - bounds[i]},settb=AVTB,format=yuv420p[transitionVideo${i}]`)
    if (audio) filters.push(`[transitionAudio${i}]atrim=start=${bounds[i]}:end=${bounds[i + 1]},asetpts=PTS-STARTPTS[transitionSound${i}]`)
  }
  let v = 'transitionVideo0', a = audio ? 'transitionSound0' : null, removed = 0
  active.forEach((join, i) => {
    const nextV = `transitionBlend${i}`, nextA = `transitionMix${i}`
    const style = join.kind === 'whip-pan' ? 'smoothleft' : join.kind === 'dissolve' ? 'fade' : join.kind === 'slide-left' ? 'slideleft' : 'slideright'
    filters.push(`[${v}][transitionVideo${i + 1}]xfade=transition=${style}:duration=${join.overlap}:offset=${join.baseTime - removed - join.overlap}[${nextV}]`)
    if (a) filters.push(`[${a}][transitionSound${i + 1}]acrossfade=d=${join.overlap}:c1=tri:c2=tri[${nextA}]`)
    v = nextV
    if (join.kind === 'whip-pan') {
      const begin = join.baseTime - removed - join.overlap
      // Only the fast central portion is smeared; static edges remain sharp.
      filters.push(`[${v}]gblur=sigma=12:sigmaV=0:enable='between(t,${begin + join.overlap * 0.15},${begin + join.overlap * 0.85})'[transitionWhip${i}]`)
      v = `transitionWhip${i}`
    }
    if (a) a = nextA
    removed += join.overlap
  })
  return { filters, video: v, audio: a }
}
