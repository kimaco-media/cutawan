import { createReadStream } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { FFPROBE_PATH, runBinary, runFfmpeg } from './pipeline/ffmpeg'
import type { LibrarySound, SoundAsset } from '@shared/manualSound'

export function soundDirectory(root: string, projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('Invalid project ID.')
  return join(root, projectId, 'sound-effects')
}

export async function readSoundLibrary(dir: string, assets: SoundAsset[] = [], verify?: Set<string>): Promise<LibrarySound[]> {
  return Promise.all(assets.map(async asset => {
    const path = join(dir, asset.id + '.mp3')
    let valid = /^[0-9a-f-]{36}$/.test(asset.id)
    if (valid) {
      const info = await stat(path).catch(() => null)
      valid = !!info?.isFile() && info.size <= 32 * 1024 * 1024
      if (valid && (!verify || verify.has(asset.id))) valid = await digest(path).then(hash => hash === asset.sha256, () => false)
    }
    return { ...asset, path: valid ? path : null }
  }))
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Validate the managed copy before publishing its ID in the project. */
export async function importSound(dir: string, picked: string, persist: (a: SoundAsset) => Promise<unknown>): Promise<void> {
  const info = await stat(picked)
  if (extname(picked).toLowerCase() !== '.mp3' || !info.isFile() || info.size > 32 * 1024 * 1024)
    throw new Error('Choose an MP3 audio file up to 32 MiB.')
  const id = randomUUID()
  await mkdir(dir, { recursive: true })
  const path = join(dir, id + '.mp3')
  try {
    await copyFile(picked, path)
    const data = JSON.parse(await runBinary(FFPROBE_PATH, ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'mp3', '-show_entries',
      'stream=codec_type,codec_name:format=duration', '-of', 'json', path]))
    const duration = Number(data.format?.duration)
    if (!data.streams?.some((s: { codec_name: string }) => s.codec_name === 'mp3') || !(duration > 0 && duration <= 600))
      throw new Error('Choose an MP3 up to 10 minutes long.')
    await runFfmpeg(['-xerror', '-protocol_whitelist', 'file', '-f', 'mp3', '-i', path, '-map', '0:a:0', '-f', 'null', '-'])
    await persist({ id, name: basename(picked), duration, sha256: await digest(path) })
  } catch (error) {
    await rm(path, { force: true })
    throw new Error('Could not import ' + basename(picked) + '. ' + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
}
