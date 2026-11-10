import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AssistantChatResponse,
  AssistantPlan,
  RunOutput,
  RunRecord,
} from './api'
import { Model3DViewer } from './Model3DViewer'

export interface CanvasRevision {
  id: string
  label: string
  dataUrl: string
  width: number
  height: number
  timestamp: number
}

interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  plan?: AssistantPlan | null
  runId?: string | null
}

interface PhotoStudioProps {
  runs: RunRecord[]
  initialImageUrl?: string | null
  initialImageLabel?: string | null
  onSendToVideoStudio: (imageUrl: string, label: string) => void
  onRunsUpdated: () => void
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (err) => reject(err)
    img.src = src
  })
}

async function compositeWithFeatheredMask(
  originalDataUrl: string,
  editedImageUrl: string,
  maskCanvas: HTMLCanvasElement,
  featherPx: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const [origImg, editImg] = await Promise.all([
    loadImageElement(originalDataUrl),
    loadImageElement(editedImageUrl),
  ])
  const w = origImg.naturalWidth || origImg.width
  const h = origImg.naturalHeight || origImg.height

  // 1. Prepare feathered alpha mask at full image resolution
  const alphaCanvas = document.createElement('canvas')
  alphaCanvas.width = w
  alphaCanvas.height = h
  const alphaCtx = alphaCanvas.getContext('2d')!
  if (featherPx > 0) {
    alphaCtx.filter = `blur(${featherPx}px)`
  }
  alphaCtx.drawImage(maskCanvas, 0, 0, w, h)
  alphaCtx.filter = 'none'

  // 2. Mask the AI-edited image using source-in over the feathered mask
  const maskedEditCanvas = document.createElement('canvas')
  maskedEditCanvas.width = w
  maskedEditCanvas.height = h
  const maskedEditCtx = maskedEditCanvas.getContext('2d')!
  maskedEditCtx.drawImage(alphaCanvas, 0, 0, w, h)
  maskedEditCtx.globalCompositeOperation = 'source-in'
  maskedEditCtx.drawImage(editImg, 0, 0, w, h)

  // 3. Draw original base image and overlay the feathered edited region
  const outCanvas = document.createElement('canvas')
  outCanvas.width = w
  outCanvas.height = h
  const outCtx = outCanvas.getContext('2d')!
  outCtx.drawImage(origImg, 0, 0, w, h)
  outCtx.drawImage(maskedEditCanvas, 0, 0, w, h)

  return {
    dataUrl: outCanvas.toDataURL('image/png'),
    width: w,
    height: h,
  }
}

async function extractMaskedSubjectDataUrl(
  baseDataUrl: string,
  maskCanvas: HTMLCanvasElement,
  featherPx: number,
): Promise<string> {
  const origImg = await loadImageElement(baseDataUrl)
  const w = origImg.naturalWidth || origImg.width
  const h = origImg.naturalHeight || origImg.height

  const alphaCanvas = document.createElement('canvas')
  alphaCanvas.width = w
  alphaCanvas.height = h
  const alphaCtx = alphaCanvas.getContext('2d')!
  if (featherPx > 0) {
    alphaCtx.filter = `blur(${Math.max(4, featherPx)}px)`
  }
  alphaCtx.drawImage(maskCanvas, 0, 0, w, h)
  alphaCtx.filter = 'none'

  const subjCanvas = document.createElement('canvas')
  subjCanvas.width = w
  subjCanvas.height = h
  const subjCtx = subjCanvas.getContext('2d')!
  subjCtx.drawImage(alphaCanvas, 0, 0, w, h)
  subjCtx.globalCompositeOperation = 'source-in'
  subjCtx.drawImage(origImg, 0, 0, w, h)

  const finalCanvas = document.createElement('canvas')
  finalCanvas.width = w
  finalCanvas.height = h
  const finalCtx = finalCanvas.getContext('2d')!
  finalCtx.fillStyle = '#ffffff'
  finalCtx.fillRect(0, 0, w, h)
  finalCtx.drawImage(subjCanvas, 0, 0, w, h)
  return finalCanvas.toDataURL('image/png')
}

