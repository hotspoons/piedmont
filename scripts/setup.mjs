#!/usr/bin/env node
// The first command on a fresh clone: `npm run setup` (or `node scripts/setup.mjs`).
//
// Piedmont builds against three packages that live in siomporas-arcade — @apex/engine,
// @apex/enginesim and @apex/stunt-pieces — consumed as TypeScript source exactly as the arcade's
// own games consume them. They are npm WORKSPACES here (`vendor/arcade/packages/*`), so they have to
// exist on disk before npm resolves the tree. That is why this runs first and why it ends with
// `npm install` itself:
//
//   1. the arcade packages. If `ext/siomporas-arcade` is checked out, `vendor/arcade` links to it,
//      so an edit there shows up in the dev server with no reinstall. Otherwise the ref pinned in
//      `arcade.json` is shallow-fetched into `.cache/arcade/<ref>` and `vendor/arcade` links to that.
//   2. gaussworks, the splat trainer, cloned into `ext/gaussworks` if it is not there.
//   3. the data directory ($PIEDMONT_DATA, default `data/`).
//   4. Node dependencies (`npm install`, or `npm ci` with --ci).
//   5. the bake's Python dependencies, in a venv ($PIEDMONT_VENV, default `bake/.venv`).
//
// Flags:
//   --ci             npm ci instead of npm install
//   --no-install     stop after the arcade link (and gaussworks)
//   --no-python      skip the venv
//   --no-gaussworks  do not clone gaussworks
//   --fetch          ignore ext/siomporas-arcade and use the pinned ref
//   --copy <dir>     copy the pinned packages (plus the arcade's tsconfig.base.json) into <dir>
//                    as real files instead of linking — what an image build wants; implies --fetch
//   --check          only verify vendor/arcade resolves (the preinstall hook); exit 1 if not
//
// Environment: PIEDMONT_ARCADE_REPO overrides arcade.json's repo (a local path works);
// PIEDMONT_DATA, PIEDMONT_VENV as above.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const pin = JSON.parse(readFileSync(join(ROOT, 'arcade.json'), 'utf8'))
const EXT = join(ROOT, 'ext/siomporas-arcade')
const VENDOR = join(ROOT, 'vendor/arcade')
const log = (m) => console.log(`setup: ${m}`)
const die = (m) => { console.error(`setup: ${m}`); process.exit(1) }

