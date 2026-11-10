import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AssistantChatResponse,
  AssistantPlan,
  RunOutput,
  RunRecord,
  ScratchItem,
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

type LeftToolset = 'media' | 'paint' | 'adjust' | '3d' | 'scratch'

interface PhotoStudioProps {
  runs: RunRecord[]
  scratchItems: ScratchItem[]
  onAddScratchItem: (item: Omit<ScratchItem, 'id' | 'createdAt'>) => void
  onRemoveScratchItem: (id: string) => void
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

  const alphaCanvas = document.createElement('canvas')
  alphaCanvas.width = w
  alphaCanvas.height = h
  const alphaCtx = alphaCanvas.getContext('2d')!
  if (featherPx > 0) {
    alphaCtx.filter = `blur(${featherPx}px)`
  }
  alphaCtx.drawImage(maskCanvas, 0, 0, w, h)
  alphaCtx.filter = 'none'

  const maskedEditCanvas = document.createElement('canvas')
  maskedEditCanvas.width = w
  maskedEditCanvas.height = h
  const maskedEditCtx = maskedEditCanvas.getContext('2d')!
  maskedEditCtx.drawImage(alphaCanvas, 0, 0, w, h)
  maskedEditCtx.globalCompositeOperation = 'source-in'
  maskedEditCtx.drawImage(editImg, 0, 0, w, h)

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
  scratchItems,
  onAddScratchItem,
  onRemoveScratchItem,
  initialImageUrl,
  initialImageLabel,
  onSendToVideoStudio,
  onRunsUpdated,
}: PhotoStudioProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const refImageInputRef = useRef<HTMLInputElement | null>(null)

  // Minimizable Dock & Toolset state
  const [activeToolset, setActiveToolset] = useState<LeftToolset>('paint')
  const [leftDrawerOpen, setLeftDrawerOpen] = useState<boolean>(true)
  const [rightCopilotOpen, setRightCopilotOpen] = useState<boolean>(true)

  const [revisions, setRevisions] = useState<CanvasRevision[]>([])
  const [activeRevIndex, setActiveRevIndex] = useState<number>(-1)
  const [compareOriginal, setCompareOriginal] = useState(false)

  // Paint & Brush state
  const [brushMode, setBrushMode] = useState<'brush' | 'eraser' | 'pan'>('brush')
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
  const [isolationTarget, setIsolationTarget] = useState<
    'main_character' | 'group' | 'masked' | 'custom'
  >('main_character')
  const [customIsolationPrompt, setCustomIsolationPrompt] = useState('')
  const [figurinePrepass, setFigurinePrepass] = useState(false)
  const [apply3DTexture, setApply3DTexture] = useState(true)
  const [texturePrompt, setTexturePrompt] = useState('')
  const [render3DMode, setRender3DMode] = useState<'texture' | 'solid' | 'normal' | 'auto'>(
    'texture',
  )
  const [active3DModel, setActive3DModel] = useState<{ url: string; filename: string } | null>(
    null,
  )

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
      text: 'Welcome to Photo & 3D Studio! Use the left icon rail to switch toolsets or minimize panels. Paint a mask, isolate a character/group, build a textured 3D model, or ask me anything.',
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

  useEffect(() => {
    fetch('/api/assistant/status')
      .then((r) => r.json())
      .then((d) => {
        setAssistantOnline(Boolean(d.online))
        if (d.active_model) setAssistantModel(d.active_model)
      })
      .catch(() => setAssistantOnline(false))
  }, [])

  useEffect(() => {
    if (initialImageUrl) {
      pushRevision(initialImageUrl, initialImageLabel || 'Imported Frame')
    }
  }, [initialImageUrl, initialImageLabel])

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
            onAddScratchItem({
              kind: '3d',
              label: `3D: ${glbOut.filename}`,
              url: glbOut.url,
              filename: glbOut.filename,
              metaText: 'GLB Mesh',
            })
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
            onAddScratchItem({
              kind: 'video',
              label: run.template_title,
              url: vidOut.url,
              filename: vidOut.filename,
              subfolder: vidOut.subfolder,
              type: vidOut.type,
              metaText: 'AI Video',
            })
            setStatusBanner(`Video generated! Opening in Video Studio...`)
            onSendToVideoStudio(vidOut.url, run.template_title)
          }
        } else if (run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(timer)
          setActiveRunId(null)
          setStatusBanner(`Run ${run.status}: ${run.error || 'Unknown error'}`)
        }
      } catch {}
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
    onAddScratchItem,
  ])

  const selectToolset = (ts: LeftToolset) => {
    if (activeToolset === ts && leftDrawerOpen) {
      setLeftDrawerOpen(false)
    } else {
      setActiveToolset(ts)
      setLeftDrawerOpen(true)
    }
  }

  const clearMask = () => {
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')!
    ctx.clearRect(0, 0, mc.width, mc.height)
    setHasMask(false)
  }

  const paintAtEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mc = maskCanvasRef.current
    if (!mc || brushMode === 'pan') return
    const rect = mc.getBoundingClientRect()
    const scaleX = mc.width / (rect.width || 1)
    const scaleY = mc.height / (rect.height || 1)
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    const ctx = mc.getContext('2d')!
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, brushSize * scaleX * 0.5, 0, Math.PI * 2)
    if (brushMode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(244, 63, 94, 0.62)'
    }
    ctx.fill()
    ctx.restore()
    if (brushMode === 'brush') setHasMask(true)
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

  const handlePinCurrentToScratch = () => {
    const canvas = baseCanvasRef.current
    if (!canvas || !currentRevision) return
    const dataUrl = canvas.toDataURL('image/png')
    onAddScratchItem({
      kind: 'image',
      label: currentRevision.label,
      url: dataUrl,
      metaText: `${currentRevision.width}×${currentRevision.height}`,
    })
    setStatusBanner(`Pinned "${currentRevision.label}" to Scratch Space!`)
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

  const recentImageOutputs = runs
    .flatMap((r) =>
      (r.outputs || [])
        .filter((o) => o.media_kind === 'image')
        .map((o) => ({ ...o, title: r.template_title })),
    )
    .slice(0, 12)

  const toolsetButtons: Array<{ id: LeftToolset; icon: string; label: string; badge?: number }> = [
    { id: 'media', icon: '📂', label: 'Source' },
    { id: 'paint', icon: '🖌️', label: 'Mask' },
    { id: 'adjust', icon: '🎛️', label: 'Adjust' },
    { id: '3d', icon: '🧊', label: '3D Studio' },
    { id: 'scratch', icon: '🗂️', label: 'Scratch', badge: scratchItems.length },
  ]

  return (
    <div
      style={{
        display: 'flex',
        height: 'calc(100vh - 58px)',
        overflow: 'hidden',
        background: 'var(--bg-main)',
      }}
    >
      {/* Hidden File Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />
      <input
        ref={refImageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleSecondImageUpload}
      />

      {/* FAR-LEFT DOCK: Compact Toolset Switcher + Minimize Toggle */}
      <nav
        style={{
          width: 60,
          flexShrink: 0,
          background: '#0b0f19',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '0.6rem 0.25rem',
          gap: '0.45rem',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', width: '100%' }}>
          {toolsetButtons.map((tb) => {
            const isActive = leftDrawerOpen && activeToolset === tb.id
            return (
              <button
                key={tb.id}
                type="button"
                onClick={() => selectToolset(tb.id)}
                title={`${tb.label} Toolset (Click to toggle)`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                  padding: '0.48rem 0.2rem',
                  borderRadius: 8,
                  border: isActive ? '1px solid #6366f1' : '1px solid transparent',
                  background: isActive ? 'rgba(99, 102, 241, 0.22)' : 'transparent',
                  color: isActive ? '#e0e7ff' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.64rem',
                  fontWeight: 600,
                }}
              >
                <span style={{ fontSize: '1.15rem', lineHeight: 1 }}>{tb.icon}</span>
                <span>{tb.label}</span>
                {tb.badge ? (
                  <span
                    style={{
                      position: 'absolute',
                      top: 3,
                      right: 4,
                      background: '#6366f1',
                      color: '#fff',
                      fontSize: '0.58rem',
                      borderRadius: 999,
                      padding: '0 5px',
                      fontWeight: 700,
                    }}
                  >
                    {tb.badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="chip"
          onClick={() => setLeftDrawerOpen((v) => !v)}
          title={leftDrawerOpen ? 'Minimize Left Tool Drawer' : 'Expand Left Tool Drawer'}
          style={{ width: '90%', padding: '0.35rem 0', fontSize: '0.75rem', textAlign: 'center' }}
        >
          {leftDrawerOpen ? '« Hide' : '» Show'}
        </button>
      </nav>

      {/* MINIMIZABLE LEFT TOOLSET DRAWER */}
      {leftDrawerOpen && (
        <aside
          style={{
            width: 285,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '0.85rem',
            gap: '0.85rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid var(--border)',
              paddingBottom: '0.45rem',
            }}
          >
            <span style={{ fontWeight: 700, fontSize: '0.84rem' }}>
              {activeToolset === 'media' && '📂 Photo Source & Recent'}
              {activeToolset === 'paint' && '🖌️ Feathered Mask & Brush'}
              {activeToolset === 'adjust' && '🎛️ Raster Color & Crop'}
              {activeToolset === '3d' && '🧊 Character & 3D Studio'}
              {activeToolset === 'scratch' && `🗂️ Scratch Space (${scratchItems.length})`}
            </span>
            <button
              type="button"
              className="chip"
              style={{ padding: '0.1rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() => setLeftDrawerOpen(false)}
              title="Minimize panel"
            >
              «
            </button>
          </div>

          {/* TOOLSET 1: MEDIA & SOURCE */}
          {activeToolset === 'media' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
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
                  ⬇ Export PNG
                </button>
              </div>

              <div
                style={{
                  padding: '0.6rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid var(--border)',
                  fontSize: '0.74rem',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  2nd Reference / Texture Image
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: 6 }}>
                  Used for multi-image edits (`Qwen 2.1`) or custom 3D mesh texture projection.
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.72rem' }}>{secondImageName || 'None loaded'}</span>
                  <button
                    type="button"
                    className="chip"
                    onClick={() =>
                      secondImageB64
                        ? (setSecondImageB64(null), setSecondImageName(null))
                        : refImageInputRef.current?.click()
                    }
                  >
                    {secondImageB64 ? 'Clear' : '+ Load Ref'}
                  </button>
                </div>
              </div>

              <div>
                <div style={{ fontSize: '0.74rem', fontWeight: 600, marginBottom: 6 }}>
                  Recent ComfyUI Generations
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 6,
                  }}
                >
                  {recentImageOutputs.map((item, idx) => (
                    <div
                      key={`${item.filename}-${idx}`}
                      onClick={() => pushRevision(item.url, item.title)}
                      style={{
                        cursor: 'pointer',
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid var(--border)',
                        position: 'relative',
                      }}
                      title={`Click to load: ${item.title}`}
                    >
                      <img
                        src={item.url}
                        alt={item.title}
                        style={{ width: '100%', height: 68, objectFit: 'cover', display: 'block' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TOOLSET 2: PAINT & FEATHERED MASK */}
          {activeToolset === 'paint' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
                fontSize: '0.76rem',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.35rem' }}>
                <button
                  type="button"
                  className={`chip ${brushMode === 'brush' ? 'active' : ''}`}
                  onClick={() => setBrushMode('brush')}
                >
                  🖌️ Paint
                </button>
                <button
                  type="button"
                  className={`chip ${brushMode === 'eraser' ? 'active' : ''}`}
                  onClick={() => setBrushMode('eraser')}
                >
                  🧹 Erase
                </button>
                <button
                  type="button"
                  className={`chip ${brushMode === 'pan' ? 'active' : ''}`}
                  onClick={() => setBrushMode('pan')}
                >
                  👆 Cursor
                </button>
              </div>

              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Brush Diameter</span>
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
                <span>Mask Feathering (Soft Edge)</span>
                <span>{featherPx}px</span>
              </label>
              <input
                type="range"
                min={0}
                max={40}
                value={featherPx}
                onChange={(e) => setFeatherPx(Number(e.target.value))}
              />

              <div style={{ display: 'flex', gap: '0.35rem' }}>
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

              <div
                style={{
                  padding: '0.6rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid var(--border)',
                  fontSize: '0.71rem',
                  color: 'var(--text-muted)',
                  lineHeight: 1.45,
                }}
              >
                <strong>How Localized Fill Works:</strong> Paint ruby-red over any area on the
                canvas, then ask the AI Copilot what to change. Studio runs <em>Qwen Image Edit</em>{' '}
                and alpha-composites only your feathered mask back onto the original image.
              </div>
            </div>
          )}

          {/* TOOLSET 3: RASTER COLOR & CROP */}
          {activeToolset === 'adjust' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
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
                <span>Warmth / Sepia</span>
                <span>{warmth}%</span>
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={warmth}
                onChange={(e) => setWarmth(Number(e.target.value))}
              />
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Gaussian Blur</span>
                <span>{blurPx}px</span>
              </label>
              <input
                type="range"
                min={0}
                max={12}
                value={blurPx}
                onChange={(e) => setBlurPx(Number(e.target.value))}
              />

              <div style={{ display: 'flex', gap: '0.35rem', marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, fontSize: '0.74rem' }}
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

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.35rem 0' }} />
              <div style={{ fontWeight: 600 }}>Rotate &amp; Flip</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
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

              <div style={{ fontWeight: 600, marginTop: 4 }}>Center Aspect Crop</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
                <button type="button" className="chip" onClick={() => handleAspectCrop(1, 1)}>
                  1:1 Square
                </button>
                <button type="button" className="chip" onClick={() => handleAspectCrop(16, 9)}>
                  16:9 Widescreen
                </button>
                <button type="button" className="chip" onClick={() => handleAspectCrop(9, 16)}>
                  9:16 Vertical
                </button>
                <button type="button" className="chip" onClick={() => handleAspectCrop(4, 3)}>
                  4:3 Classic
                </button>
              </div>
            </div>
          )}

          {/* TOOLSET 4: CHARACTER ISOLATION & 3D STUDIO */}
          {activeToolset === '3d' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
                fontSize: '0.75rem',
              }}
            >
              <div style={{ fontWeight: 600, color: '#a5b4fc' }}>
                Step 1: Isolate Character / Group
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
                  placeholder="e.g., Isolate the knight in silver armor..."
                  value={customIsolationPrompt}
                  onChange={(e) => setCustomIsolationPrompt(e.target.value)}
                  style={{ fontSize: '0.74rem' }}
                />
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={figurinePrepass}
                  onChange={(e) => setFigurinePrepass(e.target.checked)}
                />
                <span>3D Figurine clean lighting pre-pass</span>
              </label>

              <button
                type="button"
                className="btn"
                style={{ width: '100%', fontSize: '0.75rem', borderColor: '#6366f1' }}
                onClick={handleRunCharacterIsolation}
                disabled={!currentRevision || Boolean(activeRunId)}
              >
                ✂️ 1. Isolate &amp; Remove BG (Qwen 2.1)
              </button>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.2rem 0' }} />

              <div style={{ fontWeight: 600, color: '#a5b4fc' }}>
                Step 2: 3D Mesh + UV Texture + Render
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={apply3DTexture}
                  onChange={(e) => setApply3DTexture(e.target.checked)}
                />
                <span>UV-Unwrap &amp; Apply Color/Texture Map</span>
              </label>

              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.71rem' }}>Render Mode:</span>
                <select
                  value={render3DMode}
                  onChange={(e) => setRender3DMode(e.target.value as any)}
                  style={{
                    flex: 1,
                    background: 'var(--bg-main)',
                    color: 'var(--text-main)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '0.25rem 0.4rem',
                    fontSize: '0.72rem',
                  }}
                >
                  <option value="texture">Textured 3D Render</option>
                  <option value="solid">Shaded Clay Render</option>
                  <option value="normal">Surface Normal Map</option>
                  <option value="auto">Auto</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Optional material (e.g. gold armor)"
                  value={texturePrompt}
                  onChange={(e) => setTexturePrompt(e.target.value)}
                  style={{ flex: 1, fontSize: '0.72rem' }}
                />
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.68rem' }}
                  onClick={handleGenerateAITextureFor3D}
                  disabled={!texturePrompt.trim() || Boolean(activeRunId)}
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
          )}

          {/* TOOLSET 5: SHARED SCRATCH SPACE */}
          {activeToolset === 'scratch' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '0.75rem' }}
                onClick={handlePinCurrentToScratch}
                disabled={!currentRevision}
              >
                📌 Pin Current Canvas to Scratch Space
              </button>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Scratch Space holds intermediate cutouts, video frames, textures, and clips across
                Photo &amp; Video Studio.
              </div>
              {scratchItems.length === 0 ? (
                <div
                  style={{
                    padding: '1.2rem',
                    textAlign: 'center',
                    border: '1px dashed var(--border)',
                    borderRadius: 8,
                    color: 'var(--text-muted)',
                    fontSize: '0.74rem',
                  }}
                >
                  No items in Scratch Space yet. Pin a canvas layer or capture a frame from Video
                  Studio!
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {scratchItems.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        padding: '0.45rem',
                        borderRadius: 8,
                        background: 'rgba(15, 23, 42, 0.7)',
                        border: '1px solid var(--border)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                        fontSize: '0.72rem',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {item.kind === 'image' ? (
                          <img
                            src={item.url}
                            alt={item.label}
                            style={{
                              width: 48,
                              height: 48,
                              objectFit: 'cover',
                              borderRadius: 5,
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 48,
                              height: 48,
                              borderRadius: 5,
                              background: '#1e293b',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '1.2rem',
                              flexShrink: 0,
                            }}
                          >
                            {item.kind === 'video' ? '🎬' : '🧊'}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {item.label}
                          </div>
                          <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                            {item.metaText || item.kind.toUpperCase()}
                          </div>
                        </div>
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#fca5a5',
                            cursor: 'pointer',
                          }}
                          onClick={() => onRemoveScratchItem(item.id)}
                          title="Remove from Scratch Space"
                        >
                          ✕
                        </button>
                      </div>

                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {item.kind === 'image' && (
                          <>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => pushRevision(item.url, item.label)}
                            >
                              🖼️ To Canvas
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => {
                                setSecondImageB64(item.url)
                                setSecondImageName(item.label)
                                setStatusBanner(`Set "${item.label}" as Reference / 3D Texture`)
                              }}
                            >
                              🎨 Use as Ref/Tex
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => onSendToVideoStudio(item.url, item.label)}
                            >
                              🎬 To Video
                            </button>
                          </>
                        )}
                        {item.kind === '3d' && (
                          <button
                            type="button"
                            className="chip"
                            style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                            onClick={() =>
                              setActive3DModel({
                                url: item.url,
                                filename: item.filename || 'model.glb',
                              })
                            }
                          >
                            🧊 Open 3D Viewer
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      )}

      {/* CENTER WORKSPACE: Interactive Dual-Canvas + 3D Material Studio + Bottom Revision Strip */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
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
            padding: '0.48rem 0.85rem',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            fontSize: '0.75rem',
            flexWrap: 'wrap',
            gap: '0.4rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600 }}>
              {currentRevision
                ? `${currentRevision.label} (${currentRevision.width}×${currentRevision.height})`
                : 'Empty Canvas'}
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
                🖌️ Mask Active
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="chip"
              onClick={() => setActiveRevIndex((i) => Math.max(0, i - 1))}
              disabled={activeRevIndex <= 0}
            >
              ↩ Undo
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => setActiveRevIndex((i) => Math.min(revisions.length - 1, i + 1))}
              disabled={activeRevIndex >= revisions.length - 1}
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
            >
              👁️ Compare Orig
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.15).toFixed(2)))}
            >
              −
            </button>
            <span style={{ minWidth: 40, textAlign: 'center', fontSize: '0.72rem' }}>
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
              <>
                <button
                  type="button"
                  className="chip"
                  onClick={handlePinCurrentToScratch}
                  title="Pin current canvas layer to Scratch Space"
                >
                  📌 To Scratch
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: '0.18rem 0.55rem', fontSize: '0.72rem' }}
                  onClick={() =>
                    onSendToVideoStudio(currentRevision.dataUrl, currentRevision.label)
                  }
                >
                  🎬 To Video
                </button>
              </>
            )}
            <button
              type="button"
              className={`chip ${rightCopilotOpen ? 'active' : ''}`}
              onClick={() => setRightCopilotOpen((v) => !v)}
              title="Toggle AI Copilot Sidebar"
            >
              🤖 {rightCopilotOpen ? 'Hide Copilot »' : '« AI Copilot'}
            </button>
          </div>
        </div>

        {statusBanner && (
          <div
            style={{
              padding: '0.4rem 0.9rem',
              background: 'rgba(99, 102, 241, 0.16)',
              borderBottom: '1px solid rgba(99, 102, 241, 0.35)',
              color: '#c7d2fe',
              fontSize: '0.75rem',
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

        {/* Canvas Viewport */}
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
            <div style={{ width: '100%', maxWidth: 820 }}>
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
                  🧊 Interactive 3D Material &amp; Render Studio ({active3DModel.filename})
                </span>
                <button type="button" className="chip" onClick={() => setActive3DModel(null)}>
                  Hide 3D Viewer
                </button>
              </div>
              <Model3DViewer
                url={active3DModel.url}
                filename={active3DModel.filename}
                height={330}
                textureCandidateUrl={secondImageB64 || currentRevision?.dataUrl || null}
                onCaptureRenderToCanvas={(dataUrl, label) => {
                  pushRevision(dataUrl, label)
                  onAddScratchItem({
                    kind: 'image',
                    label,
                    url: dataUrl,
                    metaText: '3D Snapshot',
                  })
                  setStatusBanner('Captured 3D Render onto Canvas & Scratch Space!')
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
                style={{ display: 'block', maxWidth: '78vw', maxHeight: '68vh' }}
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
                  cursor: brushMode === 'pan' ? 'grab' : 'crosshair',
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
                Open a photo from disk, pick from Scratch Space (`🗂️`), or ask the AI Copilot on
                the right to generate a brand-new image!
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  📂 Open Photo
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => selectToolset('media')}
                >
                  Browse Recent Generations
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Revision History Filmstrip */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: '0.45rem 0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.55rem',
            overflowX: 'auto',
            minHeight: 68,
          }}
        >
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            History ({revisions.length}):
          </span>
          {revisions.map((rev, idx) => (
            <div
              key={rev.id}
              onClick={() => setActiveRevIndex(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0.2rem 0.45rem',
                borderRadius: 8,
                cursor: 'pointer',
                border:
                  idx === activeRevIndex ? '2px solid #6366f1' : '1px solid var(--border)',
                background:
                  idx === activeRevIndex ? 'rgba(99, 102, 241, 0.16)' : 'rgba(15, 23, 42, 0.6)',
                flexShrink: 0,
              }}
            >
              <img
                src={rev.dataUrl}
                alt={rev.label}
                style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4 }}
              />
              <div style={{ fontSize: '0.68rem', maxWidth: 110 }}>
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
                <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>
                  {rev.width}×{rev.height}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* MINIMIZABLE RIGHT PANEL: AI Copilot Chat & Automatic Model Router */}
      {rightCopilotOpen && (
        <aside
          style={{
            width: 340,
            flexShrink: 0,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '0.7rem 0.8rem',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.45rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>🤖 Lemonade AI Copilot</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: '0.66rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: 999,
                    background: assistantOnline
                      ? 'rgba(16, 185, 129, 0.16)'
                      : 'rgba(245, 158, 11, 0.16)',
                    color: assistantOnline ? '#34d399' : '#fbbf24',
                  }}
                >
                  {assistantOnline ? '🟢 Online' : '🟡 Local'}
                </span>
                <button
                  type="button"
                  className="chip"
                  style={{ padding: '0.1rem 0.4rem', fontSize: '0.68rem' }}
                  onClick={() => setRightCopilotOpen(false)}
                  title="Minimize Copilot Sidebar"
                >
                  »
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
              }}
            >
              <span
                title={assistantModel}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {assistantModel}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className={`chip ${autoPilot ? 'active' : ''}`}
                  style={{ padding: '0.1rem 0.4rem', fontSize: '0.66rem' }}
                  onClick={() => setAutoPilot(true)}
                >
                  ⚡ Auto
                </button>
                <button
                  type="button"
                  className={`chip ${!autoPilot ? 'active' : ''}`}
                  style={{ padding: '0.1rem 0.4rem', fontSize: '0.66rem' }}
                  onClick={() => setAutoPilot(false)}
                >
                  🧭 Review
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.28rem' }}>
              <button
                type="button"
                className="chip"
                style={{ fontSize: '0.66rem', padding: '0.14rem 0.42rem' }}
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
                style={{ fontSize: '0.66rem', padding: '0.14rem 0.42rem' }}
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
                style={{ fontSize: '0.66rem', padding: '0.14rem 0.42rem' }}
                onClick={() => handleSendChat('Remove the background and output a clean PNG')}
              >
                ✂️ Remove BG
              </button>
              <button
                type="button"
                className="chip"
                style={{ fontSize: '0.66rem', padding: '0.14rem 0.42rem' }}
                onClick={() =>
                  handleSendChat('Convert this subject into a textured 3D model and render it')
                }
              >
                🧊 3D + Texture
              </button>
              <button
                type="button"
                className="chip"
                style={{ fontSize: '0.66rem', padding: '0.14rem 0.42rem' }}
                onClick={() =>
                  handleSendChat(
                    'Enhance lighting, skin texture, and cinematic clarity while preserving the subject',
                  )
                }
              >
                ✨ Enhance
              </button>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '0.7rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.6rem',
            }}
          >
            {chatTurns.map((turn) => (
              <div
                key={turn.id}
                style={{
                  alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  padding: '0.5rem 0.65rem',
                  borderRadius: 10,
                  fontSize: '0.76rem',
                  lineHeight: 1.45,
                  background:
                    turn.role === 'user'
                      ? 'rgba(99, 102, 241, 0.25)'
                      : 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid var(--border)',
                }}
              >
                <div>{turn.text}</div>
                {turn.plan && turn.plan.action === 'execute' && turn.plan.template_id && (
                  <div
                    style={{
                      marginTop: '0.4rem',
                      padding: '0.4rem 0.5rem',
                      borderRadius: 6,
                      background: 'rgba(30, 41, 59, 0.8)',
                      border: '1px solid rgba(99, 102, 241, 0.35)',
                      fontSize: '0.7rem',
                    }}
                  >
                    <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
                      🎯 {turn.plan.template_id}
                    </div>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                      &ldquo;{turn.plan.prompt}&rdquo;
                    </div>
                    {!turn.runId && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ marginTop: 6, padding: '0.18rem 0.55rem', fontSize: '0.68rem' }}
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
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                🤖 Selecting optimal ComfyUI workflow...
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSendChat()
            }}
            style={{
              padding: '0.6rem',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: '0.35rem',
            }}
          >
            <input
              type="text"
              className="search-input"
              placeholder={
                hasMask
                  ? 'Describe what to put in painted mask...'
                  : 'Ask Copilot to edit, isolate, make 3D...'
              }
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              style={{ flex: 1, fontSize: '0.76rem' }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={chatBusy || !chatInput.trim()}
              style={{ fontSize: '0.76rem', padding: '0.38rem 0.7rem' }}
            >
              Send
            </button>
          </form>
        </aside>
      )}
    </div>
  )
}
