import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { defaultProfileId, llamaServerConfig, modelProfiles, ruyiConfig } from './config'
import { backendClients } from './services/backendClients'
import { availabilityFor, modelIsReady } from './services/backendStatus'
import { resolveLlamaModelId } from './services/llamaClient'
import { useBackendStatus } from './hooks/useBackendStatus'
import { useInferenceRunner } from './hooks/useInferenceRunner'
import { formatMetric, formatNumber, speedupForResults } from './metrics'
import type { EngineStatus } from './services/inferenceRunner'
import type { BackendAvailability, BackendKind, EngineResult, EngineStreamUpdate, InferenceRequest, ModelProfile } from './types'

type Availability = BackendAvailability
type Theme = 'light' | 'dark'
const themeStorageKey = 'performance-lab-theme'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const savedTheme = window.localStorage.getItem(themeStorageKey)
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
  } catch {
    // Local storage can be unavailable in privacy-restricted browsers.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { checking: '检查中', ready: '就绪', unavailable: '不可用', running: '运行中', idle: '待运行', success: '已完成', completed: '已完成', failed: '失败', error: '失败', cancelled: '已取消' }
  return labels[status] ?? status
}

function statusClass(status: Availability | EngineStatus): string {
  return `status-pill status-${status}`
}

function backendName(backend: BackendKind): string {
  return backend === 'buddy' ? 'Buddy-MLIR' : 'llama.cpp'
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-row"><dt>{label}</dt><dd>{value}</dd></div>
}

function ResultCard({ backend, result, progress, status }: { backend: BackendKind; result: EngineResult | null; progress: EngineStreamUpdate | null; status: EngineStatus }) {
  const isBuddy = backend === 'buddy'
  const metrics = result?.metrics
  const output = result?.text || progress?.text || ''
  const notice = result?.status === 'error' ? result.error || '后端请求失败' : result?.status === 'cancelled' ? '本次请求已取消' : null
  return (
    <article className={`result-card ${isBuddy ? 'card-buddy' : 'card-llama'}`}>
      <div className="result-card-header">
        <div className="engine-heading">
          <span className={`engine-logo ${isBuddy ? 'logo-buddy' : 'logo-llama'}`} aria-hidden="true">{isBuddy ? 'B' : 'L'}</span>
          <div><p className="card-kicker">ENGINE {isBuddy ? '01' : '02'}</p><h2>{backendName(backend)}</h2></div>
        </div>
        <span className={statusClass(status)}>{statusLabel(status)}</span>
      </div>
      <div className="output-panel" aria-live="polite">
        {output || notice ? <div className="output-content">{notice && <p className="output-notice" role="status">{notice}</p>}{output && <p className="result-text">{output}</p>}</div> : <div className="empty-state"><span className="state-icon">↗</span><p>{status === 'running' ? '正在生成回答…' : '运行后端或对比，结果会显示在这里'}</p></div>}
      </div>
      <dl className="metrics-grid">
        <Metric label="输入 tokens" value={formatNumber(metrics?.promptTokens ?? null, 0)} />
        <Metric label="输出 tokens" value={formatNumber(metrics?.completionTokens ?? null, 0)} />
        <Metric label="总 tokens" value={formatNumber(metrics?.totalTokens ?? null, 0)} />
        <Metric label="总延迟" value={formatMetric(metrics?.latencyMs ?? null, 'ms', 0)} />
        <Metric label="首 token" value={formatMetric(metrics?.timeToFirstTokenMs ?? progress?.timeToFirstTokenMs ?? null, 'ms', 0)} />
        <Metric label="Tokens / s" value={formatMetric(metrics?.tokensPerSecond ?? null, 't/s', 1)} />
      </dl>
      <div className="result-card-footer"><span>finish reason</span><strong>{result?.finishReason ?? '—'}</strong>{metrics?.metricsSource === 'frontend' && <em>tokens/s 为前端计算</em>}</div>
    </article>
  )
}