function git(argv, opts = {}) {
  return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

/** Every pinned package present, each with a package.json. */
function complete(dir) {
  return pin.packages.every((p) => existsSync(join(dir, 'packages', p, 'package.json'))) && existsSync(join(dir, 'tsconfig.base.json'))
}

/** The pinned ref, shallow-fetched once into .cache/arcade/<ref>. Written to a temp dir and renamed, so a
 *  fetch that dies half way never leaves something that looks finished. */
function fetchPinned() {
  if (!/^[0-9a-f]{40}$/.test(pin.ref)) die(`arcade.json ref must be a full 40-character sha, got ${pin.ref}`)
  const dest = join(ROOT, '.cache/arcade', pin.ref)
  if (complete(dest)) return dest
  const repo = process.env.PIEDMONT_ARCADE_REPO ?? pin.repo
  const tmp = `${dest}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  log(`fetching ${repo} @ ${pin.ref.slice(0, 12)} into ${relative(ROOT, dest)}`)
  try {
    git(['init', '-q'], { cwd: tmp })
    git(['remote', 'add', 'origin', repo], { cwd: tmp })
    // Only the pinned packages and the tsconfig they extend: the arcade's games are ~100 MB of art
    // this repository never reads. A blob filter plus a sparse checkout fetches just those files.
    git(['sparse-checkout', 'set', '--no-cone', ...pin.packages.map((p) => `/packages/${p}/`), '/tsconfig.base.json', '/LICENSE', '/NOTICE'], { cwd: tmp })
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', pin.ref], { cwd: tmp })
    git(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: tmp })
    const head = git(['rev-parse', 'HEAD'], { cwd: tmp })
    if (head !== pin.ref) throw new Error(`fetched ${head}, wanted ${pin.ref}`)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    die(`could not fetch the arcade at ${pin.ref}: ${String(e.stderr || e.message).trim()}`)
  }
  if (!complete(tmp)) { rmSync(tmp, { recursive: true, force: true }); die(`the arcade at ${pin.ref} does not have packages ${pin.packages.join(', ')}`) }
  rmSync(join(tmp, '.git'), { recursive: true, force: true }) // a snapshot, not a working copy
  rmSync(dest, { recursive: true, force: true })
  renameSync(tmp, dest)
  return dest
}

/** Where vendor/arcade points now, or null. */
function current() {
  try {
    const st = lstatSync(VENDOR)
    if (st.isSymbolicLink()) return resolve(dirname(VENDOR), readlinkSync(VENDOR))
    return VENDOR
  } catch {
    return null
  }
}

function link(src) {
  mkdirSync(dirname(VENDOR), { recursive: true })
  const was = current()
  if (was === src) return
  rmSync(VENDOR, { recursive: true, force: true })
  symlinkSync(relative(dirname(VENDOR), src), VENDOR, 'dir')
}

function checkWorkspaces() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const want = pin.packages.map((p) => `vendor/arcade/packages/${p}`)
  const missing = want.filter((w) => !pkg.workspaces.includes(w))
  if (missing.length) die(`package.json workspaces lack ${missing.join(', ')} (arcade.json lists them)`)
}

if (flag('--check')) {
  const at = current()
  if (!at || !complete(at)) {
    die('vendor/arcade is missing or incomplete. Run `npm run setup` (it runs npm install itself) — see README.md, Quick start.')
  }
  process.exit(0)
}

checkWorkspaces()

if (opt('--copy')) {
  const out = resolve(opt('--copy'))
  const src = fetchPinned()
  rmSync(out, { recursive: true, force: true })
  for (const p of pin.packages) cpSync(join(src, 'packages', p), join(out, 'packages', p), { recursive: true })
  cpSync(join(src, 'tsconfig.base.json'), join(out, 'tsconfig.base.json'))
  log(`copied ${pin.packages.join(', ')} @ ${pin.ref.slice(0, 12)} into ${out}`)
  process.exit(0)
}

// 1. the arcade
let src
if (!flag('--fetch') && existsSync(EXT)) {
  if (!complete(EXT)) die(`ext/siomporas-arcade exists but lacks packages ${pin.packages.join(', ')} or tsconfig.base.json`)
  src = EXT
  let at = '?'
  try { at = git(['rev-parse', '--short', 'HEAD'], { cwd: EXT }) } catch { /* not a git checkout */ }
  log(`linking vendor/arcade -> ext/siomporas-arcade (at ${at}; arcade.json pins ${pin.ref.slice(0, 7)})`)
  if (existsSync(join(EXT, 'node_modules'))) {
    log('WARNING: ext/siomporas-arcade/node_modules exists. The engine will resolve three and its other dependencies from')
    log('         there rather than from piedmont, and two copies of three break instanceof checks. Vite dedupes the')
    log('         runtime ones; delete that node_modules if tsc reports two incompatible @types/three.')
  }
} else {
  src = fetchPinned()
  log(`linking vendor/arcade -> ${relative(ROOT, src)}`)
}
link(src)
mkdirSync(join(ROOT, '.cache'), { recursive: true })
writeFileSync(join(ROOT, '.cache/arcade-source'), `${relative(ROOT, src)}\n`)

// 2. gaussworks
if (!flag('--no-gaussworks') && !process.env.PIEDMONT_SKIP_GAUSSWORKS) {
  const gw = join(ROOT, 'ext/gaussworks')
  if (existsSync(gw)) log('ext/gaussworks is there; leaving it alone')
  else {
    log('cloning hotspoons/gaussworks into ext/gaussworks')
    const r = spawnSync('git', ['clone', '-q', 'https://github.com/hotspoons/gaussworks.git', gw], { stdio: 'inherit' })
    if (r.status !== 0) die('could not clone gaussworks (pass --no-gaussworks to skip it)')
  }
}

// 3. the data directory
const data = resolve(ROOT, process.env.PIEDMONT_DATA ?? 'data')
mkdirSync(join(data, 'sites'), { recursive: true })

if (flag('--no-install')) process.exit(0)

// 4. Node
const npm = flag('--ci') ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund']
log(`npm ${npm[0]}`)
let r = spawnSync('npm', npm, { cwd: ROOT, stdio: 'inherit' })
if (r.status !== 0) die(`npm ${npm[0]} failed`)

// 5. Python
if (!flag('--no-python')) {
  const venv = resolve(ROOT, process.env.PIEDMONT_VENV ?? 'bake/.venv')
  const py = join(venv, 'bin/python')
  if (!existsSync(py)) {
    log(`creating the bake's venv at ${relative(ROOT, venv) || venv}`)
    r = spawnSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' })
    if (r.status !== 0) die('python3 -m venv failed (install python3-venv, or pass --no-python)')
  }
  log('pip install -r bake/requirements.txt')
  r = spawnSync(py, ['-m', 'pip', 'install', '-q', '-r', join(ROOT, 'bake/requirements.txt')], { stdio: 'inherit' })
  if (r.status !== 0) die('pip install failed (pass --no-python to skip)')
}
log('done. `npm run dev` serves the game on :5185.')
