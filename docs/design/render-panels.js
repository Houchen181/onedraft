// Render the platform-panel mockup in two states (Rednote and YouTube selected).
const { chromium } = require('../../node_modules/playwright-core')
const path = require('path')
;(async () => {
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const file = 'file:///' + path.join(__dirname, 'e-platform-panels.html').replace(/\\/g, '/')
  for (const p of ['rednote', 'youtube']) {
    await page.goto(`${file}?p=${p}`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(__dirname, `e-platform-panels-${p}.png`) })
  }
  await b.close()
})()