function ProfileSelect({ profiles, value, onChange, disabled }: { profiles: ModelProfile[]; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return <label className="field profile-field"><span>模型 profile</span><select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
}

function App() {
  const defaultProfile = modelProfiles.find((profile) => profile.id === defaultProfileId) ?? modelProfiles[0]
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfile?.id ?? '')
  const selectedProfile = useMemo(() => modelProfiles.find((profile) => profile.id === selectedProfileId) ?? defaultProfile, [defaultProfile, selectedProfileId])
  const [prompt, setPrompt] = useState('Explain how MLIR can improve local LLM inference in three concise points.')
  const [maxOutputTokens, setMaxOutputTokens] = useState(128)
  const [temperature, setTemperature] = useState(0)
  const [seed, setSeed] = useState(42)
  const [streamOutput, setStreamOutput] = useState(false)
  const { statuses: backendStatuses, refreshStatus } = useBackendStatus(backendClients)
  const { engineStatuses, results, progress, runState, runMode, run, cancel } = useInferenceRunner(backendClients)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#11171d' : '#f5f7f8')
    try {
      window.localStorage.setItem(themeStorageKey, theme)
    } catch {
      // The selected theme still applies for the current page session.
    }
  }, [theme])

  const backendModelId = (backend: BackendKind) => selectedProfile
    ? backend === 'buddy'
      ? selectedProfile.buddyModelId
      : resolveLlamaModelId(selectedProfile)
    : ''
  const modelReadyFor = (backend: BackendKind) => {
    const modelId = backendModelId(backend)
    return modelId && backendStatuses[backend].healthStatus === 'ready'
      ? modelIsReady(backendStatuses[backend], modelId)
      : false
  }
  const profileReady = selectedProfile ? modelReadyFor('buddy') && modelReadyFor('llama') : false
  const availability = (backend: BackendKind): Availability => {
    return availabilityFor(backendStatuses[backend], engineStatuses[backend], backendModelId(backend))
  }

  const startRun = (mode: BackendKind | 'comparison') => {
    setFormError('')
    if (!prompt.trim()) { setFormError('请输入 Prompt 后再运行。'); return }
    if (mode === 'comparison') {
      if (!selectedProfile || !profileReady) { setFormError('当前 profile 的两个后端模型都不可用，请检查两侧服务的 /v1/models。'); return }
    } else if (!selectedProfile || !modelReadyFor(mode)) {
      setFormError(`${backendName(mode)} 模型不可用，请检查对应服务的 /v1/models。`)
      return
    }
    const params: InferenceRequest = { prompt: prompt.trim(), maxOutputTokens, temperature, seed }
    void run(mode, { buddy: selectedProfile.buddyModelId, llama: resolveLlamaModelId(selectedProfile) }, params, streamOutput)
  }

  const speedup = runMode === 'comparison' ? speedupForResults(results.buddy, results.llama) : null
  const hasResults = results.buddy !== null || results.llama !== null
  const summaryText = speedup === null ? '完成两侧推理后，这里会显示速度倍率。' : speedup >= 1 ? `Buddy-MLIR 快 ${formatNumber(speedup, 2)}x` : `llama.cpp 快 ${formatNumber(1 / speedup, 2)}x`
  const modeLabel = runMode === 'comparison' ? 'SEQUENTIAL' : runMode === 'buddy' ? 'BUDDY ONLY' : 'LLAMA ONLY'
  const nextThemeLabel = theme === 'light' ? '切换到黑夜模式' : '切换到白天模式'
  const controlsDisabled = runState === 'running'
  const statusChecking = backendStatuses.buddy.healthStatus === 'checking' || backendStatuses.llama.healthStatus === 'checking'
  const backendErrors = [
    backendStatuses.buddy.healthError,
    backendStatuses.buddy.modelsError,
    backendStatuses.llama.healthError,
    backendStatuses.llama.modelsError,
  ].filter(Boolean).join('；')
  const anyModelsLoaded = backendStatuses.buddy.modelsLoaded || backendStatuses.llama.modelsLoaded

  return (
    <div className="app-shell">
      <header className="topbar"><a className="wordmark" href="/" aria-label="Performance Lab home"><span className="wordmark-mark">⌁</span><span>PERFORMANCE LAB</span></a><div className="topbar-actions"><div className="topbar-meta"><span className="api-url"><span className="meta-label">BUDDY API</span> {ruyiConfig.baseUrl}</span><span className="topbar-divider" aria-hidden="true" /><span className="api-url"><span className="meta-label">LLAMA API</span> {llamaServerConfig.baseUrl}</span><span className="topbar-divider" aria-hidden="true" /><span className="live-dot" /> LOCAL / SINGLE REQUEST</div><button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} aria-label={nextThemeLabel} aria-pressed={theme === 'dark'} title={nextThemeLabel}><span className="theme-track" aria-hidden="true"><span className="theme-thumb">{theme === 'light' ? '☀' : '☾'}</span></span><span className="theme-label">{theme === 'light' ? '白天' : '黑夜'}</span></button></div></header>
      <main>
        <section className="status-strip" aria-label="服务状态"><div className="status-strip-heading"><span className="section-index">01</span><span>RUNTIME STATUS</span></div><div className="status-items"><div className="runtime-status"><span className="runtime-label">BUDDY-MLIR</span><span className={statusClass(availability('buddy'))}>{statusLabel(availability('buddy'))}</span></div><div className="runtime-status"><span className="runtime-label">LLAMA.CPP</span><span className={statusClass(availability('llama'))}>{statusLabel(availability('llama'))}</span></div><button className="text-button" type="button" onClick={() => void refreshStatus()} disabled={statusChecking}><span className="refresh-icon" aria-hidden="true">↻</span> 刷新状态</button></div></section>
        {backendErrors && <div className="notice-banner" role="alert"><span className="notice-mark">!</span><span>{backendErrors}</span><button type="button" className="notice-action" onClick={() => void refreshStatus()}>重试</button></div>}
        <section className="benchmark-layout"><aside className="control-panel">
          <div className="panel-heading"><div><span className="section-index">02</span><span className="panel-label">TEST CONFIGURATION</span></div><span className="config-tag">TEXT / 01</span></div>
          <div className="fields">
            <ProfileSelect profiles={modelProfiles} value={selectedProfileId} onChange={setSelectedProfileId} disabled={controlsDisabled} />
            <div className="profile-ids"><span>{selectedProfile?.buddyModelId ?? '未配置'}</span><span>{backendModelId('llama') || '未配置'}</span></div>
            <label className="field prompt-field"><span>Prompt</span><textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={controlsDisabled} rows={4} placeholder="输入一段要比较的文本…" /><small>{prompt.length.toLocaleString()} / 32,768 chars</small></label>
            <div className="parameter-grid">
              <label className="field"><span>Max tokens</span><input id="max-tokens" type="number" min={1} max={4096} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Math.max(1, Number(event.target.value) || 1))} disabled={controlsDisabled} /></label>
              <label className="field"><span>Temperature</span><input id="temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Math.min(2, Math.max(0, Number(event.target.value) || 0)))} disabled={controlsDisabled} /></label>
              <label className="field"><span>Seed</span><input id="seed" type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 0)} disabled={controlsDisabled} /></label>
            </div>
            <label className="stream-toggle"><input type="checkbox" checked={streamOutput} onChange={(event) => setStreamOutput(event.target.checked)} disabled={controlsDisabled} /><span>Buddy / llama 流式输出</span></label>
          </div>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <div className="engine-run-actions" aria-label="单独运行后端">
            <button className="engine-run-button engine-run-buddy" type="button" onClick={() => startRun('buddy')} disabled={controlsDisabled || !modelReadyFor('buddy')}><span>{engineStatuses.buddy === 'running' ? '运行中…' : '运行 Buddy-MLIR'}</span><span className="button-arrow" aria-hidden="true">↗</span></button>
            <button className="engine-run-button engine-run-llama" type="button" onClick={() => startRun('llama')} disabled={controlsDisabled || !modelReadyFor('llama')}><span>{engineStatuses.llama === 'running' ? '运行中…' : '运行 llama.cpp'}</span><span className="button-arrow" aria-hidden="true">↗</span></button>
          </div>
          <button className="run-button" type="button" onClick={() => startRun('comparison')} disabled={controlsDisabled || !profileReady}><span>{runState === 'running' ? '正在运行…' : '运行对比'}</span><span className="button-arrow" aria-hidden="true">↗</span></button>
          {runState === 'running' && <button className="cancel-button" type="button" onClick={cancel}>取消本次运行</button>}
          {!profileReady && anyModelsLoaded && <p className="availability-hint">运行对比需要同时注册两个后端模型；也可以使用上方按钮单独运行可用后端。</p>}
        </aside>
          <section className="results-section"><div className="results-heading"><div><span className="section-index">03</span><span className="panel-label">LIVE RESULTS</span></div><span className="result-run-state">{runState === 'idle' ? 'READY TO RUN' : statusLabel(runState)}</span></div><div className="results-grid"><ResultCard backend="buddy" result={results.buddy} progress={progress.buddy} status={engineStatuses.buddy} /><ResultCard backend="llama" result={results.llama} progress={progress.llama} status={engineStatuses.llama} /></div><div className={`summary-card ${hasResults ? 'summary-active' : ''}`}><div className="summary-main"><span className="summary-icon" aria-hidden="true">≈</span><div><p className="card-kicker">COMPARISON SUMMARY</p><strong>{summaryText}</strong></div></div><div className="summary-stats"><div><span>Buddy / llama</span><strong>{speedup === null ? '—' : `${formatNumber(speedup, 2)}x`}</strong></div><div><span>模式</span><strong>{modeLabel}</strong></div></div></div><p className="disclaimer">结果来自独立的 ruyi-serving 与 llama-server 请求。不同运行时、采样实现或模型精度可能产生不同文本；速度数据用于性能观察，不代表模型质量结论。</p></section></section>
      </main>
      <footer className="page-footer"><span>MLIR × GGML</span><span>LOCAL INFERENCE / 2026</span></footer>
    </div>
  )
}

export default App
