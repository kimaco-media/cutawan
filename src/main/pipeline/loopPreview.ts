import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractLoopEdges } from './loopEdges'
import { renderClip, type RenderJob } from './render'
import { MediaQueue, mediaJobs } from './mediaJobs'

type Inputs = Omit<RenderJob, 'outputPath' | 'signal'>
const active = new Map<string, { queue: MediaQueue; users: number }>()

export async function renderLoopPreview(job: Inputs, seconds: number, root: string, version: string, signal: AbortSignal, cachedPath?: string) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 5) throw new Error('Choose 1–5 seconds per side.')
  const { clip, fontsDirPath } = job
  const paths = [job.source.path, job.musicPath, job.branding?.enabled && job.branding.imagePath,
    ...clip.broll.filter(b => b.enabled).map(b => b.imagePath),
    ...(clip.dub?.enabled ? clip.dub.lines.map(line => line.audioPath) : []),
    ...(job.soundLibrary ?? []).map(s => s.path),
    ...(fontsDirPath ? (await readdir(fontsDirPath)).sort().map(name => join(fontsDirPath, name)) : [])]
  const assets = await Promise.all(paths.filter((p): p is string => Boolean(p)).map(async path => {
    const meta = await stat(path)
    return [path, meta.size, meta.mtimeMs]
  }))
  const key = createHash('sha256').update(JSON.stringify([2, version, job, assets])).digest('hex')
  const dir = join(root, key)
  const path = join(dir, seconds + '.mp4')
  const marker = path + '.json'
  if (cachedPath !== undefined) {
    if (cachedPath !== path || !existsSync(path) || !existsSync(marker)) {
      throw new Error('The render inputs or cache have changed. Render a new loop preview.')
    }
    return { path, seam: Number(await readFile(marker, 'utf8')), notice: undefined }
  }
  const entry = active.get(dir) ?? { queue: new MediaQueue(() => 1), users: 0 }
  entry.users++
  active.set(dir, entry)
  try {
    return await entry.queue.run(async () => {
      await mkdir(dir, { recursive: true })
      await utimes(dir, new Date(), new Date())
      const master = join(dir, 'export.mp4')
      const metadata = join(dir, 'export.json')
      if (!existsSync(master) || !existsSync(metadata)) {
        const rendered = await renderClip({ ...job, outputPath: master, signal })
        await writeFile(metadata, JSON.stringify({ notice: rendered.captionNotice }))
      }
      const { notice } = JSON.parse(await readFile(metadata, 'utf8')) as { notice?: string }
      if (existsSync(path) && existsSync(marker)) return { path, seam: Number(await readFile(marker, 'utf8')), notice }
      const temp = join(dir, randomUUID() + '.mp4')
      try {
        const seam = await mediaJobs.run(() => extractLoopEdges(master, temp, seconds, signal), signal)
        await writeFile(marker, String(seam))
        await rename(temp, path)
        return { path, seam, notice }
      } finally {
        await rm(temp, { force: true })
      }
    }, signal)
  } finally {
    if (--entry.users === 0) active.delete(dir)
    const entries = await readdir(root).catch(() => [])
    const dirs = await Promise.all(entries.filter(n => /^[a-f0-9]{64}$/.test(n)).map(async n => {
      const path = join(root, n)
      return { path, time: (await stat(path).catch(() => null))?.mtimeMs ?? 0 }
    }))
    await Promise.all(dirs.sort((a,b) => b.time - a.time).slice(4).filter(d => !active.has(d.path) && d.path !== dir)
      .map(d => rm(d.path, { recursive: true, force: true })))
  }
}
