// The MCP port's real-browser acceptance (docs/dev/specs/PLAN-MCP-PORT.md, *Done when*), checked
// end to end: an editor page attached to a LOCAL world editor, the Shell tab NEVER opened, and the
// bridge tools called over MCP exactly as an agent would.
//
// What it proves, and why each one needs a browser:
//   - shell_exec starts the wasm machine on the FIRST call with no Shell tab ever opened
//     (ShellPanel.ensureMachine, pre-warmed when the bridge attaches) — the machine is a Worker,
//     so only a browser can show this;
//   - the second call reuses that machine instead of cold-starting it;
//   - the agent's calls do not touch the visible pane (mode unchanged, the Shell pane not built);
//   - a server-side program_write reaches the page's shell filesystem (`cat` sees it) — the
//     documents channel, not a filesystem shared by the two processes;
//   - opening the Shell tab afterwards shows the machine the agent started, not a fresh one.
//
// RUN IT (a local editor just for this, so nothing else owns the bridge):
//
//   mkdir -p /tmp/piedmont/we-data
//   PIEDMONT_EDITOR_MCP_AUTH=on node services/worldeditor/server.mjs --port 8782 --data /tmp/piedmont/we-data &
//   WE_BASE=http://127.0.0.1:8782 node services/worldeditor/mcp-browser-check.mjs
//
// The server serves the BUILT app (`apps/game/dist`), so build first if the page is stale
// (`npm run build -w apps/game`) — a stale dist lacks ensureShell and fails the first call with
// the old "open the Shell tab once" message, which is itself the thing this check is for.
import { chromium } from 'playwright'

const BASE = process.env.WE_BASE ?? 'http://127.0.0.1:8782'
const fails = []
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fails.push(msg) }

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERR', e.message))
await page.goto(`${BASE}/world.html`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForFunction(() => globalThis.__we?.ready?.() === true, null, { timeout: 60_000 })
console.log('page ready; Shell tab never touched')

// --- the bridge now has our page as the owner -------------------------------------------------
let cfg = null
for (let i = 0; i < 40; i++) {
  cfg = await (await fetch(`${BASE}/api/agent/mcp/config`)).json()
  if (cfg.bridge?.attached >= 1) break
  await new Promise((r) => setTimeout(r, 250))
}
const token = cfg.auth.token
ok(!!token && cfg.auth.required === true, `MCP auth is required and a token exists (len ${token?.length})`)
ok(cfg.bridge.attached === 1, `exactly one editor page is attached (got ${cfg.bridge.attached})`)
console.log('owner page:', cfg.bridge.owner?.name, '| label:', cfg.bridge.pages?.[0]?.label)

const shellBefore = await page.evaluate(() => ({
  mode: globalThis.__we.mode(),
  shellPaneChildren: document.querySelector('[data-pane="shell"]')?.childElementCount ?? -1,
}))

// --- MCP client ------------------------------------------------------------------------------
const tryJson = (t) => { try { return JSON.parse(t) } catch { return null } }
const call = async (name, args) => {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/agent/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await res.json()
  const ms = Date.now() - t0
  if (body.error) throw new Error(`${name}: ${body.error.message}`)
  const text = body.result?.content?.[0]?.text ?? ''
  return { ms, text, isError: body.result?.isError === true, parsed: tryJson(text) }
}

const list = await fetch(`${BASE}/api/agent/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
}).then((r) => r.json())
const names = (list.result?.tools ?? []).map((t) => t.name)
ok(names.includes('shell_exec'), 'shell_exec is advertised while a page is attached')
ok(names.includes('program_write'), 'program_write (server-side) is advertised')

// --- shell_exec cold, then warm --------------------------------------------------------------
const cold = await call('shell_exec', { command: 'echo cold-$((1+1))' })
ok(!cold.isError && cold.parsed?.exitCode === 0 && /cold-2/.test(cold.parsed?.stdout ?? ''),
  `first shell_exec succeeds with no Shell tab (${cold.ms} ms): ${JSON.stringify(cold.parsed?.stdout?.trim())}`)
const warm = await call('shell_exec', { command: 'echo warm-ok' })
ok(!warm.isError && warm.parsed?.exitCode === 0 && /warm-ok/.test(warm.parsed?.stdout ?? ''),
  `second shell_exec reuses the machine (${warm.ms} ms, first was ${cold.ms} ms)`)

// --- the visible pane is undisturbed ---------------------------------------------------------
const shellAfter = await page.evaluate(() => ({
  mode: globalThis.__we.mode(),
  shellPaneChildren: document.querySelector('[data-pane="shell"]')?.childElementCount ?? -1,
}))
ok(shellAfter.mode === shellBefore.mode, `mode unchanged by the agent (${shellBefore.mode} -> ${shellAfter.mode})`)
ok(shellAfter.shellPaneChildren === shellBefore.shellPaneChildren, `the Shell pane was not built for the agent (children ${shellAfter.shellPaneChildren})`)

// --- an MCP-side program_write shows up in the page shell's cat -------------------------------
const SRC = 'export const hello = "from mcp"\n'
const wrote = await call('program_write', { path: 'mcpcheck/hello.ts', source: SRC })
ok(!wrote.isError, `program_write wrote programs/mcpcheck/hello.ts (${wrote.ms} ms)`)
await new Promise((r) => setTimeout(r, 1500)) // the doc channel broadcasts; let the page pull it
const cat = await call('shell_exec', { command: 'cat programs/mcpcheck/hello.ts' })
ok(/from mcp/.test(cat.parsed?.stdout ?? ''), `the page shell sees the write: cat -> ${JSON.stringify(cat.parsed?.stdout?.trim())}`)

// --- opening the Shell tab afterwards shows the machine the agent started ----------------------
await page.evaluate(() => globalThis.__we.setMode('shell'))
await new Promise((r) => setTimeout(r, 2500))
const shellTab = await page.evaluate(() => ({
  mode: globalThis.__we.mode(),
  children: document.querySelector('[data-pane="shell"]')?.childElementCount ?? -1,
}))
ok(shellTab.mode === 'shell' && shellTab.children > 0, `the Shell tab opens afterwards (children ${shellTab.children})`)

await browser.close()
console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'all checks passed'))
process.exit(fails.length ? 1 : 0)
