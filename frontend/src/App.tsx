import React, { useEffect, useState } from 'react'
import {
  DownloadJob,
  ExtractedParameter,
  formatBytes,
  RunRecord,
  TemplateDetailResponse,
  TemplateSummary,
} from './api'
import { Model3DViewer } from './Model3DViewer'

export function App() {
  const [health, setHealth] = useState<any>(null)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [statusFilter, setStatusFilter] = useState<string>('local')
  const [categoryFilter, setCategoryFilter] = useState<string>('All')
  const [searchQuery, setSearchQuery] = useState<string>('')

  const [selectedId, setSelectedId] = useState<string>('image_z_image_turbo')
  const [detail, setDetail] = useState<TemplateDetailResponse | null>(null)
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false)

  const [fieldValues, setFieldValues] = useState<Record<string, any>>({})
  const [showDetails, setShowDetails] = useState<boolean>(false)
  const [installingTemplate, setInstallingTemplate] = useState<boolean>(false)
  const [startingDownloads, setStartingDownloads] = useState<boolean>(false)

  const [activeRun, setActiveRun] = useState<RunRecord | null>(null)
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false)
  const [hfTokenInput, setHfTokenInput] = useState<string>('')
  const [settingsInfo, setSettingsInfo] = useState<any>(null)

  const [segmentMode, setSegmentMode] = useState<boolean>(false)
  const [segmentSeconds, setSegmentSeconds] = useState<number>(10)

  const [urlInputs, setUrlInputs] = useState<Record<string, string>>({})
  const [importingUrlKey, setImportingUrlKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  // Fetch health & runs on mount
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {})
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setSettingsInfo)
      .catch(() => {})
    refreshRuns()
  }, [])

  // Fetch templates catalog when filters change
  const refreshCatalog = () => {
    const params = new URLSearchParams()
    if (statusFilter && statusFilter !== 'all') {
      if (statusFilter === 'installed') {
        params.set('installed_only', 'true')
      } else if (statusFilter === 'favorites') {
        params.set('favorites_only', 'true')
      } else {
        params.set('status', statusFilter)
      }
    }
    if (categoryFilter && categoryFilter !== 'All') {
      params.set('category', categoryFilter)
    }
    if (searchQuery.trim()) {
      params.set('q', searchQuery.trim())
    }
    fetch(`/api/templates?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setTemplates(data.templates || [])
        setCategories(['All', ...(data.categories || [])])
        setCounts(data.counts || {})
      })
      .catch(() => {})
  }

  useEffect(() => {
    refreshCatalog()
  }, [statusFilter, categoryFilter, searchQuery])

  // Load selected template detail
  const loadTemplateDetail = async (templateId: string, preserveFields = false) => {
    if (!preserveFields) setLoadingDetail(true)
    setActionError(null)
    try {
      const resp = await fetch(`/api/templates/${templateId}`)
      if (!resp.ok) throw new Error(`Failed to load template ${templateId}`)
      const data: TemplateDetailResponse = await resp.json()
      setDetail(data)
      if (!preserveFields) {
        const defaults: Record<string, any> = {}
        for (const p of data.parameters) {
          defaults[p.key] = p.default
        }
        setFieldValues(defaults)
      }
    } catch (err: any) {
      setActionError(err.message || String(err))
    } finally {
      setLoadingDetail(false)
    }
  }

  useEffect(() => {
    if (selectedId) {
      loadTemplateDetail(selectedId, false)
    }
  }, [selectedId])

  // Poll active downloads if any are queued/downloading
  useEffect(() => {
    if (!detail) return
    const hasActiveDl = (detail.downloads || []).some((d) =>
      ['queued', 'downloading'].includes(d.status),
    )
    if (!hasActiveDl) return
    const timer = setInterval(() => {
      loadTemplateDetail(detail.template.id, true)
    }, 1000)
    return () => clearInterval(timer)
  }, [detail])

  // Poll active run if queued/running/submitting
  useEffect(() => {
    if (!activeRun || !['submitting', 'queued', 'running'].includes(activeRun.status)) {
      return
    }
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/runs/${activeRun.id}`)
        if (r.ok) {
          const updated: RunRecord = await r.json()
          setActiveRun(updated)
          if (['completed', 'failed', 'cancelled'].includes(updated.status)) {
            refreshRuns()
          }
        }
      } catch {}
    }, 800)
    return () => clearInterval(timer)
  }, [activeRun])

  const refreshRuns = async () => {
    try {
      const r = await fetch('/api/runs?limit=30')
      if (r.ok) {
        const data = await r.json()
        setRuns(data.runs || [])
      }
    } catch {}
  }

  const handleInstallTemplate = async () => {
    if (!detail) return
    setInstallingTemplate(true)
    setActionError(null)
    try {
      const r = await fetch(`/api/templates/${detail.template.id}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_overrides: fieldValues }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed to install template')
      await loadTemplateDetail(detail.template.id, true)
    } catch (err: any) {
      setActionError(err.message || String(err))
    } finally {
      setInstallingTemplate(false)
    }
  }

  const handleDownloadMissingModels = async (specificKey?: string) => {
    if (!detail) return
    setStartingDownloads(true)
    setActionError(null)
    try {
      const keys = specificKey
        ? [specificKey]
        : detail.template.models.filter((m) => !m.installed).map((m) => m.key)
      const r = await fetch('/api/models/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: detail.template.id,
          model_keys: keys,
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed to start model downloads')
      if (data.errors && data.errors.length > 0) {
        setActionError(data.errors.map((e: any) => `${e.model}: ${e.error}`).join('; '))
      }
      await loadTemplateDetail(detail.template.id, true)
    } catch (err: any) {
      setActionError(err.message || String(err))
    } finally {
      setStartingDownloads(false)
    }
  }

  const handleCancelDownload = async (dlId: string) => {
    await fetch(`/api/downloads/${dlId}/cancel`, { method: 'POST' })
    if (detail) await loadTemplateDetail(detail.template.id, true)
  }

  const handleUploadMedia = async (paramKey: string, file: File) => {
    setActionError(null)
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'png'
    const normalizedFile =
      !file.name || file.name === 'image.png' || file.name === 'blob'
        ? new File([file], `pasted_${Date.now()}.${ext}`, { type: file.type || 'image/png' })
        : file
    const form = new FormData()
    form.append('file', normalizedFile)
    try {
      const r = await fetch('/api/assets', { method: 'POST', body: form })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Upload failed')
      setFieldValues((prev) => ({ ...prev, [paramKey]: data.filename }))
    } catch (err: any) {
      setActionError(err.message || String(err))
    }
  }

  const handleImportUrl = async (paramKey: string, rawUrl?: string) => {
    const targetUrl = (rawUrl ?? urlInputs[paramKey] ?? '').trim()
    if (!targetUrl) return
    setActionError(null)
    setImportingUrlKey(paramKey)
    try {
      const r = await fetch('/api/assets/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'URL import failed')
      setFieldValues((prev) => ({ ...prev, [paramKey]: data.filename }))
      setUrlInputs((prev) => ({ ...prev, [paramKey]: '' }))
    } catch (err: any) {
      setActionError(err.message || String(err))
    } finally {
      setImportingUrlKey(null)
    }
  }

  const handleDropMedia = async (paramKey: string, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverKey(null)

    const droppedFile = e.dataTransfer?.files?.[0]
    if (droppedFile) {
      await handleUploadMedia(paramKey, droppedFile)
      return
    }

    const uriList = e.dataTransfer?.getData('text/uri-list') || ''
    const htmlData = e.dataTransfer?.getData('text/html') || ''
    const plainText = e.dataTransfer?.getData('text/plain') || ''

    let extractedUrl = uriList.split('\n').find((line) => line.startsWith('http'))?.trim() || ''
    if (!extractedUrl && htmlData) {
      const imgMatch = htmlData.match(/<img[^>]+src=["']([^"']+)["']/i)
      if (imgMatch?.[1]) {
        extractedUrl = imgMatch[1].replace(/&amp;/g, '&')
      }
    }
    if (!extractedUrl && /^https?:\/\//i.test(plainText.trim())) {
      extractedUrl = plainText.trim()
    }
    if (extractedUrl) {
      await handleImportUrl(paramKey, extractedUrl)
    }
  }

  const handlePasteOnMediaInput = async (paramKey: string, e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) {
            e.preventDefault()
            await handleUploadMedia(paramKey, f)
            return
          }
        }
      }
    }
    const pastedText = e.clipboardData?.getData('text/plain')?.trim() || ''
    if (/^https?:\/\//i.test(pastedText)) {
      e.preventDefault()
      setUrlInputs((prev) => ({ ...prev, [paramKey]: pastedText }))
      await handleImportUrl(paramKey, pastedText)
    }
  }

  // Global Ctrl+V paste handler when a template has an image/video input and user isn't typing in a text prompt
  useEffect(() => {
    if (!detail) return
    const mediaParam = detail.parameters.find((p) =>
      ['image', 'video', 'audio'].includes(p.param_type),
    )
    if (!mediaParam) return

    const onWindowPaste = (e: ClipboardEvent) => {
      const activeEl = document.activeElement
      if (
        activeEl &&
        (activeEl.tagName === 'TEXTAREA' ||
          (activeEl.tagName === 'INPUT' &&
            (activeEl as HTMLInputElement).dataset.mediaUrlInput !== 'true'))
      ) {
        return
      }
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) {
            e.preventDefault()
            handleUploadMedia(mediaParam.key, f)
            return
          }
        }
      }
    }
    window.addEventListener('paste', onWindowPaste)
    return () => window.removeEventListener('paste', onWindowPaste)
  }, [detail])

  const handleToggleFavorite = async (templateId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    try {
      const r = await fetch(`/api/templates/${templateId}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (r.ok) {
        const data = await r.json()
        const isFav = Boolean(data.favorite)
        setTemplates((prev) =>
          prev.map((t) => (t.id === templateId ? { ...t, favorite: isFav } : t)),
        )
        if (detail && detail.template.id === templateId) {
          setDetail({
            ...detail,
            template: { ...detail.template, favorite: isFav },
          })
        }
        refreshCatalog()
      }
    } catch {}
  }

  const handleGenerate = async () => {
    if (!detail) return
    setActionError(null)
    const hasVideoInput = detail.parameters.some((p) => p.param_type === 'video')
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: detail.template.id,
          fields: fieldValues,
          segment_seconds: hasVideoInput && segmentMode ? segmentSeconds : null,
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.detail || 'Failed to start generation')
      setActiveRun(data)
      refreshRuns()
    } catch (err: any) {
      setActionError(err.message || String(err))
    }
  }

  const handleCancelRun = async (runId: string) => {
    const r = await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' })
    if (r.ok) {
      const updated = await r.json()
      setActiveRun(updated)
      refreshRuns()
    }
  }

  const handleDeleteRun = async (runId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const r = await fetch(`/api/runs/${runId}`, { method: 'DELETE' })
    if (r.ok) {
      setRuns((prev) => prev.filter((item) => item.id !== runId))
      setActiveRun((prev) => (prev?.id === runId ? null : prev))
    }
  }

  const handleRemixRun = (run: RunRecord) => {
    if (run.template_id !== selectedId) {
      setSelectedId(run.template_id)
    }
    setFieldValues((prev) => ({ ...prev, ...(run.fields || {}) }))
    setActiveRun(run)
  }

  const handleDownloadWorkflowJson = () => {
    if (!detail) return
    const blob = new Blob([JSON.stringify(detail.editor_workflow, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${detail.template.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSaveSettings = async () => {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hf_token: hfTokenInput }),
    })
    if (r.ok) {
      setSettingsInfo(await r.json())
      setHfTokenInput('')
      setShowSettingsModal(false)
    }
  }

  const renderParameterInput = (param: ExtractedParameter) => {
    const val = fieldValues[param.key] ?? param.default ?? ''

    if (param.param_type === 'multiline') {
      return (
        <div key={param.key} className="field-group">
          <div className="field-label">
            <span>{param.label}</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {param.node_title}
            </span>
          </div>
          <textarea
            className="field-textarea"
            value={String(val)}
            onChange={(e) => setFieldValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
            placeholder={`Enter ${param.label.toLowerCase()}...`}
          />
        </div>
      )
    }

    if (param.param_type === 'image' || param.param_type === 'video' || param.param_type === 'audio') {
      const previewUrl =
        val && detail
          ? `/api/view?filename=${encodeURIComponent(String(val))}&type=input`
          : null
      const fallbackAssetUrl =
        val && detail
          ? `/api/templates/${detail.template.id}/assets/${encodeURIComponent(String(val))}`
          : null
      const isDragOver = dragOverKey === param.key
      const isImportingUrl = importingUrlKey === param.key

      return (
        <div
          key={param.key}
          className="field-group"
          onDragOver={(e) => {
            e.preventDefault()
            if (dragOverKey !== param.key) setDragOverKey(param.key)
          }}
          onDragLeave={() => {
            if (dragOverKey === param.key) setDragOverKey(null)
          }}
          onDrop={(e) => handleDropMedia(param.key, e)}
          onPaste={(e) => handlePasteOnMediaInput(param.key, e)}
          style={{
            padding: '0.7rem',
            borderRadius: 8,
            border: isDragOver ? '1px dashed #60a5fa' : '1px dashed var(--border)',
            background: isDragOver ? 'rgba(59, 130, 246, 0.12)' : 'rgba(15, 23, 42, 0.35)',
            transition: 'all 0.15s ease',
          }}
        >
          <div className="field-label" style={{ marginBottom: '0.45rem' }}>
            <span>{param.label}</span>
            <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              {String(val)} • Drop file/photo or press Ctrl+V to paste
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {val && param.param_type === 'image' && (
              <img
                key={String(val)}
                src={previewUrl || fallbackAssetUrl || ''}
                onError={(e) => {
                  const img = e.currentTarget
                  if (fallbackAssetUrl && !img.src.endsWith(fallbackAssetUrl)) {
                    img.src = fallbackAssetUrl
                  } else if (
                    detail?.template.thumbnail_url &&
                    !img.src.endsWith(detail.template.thumbnail_url)
                  ) {
                    img.src = detail.template.thumbnail_url
                  } else {
                    img.style.display = 'none'
                  }
                }}
                alt=""
                style={{
                  width: 72,
                  height: 72,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              />
            )}
            {val && param.param_type === 'video' && (previewUrl || fallbackAssetUrl) && (
              <video
                key={String(val)}
                src={previewUrl || fallbackAssetUrl || ''}
                onError={(e) => {
                  const vid = e.currentTarget
                  if (fallbackAssetUrl && !vid.src.endsWith(fallbackAssetUrl)) {
                    vid.src = fallbackAssetUrl
                  } else {
                    vid.style.display = 'none'
                  }
                }}
                muted
                loop
                autoPlay
                style={{
                  width: 110,
                  height: 72,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              />
            )}
            <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
              Upload {param.param_type}
              <input
                type="file"
                style={{ display: 'none' }}
                accept={
                  param.param_type === 'image'
                    ? 'image/*'
                    : param.param_type === 'video'
                      ? 'video/*'
                      : param.param_type === 'audio'
                        ? 'audio/*'
                        : '*/*'
                }
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleUploadMedia(param.key, f)
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: '0.4rem', flex: 1, minWidth: 220 }}>
              <input
                type="url"
                className="field-input"
                data-media-url-input="true"
                placeholder="Paste Google Photos / image URL or Ctrl+V copied image..."
                value={urlInputs[param.key] || ''}
                onChange={(e) =>
                  setUrlInputs((prev) => ({ ...prev, [param.key]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleImportUrl(param.key)
                  }
                }}
                style={{ flex: 1, padding: '0.4rem 0.65rem', fontSize: '0.8rem' }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={isImportingUrl || !(urlInputs[param.key] || '').trim()}
                onClick={() => handleImportUrl(param.key)}
                style={{ padding: '0.4rem 0.75rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {isImportingUrl ? 'Importing...' : 'Import URL'}
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (param.param_type === 'combo' && param.options && param.options.length > 0) {
      return (
        <div key={param.key} className="field-group" style={{ marginBottom: 0 }}>
          <div className="field-label">
            <span>{param.label}</span>
          </div>
          <select
            className="field-select"
            value={String(val)}
            onChange={(e) => setFieldValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
          >
            {param.options.map((opt) => (
              <option key={String(opt)} value={String(opt)}>
                {String(opt)}
              </option>
            ))}
          </select>
        </div>
      )
    }

    if (param.param_type === 'boolean') {
      return (
        <div key={param.key} className="field-group" style={{ marginBottom: 0 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.84rem',
              cursor: 'pointer',
              paddingTop: '1.2rem',
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(val)}
              onChange={(e) =>
                setFieldValues((prev) => ({ ...prev, [param.key]: e.target.checked }))
              }
            />
            {param.label}
          </label>
        </div>
      )
    }

    const isSeed = param.input_name === 'seed' || param.input_name === 'noise_seed'
    const isNumeric = param.param_type === 'int' || param.param_type === 'float'

    return (
      <div key={param.key} className="field-group" style={{ marginBottom: 0 }}>
        <div className="field-label">
          <span>{param.label}</span>
          {isSeed && (
            <button
              type="button"
              className="chip"
              style={{ padding: '0.1rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() =>
                setFieldValues((prev) => ({
                  ...prev,
                  [param.key]: Math.floor(Math.random() * 1000000000000),
                }))
              }
            >
              Randomize
            </button>
          )}
        </div>
        <input
          className="field-input"
          type={isNumeric ? 'number' : 'text'}
          step={param.param_type === 'float' ? param.step || 0.05 : 1}
          min={param.min ?? undefined}
          max={param.max ?? undefined}
          value={val}
          onChange={(e) => {
            const raw = e.target.value
            const parsed =
              param.param_type === 'int'
                ? parseInt(raw || '0', 10)
                : param.param_type === 'float'
                  ? parseFloat(raw || '0')
                  : raw
            setFieldValues((prev) => ({ ...prev, [param.key]: parsed }))
          }}
        />
      </div>
    )
  }

  const latestDownloadForModel = (modelKey: string): DownloadJob | undefined => {
    if (!detail?.downloads) return undefined
    return detail.downloads.find((d) => d.model_key === modelKey)
  }

  return (
    <div className="studio-shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-badge">Studio</span>
          <span>ComfyUI Template Workspace</span>
        </div>
        <div className="status-pills">
          <div className="pill">
            <span className={`dot ${health?.comfyui_online ? 'online' : 'offline'}`} />
            <span>
              ComfyUI {health?.comfyui_system?.system?.comfyui_version || '8188'}
            </span>
          </div>
          {health?.disk && (
            <div className="pill" title="Free space on /Beta/ComfyUI/models">
              <span>Models Disk Free: {formatBytes(health.disk.free_bytes)}</span>
            </div>
          )}
          <button
            className="btn btn-secondary"
            style={{ padding: '0.32rem 0.7rem', fontSize: '0.78rem' }}
            onClick={() => setShowSettingsModal(true)}
          >
            Tokens & Settings {settingsInfo?.has_hf_token ? '✓' : ''}
          </button>
        </div>
      </header>

      <div className="main-layout">
        {/* Column 1: Template Catalog */}
        <aside className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>1. Select Template</span>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {templates.length} shown
              </span>
            </div>
            <input
              className="search-input"
              type="search"
              placeholder="Search 650+ templates (e.g. z-image, qwen, flux, wan)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="filter-row" style={{ marginBottom: '0.45rem' }}>
              {[
                { id: 'favorites', label: `★ Favorites (${counts.favorites || 0})` },
                { id: 'local', label: `Local (${(counts.ready || 0) + (counts.needs_models || 0)})` },
                { id: 'ready', label: `Ready Now (${counts.ready || 0})` },
                { id: 'installed', label: `Installed (${counts.installed || 0})` },
                { id: 'all', label: `All (${counts.total || 0})` },
              ].map((tab) => (
                <button
                  key={tab.id}
                  className={`chip ${statusFilter === tab.id ? 'active' : ''}`}
                  onClick={() => setStatusFilter(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="filter-row">
              {categories.slice(0, 7).map((cat) => (
                <button
                  key={cat}
                  className={`chip ${categoryFilter === cat ? 'active' : ''}`}
                  onClick={() => setCategoryFilter(cat)}
                >
                  {cat.replace(' templates', '')}
                </button>
              ))}
            </div>
          </div>

          <div className="template-list">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`template-card ${selectedId === t.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                {t.thumbnail_url ? (
                  <img
                    className="template-thumb"
                    src={t.thumbnail_url}
                    alt={t.title}
                    loading="lazy"
                  />
                ) : (
                  <div className="template-thumb" />
                )}
                <div className="template-card-body">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '0.35rem',
                    }}
                  >
                    <h4 className="template-card-title" style={{ flex: 1 }}>
                      {t.title}
                    </h4>
                    <button
                      type="button"
                      onClick={(e) => handleToggleFavorite(t.id, e)}
                      title={t.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '0 0.15rem',
                        fontSize: '1.05rem',
                        lineHeight: 1,
                        color: t.favorite ? '#facc15' : 'var(--text-muted)',
                      }}
                    >
                      {t.favorite ? '★' : '☆'}
                    </button>
                  </div>
                  <p className="template-card-desc">{t.description || t.id}</p>
                  <div className="badge-row">
                    <span className={`status-badge ${t.status}`}>
                      {t.status === 'ready'
                        ? 'Ready'
                        : t.status === 'needs_models'
                          ? `Needs ${t.missing_models.length} Model(s)`
                          : t.status === 'needs_nodes'
                            ? 'Needs Custom Nodes'
                            : 'Cloud API'}
                    </span>
                    {t.installed && <span className="status-badge installed">Installed</span>}
                    {t.estimated_size_bytes > 0 && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        {formatBytes(t.estimated_size_bytes)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Column 2: 4-Step Workspace (Install Template -> Download Models -> Prompt & Details -> Generate) */}
        <main className="workspace-scroll">
          {actionError && (
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.16)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#fca5a5',
                fontSize: '0.85rem',
              }}
            >
              {actionError}
            </div>
          )}

          {loadingDetail || !detail ? (
            <div className="step-card">Loading template inspection...</div>
          ) : (
            <>
              {/* STEP 1: Install Template */}
              <section className="step-card">
                <div className="step-header">
                  <h3 className="step-title">
                    <span className="step-num">1</span>
                    <span>{detail.template.title}</span>
                    <button
                      type="button"
                      onClick={(e) => handleToggleFavorite(detail.template.id, e)}
                      title={
                        detail.template.favorite
                          ? 'Remove template from Favorites'
                          : 'Mark template as Favorite'
                      }
                      style={{
                        background: 'rgba(250, 204, 21, 0.1)',
                        border: '1px solid rgba(250, 204, 21, 0.35)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        padding: '0.15rem 0.45rem',
                        fontSize: '0.85rem',
                        color: detail.template.favorite ? '#facc15' : 'var(--text-muted)',
                      }}
                    >
                      {detail.template.favorite ? '★ Favorited' : '☆ Favorite'}
                    </button>
                    <span className={`status-badge ${detail.template.status}`}>
                      {detail.template.status.replace('_', ' ')}
                    </span>
                  </h3>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={handleDownloadWorkflowJson}
                      title="Download original ComfyUI workflow JSON"
                    >
                      Export Graph JSON
                    </button>
                    <button
                      className={`btn ${detail.template.installed ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={handleInstallTemplate}
                      disabled={installingTemplate}
                    >
                      {installingTemplate
                        ? 'Installing...'
                        : detail.template.installed
                          ? '✓ Template Installed (Re-sync)'
                          : 'Install Template'}
                    </button>
                  </div>
                </div>
                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.86rem', color: 'var(--text-muted)' }}>
                  {detail.template.description}
                </p>
                {detail.template.missing_nodes.length > 0 && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.6rem',
                      borderRadius: 6,
                      background: 'rgba(239, 68, 68, 0.12)',
                      fontSize: '0.8rem',
                      color: '#fca5a5',
                    }}
                  >
                    <strong>Missing Custom Nodes in ComfyUI:</strong>{' '}
                    {detail.template.missing_nodes.join(', ')}
                  </div>
                )}
              </section>

              {/* STEP 2: Download Models */}
              <section className="step-card">
                <div className="step-header">
                  <h3 className="step-title">
                    <span className="step-num">2</span>
                    <span>Required Models ({detail.template.models.length})</span>
                  </h3>
                  {detail.template.missing_models.length > 0 ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => handleDownloadMissingModels()}
                      disabled={startingDownloads}
                    >
                      {startingDownloads
                        ? 'Starting Download...'
                        : `Download ${detail.template.missing_models.length} Missing Model(s) to Server`}
                    </button>
                  ) : (
                    <span className="status-badge ready">All Models Installed on Server</span>
                  )}
                </div>

                {detail.template.models.length === 0 ? (
                  <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                    No local model files required by this template.
                  </div>
                ) : (
                  <div className="model-list">
                    {detail.template.models.map((m) => {
                      const dl = latestDownloadForModel(m.key)
                      const isDownloading = dl && ['queued', 'downloading'].includes(dl.status)
                      const pct =
                        dl && dl.total_bytes && dl.total_bytes > 0
                          ? Math.min(100, Math.round((dl.bytes_downloaded / dl.total_bytes) * 100))
                          : 0
                      return (
                        <div key={m.key} className="model-item">
                          <div className="model-item-top">
                            <div>
                              <strong>{m.name}</strong>{' '}
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                                → /Beta/ComfyUI/models/{m.directory}/
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              {m.installed ? (
                                <span className="status-badge ready">
                                  Installed ({formatBytes(m.size_bytes)})
                                </span>
                              ) : isDownloading ? (
                                <>
                                  <span className="status-badge needs_models">
                                    {pct}% ({formatBytes(dl.bytes_downloaded)} /{' '}
                                    {dl.total_bytes ? formatBytes(dl.total_bytes) : '?'}) •{' '}
                                    {formatBytes(dl.speed_bps)}/s
                                  </span>
                                  <button
                                    className="btn btn-danger"
                                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.74rem' }}
                                    onClick={() => handleCancelDownload(dl.id)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="status-badge needs_models">Missing</span>
                                  {m.url && (
                                    <button
                                      className="btn btn-secondary"
                                      style={{ padding: '0.25rem 0.6rem', fontSize: '0.76rem' }}
                                      onClick={() => handleDownloadMissingModels(m.key)}
                                    >
                                      Download
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                          {isDownloading && (
                            <div className="progress-bar-wrap">
                              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                          )}
                          {dl?.status === 'failed' && dl.error && (
                            <div style={{ color: '#f87171', fontSize: '0.78rem' }}>
                              Download error: {dl.error}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* STEP 3: Display Prompt & Modify Details */}
              <section className="step-card">
                <div className="step-header">
                  <h3 className="step-title">
                    <span className="step-num">3</span>
                    <span>Prompt & Modify Details</span>
                  </h3>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowDetails((prev) => !prev)}
                  >
                    {showDetails
                      ? `Hide Details (${detail.detail_parameters.length})`
                      : `Modify Details (${detail.detail_parameters.length} controls)`}
                  </button>
                </div>

                {/* Primary Prompt & Input Media Controls */}
                {detail.primary_parameters.length === 0 ? (
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                    No primary text prompt detected. Click "Modify Details" to adjust node parameters.
                  </p>
                ) : (
                  detail.primary_parameters.map((param) => renderParameterInput(param))
                )}

                {/* Collapsible Modify Details Drawer */}
                {showDetails && detail.detail_parameters.length > 0 && (
                  <div
                    style={{
                      marginTop: '1rem',
                      paddingTop: '1rem',
                      borderTop: '1px solid var(--border)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        marginBottom: '0.5rem',
                      }}
                    >
                      Resolution, Seed, Sampler & Template Controls
                    </div>
                    <div className="details-grid">
                      {detail.detail_parameters.map((param) => renderParameterInput(param))}
                    </div>
                  </div>
                )}
              </section>

              {/* STEP 4: Generate Output */}
              <section className="step-card">
                {detail.parameters.some((p) => p.param_type === 'video') && (
                  <div
                    style={{
                      marginBottom: '0.85rem',
                      padding: '0.7rem 0.85rem',
                      borderRadius: 8,
                      background: 'rgba(59, 130, 246, 0.08)',
                      border: '1px solid rgba(59, 130, 246, 0.25)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        cursor: 'pointer',
                        fontSize: '0.84rem',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={segmentMode}
                        onChange={(e) => setSegmentMode(e.target.checked)}
                      />
                      <span>
                        <strong>Long-Video Segmented Batch Mode</strong> — split long videos (e.g.,
                        60 min) into chunks, process each in ComfyUI, and stitch losslessly with
                        ffmpeg
                      </span>
                    </label>
                    {segmentMode && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          Chunk size (sec):
                        </span>
                        <input
                          type="number"
                          className="input-control"
                          style={{ width: 80, padding: '0.25rem 0.5rem' }}
                          min={2}
                          max={300}
                          value={segmentSeconds}
                          onChange={(e) =>
                            setSegmentSeconds(Math.max(2, Number(e.target.value) || 10))
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
                <div className="step-header" style={{ marginBottom: 0 }}>
                  <h3 className="step-title">
                    <span className="step-num">4</span>
                    <span>Generate Output</span>
                  </h3>
                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    {activeRun &&
                      ['submitting', 'queued', 'running'].includes(activeRun.status) && (
                        <button
                          className="btn btn-danger"
                          onClick={() => handleCancelRun(activeRun.id)}
                        >
                          Cancel Active Run
                        </button>
                      )}
                    <button
                      className="btn btn-primary"
                      style={{ padding: '0.7rem 1.5rem', fontSize: '0.95rem' }}
                      disabled={
                        detail.template.status !== 'ready' ||
                        Boolean(
                          activeRun &&
                            ['submitting', 'queued', 'running'].includes(activeRun.status),
                        )
                      }
                      onClick={handleGenerate}
                    >
                      {activeRun && ['submitting', 'queued', 'running'].includes(activeRun.status)
                        ? `Generating (${activeRun.status})...`
                        : detail.template.status !== 'ready'
                          ? `Resolve ${detail.template.status.replace('_', ' ')} first`
                          : segmentMode && detail.parameters.some((p) => p.param_type === 'video')
                            ? `▶ Generate Segmented Batch (${segmentSeconds}s chunks)`
                            : '▶ Generate Output'}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
        </main>

        {/* Column 3: Live Output Viewer & Run Library */}
        <aside className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>Output & Run Library</span>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                {runs.length} runs
              </span>
            </div>
          </div>

          <div className="output-stage">
            {activeRun ? (
              <div className="output-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.6rem',
                  }}
                >
                  <strong style={{ fontSize: '0.88rem' }}>{activeRun.template_title}</strong>
                  <span
                    className={`status-badge ${
                      activeRun.status === 'completed'
                        ? 'ready'
                        : activeRun.status === 'failed'
                          ? 'needs_nodes'
                          : 'needs_models'
                    }`}
                  >
                    {activeRun.status}
                  </span>
                </div>

                {['submitting', 'queued', 'running'].includes(activeRun.status) && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                        marginBottom: '0.35rem',
                      }}
                    >
                      <span>
                        {activeRun.current_node
                          ? `Executing node ${activeRun.current_node}`
                          : 'Waiting in ComfyUI queue...'}
                      </span>
                      {activeRun.progress_total > 0 && (
                        <span>
                          Step {activeRun.progress_step} / {activeRun.progress_total}
                        </span>
                      )}
                    </div>
                    <div className="progress-bar-wrap">
                      <div
                        className="progress-bar-fill"
                        style={{
                          width:
                            activeRun.progress_total > 0
                              ? `${Math.round(
                                  (activeRun.progress_step / activeRun.progress_total) * 100,
                                )}%`
                              : '35%',
                        }}
                      />
                    </div>
                  </div>
                )}

                {activeRun.error && (
                  <div
                    style={{
                      padding: '0.6rem',
                      borderRadius: 6,
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: '#fca5a5',
                      fontSize: '0.78rem',
                      marginBottom: '0.6rem',
                      wordBreak: 'break-word',
                    }}
                  >
                    {activeRun.error}
                  </div>
                )}

                {activeRun.outputs && activeRun.outputs.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {activeRun.outputs.map((out, idx) => (
                      <div key={`${out.filename}-${idx}`}>
                        {out.media_kind === 'video' ? (
                          <video className="output-media" src={out.url} controls autoPlay loop />
                        ) : out.media_kind === 'audio' ? (
                          <audio style={{ width: '100%' }} src={out.url} controls />
                        ) : out.media_kind === '3d' ? (
                          <Model3DViewer url={out.url} filename={out.filename} />
                        ) : (
                          <a href={out.url} target="_blank" rel="noreferrer">
                            <img className="output-media" src={out.url} alt={out.filename} />
                          </a>
                        )}
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginTop: '0.45rem',
                            gap: '0.5rem',
                          }}
                        >
                          <a
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.76rem', textDecoration: 'none' }}
                            href={out.url}
                            download={out.filename}
                          >
                            Download {out.filename}
                          </a>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.76rem' }}
                            onClick={() => handleRemixRun(activeRun)}
                          >
                            Remix Settings
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  padding: '2rem 1rem',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.86rem',
                  border: '1px dashed var(--border)',
                  borderRadius: 12,
                }}
              >
                Click <strong>Generate Output</strong> to run the selected template and view results
                here.
              </div>
            )}

            {/* Recent Runs History */}
            <div style={{ marginTop: '0.5rem' }}>
              <h4 style={{ fontSize: '0.84rem', margin: '0 0 0.6rem 0', color: 'var(--text-muted)' }}>
                Recent Generations
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {runs.map((r) => {
                  const firstOut = r.outputs?.[0]
                  return (
                    <div
                      key={r.id}
                      className="history-item"
                      onClick={() => handleRemixRun(r)}
                    >
                      {firstOut && firstOut.media_kind === 'image' ? (
                        <img
                          src={firstOut.url}
                          alt={firstOut.filename}
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 6,
                            objectFit: 'cover',
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 6,
                            background: 'var(--bg-0)',
                            flexShrink: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1.15rem',
                          }}
                        >
                          {firstOut?.media_kind === 'video'
                            ? '🎬'
                            : firstOut?.media_kind === '3d'
                              ? '🧊'
                              : firstOut?.media_kind === 'audio'
                                ? '🎵'
                                : '⏳'}
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: '0.82rem',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {r.template_title}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {r.status} • {new Date(r.created_at * 1000).toLocaleTimeString()}
                        </div>
                      </div>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {firstOut && (
                          <a
                            className="btn btn-secondary"
                            style={{
                              padding: '0.25rem 0.5rem',
                              fontSize: '0.74rem',
                              textDecoration: 'none',
                            }}
                            href={firstOut.url}
                            download={firstOut.filename}
                            title={`Download ${firstOut.filename}`}
                          >
                            ⬇
                          </a>
                        )}
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.74rem' }}
                          onClick={(e) => handleDeleteRun(r.id, e)}
                          title="Delete task from Recent Generations"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Optional Token Settings Modal */}
      {showSettingsModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div className="step-card" style={{ width: 440, maxWidth: '92vw' }}>
            <h3 style={{ marginTop: 0 }}>Model Provider Tokens</h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Optional: Configure a Hugging Face token to download gated models (e.g. Flux) directly
              to <code>/Beta/ComfyUI/models</code>.
            </p>
            <div className="field-group">
              <div className="field-label">
                <span>Hugging Face Token (hf_...)</span>
                {settingsInfo?.has_hf_token && (
                  <span style={{ color: 'var(--success)' }}>
                    Saved ({settingsInfo.hf_token_masked})
                  </span>
                )}
              </div>
              <input
                className="field-input"
                type="password"
                placeholder="hf_..."
                value={hfTokenInput}
                onChange={(e) => setHfTokenInput(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowSettingsModal(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={handleSaveSettings}>
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
