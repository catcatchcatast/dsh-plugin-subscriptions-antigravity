// 变更追溯：CHG-20261124-154130-quota-prefetch-d570c33d；记录：.codex/doc/change-history/CHG-20261124-154130-quota-prefetch-d570c33d.md
// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；记录：.codex/doc/change-history/CHG-20261124-152158-preview-parity-2fdd82c1.md
// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：CHG-20261103-143200-subscription-account-audit-b8023110；记录：.codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { callSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { notifyDisplayNameChange } from '../src/client/display-name-events.js'
import { en, zh } from '../src/client/locales.js'

const selections = {
  api: { provider: 'deepseek', model: 'deepseek-chat' },
  codex: { provider: 'codex', model: 'gpt-test' },
  grok: { provider: 'grok', model: 'grok-test' },
  antigravity: { provider: 'antigravity', model: 'gemini-4-argon' },
  denied: { provider: 'antigravity', model: 'gemini-non-entitled' },
}
const parity = new URLSearchParams(location.search).has('parity')
const prefetch = new URLSearchParams(location.search).has('prefetch')
let selection = parity || prefetch ? selections.codex : selections.api
let failGoogleUsage = false
let hangBridgeQuota = false
let bridgeAccountCalls = 0
let bridgeModelCalls = 0
let bridgeAborts = 0
let grokDisplayName: string | undefined
let codexValues: unknown[] = [13]
let codexStale = false
let failCodex = false
let usageCalls = 0
let reads = 0
// 变更追溯：断网持续重试与恢复；记录：.codex/doc/change-history/CHG-20261114-badge-overlay-b8023110.md
let statusCalls = 0
let offline = false
let hangStatus = false
let usagePercent = 71
let observedAccount: 'actual' | 'default' | 'unknown' = 'actual'
const currentModel = async () => {
  document.documentElement.dataset.modelReads = String(++reads)
  document.documentElement.dataset.lastRead = selection.provider
  return selection
}
// 变更追溯：模拟无订阅Home显示所属电脑数据；记录：.codex/doc/change-history/CHG-20261113-owner-quota-b8023110.md
const remote = new URLSearchParams(location.search).has('remote')
const actualAccounts = !new URLSearchParams(location.search).has('quota')
const ownerId = 'rh1.bGFwdG9w.c2Vzc2lvbi1vd25lcg'
const localId = 'fixture-session'
const rpc = { call: async (_channel: string, method: string, payload: { provider?: string; account?: string; accountId?: string; model?: string; sessionId?: string; read?: string }, signal?: AbortSignal) => {
  if (method === 'subscriptions-auth.sessionAccount') {
    if (remote && payload.sessionId !== ownerId && (!prefetch || payload.sessionId !== localId)) throw new Error('Badge queried wrong owner')
    method = `subscriptions-auth.${payload.read ?? 'sessionAccount'}`
  }
  if (method.endsWith('.status')) document.documentElement.dataset.statusCalls = String(++statusCalls)
  if (hangStatus && payload.read === 'status') {
    await new Promise<void>((_, reject) => { signal?.addEventListener('abort', () => {
      document.documentElement.dataset.aborted = 'true'
      setTimeout(() => { reject(signal.reason) }, 1000)
    }, { once: true }) })
  }
  if (offline) throw new Error('fixture owner offline')
  if (method.endsWith('.status')) return { ok: true, value: { providers: {
    claude: { busy: false, accounts: [] },
    copilot: { busy: false, accounts: [] },
    codex: { busy: false, accounts: [{ key: 'codex-test', account: parity ? '账号 A' : 'default@example.test', isDefault: true }, ...(actualAccounts ? [{ key: 'codex-serving', account: parity ? 'catcatchcatast@example.test' : 'actual@example.test', isDefault: false }] : [])] },
    grok: { busy: false, displayName: grokDisplayName, accounts: parity ? [] : [{ key: 'grok-test', isDefault: true }] },
  } } }
  const remoteOwner = payload.sessionId === ownerId
  if (method.endsWith('.antigravityStatus')) {
    if (!payload.sessionId) throw new Error('Badge bypassed the session relay')
    return { ok: true, value: { state: 'ready', displayName: 'Antigravity', accounts: parity || location.search.includes('placeholder=1')
      ? [{ id: 'sole-system', label: 'This Mac', state: 'ready', enabled: true }]
      : [
        { id: 'bridge-one', label: remoteOwner ? 'Laptop bridge' : 'Local bridge', state: 'ready', enabled: true },
        { id: 'bridge-two', label: 'This Mac', state: 'ready', enabled: true },
      ] } }
  }
  if (method.endsWith('.antigravityQuota')) {
    if (!payload.sessionId) throw new Error('Badge bypassed the session relay')
    const data = document.documentElement.dataset
    if (payload.accountId) data.bridgeAccountCalls = String(++bridgeAccountCalls)
    if (payload.model) data.bridgeModelCalls = String(++bridgeModelCalls)
    if (hangBridgeQuota) {
      await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => {
        data.bridgeAborts = String(++bridgeAborts)
        reject(signal.reason)
      }, { once: true }))
    }
    const group = { name: 'Gemini shared pool', description: '', buckets: [{ id: 'gemini-7d', name: 'Weekly', window: 'weekly', remainingFraction: remoteOwner ? .66 : .71, resetTime: new Date(Date.now() + 6 * 86_400_000 + 23_000).toISOString() }] }
    const bucket = (id: string, window: string, remainingFraction: number, minutes: number) => ({
      id, window, name: window, remainingFraction, resetTime: new Date(Date.now() + (minutes * 60 + 23) * 1000).toISOString(),
    })
    const groups = parity ? [
      { name: 'Gemini Models', kind: 'gemini', description: '', buckets: [bucket('gemini-weekly', 'WINDOW_WEEKLY', .97, 6 * 1440 + 14 * 60), bucket('gemini-rolling', 'WINDOW_5_HOUR', .92, 23)] },
      { name: 'Claude and GPT models', kind: 'claude', description: '', buckets: [bucket('3p-7d', 'WINDOW_WEEKLY', .99, 4 * 1440 + 20 * 60), bucket('3p-rolling', 'WINDOW_5_HOUR', 1, 5 * 60)] },
    ] : [group]
    const selected = { name: 'Bridge selected pool', description: '', buckets: [{ id: 'focus-7d', name: 'Weekly', window: 'weekly', remainingFraction: remoteOwner ? .58 : .7, resetTime: '' }] }
    if (payload.model) document.documentElement.dataset.bridgeModel = payload.model
    return { ok: true, value: failGoogleUsage
      ? { status: 'error', error: 'Simulated quota failure', groups: [] }
      : { status: 'ok', updatedAt: new Date().toISOString(), groups, subscriptionName: 'Google AI Pro', accountId: 'bridge-one',
        accountLabel: remoteOwner ? 'Laptop bridge' : 'Local bridge', model: payload.model,
        focus: { model: payload.model, family: 'gemini', entitled: payload.model === 'gemini-4-argon', group: selected },
      } }
  }
  if (payload.provider === 'antigravity') throw new Error('Unexpected legacy Google endpoint')
  if (method.endsWith('.proxyGet')) return { ok: true, value: { enabled: false, url: '', bypass: [], passwordSet: false } }
  if (method.endsWith('.usage')) document.documentElement.dataset.usageCalls = String(++usageCalls)
  if (method.endsWith('.usage') && payload.provider === 'codex' && failCodex) throw new Error('Synthetic failure')
  if (method.endsWith('.sessionAccount') && payload.provider === 'codex' && observedAccount === 'unknown') return { ok: true, value: { state: 'unknown' } }
  if (method.endsWith('.sessionAccount')) return { ok: true, value: { state: observedAccount === 'default' ? 'active' : 'last', account: {
    key: payload.provider === 'codex' ? observedAccount === 'default' ? 'codex-test' : 'codex-serving' : 'grok-test',
    label: payload.provider === 'codex' ? observedAccount === 'default' ? 'default@example.test' : (parity ? 'catcatchcatast@example.test' : 'actual@example.test') : `${payload.provider}@example.test`,
    model: payload.model, callId: 'fixture-call', startedAt: 1,
  } } }
  if (parity && method.endsWith('.usage')) {
    const observed = payload.account === 'codex-serving'
    return { ok: true, value: { supported: true, fetchedAt: Date.now(), plan: 'fixture plan',
      credits: { hasCredits: true, unlimited: false, balance: observed ? '50807.62' : '62500' },
      windows: [{ kind: 'weekly', usedPercent: observed ? 32 : 7,
        resetsAt: Date.now() + ((observed ? 4 * 24 + 9 : 5 * 24 + 23) * 3600 + 23) * 1000 }],
    } }
  }
  if (method.endsWith('.usage')) return { ok: true, value: {
    supported: true, fetchedAt: Date.now() - (codexStale ? 600_000 : 1000), staleAt: Date.now() + (codexStale ? -300_000 : 299_000), windows: payload.provider === 'codex' ? (payload.account === 'codex-serving' ? [usagePercent] : codexValues).map((usedPercent, i) => ({ kind: i === 0 ? 'session' : 'weekly', usedPercent, ...(codexStale ? { resetsAt: Date.now() - 1000 } : {}) })) : [{ kind: 'weekly', usedPercent: 25 }],
  } }
  throw new Error(`Unexpected RPC: ${method}`)
} } as unknown as SubscriptionUsageBadgeInjected['rpc']

