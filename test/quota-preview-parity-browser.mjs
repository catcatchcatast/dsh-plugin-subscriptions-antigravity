// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；记录：.codex/doc/change-history/CHG-20261124-152158-preview-parity-2fdd82c1.md
// Offline comparison: the candidate bundles the real React badge and supplies synthetic RPC data only.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dependencies = await readdir('node_modules/.pnpm')
const packagePath = name => resolve('node_modules/.pnpm', dependencies.find(entry => entry.startsWith(`${name}@`)), 'node_modules', name)
const { build } = await import(pathToFileURL(`${packagePath('rolldown')}/dist/index.mjs`))
const { chromium } = await import(pathToFileURL(`${process.env.PLAYWRIGHT_PATH}/index.mjs`))
const result = await build({
  input: 'test/subscription-usage-browser.fixture.tsx',
  resolve: { alias: { 'react-dom/client': `${packagePath('react-dom')}/client.js` } },
  transform: { define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } },
  plugins: [{ name: 'test-css', load(id) { return id.endsWith('.css') ? 'export default {}' : null } }],
  output: { format: 'iife' }, write: false,
})
const code = result.output.find(file => file.type === 'chunk').code
const preview = await readFile('test/fixtures/preview/preview-bars.html', 'utf8')
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
try {
  const context = await browser.newContext({ viewport: { width: 386, height: 720 }, locale: 'zh-CN', colorScheme: 'dark' })
  await context.route('https://parity.test/**', route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ status: 200, contentType: path === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      body: path === '/app.js' ? code : path === '/preview' ? preview : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>' })
  })
  const candidate = await context.newPage()
  const errors = []
  candidate.on('pageerror', error => errors.push(error.message))
  candidate.setDefaultTimeout(10_000)
  await candidate.goto('https://parity.test/?parity=1')
  const badge = candidate.locator('[data-composer-stats] button')
  await badge.filter({ hasText: '32%' }).click()
  const actual = candidate.locator('.dsh-subscription-usage-panel')
  await actual.getByRole('progressbar', { name: 'Claude/GPT · 每周' }).waitFor()

  const reference = await context.newPage()
  await reference.goto('https://parity.test/preview')
  const expected = reference.locator('article')
  assert.deepEqual(errors, [])

  async function describe(panel, prototype) {
    return panel.evaluate((root, prototype) => {
      const box = root.getBoundingClientRect()
      const read = (row, index) => row.cells[index]?.innerText.trim()
      return {
        width: box.width, height: box.height, horizontalOverflow: root.scrollWidth > root.clientWidth,
        title: root.firstElementChild.innerText.trim(),
        headings: [...root.querySelectorAll('thead th')].map(th => th.innerText.trim()),
        accounts: [...root.querySelectorAll(prototype ? 'tr.account' : 'tr.dsh-quota-account')].map(row => read(row, 0).replace(/\s+/g, ' ')),
        rows: [...root.querySelectorAll(prototype ? 'tr.row' : 'tr.dsh-quota-row')].map(row => Array.from({ length: 3 }, (_, index) => read(row, index))),
        bars: [...root.querySelectorAll(prototype ? '.meter' : '.dsh-quota-meter')].map(el => {
          const track = getComputedStyle(el, '::before')
          const fill = getComputedStyle(el, '::after')
          return { width: el.getBoundingClientRect().width, height: track.height, textured: fill.backgroundImage.includes('repeating-linear-gradient') }
        }),
      }
    }, prototype)
  }
  const baseline = await describe(expected, true)
  const rendered = await describe(actual, false)
  const screenshot = process.env.QUOTA_PARITY_SCREENSHOT || '/tmp/quota-preview-parity-actual.png'
  await actual.screenshot({ path: screenshot })
  await expected.screenshot({ path: screenshot.replace(/\.png$/, '-reference.png') })
  console.log(JSON.stringify({ baseline, rendered, screenshot }, null, 2))
  assert.equal(rendered.title, baseline.title)
  assert.deepEqual(rendered.headings, baseline.headings)
  assert.deepEqual(rendered.accounts, baseline.accounts)
  assert.deepEqual(rendered.rows, baseline.rows)
  assert.equal(rendered.width, baseline.width)
  assert.ok(Math.abs(rendered.height - baseline.height) <= 10, 'table height matches preview to within 10px')
  assert.deepEqual(rendered.bars, baseline.bars)
  assert.equal(rendered.horizontalOverflow, false)
  assert.doesNotMatch(await actual.innerText(), /获取时间|收到响应|计划|Google AI Pro|This Mac|★|当前|限额|约|@/)
  console.log('PASS: 386px real-component parity with approved preview')
} finally { await browser.close() }
