// Render a stance URL (what Rich copied with C) headlessly: node probes/stance.mjs '<url>' out.png
import { chromium } from 'playwright'
const [,, url, out] = process.argv
const local = url.replace(/^https?:\/\/[^/]+/, 'http://127.0.0.1:5185')
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(local, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.piedmont, null, { timeout: 180000 })
await page.waitForTimeout(3000)
await page.screenshot({ path: out, timeout: 120000 })
console.log(await page.evaluate(() => JSON.stringify({ site: window.piedmont.site.manifest.slug, drive: window.piedmont.drive.on, cam: window.piedmont.camera.position.toArray().map((v) => +v.toFixed(1)) })))
await browser.close()
