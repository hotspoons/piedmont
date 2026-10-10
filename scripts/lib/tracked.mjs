// The files a repository check reads: everything git tracks plus anything new that is not ignored,
// so a check run before `git add` sees what is about to be committed.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(new URL('../..', import.meta.url).pathname)

export function trackedFiles(root = ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  return [...new Set(out.split('\0').filter(Boolean))].sort()
}

/** The file's text, or null for a binary (a NUL in it) or a file that is gone. */
export function readText(file, root = ROOT) {
  let buf
  try { buf = readFileSync(join(root, file)) } catch { return null }
  if (buf.includes(0)) return null
  return buf.toString('utf8')
}
