import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import logo from './assets/ruyiai-logo.png'
import { defaultProfileId, llamaServerConfig, modelProfiles, ruyiConfig } from './config'
import { backendClients } from './services/backendClients'
import { availabilityFor, modelIsReady } from './services/backendStatus'
import { resolveLlamaModelId } from './services/llamaClient'
import { useBackendStatus } from './hooks/useBackendStatus'
import { useInferenceRunner } from './hooks/useInferenceRunner'
import { formatMetric, formatNumber, speedupForResults } from './metrics'
import type { EngineStatus } from './services/inferenceRunner'
import type { BackendAvailability, BackendKind, EngineResult, EngineStreamUpdate, InferenceRequest, ModelProfile } from './types'

type Theme = 'light' | 'dark'
type IconName = 'activity' | 'settings' | 'play' | 'stop' | 'refresh' | 'sun' | 'moon' | 'message' | 'compare' | 'info'
const themeStorageKey = 'performance-lab-theme'

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths = {
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    settings: <><path d="M4 7h7m4 0h5M4 17h3m4 0h9" /><circle cx="13" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
    play: <path d="m9 5 11 7-11 7V5Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M20 14a8 8 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z" />,
    message: <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9ZM8 8h8M8 12h5" />,
    compare: <path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  }
  return <svg className={`icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function getInitialTheme(): Theme {
  try {
    const savedTheme = window.localStorage.getItem(themeStorageKey)
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme
  } catch {
    // The default platform theme also works when local storage is unavailable.
  }
  return 'light'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { checking: 'Checking', ready: 'Ready', unavailable: 'Unavailable', running: 'Running', idle: 'Idle', success: 'Completed', completed: 'Completed', failed: 'Failed', error: 'Failed', cancelled: 'Cancelled' }
  return labels[status] ?? status
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{statusLabel(status)}</span>
}

function backendName(backend: BackendKind): string {
  return backend === 'buddy' ? 'Buddy-MLIR' : 'llama.cpp'
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-row" title={`${label}: ${value}`}><dt>{label}</dt><dd>{value}</dd></div>
}

function ResultCard({ backend, result, progress, status }: { backend: BackendKind; result: EngineResult | null; progress: EngineStreamUpdate | null; status: EngineStatus }) {
  const isBuddy = backend === 'buddy'
  const metrics = result?.metrics
  const output = result?.text || progress?.text || ''
  const notice = result?.status === 'error' ? result.error || 'Backend request failed.' : result?.status === 'cancelled' ? 'This run was cancelled.' : null
  const outputPanelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const panel = outputPanelRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [output])

  return (
    <article className={`result-card card-${backend}`} aria-labelledby={`${backend}-heading`}>
      <div className="result-card-header">
        <div className="engine-heading">
          <span className={`engine-logo logo-${backend}`} aria-hidden="true">{isBuddy ? 'B' : 'L'}</span>
          <div><h3 id={`${backend}-heading`}>{backendName(backend)}</h3><p>ENGINE {isBuddy ? '01' : '02'}</p></div>
        </div>
        <StatusBadge status={status} />
      </div>
      <div ref={outputPanelRef} className="output-panel" aria-label={`${backendName(backend)} output`} aria-live="polite" tabIndex={0}>
        {output || notice ? (
          <div className="output-content">
            {notice && <p className="output-notice" role="status">{notice}</p>}
            {output && <p className="result-text">{output}</p>}
          </div>
        ) : (
          <div className="empty-state">
            <span className={`empty-state-icon ${status === 'running' ? 'is-running' : ''}`}><Icon name={status === 'running' ? 'activity' : 'message'} /></span>
            <strong>{status === 'running' ? 'Generating a response…' : 'Ready to run'}</strong>
            <p>{status === 'running' ? 'Generated text will appear here.' : 'Run a model to see its output and performance metrics.'}</p>
          </div>
        )}
      </div>
      <dl className="metrics-grid">
        <Metric label="Input" value={formatNumber(metrics?.promptTokens ?? null, 2)} />
        <Metric label="Output" value={formatNumber(metrics?.completionTokens ?? null, 2)} />
        <Metric label="Total" value={formatNumber(metrics?.totalTokens ?? null, 2)} />
        <Metric label="Latency" value={formatMetric(metrics?.latencyMs ?? null, 'ms', 2)} />
        <Metric label="TTFT" value={formatMetric(metrics?.timeToFirstTokenMs ?? progress?.timeToFirstTokenMs ?? null, 'ms', 2)} />
        <Metric label="Speed" value={formatMetric(metrics?.tokensPerSecond ?? null, 't/s', 2)} />
      </dl>
      <div className="result-card-footer">
        <span>finish reason <strong>{result?.finishReason ?? '—'}</strong></span>
        <span>{metrics?.metricsSource === 'frontend' ? 'Speed: frontend estimate' : metrics?.metricsSource === 'backend' ? 'Speed: backend reported' : 'Speed: unavailable'}</span>
      </div>
    </article>
  )
}

function ProfileSelect({ profiles, value, onChange, disabled }: { profiles: ModelProfile[]; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <label className="field profile-field">
      <span>Model profile</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </label>
  )
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#131b2c' : '#f5f5f5')
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
  const availability = (backend: BackendKind): BackendAvailability => {
    return availabilityFor(backendStatuses[backend], engineStatuses[backend], backendModelId(backend))
  }

  const startRun = (mode: BackendKind | 'comparison') => {
    setFormError('')
    if (!prompt.trim()) { setFormError('Enter a prompt before running.'); return }
    if (mode === 'comparison') {
      if (!selectedProfile || !profileReady) { setFormError('Both inference services must be ready for the selected model. Check the service status.'); return }
    } else if (!selectedProfile || !modelReadyFor(mode)) {
      setFormError(`${backendName(mode)} model is unavailable. Check the service status.`)
      return
    }
    const params: InferenceRequest = { prompt: prompt.trim(), maxOutputTokens, temperature, seed }
    void run(mode, { buddy: selectedProfile.buddyModelId, llama: resolveLlamaModelId(selectedProfile) }, params, streamOutput)
  }

  const speedup = runMode === 'comparison' ? speedupForResults(results.buddy, results.llama) : null
  const hasResults = results.buddy !== null || results.llama !== null
  const summaryText = speedup === null ? 'Run both engines to compare generation speed.' : `Buddy-MLIR generates at ${formatNumber(speedup, 2)}× the speed of llama.cpp.`
  const modeLabel = runMode === 'comparison' ? 'PARALLEL' : runMode === 'buddy' ? 'BUDDY ONLY' : 'LLAMA ONLY'
  const nextThemeLabel = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
  const controlsDisabled = runState === 'running'
  const statusChecking = backendStatuses.buddy.healthStatus === 'checking' || backendStatuses.llama.healthStatus === 'checking'
  const backendErrors = Array.from(new Set([
    backendStatuses.buddy.healthError,
    backendStatuses.buddy.modelsError,
    backendStatuses.llama.healthError,
    backendStatuses.llama.modelsError,
  ].filter(Boolean))).join('; ')
  const anyModelsLoaded = backendStatuses.buddy.modelsLoaded || backendStatuses.llama.modelsLoaded

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-group">
            <a className="brand" href={import.meta.env.BASE_URL} aria-label="RuyiAI Performance Lab home"><img src={logo} alt="RuyiAI" /></a>
            <span className="brand-divider" />
            <h1 className="module-name">Performance Lab</h1>
          </div>
          <button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} aria-label={nextThemeLabel} aria-pressed={theme === 'dark'} title={nextThemeLabel}>
            <Icon name={theme === 'light' ? 'moon' : 'sun'} /><span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
          </button>
        </div>
      </header>

      <main id="main-content" className="main-content">
        <section className="status-strip" aria-label="Service status">
          <div className="status-strip-heading"><span className="section-icon"><Icon name="activity" /></span><h2>RUNTIME STATUS</h2></div>
          <div className="status-items">
            <div className="runtime-status"><span>Buddy-MLIR</span><StatusBadge status={availability('buddy')} /></div>
            <div className="runtime-status"><span>llama.cpp</span><StatusBadge status={availability('llama')} /></div>
          </div>
          <button className="text-button refresh-button" type="button" onClick={() => void refreshStatus()} disabled={statusChecking}>
            <Icon name="refresh" className={statusChecking ? 'is-spinning' : ''} />{statusChecking ? 'Checking' : 'Refresh status'}
          </button>
        </section>
        {backendErrors && <div className="notice-banner" role="alert"><Icon name="info" /><span>{backendErrors}</span><button type="button" className="notice-action" onClick={() => void refreshStatus()}>Retry</button></div>}

        <div className="benchmark-layout">
          <aside className="control-panel" aria-labelledby="configuration-heading">
            <div className="panel-heading"><span className="section-icon"><Icon name="settings" /></span><div><h2 id="configuration-heading">TEST CONFIGURATION</h2><p>Shared generation settings</p></div></div>
            <div className="fields">
              <ProfileSelect profiles={modelProfiles} value={selectedProfileId} onChange={setSelectedProfileId} disabled={controlsDisabled} />
              <label className="field prompt-field">
                <span>Prompt</span>
                <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={controlsDisabled} rows={5} placeholder="Enter a prompt to compare…" aria-describedby="prompt-count" />
                <small id="prompt-count">{prompt.length.toLocaleString()} chars</small>
              </label>
              <div className="parameter-grid">
                <label className="field"><span>Max tokens</span><input id="max-tokens" type="number" min={1} max={4096} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Math.max(1, Number(event.target.value) || 1))} disabled={controlsDisabled} /></label>
                <label className="field"><span>Temperature</span><input id="temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(Math.min(2, Math.max(0, Number(event.target.value) || 0)))} disabled={controlsDisabled} /></label>
                <label className="field"><span>Seed</span><input id="seed" type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value) || 0)} disabled={controlsDisabled} /></label>
              </div>
              <label className="stream-toggle">
                <span className="stream-copy"><span>Streaming output</span><small>Show output as it is generated</small></span>
                <input type="checkbox" role="switch" checked={streamOutput} onChange={(event) => setStreamOutput(event.target.checked)} disabled={controlsDisabled} aria-label="Streaming output" />
                <span className="switch-track" aria-hidden="true" />
              </label>
            </div>
            <div className="control-actions">
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <button className="run-button" type="button" onClick={() => startRun('comparison')} disabled={controlsDisabled || !profileReady}><Icon name={controlsDisabled ? 'activity' : 'compare'} />{controlsDisabled ? 'Running…' : 'Run comparison'}</button>
              {controlsDisabled && <button className="cancel-button" type="button" onClick={cancel}><Icon name="stop" />Cancel run</button>}
              <div className="action-divider"><span>or run one engine</span></div>
              <div className="engine-run-actions" aria-label="Run an individual engine">
                <button className="engine-run-button" type="button" onClick={() => startRun('buddy')} disabled={controlsDisabled || !modelReadyFor('buddy')} aria-label="Run Buddy-MLIR"><Icon name="play" />Buddy-MLIR</button>
                <button className="engine-run-button" type="button" onClick={() => startRun('llama')} disabled={controlsDisabled || !modelReadyFor('llama')} aria-label="Run llama.cpp"><Icon name="play" />llama.cpp</button>
              </div>
              {!profileReady && anyModelsLoaded && <p className="availability-hint">Both models must be ready for a comparison. You can also run an available model individually.</p>}
              <details className="connection-details">
                <summary>Connection details</summary>
                <dl><dt>BUDDY API</dt><dd>{ruyiConfig.baseUrl}</dd><dt>Buddy model</dt><dd>{selectedProfile?.buddyModelId ?? 'Not configured'}</dd><dt>LLAMA API</dt><dd>{llamaServerConfig.baseUrl}</dd><dt>llama model</dt><dd>{backendModelId('llama') || 'Not configured'}</dd></dl>
              </details>
            </div>
          </aside>

          <section className="results-section" aria-labelledby="results-heading">
            <div className="results-heading"><h2 id="results-heading">LIVE RESULTS</h2><span className="result-run-state">{runState === 'idle' ? 'READY TO RUN' : statusLabel(runState)}</span></div>
            <div className="results-grid">
              <ResultCard backend="buddy" result={results.buddy} progress={progress.buddy} status={engineStatuses.buddy} />
              <ResultCard backend="llama" result={results.llama} progress={progress.llama} status={engineStatuses.llama} />
            </div>
            <div className={`summary-card ${hasResults ? 'summary-active' : ''}`}>
              <div className="summary-main"><span className="section-icon"><Icon name="compare" /></span><div><h3>COMPARISON SUMMARY</h3><p>{summaryText}</p></div></div>
              <div className="summary-stats"><div><span>Buddy / llama</span><strong>{speedup === null ? '—' : `${formatNumber(speedup, 2)}×`}</strong></div><div><span>Mode</span><strong className="mode-label">{modeLabel}</strong></div></div>
            </div>
            <p className="disclaimer"><Icon name="info" /><span>Model precision, sampling implementations, and metric sources can affect results. Generation speed is a performance indicator; time to first token may include network and queueing delays.</span></p>
          </section>
        </div>
      </main>
      <footer className="page-footer"><span>RuyiAI · Performance Lab</span><span>Buddy-MLIR × llama.cpp</span></footer>
    </div>
  )
}

export default App