function App() {
  const [showSettings, setShowSettings] = useState(false)
  const updateCodex = (values: unknown[], stale = false, fail = false) => {
    codexValues = values; codexStale = stale; failCodex = fail
    void callSubscriptionsAuth(rpc, 'usage', { provider: 'codex', account: 'codex-test' }).catch(() => {})
  }
  const [locale, setLocale] = useState<'en' | 'zh'>(parity ? 'zh' : 'en')
  const [mounted, setMounted] = useState(true)
  const [sessionId, setSessionId] = useState(remote ? ownerId : localId)
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  if (parity) return <>
    <style>{`body { margin: 0; background: #171719; color: #ededee; font: 14px/1.45 system-ui, 'Noto Sans CJK SC', sans-serif; color-scheme: dark;
      --dsw-specific-menu: #262629; --dsw-alias-border-l2: #424245; --dsw-elevation-prominent: 0 6px 18px #0003;
      --dsw-alias-label-primary: #ededee; --dsw-alias-label-secondary: #ededee; --dsw-alias-label-tertiary: #a9a9af;
      --dsw-alias-interactive-bg-hover: #414146; } main { position: absolute; bottom: 40px; left: 12px; }`}</style>
    <main><div data-composer-stats />
      <SubscriptionUsageBadge sessionId="fixture-session" rpc={rpc} currentModel={currentModel} t={t} />
    </main>
  </>
  return <>
    <style>{`:root { font-family: system-ui; --dsw-alias-bg-layer-1: #f3f4f6; --dsw-alias-bg-layer-2: white; --dsw-specific-menu: white; --dsw-elevation-prominent: 0 4px 20px #0003;
      --dsw-alias-label-primary: #171717; --dsw-alias-label-secondary: #444; --dsw-alias-label-tertiary: #666;
      --dsw-alias-label-dimmed: #888; --dsw-alias-border-l2: #ddd; --dsw-alias-border-l4: #eee;
      --dsw-alias-state-success-primary: #198754; --dsw-alias-state-error-primary: #cf222e; --dsw-alias-state-warn-label: #9a6700; }
      button, select { font: inherit; }`}</style>
    <button onClick={() => setShowSettings(!showSettings)}>Toggle settings</button>
    <button onClick={() => updateCodex([0, 100, 95, 80])}>Boundary usage</button>
    <button onClick={() => updateCodex([null])}>Unknown usage</button>
    <button onClick={() => updateCodex([28], true)}>Stale usage</button>
    <button onClick={() => updateCodex([28], false, true)}>Fail Codex usage</button>
    <button onClick={() => updateCodex([36])}>Recover usage</button>
    {showSettings && <div data-settings><SubscriptionsSection rpc={rpc} t={t} /></div>}
    <button onClick={() => { failGoogleUsage = true }}>Fail Google usage</button>
    <button onClick={() => { failGoogleUsage = false }}>Recover Google usage</button>
    <button onClick={() => { grokDisplayName = '我的 Grok'; notifyDisplayNameChange('grok', grokDisplayName) }}>Rename Grok</button>
    <button onClick={() => { grokDisplayName = undefined; notifyDisplayNameChange('grok', '') }}>Reset Grok</button>
    <button onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>Locale</button>
    {Object.entries(selections).map(([name, next]) => <button key={name} onClick={() => { selection = next }}>{name}</button>)}
    <button onClick={() => { observedAccount = 'unknown' }}>Unknown account</button>
    <button onClick={() => { observedAccount = 'default' }}>Dispatch default</button>
    <button onClick={() => { observedAccount = 'actual' }}>Dispatch actual</button>
    <button onClick={() => { offline = true }}>Offline</button>
    <button onClick={() => { offline = false; usagePercent = 72 }}>Recover</button>
    <button onClick={() => { hangStatus = true }}>Hang status</button>
    <button onClick={() => { hangStatus = false }}>Unhang status</button>
    {prefetch && <>
      <button onClick={() => { hangBridgeQuota = true }}>Hang Google quota</button>
      <button onClick={() => { hangBridgeQuota = false }}>Unhang Google quota</button>
      <button onClick={() => { setSessionId(localId) }}>Switch to local session</button>
    </>}
    <button onClick={() => { setMounted(false) }}>Unmount badge</button>
    <UsageBadgeDisplaySetting t={t} />
    <div>
      <div data-composer-stats />
      {mounted && <SubscriptionUsageBadge sessionId={sessionId} rpc={rpc} currentModel={currentModel} t={t} />}
    </div>
  </>
}
if (parity) document.body.dataset.dsDarkTheme = ''
createRoot(document.getElementById('root')!).render(<App />)
