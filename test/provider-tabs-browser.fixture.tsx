// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import { createRoot } from 'react-dom/client'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { zh, type SubscriptionsKey } from '../src/client/locales.js'

// Synthetic RPC only: hold the first status so tests can choose a tab before it arrives.
const state = window as any
const account = (provider: string) => ({ key: provider, account: `${provider}@example.test`, isDefault: true })

state.providers = {
  codex: { busy: false, accounts: [account('codex')], displayName: 'Zulu' },
  claude: { busy: false, accounts: [account('claude')], displayName: 'Alpha' },
  grok: { busy: false, accounts: [] },
  copilot: { busy: false, accounts: [] },
}
let releaseStatus!: () => void
const firstStatus = new Promise<void>(resolve => { releaseStatus = resolve })
state.releaseStatus = releaseStatus
let statusCalls = 0
const rpc = { call: async (_channel: string, method: string, payload: any) => {
  const endpoint = method.split('.').at(-1)
  if (endpoint === 'status') {
    if (++statusCalls === 1) await firstStatus
    return { ok: true, value: { providers: structuredClone(state.providers) } }
  }
  if (endpoint === 'antigravityStatus') return { ok: true, value: { state: 'ready', displayName: 'Google Antigravity', accounts: [] } }
  if (endpoint === 'antigravityModels') return { ok: true, value: { models: structuredClone(state.bridgeModels) } }
  if (endpoint === 'setAntigravityModels') {
    state.modelSave = payload
    if (state.refuseModelSave) return { ok: false, error: { message: 'Profile is read-only' } }
    for (const change of payload.changes) state.bridgeModels.find((model: any) => model.id === change.id).enabled = change.enabled
    return { ok: true, value: { models: structuredClone(state.bridgeModels) } }
  }
  if (endpoint === 'login') {
    state.providers[payload.provider].accounts = [account(payload.provider)]
    return { ok: true, value: { authorizeUrl: '' } }
  }
  if (endpoint === 'logout') {
    state.providers[payload.provider].accounts = []
    return { ok: true, value: {} }
  }
  if (endpoint === 'proxyGet') return { ok: true, value: { enabled: false, url: '', bypass: [], passwordSet: false } }
  if (endpoint === 'prepareReset') {
    state.preparedReset = payload
    return { ok: true, value: { ticket: 'test-ticket', expiresAt: Date.now() + 60_000, creditExpiresAt: state.resetExpiry, weeklyUsedPercent: 90 } }
  }
  if (endpoint === 'consumeReset') {
    state.consumedReset = payload
    return { ok: true, value: {} }
  }
  if (endpoint === 'usage') {
    if (payload.provider === 'codex') {
      const now = Date.now()
      state.resetExpiry = now + 86_400_000
      return { ok: true, value: {
        supported: true, credits: { balance: 0 },
        windows: [{ kind: 'weekly', usedPercent: payload.force ? 90 : 47, resetsAt: now + 86_400_000 }],
        resetCredits: [3, 1, 2].map(days => ({ id: String(days), expiresAt: now + days * 86_400_000 })),
      } }
    }
    if (payload.force) state.forcedRefresh = payload
    return { ok: true, value: { supported: true, windows: [] } }
  }
  return { ok: true, value: {} }
} } as any
state.bridgeModels = [
  { id: 'gemini-first', name: 'Gemini First', enabled: true, locked: false },
  { id: 'gemini-second', name: 'Gemini Second', enabled: false, locked: false },
  { id: 'hidden-preview', name: 'Hidden Preview', enabled: false, locked: true },
]
const translate = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (raw, id) => String(params?.[id] ?? raw))
createRoot(document.getElementById('root')!).render(<SubscriptionsSection rpc={rpc} {...navigator.language.startsWith('zh') ? { t: translate } : {}} />)
