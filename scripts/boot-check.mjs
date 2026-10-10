#!/usr/bin/env node
// Boot the game once in headless Chromium (SwiftShader) and fail unless it reaches a built site
// with no page errors. The check to run before a start-up change reaches anybody's live tab.
//
//   node scripts/boot-check.mjs [url]       default http://localhost:5185/#crofton-triangle
//   BOOT_TIMEOUT_S=300 node scripts/boot-check.mjs http://localhost:5297/#crofton-triangle
//
// Exit 0: `window.piedmont.site.manifest.slug` is set and nothing threw. Exit 1 otherwise, with
// every page error and console error it saw.
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5185/#crofton-triangle'
const timeout = Number(process.env.BOOT_TIMEOUT_S ?? 300) * 1000
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
const missing = []
page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 300)) })
// 404s are listed rather than failed on: several files a world MAY have (tuning.json, presets.json,
// splats.json, generated surfaces) are optional and answer 404 by design.
page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`) })

const t0 = Date.now()
let reached = null
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForFunction(() => !!globalThis.piedmont?.site?.manifest?.slug, null, { timeout, polling: 500 })
  reached = await page.evaluate(() => ({
    slug: globalThis.piedmont.site.manifest.slug,
    title: document.title,
    mode: typeof globalThis.piedmont.mode === 'function' ? globalThis.piedmont.mode() : null,
  }))
} catch (e) {
  consoleErrors.push(`boot-check: ${e.message.split('\n')[0]}`)
}
await browser.close()

const s = ((Date.now() - t0) / 1000).toFixed(1)
for (const e of pageErrors) console.log(`PAGE ERROR  ${e}`)
for (const e of consoleErrors) console.log(`console     ${e}`)
for (const m of [...new Set(missing)]) console.log(`http        ${m}`)
if (reached && pageErrors.length === 0) {
  console.log(`boot-check: OK in ${s}s — window.piedmont.site is ${reached.slug} (${reached.title})`)
  process.exit(0)
}
console.log(`boot-check: FAILED after ${s}s — ${reached ? `${pageErrors.length} page error(s)` : 'window.piedmont.site never appeared'}`)
process.exit(1)
