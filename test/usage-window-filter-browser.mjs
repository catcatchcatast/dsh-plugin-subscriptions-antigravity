// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
// Offline UI regression: PLAYWRIGHT_PATH=/path/to/playwright node test/usage-window-filter-browser.mjs
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/usage-window-filter-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ status: 200,
    contentType: route.request().url().endsWith('/app.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/app.js') ? code : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>',
  }))
  await page.goto('http://usage-window-filter.test/')
  const google = page.getByRole('tab', { name: /Google Antigravity/ })
  await google.click()
  const panel = page.getByRole('tabpanel', { name: /Google Antigravity/ })
  const pool = panel.getByRole('region', { name: 'Gemini weekly pool', exact: true })
  await pool.waitFor()
  assert.match(await panel.innerText(), /Bridge account.*Google AI Pro/s)
  assert.doesNotMatch(await panel.innerText(), /legacy-account/)
  assert.equal(await pool.getByRole('progressbar').count(), 1)
  assert.match(await pool.innerText(), /33% used.*Inactive/s)
  assert.equal(await panel.getByRole('button', { name: 'Manage', exact: true }).count(), 1) // CHG-20261124-145318-quota-models-47c9e254
  assert.equal(await panel.getByRole('button', { name: 'Refresh', exact: true }).count(), 1)
  await page.getByRole('combobox', { name: 'Quota percentages', exact: true }).selectOption('remaining')
  await pool.getByText('67% remaining', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls).filter(call => call.endpoint === 'antigravityQuota').length === 2)
  const requests = await page.evaluate(() => JSON.parse(document.documentElement.dataset.calls))
  assert.deepEqual(requests.filter(call => call.endpoint === 'antigravityQuota').map(call => call.payload), [
    { accountId: 'bridge-account' }, { accountId: 'bridge-account', force: true },
  ])
  assert.ok(!requests.some(call => call.payload?.provider === 'antigravity'), 'legacy Google data is not used')
  await page.setViewportSize({ width: 380, height: 950 })
  assert.ok(await pool.evaluate(el => el.scrollWidth <= el.clientWidth))
  await page.goto('http://usage-window-filter.test/?empty=1')
  await google.click()
  await panel.getByText('No accounts configured in Antigravity bridge', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Refresh', exact: true }).count(), 0)
  assert.equal(await panel.getByRole('button', { name: 'Manage', exact: true }).count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS: read-only bridge account settings, quota grouping, used/remaining, refresh and empty state')
} finally {
  await browser.close()
}
