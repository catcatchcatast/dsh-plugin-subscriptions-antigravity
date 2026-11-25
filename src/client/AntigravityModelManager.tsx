// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
import { useEffect, useId, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { AntigravityModelCatalog } from '../antigravity-bridge.js'
import type { SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'

export function AntigravityModelManager({ name, rpc, t, onClose }: {
  name: string
  rpc: ConnectionHandle['rpc']
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  onClose: () => void
}) {
  const title = useId()
  const description = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const [attempt, retry] = useState(0)
  const [catalog, setCatalog] = useState<AntigravityModelCatalog>()
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let current = true
    setError(undefined)
    void callSubscriptionsAuth<AntigravityModelCatalog>(rpc, 'antigravityModels', {}).then(value => {
      if (current) setCatalog(value)
    }, (failure: Error) => {
      if (current) setError(t('modelDefaultsLoadFailed', { message: failure.message }))
    })
    return () => { current = false }
  }, [attempt, rpc, t])
  const edits = (catalog?.models ?? []).flatMap(model => {
    if (!Object.hasOwn(draft, model.id) || draft[model.id] === model.enabled) return []
    return [{ id: model.id, enabled: draft[model.id] }]
  })
  async function save() {
    if (submitting.current || edits.length === 0) return
    submitting.current = true
    setError(undefined)
    setSaving(true)
    try {
      await callSubscriptionsAuth(rpc, 'setAntigravityModels', { changes: edits })
      dialog.current?.close()
    } catch (failure) {
      setError(t('accountsSaveFailed', { message: (failure as Error).message }))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }
  const actions = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' } as const
  return <dialog className="dsh-subscription-manager" ref={dialog} aria-labelledby={title} aria-describedby={description}
    onCancel={event => { if (submitting.current) event.preventDefault() }} onClose={onClose}
    style={{ width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}>
    <div style={{ display: 'grid', gap: 12, padding: 'min(4vw, 20px)' }}>
      <header style={actions}>
        <h2 id={title} style={{ margin: 0, overflowWrap: 'anywhere' }}>{t('antigravityModelsTitle', { provider: name })}</h2>
        <button type="button" autoFocus disabled={saving} onClick={() => dialog.current?.close()}>{t('imageClose')}</button>
      </header>
      <p id={description} className="dsh-subscription-hint">{t('antigravityModelsHint')}</p>
      {error && <p role="alert">{error}</p>}
      {!catalog && !error && <p role="status">{t('modelDefaultsLoading')}</p>}
      {!catalog && error && <button type="button" onClick={() => retry(value => value + 1)}>{t('modelDefaultsRetry')}</button>}
      {catalog && <>
        <fieldset style={{ display: 'grid', gap: 8, margin: 0, minInlineSize: 0 }} disabled={saving}>
          <legend>{t('antigravityModelsList')}</legend>
          {catalog.models.length === 0 && <p>{t('modelDefaultsNoModels')}</p>}
          {catalog.models.map(model => <label key={model.id} style={{ overflowWrap: 'anywhere' }}>
            <input type="checkbox" checked={Object.hasOwn(draft, model.id) ? draft[model.id] : model.enabled} disabled={model.locked}
              onChange={event => { const enabled = event.target.checked; setDraft(previous => ({ ...previous, [model.id]: enabled })) }} />{' '}
            {model.name}{model.locked && ` (${t('antigravityModelsLocked')})`}
          </label>)}
        </fieldset>
        <div style={{ ...actions, justifyContent: 'flex-end' }}>
          <button type="button" disabled={saving || edits.length === 0} onClick={() => { void save() }}>
            {t(saving ? 'modelDefaultsSaving' : 'modelsSave')}
          </button>
        </div>
      </>}
    </div>
  </dialog>
}