export function PhotoStudio({
  runs,
  initialImageUrl,
  initialImageLabel,
  onSendToVideoStudio,
  onRunsUpdated,
}: PhotoStudioProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const refImageInputRef = useRef<HTMLInputElement | null>(null)

  const [revisions, setRevisions] = useState<CanvasRevision[]>([])
  const [activeRevIndex, setActiveRevIndex] = useState<number>(-1)
  const [compareOriginal, setCompareOriginal] = useState(false)

  // Tool & Brush state
  const [activeTool, setActiveTool] = useState<'pan' | 'brush' | 'eraser' | 'adjust' | '3d'>('brush')
  const [brushSize, setBrushSize] = useState(42)
  const [featherPx, setFeatherPx] = useState(12)
  const [hasMask, setHasMask] = useState(false)
  const [showMaskOverlay, setShowMaskOverlay] = useState(true)
  const [zoom, setZoom] = useState(1.0)
  const [isPainting, setIsPainting] = useState(false)

  // GIMP Raster adjustment sliders
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [saturation, setSaturation] = useState(100)
  const [warmth, setWarmth] = useState(0)
  const [blurPx, setBlurPx] = useState(0)

  // Optional 2nd Reference / Texture image
  const [secondImageB64, setSecondImageB64] = useState<string | null>(null)
  const [secondImageName, setSecondImageName] = useState<string | null>(null)

  // Character Isolation & 3D Studio state
  const [isolationTarget, setIsolationTarget] = useState<'main_character' | 'group' | 'masked' | 'custom'>('main_character')
  const [customIsolationPrompt, setCustomIsolationPrompt] = useState('')
  const [figurinePrepass, setFigurinePrepass] = useState(false)
  const [apply3DTexture, setApply3DTexture] = useState(true)
  const [texturePrompt, setTexturePrompt] = useState('')
  const [render3DMode, setRender3DMode] = useState<'texture' | 'solid' | 'normal' | 'auto'>('texture')
  const [active3DModel, setActive3DModel] = useState<{ url: string; filename: string } | null>(null)

  // AI Copilot & Run tracking state
  const [assistantOnline, setAssistantOnline] = useState<boolean | null>(null)
  const [assistantModel, setAssistantModel] = useState<string>('Qwen3.8-27B-GGUF-Q4_K_M')
  const [autoPilot, setAutoPilot] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Welcome to Photo & 3D Studio! Load a photo, paint a mask with the brush, or ask me to isolate a character/group, remove the background, generate a textured 3D model, or edit anything on your canvas.',
    },
  ])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activePostProcess, setActivePostProcess] = useState<string>('replace_canvas')
  const [statusBanner, setStatusBanner] = useState<string | null>(null)

  const currentRevision =
    activeRevIndex >= 0 && activeRevIndex < revisions.length ? revisions[activeRevIndex] : null
  const originalRevision = revisions.length > 0 ? revisions[0] : null

  const pushRevision = useCallback(
    async (imageUrlOrDataUrl: string, label: string) => {
      try {
        const img = await loadImageElement(imageUrlOrDataUrl)
        const w = img.naturalWidth || img.width || 1024
        const h = img.naturalHeight || img.height || 1024
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        const dataUrl = c.toDataURL('image/png')

        const rev: CanvasRevision = {
          id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          label,
          dataUrl,
          width: w,
          height: h,
          timestamp: Date.now(),
        }
        setRevisions((prev) => {
          const next = [...prev.slice(0, activeRevIndex + 1), rev]
          setActiveRevIndex(next.length - 1)
          return next
        })
      } catch (err) {
        setStatusBanner(`Failed to load image onto canvas: ${String(err)}`)
      }
    },
    [activeRevIndex],
  )

  // Check Lemonade AI status on mount
  useEffect(() => {
    fetch('/api/assistant/status')
      .then((r) => r.json())
      .then((d) => {
        setAssistantOnline(Boolean(d.online))
        if (d.active_model) setAssistantModel(d.active_model)
      })
      .catch(() => setAssistantOnline(false))
  }, [])

  // Load initialImageUrl when passed from Video Studio or Recent Runs
  useEffect(() => {
    if (initialImageUrl) {
      pushRevision(initialImageUrl, initialImageLabel || 'Imported Frame')
    }
  }, [initialImageUrl, initialImageLabel])

  // Render current revision + raster adjustments onto baseCanvasRef
  useEffect(() => {
    const canvas = baseCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    const targetRev = compareOriginal && originalRevision ? originalRevision : currentRevision
    if (!canvas || !targetRev) return

    let cancelled = false
    loadImageElement(targetRev.dataUrl).then((img) => {
      if (cancelled) return
      const w = targetRev.width
      const h = targetRev.height
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      if (maskCanvas && (maskCanvas.width !== w || maskCanvas.height !== h)) {
        maskCanvas.width = w
        maskCanvas.height = h
        setHasMask(false)
      }
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, w, h)
      ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) sepia(${warmth}%) blur(${blurPx}px)`
      ctx.drawImage(img, 0, 0, w, h)
      ctx.filter = 'none'
    })
    return () => {
      cancelled = true
    }
  }, [
    currentRevision,
    originalRevision,
    compareOriginal,
    brightness,
    contrast,
    saturation,
    warmth,
    blurPx,
  ])

  // Poll activeRunId until completion and apply result to canvas or 3D viewer
  useEffect(() => {
    if (!activeRunId) return
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${activeRunId}`)
        if (!res.ok) return
        const run: RunRecord = await res.json()
        if (stopped) return

        if (run.status === 'completed') {
          clearInterval(timer)
          setActiveRunId(null)
          onRunsUpdated()

          const outputs: RunOutput[] = run.outputs || []
          const glbOut = outputs.find((o) => o.media_kind === '3d')
          const imgOut = outputs.find((o) => o.media_kind === 'image')
          const vidOut = outputs.find((o) => o.media_kind === 'video')

          if (glbOut) {
            setActive3DModel({ url: glbOut.url, filename: glbOut.filename })
            setActiveTool('3d')
            setStatusBanner(`3D Mesh ready: ${glbOut.filename}`)
          }
          if (imgOut) {
            if (
              activePostProcess === 'feathered_mask_composite' &&
              hasMask &&
              currentRevision &&
              maskCanvasRef.current
            ) {
              const comp = await compositeWithFeatheredMask(
                currentRevision.dataUrl,
                imgOut.url,
                maskCanvasRef.current,
                featherPx,
              )
              await pushRevision(comp.dataUrl, `${run.template_title} (Masked Fill)`)
              clearMask()
              setStatusBanner('Applied Feathered Mask Generative Fill to canvas.')
            } else {
              await pushRevision(imgOut.url, run.template_title)
              setStatusBanner(`Completed: ${run.template_title}`)
            }
          } else if (vidOut) {
            setStatusBanner(`Video generated! Opening in Video Studio...`)
            onSendToVideoStudio(vidOut.url, run.template_title)
          }
        } else if (run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(timer)
          setActiveRunId(null)
          setStatusBanner(`Run ${run.status}: ${run.error || 'Unknown error'}`)
        }
      } catch {
        // ignore transient polling errors
      }
    }, 1400)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [
    activeRunId,
    activePostProcess,
    hasMask,
    currentRevision,
    featherPx,
    pushRevision,
    onRunsUpdated,
    onSendToVideoStudio,
  ])

  const clearMask = () => {
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')!
    ctx.clearRect(0, 0, mc.width, mc.height)
    setHasMask(false)
  }

  const paintAtEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mc = maskCanvasRef.current
    if (!mc || (activeTool !== 'brush' && activeTool !== 'eraser')) return
    const rect = mc.getBoundingClientRect()
    const scaleX = mc.width / (rect.width || 1)
    const scaleY = mc.height / (rect.height || 1)
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    const ctx = mc.getContext('2d')!
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, brushSize * scaleX * 0.5, 0, Math.PI * 2)
    if (activeTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(244, 63, 94, 0.62)'
    }
    ctx.fill()
    ctx.restore()
    if (activeTool === 'brush') setHasMask(true)
  }

  const getMaskBoundingBoxHint = (): string | null => {
    const mc = maskCanvasRef.current
    if (!mc || !hasMask) return null
    const ctx = mc.getContext('2d')!
    const { width, height } = mc
    const data = ctx.getImageData(0, 0, width, height).data
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let found = false
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const a = data[(y * width + x) * 4 + 3]
        if (a > 20) {
          found = true
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    if (!found) return null
    const cx = Math.round(((minX + maxX) / 2 / width) * 100)
    const cy = Math.round(((minY + maxY) / 2 / height) * 100)
    return `center=(${cx}%, ${cy}%), box=[${minX},${minY} to ${maxX},${maxY}] of ${width}x${height}`
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        pushRevision(reader.result, `Loaded: ${file.name}`)
      }
    }
    reader.readAsDataURL(file)
  }

  const handleSecondImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setSecondImageB64(reader.result)
        setSecondImageName(file.name)
      }
    }
    reader.readAsDataURL(file)
  }

  const handleBakeAdjustments = async () => {
    const canvas = baseCanvasRef.current
    if (!canvas || !currentRevision) return
    const bakedDataUrl = canvas.toDataURL('image/png')
    setBrightness(100)
    setContrast(100)
    setSaturation(100)
    setWarmth(0)
    setBlurPx(0)
    await pushRevision(bakedDataUrl, 'Raster Color Adjusted')
  }

  const handleTransform = async (op: 'rot_cw' | 'rot_ccw' | 'flip_h' | 'flip_v') => {
    if (!currentRevision) return
    const img = await loadImageElement(currentRevision.dataUrl)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!

    if (op === 'rot_cw' || op === 'rot_ccw') {
      c.width = h
      c.height = w
      ctx.translate(c.width / 2, c.height / 2)
      ctx.rotate((op === 'rot_cw' ? 90 : -90) * (Math.PI / 180))
      ctx.drawImage(img, -w / 2, -h / 2)
    } else {
      c.width = w
      c.height = h
      ctx.translate(op === 'flip_h' ? w : 0, op === 'flip_v' ? h : 0)
      ctx.scale(op === 'flip_h' ? -1 : 1, op === 'flip_v' ? -1 : 1)
      ctx.drawImage(img, 0, 0)
    }
    await pushRevision(c.toDataURL('image/png'), `Transform (${op})`)
  }

  const handleAspectCrop = async (ratioW: number, ratioH: number) => {
    if (!currentRevision) return
    const img = await loadImageElement(currentRevision.dataUrl)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    const targetRatio = ratioW / ratioH
    const currentRatio = w / h

    let cropW = w
    let cropH = h
    if (currentRatio > targetRatio) {
      cropW = Math.round(h * targetRatio)
    } else {
      cropH = Math.round(w / targetRatio)
    }
    const sx = Math.round((w - cropW) / 2)
    const sy = Math.round((h - cropH) / 2)

    const c = document.createElement('canvas')
    c.width = cropW
    c.height = cropH
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
    await pushRevision(c.toDataURL('image/png'), `Crop ${ratioW}:${ratioH}`)
  }

  const handleExportPNG = () => {
    const canvas = baseCanvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `studio_photo_${Date.now()}.png`
    a.click()
  }

  const handleSendChat = async (overrideMessage?: string) => {
    const msg = (overrideMessage ?? chatInput).trim()
    if (!msg || chatBusy) return
    if (!overrideMessage) setChatInput('')

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: msg,
    }
    setChatTurns((prev) => [...prev, userTurn])
    setChatBusy(true)

    try {
      const payload = {
        message: msg,
        history: chatTurns.slice(-4).map((t) => ({ role: t.role, content: t.text })),
        canvas_image_b64: currentRevision?.dataUrl || null,
        second_image_b64: secondImageB64,
        has_mask: hasMask,
        mask_bbox_hint: getMaskBoundingBoxHint(),
        auto_pilot: autoPilot,
      }
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data: AssistantChatResponse = await res.json()

      const assistantTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: data.reply,
        plan: data.plan,
        runId: data.run?.id || null,
      }
      setChatTurns((prev) => [...prev, assistantTurn])

      if (data.run?.id) {
        setActivePostProcess(data.plan?.post_process || 'replace_canvas')
        setActiveRunId(data.run.id)
        setStatusBanner(`Running ${data.run.template_title}...`)
      }
    } catch (err) {
      setChatTurns((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          text: `Failed to reach AI Copilot: ${String(err)}`,
        },
      ])
    } finally {
      setChatBusy(false)
    }
  }

  const handleExecutePlanCard = async (plan: AssistantPlan) => {
    if (!plan.template_id) return
    setStatusBanner(`Submitting ${plan.template_id}...`)
    try {
      const res = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: plan.template_id,
          prompt: plan.prompt,
          canvas_image_b64: currentRevision?.dataUrl || null,
          second_image_b64: secondImageB64,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActivePostProcess(plan.post_process || 'replace_canvas')
        setActiveRunId(data.run.id)
      }
    } catch (err) {
      setStatusBanner(`Execution error: ${String(err)}`)
    }
  }

  const handleRunCharacterIsolation = async () => {
    if (!currentRevision) {
      setStatusBanner('Load an image onto the canvas first.')
      return
    }
    setStatusBanner('Isolating character/group & removing background via Qwen Image 2.1...')
    let inputDataUrl = currentRevision.dataUrl
    if (isolationTarget === 'masked' && hasMask && maskCanvasRef.current) {
      inputDataUrl = await extractMaskedSubjectDataUrl(
        currentRevision.dataUrl,
        maskCanvasRef.current,
        featherPx,
      )
    }
    try {
      const res = await fetch('/api/assistant/3d-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_image_b64: inputDataUrl,
          stage: 'isolate_only',
          isolation_target: isolationTarget,
          isolation_prompt: customIsolationPrompt,
          figurine_prepass: figurinePrepass,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActivePostProcess('replace_canvas')
        setActiveRunId(data.run.id)
        if (isolationTarget === 'masked') clearMask()
      }
    } catch (err) {
      setStatusBanner(`Character isolation failed: ${String(err)}`)
    }
  }

  const handleRun3DPipeline = async () => {
    if (!currentRevision) {
      setStatusBanner('Load or isolate a character/object on the canvas first.')
      return
    }
    setStatusBanner(
      apply3DTexture
        ? 'Generating 3D Mesh + GPU UV Unwrap + Texture Map + 2D Render (Hunyuan3D 2.1)...'
        : 'Generating 3D Clay Mesh + 2D Studio Render (Hunyuan3D 2.1)...',
    )
    try {
      const res = await fetch('/api/assistant/3d-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_image_b64: currentRevision.dataUrl,
          texture_image_b64: secondImageB64 || currentRevision.dataUrl,
          stage: '3d_and_render',
          apply_texture: apply3DTexture,
          render_mode: render3DMode,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActivePostProcess('replace_canvas')
        setActiveRunId(data.run.id)
      }
    } catch (err) {
      setStatusBanner(`3D Pipeline failed: ${String(err)}`)
    }
  }

  const handleGenerateAITextureFor3D = async () => {
    if (!texturePrompt.trim()) return
    setStatusBanner(`Generating texture map ("${texturePrompt}") via Z-Image-Turbo...`)
    try {
      const res = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: 'image_z_image_turbo',
          prompt: `Seamless flat PBR surface material texture map of ${texturePrompt.trim()}, even lighting, high detail, 4k texture`,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActivePostProcess('replace_canvas')
        setActiveRunId(data.run.id)
      }
    } catch (err) {
      setStatusBanner(`Texture generation failed: ${String(err)}`)
    }
  }

  // Recent image/3D outputs from runs for quick 1-click loading
  const recentImageOutputs = runs
    .flatMap((r) =>
      (r.outputs || [])
        .filter((o) => o.media_kind === 'image')
        .map((o) => ({ ...o, title: r.template_title })),
    )
    .slice(0, 8)

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '290px 1fr 360px',
        height: 'calc(100vh - 58px)',
        overflow: 'hidden',
        background: 'var(--bg-main)',
      }}
    >
      {/* LEFT PANEL: GIMP Tools + Character Isolation & 3D Studio */}
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          padding: '0.85rem',
          gap: '0.9rem',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.74rem',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-muted)',
              fontWeight: 700,
              marginBottom: '0.45rem',
            }}
          >
            1. Canvas Source
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1, fontSize: '0.78rem' }}
              onClick={() => fileInputRef.current?.click()}
            >
              📂 Open Photo
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: '0.78rem' }}
              onClick={handleExportPNG}
              disabled={!currentRevision}
            >
              ⬇ Save PNG
            </button>
          </div>

          {recentImageOutputs.length > 0 && (
            <div style={{ marginTop: '0.55rem' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Or load from Recent Generations:
              </div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 4 }}>
                {recentImageOutputs.map((item, idx) => (
                  <img
                    key={`${item.filename}-${idx}`}
                    src={item.url}
                    alt={item.title}
                    title={`Load ${item.title}`}
                    onClick={() => pushRevision(item.url, item.title)}
                    style={{
                      width: 44,
                      height: 44,
                      objectFit: 'cover',
                      borderRadius: 6,
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      flexShrink: 0,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* GIMP Tool Selector */}
        <div>
          <div
            style={{
              fontSize: '0.74rem',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-muted)',
              fontWeight: 700,
              marginBottom: '0.45rem',
            }}
          >
            2. GIMP & Studio Tools
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
            <button
              type="button"
              className={`chip ${activeTool === 'brush' ? 'active' : ''}`}
              onClick={() => setActiveTool('brush')}
            >
              🖌️ Mask Brush
            </button>
            <button
              type="button"
              className={`chip ${activeTool === 'eraser' ? 'active' : ''}`}
              onClick={() => setActiveTool('eraser')}
            >
              🧹 Mask Eraser
            </button>
            <button
              type="button"
              className={`chip ${activeTool === 'adjust' ? 'active' : ''}`}
              onClick={() => setActiveTool('adjust')}
            >
              🎛️ Color / Crop
            </button>
            <button
              type="button"
              className={`chip ${activeTool === '3d' ? 'active' : ''}`}
              onClick={() => setActiveTool('3d')}
            >
              🧊 Isolate & 3D
            </button>
          </div>
        </div>

        {/* Tool-specific Inspector */}
        {(activeTool === 'brush' || activeTool === 'eraser') && (
          <div
            style={{
              padding: '0.65rem',
              borderRadius: 8,
              background: 'rgba(15, 23, 42, 0.65)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              fontSize: '0.76rem',
            }}
          >
            <div style={{ fontWeight: 600 }}>Feathered Inpaint / Subject Mask</div>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Brush Size</span>
              <span>{brushSize}px</span>
            </label>
            <input
              type="range"
              min={5}
              max={180}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Edge Feathering</span>
              <span>{featherPx}px</span>
            </label>
            <input
              type="range"
              min={0}
              max={40}
              value={featherPx}
              onChange={(e) => setFeatherPx(Number(e.target.value))}
            />
            <div style={{ display: 'flex', gap: '0.35rem', marginTop: 4 }}>
              <button
                type="button"
                className="chip"
                style={{ flex: 1 }}
                onClick={() => setShowMaskOverlay((v) => !v)}
              >
                {showMaskOverlay ? '👁️ Hide Mask' : '👁️ Show Mask'}
              </button>
              <button
                type="button"
                className="chip"
                style={{ flex: 1 }}
                onClick={clearMask}
                disabled={!hasMask}
              >
                🗑️ Clear Mask
              </button>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Paint over any object or character. When you run an AI edit, Studio alpha-composites
              only your feathered mask onto the original photo!
            </div>
          </div>
        )}

        {activeTool === 'adjust' && (
          <div
            style={{
              padding: '0.65rem',
              borderRadius: 8,
              background: 'rgba(15, 23, 42, 0.65)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.45rem',
              fontSize: '0.75rem',
            }}
          >
            <div style={{ fontWeight: 600 }}>GIMP Raster Adjustments</div>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Brightness</span>
              <span>{brightness}%</span>
            </label>
            <input
              type="range"
              min={40}
              max={160}
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
            />
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Contrast</span>
              <span>{contrast}%</span>
            </label>
            <input
              type="range"
              min={40}
              max={160}
              value={contrast}
              onChange={(e) => setContrast(Number(e.target.value))}
            />
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Saturation</span>
              <span>{saturation}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={200}
              value={saturation}
              onChange={(e) => setSaturation(Number(e.target.value))}
            />
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Warmth</span>
              <span>{warmth}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={warmth}
              onChange={(e) => setWarmth(Number(e.target.value))}
            />
            <div style={{ display: 'flex', gap: '0.35rem', marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1, fontSize: '0.73rem' }}
                onClick={handleBakeAdjustments}
              >
                ✨ Bake to Layer
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setBrightness(100)
                  setContrast(100)
                  setSaturation(100)
                  setWarmth(0)
                  setBlurPx(0)
                }}
              >
                Reset
              </button>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.3rem 0' }} />
            <div style={{ fontWeight: 600 }}>Transform & Aspect Crop</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
              <button type="button" className="chip" onClick={() => handleTransform('rot_ccw')}>
                ↺ Rotate -90°
              </button>
              <button type="button" className="chip" onClick={() => handleTransform('rot_cw')}>
                ↻ Rotate +90°
              </button>
              <button type="button" className="chip" onClick={() => handleTransform('flip_h')}>
                ↔ Flip H
              </button>
              <button type="button" className="chip" onClick={() => handleTransform('flip_v')}>
                ↕ Flip V
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: 2 }}>
              <button type="button" className="chip" onClick={() => handleAspectCrop(1, 1)}>
                Crop 1:1
              </button>
              <button type="button" className="chip" onClick={() => handleAspectCrop(16, 9)}>
                16:9
              </button>
              <button type="button" className="chip" onClick={() => handleAspectCrop(9, 16)}>
                9:16
              </button>
              <button type="button" className="chip" onClick={() => handleAspectCrop(4, 3)}>
                4:3
              </button>
            </div>
          </div>
        )}

        {/* Templated Character/Group Isolation + 3D Render & Texture Drawer */}
        <div
          style={{
            padding: '0.7rem',
            borderRadius: 8,
            background: 'rgba(30, 41, 59, 0.55)',
            border: '1px solid rgba(99, 102, 241, 0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.55rem',
            fontSize: '0.75rem',
          }}
        >
          <div style={{ fontWeight: 700, color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🧊 Character Isolation & 3D Studio</span>
          </div>

          <div style={{ fontWeight: 600, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Step A: Isolate Subject & Remove Background
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
            <button
              type="button"
              className={`chip ${isolationTarget === 'main_character' ? 'active' : ''}`}
              style={{ fontSize: '0.7rem' }}
              onClick={() => setIsolationTarget('main_character')}
            >
              🧍 Main Character
            </button>
            <button
              type="button"
              className={`chip ${isolationTarget === 'group' ? 'active' : ''}`}
              style={{ fontSize: '0.7rem' }}
              onClick={() => setIsolationTarget('group')}
            >
              👥 Character Group
            </button>
            <button
              type="button"
              className={`chip ${isolationTarget === 'masked' ? 'active' : ''}`}
              style={{ fontSize: '0.7rem' }}
              onClick={() => setIsolationTarget('masked')}
            >
              🖌️ Painted Mask
            </button>
            <button
              type="button"
              className={`chip ${isolationTarget === 'custom' ? 'active' : ''}`}
              style={{ fontSize: '0.7rem' }}
              onClick={() => setIsolationTarget('custom')}
            >
              ✍️ Custom Prompt
            </button>
          </div>

          {isolationTarget === 'custom' && (
            <input
              type="text"
              className="search-input"
              placeholder="e.g., Isolate the knight on the left..."
              value={customIsolationPrompt}
              onChange={(e) => setCustomIsolationPrompt(e.target.value)}
              style={{ fontSize: '0.74rem', padding: '0.35rem 0.5rem' }}
            />
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.71rem' }}>
            <input
              type="checkbox"
              checked={figurinePrepass}
              onChange={(e) => setFigurinePrepass(e.target.checked)}
            />
            <span>Normalize lighting as 3D figurine pre-pass</span>
          </label>

          <button
            type="button"
            className="btn"
            style={{ width: '100%', fontSize: '0.75rem', borderColor: '#6366f1' }}
            onClick={handleRunCharacterIsolation}
            disabled={!currentRevision || Boolean(activeRunId)}
          >
            ✂️ 1. Isolate & Remove BG (Qwen 2.1)
          </button>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.2rem 0' }} />

          <div style={{ fontWeight: 600, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Step B: 3D Mesh + UV Texture + 2D Render
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
            <input
              type="checkbox"
              checked={apply3DTexture}
              onChange={(e) => setApply3DTexture(e.target.checked)}
            />
            <span>UV-Unwrap & Apply Color/Texture Map</span>
          </label>

          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Render Mode:</span>
            <select
              value={render3DMode}
              onChange={(e) => setRender3DMode(e.target.value as any)}
              style={{
                flex: 1,
                background: 'var(--bg-main)',
                color: 'var(--text-main)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '0.2rem 0.4rem',
                fontSize: '0.72rem',
              }}
            >
              <option value="texture">Textured 3D Render</option>
              <option value="solid">Shaded Clay Render</option>
              <option value="normal">Surface Normal Map</option>
              <option value="auto">Auto</option>
            </select>
          </div>

          {/* Optional AI Texture Generator or Reference Texture Upload */}
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <input
              type="text"
              className="search-input"
              placeholder="Optional material (e.g. gold armor)"
              value={texturePrompt}
              onChange={(e) => setTexturePrompt(e.target.value)}
              style={{ flex: 1, fontSize: '0.71rem', padding: '0.28rem 0.45rem' }}
            />
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem' }}
              onClick={handleGenerateAITextureFor3D}
              disabled={!texturePrompt.trim() || Boolean(activeRunId)}
              title="Generate a seamless texture image on the canvas via Z-Image-Turbo"
            >
              🎨 Gen Tex
            </button>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', fontSize: '0.76rem' }}
            onClick={handleRun3DPipeline}
            disabled={!currentRevision || Boolean(activeRunId)}
          >
            🧊 2. Create 3D Mesh + Texture + Render
          </button>
        </div>

        {/* Optional 2nd Reference Image for Multi-Image Edit / Texture */}
        <div style={{ fontSize: '0.73rem' }}>
          <input
            ref={refImageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleSecondImageUpload}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              Ref / Texture Image: {secondImageName || 'None'}
            </span>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem' }}
              onClick={() =>
                secondImageB64 ? (setSecondImageB64(null), setSecondImageName(null)) : refImageInputRef.current?.click()
              }
            >
              {secondImageB64 ? 'Clear' : '+ Add Ref'}
            </button>
          </div>
        </div>
      </aside>

      {/* CENTER WORKSPACE: Interactive Dual-Canvas + 3D Material Studio + Bottom Revision Strip */}
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          background: '#070a12',
        }}
      >
        {/* Top Canvas Toolbar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.5rem 0.9rem',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            fontSize: '0.76rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600 }}>
              {currentRevision
                ? `${currentRevision.label} (${currentRevision.width}×${currentRevision.height})`
                : 'Empty Canvas — Load or Generate an Image'}
            </span>
            {hasMask && (
              <span
                style={{
                  background: 'rgba(244, 63, 94, 0.2)',
                  color: '#fda4af',
                  padding: '0.1rem 0.45rem',
                  borderRadius: 999,
                  fontSize: '0.68rem',
                  fontWeight: 600,
                }}
              >
                🖌️ Feathered Mask Active
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <button
              type="button"
              className="chip"
              onClick={() => setActiveRevIndex((i) => Math.max(0, i - 1))}
              disabled={activeRevIndex <= 0}
              title="Undo (Previous Revision)"
            >
              ↩ Undo
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => setActiveRevIndex((i) => Math.min(revisions.length - 1, i + 1))}
              disabled={activeRevIndex >= revisions.length - 1}
              title="Redo (Next Revision)"
            >
              ↪ Redo
            </button>
            <button
              type="button"
              className={`chip ${compareOriginal ? 'active' : ''}`}
              onMouseDown={() => setCompareOriginal(true)}
              onMouseUp={() => setCompareOriginal(false)}
              onMouseLeave={() => setCompareOriginal(false)}
              disabled={revisions.length < 2}
              title="Hold to compare with Original Import"
            >
              👁️ Hold to Compare Original
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.15).toFixed(2)))}
            >
              −
            </button>
            <span style={{ minWidth: 42, textAlign: 'center', fontSize: '0.72rem' }}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))}
            >
              +
            </button>
            <button type="button" className="chip" onClick={() => setZoom(1.0)}>
              100%
            </button>
            {currentRevision && (
              <button
                type="button"
                className="btn"
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.73rem' }}
                onClick={() =>
                  onSendToVideoStudio(currentRevision.dataUrl, currentRevision.label)
                }
              >
                🎬 Send to Video Studio
              </button>
            )}
          </div>
        </div>

        {statusBanner && (
          <div
            style={{
              padding: '0.4rem 0.9rem',
              background: 'rgba(99, 102, 241, 0.16)',
              borderBottom: '1px solid rgba(99, 102, 241, 0.35)',
              color: '#c7d2fe',
              fontSize: '0.76rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>
              {activeRunId ? '⏳ ' : '✨ '}
              {statusBanner}
            </span>
            <button
              type="button"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
              onClick={() => setStatusBanner(null)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Canvas Viewport + Optional 3D Material Studio Split View */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            gap: '1rem',
          }}
        >
          {active3DModel && (
            <div style={{ width: '100%', maxWidth: 760 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                  fontSize: '0.78rem',
                }}
              >
                <span style={{ fontWeight: 700, color: '#a5b4fc' }}>
                  🧊 Interactive 3D Material & Render Studio ({active3DModel.filename})
                </span>
                <button
                  type="button"
                  className="chip"
                  onClick={() => setActive3DModel(null)}
                >
                  Hide 3D Viewer
                </button>
              </div>
              <Model3DViewer
                url={active3DModel.url}
                filename={active3DModel.filename}
                height={320}
                textureCandidateUrl={secondImageB64 || currentRevision?.dataUrl || null}
                onCaptureRenderToCanvas={(dataUrl, label) => {
                  pushRevision(dataUrl, label)
                  setStatusBanner('Captured 3D Render onto Photo Studio canvas!')
                }}
              />
            </div>
          )}

          {currentRevision ? (
            <div
              style={{
                position: 'relative',
                display: 'inline-block',
                transform: `scale(${zoom})`,
                transformOrigin: 'center center',
                transition: 'transform 0.08s ease-out',
                boxShadow: '0 14px 40px rgba(0,0,0,0.65)',
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid #334155',
                background:
                  'repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 50% / 20px 20px',
              }}
            >
              <canvas
                ref={baseCanvasRef}
                style={{ display: 'block', maxWidth: '68vw', maxHeight: '62vh' }}
              />
              <canvas
                ref={maskCanvasRef}
                onMouseDown={(e) => {
                  setIsPainting(true)
                  paintAtEvent(e)
                }}
                onMouseMove={(e) => {
                  if (isPainting) paintAtEvent(e)
                }}
                onMouseUp={() => setIsPainting(false)}
                onMouseLeave={() => setIsPainting(false)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: showMaskOverlay ? 1 : 0,
                  cursor:
                    activeTool === 'brush' || activeTool === 'eraser' ? 'crosshair' : 'default',
                }}
              />
            </div>
          ) : (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem',
                border: '1px dashed var(--border)',
                borderRadius: 12,
                color: 'var(--text-muted)',
                maxWidth: 460,
              }}
            >
              <div style={{ fontSize: '2.2rem', marginBottom: '0.5rem' }}>🖼️</div>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 6 }}>
                No Photo Loaded Yet
              </div>
              <div style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                Click <strong>Open Photo</strong> on the left, pick a recent generation, or ask the
                AI Copilot on the right to generate a brand-new image!
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
              >
                📂 Open Photo from Disk
              </button>
            </div>
          )}
        </div>

        {/* Bottom Revision History Filmstrip */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: '0.5rem 0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            overflowX: 'auto',
            minHeight: 74,
          }}
        >
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            Revisions ({revisions.length}):
          </span>
          {revisions.map((rev, idx) => (
            <div
              key={rev.id}
              onClick={() => setActiveRevIndex(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0.25rem 0.45rem',
                borderRadius: 8,
                cursor: 'pointer',
                border:
                  idx === activeRevIndex
                    ? '2px solid #6366f1'
                    : '1px solid var(--border)',
                background:
                  idx === activeRevIndex ? 'rgba(99, 102, 241, 0.16)' : 'rgba(15, 23, 42, 0.6)',
                flexShrink: 0,
              }}
            >
              <img
                src={rev.dataUrl}
                alt={rev.label}
                style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 4 }}
              />
              <div style={{ fontSize: '0.7rem', maxWidth: 115 }}>
                <div
                  style={{
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {idx + 1}. {rev.label}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                  {rev.width}×{rev.height}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* RIGHT PANEL: AI Copilot Chat & Automatic Model Router */}
      <aside
        style={{
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header & Mode Switch */}
        <div
          style={{
            padding: '0.75rem 0.85rem',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '0.86rem' }}>🤖 Lemonade AI Copilot</div>
            <span
              style={{
                fontSize: '0.68rem',
                padding: '0.12rem 0.45rem',
                borderRadius: 999,
                background: assistantOnline
                  ? 'rgba(16, 185, 129, 0.16)'
                  : 'rgba(245, 158, 11, 0.16)',
                color: assistantOnline ? '#34d399' : '#fbbf24',
              }}
            >
              {assistantOnline ? '🟢 Lemonade Online' : '🟡 Local Router'}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
            }}
          >
            <span title={assistantModel} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Model: {assistantModel}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className={`chip ${autoPilot ? 'active' : ''}`}
                style={{ padding: '0.12rem 0.45rem', fontSize: '0.68rem' }}
                onClick={() => setAutoPilot(true)}
                title="Automatically execute the best ComfyUI workflow immediately"
              >
                ⚡ Auto-Pilot
              </button>
              <button
                type="button"
                className={`chip ${!autoPilot ? 'active' : ''}`}
                style={{ padding: '0.12rem 0.45rem', fontSize: '0.68rem' }}
                onClick={() => setAutoPilot(false)}
                title="Preview the selected template and prompt before running"
              >
                🧭 Review
              </button>
            </div>
          </div>

          {/* 1-Click Quick Action Chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: 2 }}>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() =>
                handleSendChat(
                  'Isolate the main character in the foreground and remove the background cleanly',
                )
              }
            >
              🧍 Isolate Character
            </button>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() =>
                handleSendChat(
                  'Isolate the central group of characters and remove the background',
                )
              }
            >
              👥 Isolate Group
            </button>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() => handleSendChat('Remove the background and output a clean PNG')}
            >
              ✂️ Remove BG
            </button>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() =>
                handleSendChat('Convert this subject into a textured 3D model and render it')
              }
            >
              🧊 3D + Texture
            </button>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() =>
                handleSendChat(
                  'Enhance lighting, skin texture, and cinematic clarity while preserving the subject',
                )
              }
            >
              ✨ Enhance
            </button>
            <button
              type="button"
              className="chip"
              style={{ fontSize: '0.68rem', padding: '0.16rem 0.45rem' }}
              onClick={() =>
                handleSendChat('Animate this photo with subtle natural motion and cinematic camera pan')
              }
            >
              🎬 Animate
            </button>
          </div>
        </div>

        {/* Chat Message History */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
          }}
        >
          {chatTurns.map((turn) => (
            <div
              key={turn.id}
              style={{
                alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                padding: '0.55rem 0.7rem',
                borderRadius: 10,
                fontSize: '0.78rem',
                lineHeight: 1.45,
                background:
                  turn.role === 'user' ? 'rgba(99, 102, 241, 0.25)' : 'rgba(15, 23, 42, 0.85)',
                border: '1px solid var(--border)',
              }}
            >
              <div>{turn.text}</div>
              {turn.plan && turn.plan.action === 'execute' && turn.plan.template_id && (
                <div
                  style={{
                    marginTop: '0.45rem',
                    padding: '0.45rem 0.55rem',
                    borderRadius: 6,
                    background: 'rgba(30, 41, 59, 0.8)',
                    border: '1px solid rgba(99, 102, 241, 0.35)',
                    fontSize: '0.71rem',
                  }}
                >
                  <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
                    🎯 Template: {turn.plan.template_id}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                    Prompt: &ldquo;{turn.plan.prompt}&rdquo;
                  </div>
                  {!turn.runId && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ marginTop: 6, padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
                      onClick={() => handleExecutePlanCard(turn.plan!)}
                    >
                      ▶ Run Workflow Now
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {chatBusy && (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              🤖 Lemonade AI is selecting the optimal ComfyUI workflow...
            </div>
          )}
        </div>

        {/* Chat Input Box */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSendChat()
          }}
          style={{
            padding: '0.65rem',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: '0.4rem',
          }}
        >
          <input
            type="text"
            className="search-input"
            placeholder={
              hasMask
                ? 'Describe what to put in the painted mask...'
                : 'Ask Copilot to edit, isolate, make 3D, or generate...'
            }
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            style={{ flex: 1, fontSize: '0.78rem' }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={chatBusy || !chatInput.trim()}
            style={{ fontSize: '0.78rem', padding: '0.4rem 0.75rem' }}
          >
            Send
          </button>
        </form>
      </aside>
    </div>
  )
}
