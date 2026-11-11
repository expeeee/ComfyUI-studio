import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AssistantChatResponse,
  AssistantPlan,
  RunOutput,
  RunRecord,
  ScratchItem,
} from './api'
import { Model3DViewer } from './Model3DViewer'

export interface PhotoLayer {
  id: string
  name: string
  dataUrl: string
  width: number
  height: number
  visible: boolean
  locked: boolean
  opacity: number // 0..100
  blendMode: GlobalCompositeOperation
  offsetX: number
  offsetY: number
  scale: number // 0.1..4.0
  brightness: number // 40..160 (default 100)
  contrast: number // 40..160 (default 100)
  saturation: number // 0..200 (default 100)
  warmth: number // 0..100 (default 0)
  blurPx: number // 0..12 (default 0)
}

export interface CanvasRevision {
  id: string
  label: string
  dataUrl: string
  width: number
  height: number
  timestamp: number
  layersSnapshot?: PhotoLayer[]
  activeLayerIdSnapshot?: string | null
}

interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  plan?: AssistantPlan | null
  runId?: string | null
}

type LeftToolset = 'layers' | 'media' | 'paint' | 'adjust' | '3d' | 'scratch'
type CanvasToolMode =
  | 'mask_brush'
  | 'mask_eraser'
  | 'box_select'
  | 'layer_brush'
  | 'layer_eraser'
  | 'move_layer'

const BLEND_MODES: Array<{ value: GlobalCompositeOperation; label: string }> = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'luminosity', label: 'Luminosity' },
  { value: 'color', label: 'Color' },
]

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

const imageCache = new Map<string, HTMLImageElement>()

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src)
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return cached
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (imageCache.size > 80) {
        const firstKey = imageCache.keys().next().value
        if (firstKey) imageCache.delete(firstKey)
      }
      imageCache.set(src, img)
      resolve(img)
    }
    img.onerror = (err) => reject(err)
    img.src = src
  })
}

function createDefaultLayer(
  dataUrl: string,
  name: string,
  width: number,
  height: number,
): PhotoLayer {
  return {
    id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    dataUrl,
    width,
    height,
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'source-over',
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    warmth: 0,
    blurPx: 0,
  }
}

async function renderLayersToDataUrl(
  layers: PhotoLayer[],
  docWidth: number,
  docHeight: number,
): Promise<string> {
  const c = document.createElement('canvas')
  c.width = docWidth
  c.height = docHeight
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, docWidth, docHeight)

  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    try {
      const img = await loadImageElement(layer.dataUrl)
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity / 100))
      ctx.globalCompositeOperation = layer.blendMode || 'source-over'
      const hasFilter =
        layer.brightness !== 100 ||
        layer.contrast !== 100 ||
        layer.saturation !== 100 ||
        layer.warmth !== 0 ||
        layer.blurPx !== 0
      if (hasFilter) {
        ctx.filter = `brightness(${layer.brightness}%) contrast(${layer.contrast}%) saturate(${layer.saturation}%) sepia(${layer.warmth}%) blur(${layer.blurPx}px)`
      }
      const drawW = layer.width * (layer.scale || 1)
      const drawH = layer.height * (layer.scale || 1)
      const dx = (docWidth - drawW) / 2 + (layer.offsetX || 0)
      const dy = (docHeight - drawH) / 2 + (layer.offsetY || 0)
      ctx.drawImage(img, dx, dy, drawW, drawH)
      ctx.restore()
    } catch {
      // ignore broken layer
    }
  }
  return c.toDataURL('image/png')
}

/**
 * Removes solid corner-sampled background color (e.g. white studio background from Qwen BG removal)
 * and turns it into true alpha transparency for multi-layer compositing.
 */
async function keyOutSolidBackgroundToAlpha(
  srcDataUrl: string,
  tolerance = 34,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImageElement(srcDataUrl)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const imgData = ctx.getImageData(0, 0, w, h)
  const d = imgData.data

  // Sample 4 corners to detect background color
  const corners = [
    0,
    (w - 1) * 4,
    (h - 1) * w * 4,
    ((h - 1) * w + (w - 1)) * 4,
  ]
  let rBg = 0
  let gBg = 0
  let bBg = 0
  for (const idx of corners) {
    rBg += d[idx]
    gBg += d[idx + 1]
    bBg += d[idx + 2]
  }
  rBg = Math.round(rBg / 4)
  gBg = Math.round(gBg / 4)
  bBg = Math.round(bBg / 4)

  const softBand = Math.max(12, Math.round(tolerance * 0.6))
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - rBg
    const dg = d[i + 1] - gBg
    const db = d[i + 2] - bBg
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)
    if (dist <= tolerance) {
      d[i + 3] = 0
    } else if (dist < tolerance + softBand) {
      const factor = (dist - tolerance) / softBand
      d[i + 3] = Math.round(d[i + 3] * factor)
    }
  }
  ctx.putImageData(imgData, 0, 0)
  return { dataUrl: c.toDataURL('image/png'), width: w, height: h }
}

async function compositeWithFeatheredMask(
  originalDataUrl: string,
  editedImageUrl: string,
  maskCanvas: HTMLCanvasElement,
  featherPx: number,
  onlyMaskedPatch = false,
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

  if (onlyMaskedPatch) {
    return {
      dataUrl: maskedEditCanvas.toDataURL('image/png'),
      width: w,
      height: h,
    }
  }

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
  transparentBg = false,
): Promise<string> {
  const origImg = await loadImageElement(baseDataUrl)
  const w = origImg.naturalWidth || origImg.width
  const h = origImg.naturalHeight || origImg.height

  const alphaCanvas = document.createElement('canvas')
  alphaCanvas.width = w
  alphaCanvas.height = h
  const alphaCtx = alphaCanvas.getContext('2d')!
  if (featherPx > 0) {
    alphaCtx.filter = `blur(${Math.max(2, featherPx)}px)`
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

  if (transparentBg) {
    return subjCanvas.toDataURL('image/png')
  }

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
  const addLayerFileInputRef = useRef<HTMLInputElement | null>(null)
  const refImageInputRef = useRef<HTMLInputElement | null>(null)

  // Minimizable Dock & Toolset state (Default to Patchy Layers toolset)
  const [activeToolset, setActiveToolset] = useState<LeftToolset>('layers')
  const [leftDrawerOpen, setLeftDrawerOpen] = useState<boolean>(true)
  const [rightCopilotOpen, setRightCopilotOpen] = useState<boolean>(true)

  // Multi-Layer Stack state (Patchy architecture)
  const [docSize, setDocSize] = useState<{ width: number; height: number }>({
    width: 1024,
    height: 1024,
  })
  const [layers, setLayers] = useState<PhotoLayer[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null)
  const [aiOutputMode, setAiOutputMode] = useState<'new_layer' | 'replace_active'>('new_layer')
  const [aiInputSource, setAiInputSource] = useState<'composite' | 'active_layer'>('composite')
  const [autoKeyCutoutBg, setAutoKeyCutoutBg] = useState<boolean>(true)
  const [bgKeyTolerance, setBgKeyTolerance] = useState<number>(34)

  // Undo/Redo Revision History (stores both composited preview & full layer stack snapshot)
  const [revisions, setRevisions] = useState<CanvasRevision[]>([])
  const [activeRevIndex, setActiveRevIndex] = useState<number>(-1)
  const [compareOriginal, setCompareOriginal] = useState(false)

  // Paint, Mask, Box Select & Move Layer state
  const [toolMode, setToolMode] = useState<CanvasToolMode>('mask_brush')
  const [brushSize, setBrushSize] = useState(42)
  const [brushColor, setBrushColor] = useState('#6366f1')
  const [brushOpacity, setBrushOpacity] = useState(100)
  const [featherPx, setFeatherPx] = useState(12)
  const [hasMask, setHasMask] = useState(false)
  const [showMaskOverlay, setShowMaskOverlay] = useState(true)
  const [zoom, setZoom] = useState(1.0)
  const [isPainting, setIsPainting] = useState(false)
  const [boxDragStart, setBoxDragStart] = useState<{ x: number; y: number } | null>(null)
  const [boxDragCurrent, setBoxDragCurrent] = useState<{ x: number; y: number } | null>(null)
  const moveStartRef = useRef<{
    mouseX: number
    mouseY: number
    origX: number
    origY: number
  } | null>(null)
  const layerPaintCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Optional 2nd Reference / Texture image
  const [secondImageB64, setSecondImageB64] = useState<string | null>(null)
  const [secondImageName, setSecondImageName] = useState<string | null>(null)

  // Drag & Drop + Google Photos / URL Import state
  const [urlImportInput, setUrlImportInput] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [dropAsNewLayer, setDropAsNewLayer] = useState(true)

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
      text: 'Welcome to the Patchy-powered Photo & 3D Studio! Manage non-destructive layers with blend modes & opacity in the Layers drawer, use Box Select or Feathered Masks to isolate objects onto new layers, or ask me to generate & edit.',
    },
  ])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activePostProcess, setActivePostProcess] = useState<string>('replace_canvas')
  const [statusBanner, setStatusBanner] = useState<string | null>(null)

  const activeLayer = layers.find((l) => l.id === activeLayerId) || layers[layers.length - 1] || null
  const currentRevision =
    activeRevIndex >= 0 && activeRevIndex < revisions.length ? revisions[activeRevIndex] : null
  const originalRevision = revisions.length > 0 ? revisions[0] : null

  // Save a snapshot of the layer stack + composited image to revision history
  const recordLayerHistory = useCallback(
    async (
      nextLayers: PhotoLayer[],
      nextActiveId: string | null,
      label: string,
      widthOverride?: number,
      heightOverride?: number,
    ) => {
      const w = widthOverride || docSize.width || 1024
      const h = heightOverride || docSize.height || 1024
      setLayers(nextLayers)
      setActiveLayerId(nextActiveId)
      if (widthOverride && heightOverride) {
        setDocSize({ width: w, height: h })
      }
      if (nextLayers.length === 0) return
      const compositeUrl = await renderLayersToDataUrl(nextLayers, w, h)
      const rev: CanvasRevision = {
        id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label,
        dataUrl: compositeUrl,
        width: w,
        height: h,
        timestamp: Date.now(),
        layersSnapshot: nextLayers.map((l) => ({ ...l })),
        activeLayerIdSnapshot: nextActiveId,
      }
      setRevisions((prev) => {
        const next = [...prev.slice(0, activeRevIndex + 1), rev]
        setActiveRevIndex(next.length - 1)
        return next
      })
    },
    [docSize.width, docSize.height, activeRevIndex],
  )

  /**
   * Loads an image onto the canvas:
   * - If `asNewLayer` is true and layers already exist, adds it as a new layer on top.
   * - Otherwise initializes/replaces the document with this layer, or updates the active layer.
   */
  const pushRevision = useCallback(
    async (
      imageUrlOrDataUrl: string,
      label: string,
      options?: {
        mode?: 'auto' | 'new_doc' | 'new_layer' | 'replace_active'
        keyBackground?: boolean
      },
    ) => {
      try {
        let finalDataUrl = imageUrlOrDataUrl
        let w = 1024
        let h = 1024

        if (options?.keyBackground) {
          const keyed = await keyOutSolidBackgroundToAlpha(imageUrlOrDataUrl, bgKeyTolerance)
          finalDataUrl = keyed.dataUrl
          w = keyed.width
          h = keyed.height
        } else {
          const img = await loadImageElement(imageUrlOrDataUrl)
          w = img.naturalWidth || img.width || 1024
          h = img.naturalHeight || img.height || 1024
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const ctx = c.getContext('2d')!
          ctx.drawImage(img, 0, 0, w, h)
          finalDataUrl = c.toDataURL('image/png')
        }

        const effectiveMode =
          options?.mode === 'auto' || !options?.mode
            ? layers.length === 0
              ? 'new_doc'
              : aiOutputMode
            : options.mode

        if (effectiveMode === 'new_doc' || layers.length === 0) {
          const baseLayer = createDefaultLayer(finalDataUrl, label, w, h)
          await recordLayerHistory([baseLayer], baseLayer.id, label, w, h)
        } else if (effectiveMode === 'new_layer') {
          const newLayer = createDefaultLayer(finalDataUrl, label, w, h)
          const nextLayers = [...layers, newLayer]
          await recordLayerHistory(nextLayers, newLayer.id, `+ Layer: ${label}`)
        } else {
          // replace_active
          const targetId = activeLayer?.id || layers[layers.length - 1].id
          const nextLayers = layers.map((l) =>
            l.id === targetId
              ? { ...l, name: label, dataUrl: finalDataUrl, width: w, height: h }
              : l,
          )
          await recordLayerHistory(nextLayers, targetId, label)
        }
      } catch (err) {
        setStatusBanner(`Failed to load image onto layer stack: ${String(err)}`)
      }
    },
    [layers, activeLayer, aiOutputMode, bgKeyTolerance, recordLayerHistory],
  )

  // Restore layer stack when stepping through Undo / Redo / History strip
  const selectRevisionIndex = (idx: number) => {
    if (idx < 0 || idx >= revisions.length) return
    const rev = revisions[idx]
    setActiveRevIndex(idx)
    if (rev.layersSnapshot && rev.layersSnapshot.length > 0) {
      setLayers(rev.layersSnapshot.map((l) => ({ ...l })))
      setActiveLayerId(rev.activeLayerIdSnapshot || rev.layersSnapshot[rev.layersSnapshot.length - 1].id)
      setDocSize({ width: rev.width, height: rev.height })
    }
  }

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
      pushRevision(initialImageUrl, initialImageLabel || 'Imported Frame', {
        mode: layers.length > 0 ? 'new_layer' : 'new_doc',
      })
    }
  }, [initialImageUrl, initialImageLabel])

  // Render live Multi-Layer Stack to baseCanvasRef whenever layers, adjustments, or compareOriginal change
  useEffect(() => {
    const canvas = baseCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    if (!canvas || layers.length === 0) return

    let cancelled = false

    const renderStack = async () => {
      if (compareOriginal && originalRevision) {
        const origImg = await loadImageElement(originalRevision.dataUrl)
        if (cancelled) return
        canvas.width = originalRevision.width
        canvas.height = originalRevision.height
        const ctx = canvas.getContext('2d')!
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(origImg, 0, 0)
        return
      }

      const w = docSize.width
      const h = docSize.height
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      if (maskCanvas && (maskCanvas.width !== w || maskCanvas.height !== h)) {
        maskCanvas.width = w
        maskCanvas.height = h
        setHasMask(false)
      }

      const loaded = await Promise.all(
        layers.map(async (layer) => {
          if (!layer.visible || layer.opacity <= 0) return null
          try {
            const img = await loadImageElement(layer.dataUrl)
            return { layer, img }
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return

      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, w, h)

      for (const item of loaded) {
        if (!item) continue
        const { layer, img } = item
        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity / 100))
        ctx.globalCompositeOperation = layer.blendMode || 'source-over'
        const hasFilter =
          layer.brightness !== 100 ||
          layer.contrast !== 100 ||
          layer.saturation !== 100 ||
          layer.warmth !== 0 ||
          layer.blurPx !== 0
        if (hasFilter) {
          ctx.filter = `brightness(${layer.brightness}%) contrast(${layer.contrast}%) saturate(${layer.saturation}%) sepia(${layer.warmth}%) blur(${layer.blurPx}px)`
        }
        const drawW = layer.width * (layer.scale || 1)
        const drawH = layer.height * (layer.scale || 1)
        const dx = (w - drawW) / 2 + (layer.offsetX || 0)
        const dy = (h - drawH) / 2 + (layer.offsetY || 0)
        ctx.drawImage(img, dx, dy, drawW, drawH)
        ctx.restore()
      }
    }

    renderStack()
    return () => {
      cancelled = true
    }
  }, [layers, docSize.width, docSize.height, compareOriginal, originalRevision])

  // Poll active ComfyUI run and route result into the Multi-Layer Stack
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
            const isBgRemoval =
              run.template_id?.includes('background_removal') ||
              run.template_title?.toLowerCase().includes('background') ||
              run.template_title?.toLowerCase().includes('isolate')

            if (
              activePostProcess === 'feathered_mask_composite' &&
              hasMask &&
              currentRevision &&
              maskCanvasRef.current
            ) {
              const sourceUrl =
                aiInputSource === 'active_layer' && activeLayer
                  ? activeLayer.dataUrl
                  : currentRevision.dataUrl
              const comp = await compositeWithFeatheredMask(
                sourceUrl,
                imgOut.url,
                maskCanvasRef.current,
                featherPx,
                aiOutputMode === 'new_layer',
              )
              await pushRevision(comp.dataUrl, `${run.template_title} (Masked Patch)`, {
                mode: aiOutputMode,
              })
              clearMask()
              setStatusBanner(
                aiOutputMode === 'new_layer'
                  ? 'Added Feathered Mask Generative Fill as a non-destructive Layer!'
                  : 'Applied Feathered Mask Generative Fill to active layer.',
              )
            } else {
              await pushRevision(imgOut.url, run.template_title, {
                mode: aiOutputMode,
                keyBackground: isBgRemoval && autoKeyCutoutBg,
              })
              setStatusBanner(
                isBgRemoval && autoKeyCutoutBg
                  ? `Isolated subject onto transparent Layer: "${run.template_title}"`
                  : `Added "${run.template_title}" to Layer Stack`,
              )
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
    activeLayer,
    aiInputSource,
    aiOutputMode,
    autoKeyCutoutBg,
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

  // --- LAYER STACK OPERATIONS (Patchy Multi-Layer Controls) ---
  const updateActiveLayer = (patch: Partial<PhotoLayer>) => {
    if (!activeLayer) return
    setLayers((prev) => prev.map((l) => (l.id === activeLayer.id ? { ...l, ...patch } : l)))
  }

  const updateLayerById = (id: string, patch: Partial<PhotoLayer>) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  const handleAddEmptyLayer = async () => {
    const w = docSize.width || 1024
    const h = docSize.height || 1024
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const emptyLayer = createDefaultLayer(
      c.toDataURL('image/png'),
      `Paint Layer ${layers.length + 1}`,
      w,
      h,
    )
    const next = [...layers, emptyLayer]
    await recordLayerHistory(next, emptyLayer.id, `New Empty Layer`)
    setToolMode('layer_brush')
    setStatusBanner(`Created transparent "${emptyLayer.name}" and switched to Layer Brush!`)
  }

  const handleDuplicateActiveLayer = async () => {
    if (!activeLayer) return
    const copy: PhotoLayer = {
      ...activeLayer,
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${activeLayer.name} Copy`,
      offsetX: activeLayer.offsetX + 16,
      offsetY: activeLayer.offsetY + 16,
    }
    const idx = layers.findIndex((l) => l.id === activeLayer.id)
    const next = [...layers.slice(0, idx + 1), copy, ...layers.slice(idx + 1)]
    await recordLayerHistory(next, copy.id, `Duplicated ${activeLayer.name}`)
  }

  const handleMoveLayerOrder = async (id: string, direction: 'up' | 'down') => {
    const idx = layers.findIndex((l) => l.id === id)
    if (idx === -1) return
    const targetIdx = direction === 'up' ? idx + 1 : idx - 1
    if (targetIdx < 0 || targetIdx >= layers.length) return
    const next = [...layers]
    const [item] = next.splice(idx, 1)
    next.splice(targetIdx, 0, item)
    await recordLayerHistory(next, id, `Reordered ${item.name}`)
  }

  const handleDeleteLayer = async (id: string) => {
    if (layers.length <= 1) {
      setStatusBanner('Cannot delete the only remaining layer.')
      return
    }
    const target = layers.find((l) => l.id === id)
    const next = layers.filter((l) => l.id !== id)
    const nextActive = next[next.length - 1]?.id || null
    await recordLayerHistory(next, nextActive, `Deleted ${target?.name || 'Layer'}`)
  }

  const handleMergeLayerDown = async () => {
    if (!activeLayer) return
    const idx = layers.findIndex((l) => l.id === activeLayer.id)
    if (idx <= 0) {
      setStatusBanner('Active layer is already at the bottom of the stack.')
      return
    }
    const bottomLayer = layers[idx - 1]
    const mergedUrl = await renderLayersToDataUrl(
      [
        { ...bottomLayer, visible: true },
        { ...activeLayer, visible: true },
      ],
      docSize.width,
      docSize.height,
    )
    const mergedLayer: PhotoLayer = {
      ...createDefaultLayer(mergedUrl, `${activeLayer.name} + ${bottomLayer.name}`, docSize.width, docSize.height),
    }
    const next = [...layers.slice(0, idx - 1), mergedLayer, ...layers.slice(idx + 1)]
    await recordLayerHistory(next, mergedLayer.id, `Merged ${activeLayer.name} Down`)
    setStatusBanner(`Merged "${activeLayer.name}" into "${bottomLayer.name}"`)
  }

  const handleFlattenAllLayers = async () => {
    if (layers.length <= 1) return
    const flatUrl = await renderLayersToDataUrl(layers, docSize.width, docSize.height)
    const flatLayer = createDefaultLayer(
      flatUrl,
      'Flattened Composite',
      docSize.width,
      docSize.height,
    )
    await recordLayerHistory([flatLayer], flatLayer.id, 'Flattened All Layers')
    setStatusBanner('Flattened all visible layers into a single layer.')
  }

  const handleKeyActiveLayerBackground = async () => {
    if (!activeLayer) return
    setStatusBanner(`Removing solid background color from "${activeLayer.name}"...`)
    const keyed = await keyOutSolidBackgroundToAlpha(activeLayer.dataUrl, bgKeyTolerance)
    const next = layers.map((l) =>
      l.id === activeLayer.id ? { ...l, dataUrl: keyed.dataUrl } : l,
    )
    await recordLayerHistory(next, activeLayer.id, `Keyed Alpha: ${activeLayer.name}`)
    setStatusBanner(`Converted solid background on "${activeLayer.name}" to transparent alpha!`)
  }

  const handleExtractMaskToNewLayer = async () => {
    if (!activeLayer || !hasMask || !maskCanvasRef.current) {
      setStatusBanner('Paint a mask or drag a Box Selection first to extract onto a new layer.')
      return
    }
    const extractedUrl = await extractMaskedSubjectDataUrl(
      activeLayer.dataUrl,
      maskCanvasRef.current,
      featherPx,
      true,
    )
    const newLayer = createDefaultLayer(
      extractedUrl,
      `${activeLayer.name} (Cutout)`,
      docSize.width,
      docSize.height,
    )
    const next = [...layers, newLayer]
    await recordLayerHistory(next, newLayer.id, `Extracted Selection Layer`)
    clearMask()
    setStatusBanner(`Extracted selection onto new transparent layer "${newLayer.name}"!`)
  }

  const clearMask = () => {
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')!
    ctx.clearRect(0, 0, mc.width, mc.height)
    setHasMask(false)
    setBoxDragStart(null)
    setBoxDragCurrent(null)
  }

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mc = maskCanvasRef.current
    if (!mc) return { x: 0, y: 0, scaleX: 1, scaleY: 1 }
    const rect = mc.getBoundingClientRect()
    const scaleX = mc.width / (rect.width || 1)
    const scaleY = mc.height / (rect.height || 1)
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY
    return { x, y, scaleX, scaleY }
  }

  const handleCanvasMouseDown = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (layers.length === 0) return
    const { x, y, scaleX } = getCanvasCoords(e)

    if (toolMode === 'move_layer') {
      if (!activeLayer || activeLayer.locked) return
      moveStartRef.current = {
        mouseX: x,
        mouseY: y,
        origX: activeLayer.offsetX || 0,
        origY: activeLayer.offsetY || 0,
      }
      setIsPainting(true)
      return
    }

    if (toolMode === 'box_select') {
      setBoxDragStart({ x, y })
      setBoxDragCurrent({ x, y })
      setIsPainting(true)
      return
    }

    if (toolMode === 'layer_brush' || toolMode === 'layer_eraser') {
      if (!activeLayer || activeLayer.locked) {
        setStatusBanner('Active layer is locked. Unlock it in the Layers panel to paint.')
        return
      }
      const img = await loadImageElement(activeLayer.dataUrl)
      const c = document.createElement('canvas')
      c.width = docSize.width
      c.height = docSize.height
      const ctx = c.getContext('2d')!
      const drawW = activeLayer.width * (activeLayer.scale || 1)
      const drawH = activeLayer.height * (activeLayer.scale || 1)
      const dx = (docSize.width - drawW) / 2 + (activeLayer.offsetX || 0)
      const dy = (docSize.height - drawH) / 2 + (activeLayer.offsetY || 0)
      ctx.drawImage(img, dx, dy, drawW, drawH)
      layerPaintCanvasRef.current = c
      setIsPainting(true)
      paintOnActiveLayerAt(x, y, scaleX)
      return
    }

    // Default: mask_brush or mask_eraser
    setIsPainting(true)
    paintMaskAt(x, y, scaleX)
  }

  const paintMaskAt = (x: number, y: number, scaleX: number) => {
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')!
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, brushSize * scaleX * 0.5, 0, Math.PI * 2)
    if (toolMode === 'mask_eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(244, 63, 94, 0.62)'
    }
    ctx.fill()
    ctx.restore()
    if (toolMode === 'mask_brush') setHasMask(true)
  }

  const paintOnActiveLayerAt = (x: number, y: number, scaleX: number) => {
    const lc = layerPaintCanvasRef.current
    if (!lc || !activeLayer) return
    const ctx = lc.getContext('2d')!
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, brushSize * scaleX * 0.5, 0, Math.PI * 2)
    if (toolMode === 'layer_eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,1)'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = Math.max(0.05, Math.min(1, brushOpacity / 100))
      ctx.fillStyle = brushColor
    }
    ctx.fill()
    ctx.restore()
    const updatedUrl = lc.toDataURL('image/png')
    updateActiveLayer({
      dataUrl: updatedUrl,
      width: docSize.width,
      height: docSize.height,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    })
  }

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPainting) return
    const { x, y, scaleX } = getCanvasCoords(e)

    if (toolMode === 'move_layer' && moveStartRef.current && activeLayer) {
      const dx = Math.round(x - moveStartRef.current.mouseX)
      const dy = Math.round(y - moveStartRef.current.mouseY)
      updateActiveLayer({
        offsetX: moveStartRef.current.origX + dx,
        offsetY: moveStartRef.current.origY + dy,
      })
      return
    }

    if (toolMode === 'box_select' && boxDragStart) {
      setBoxDragCurrent({ x, y })
      const mc = maskCanvasRef.current
      if (mc) {
        const ctx = mc.getContext('2d')!
        ctx.clearRect(0, 0, mc.width, mc.height)
        const rx = Math.min(boxDragStart.x, x)
        const ry = Math.min(boxDragStart.y, y)
        const rw = Math.abs(x - boxDragStart.x)
        const rh = Math.abs(y - boxDragStart.y)
        ctx.fillStyle = 'rgba(244, 63, 94, 0.52)'
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = '#ec4899'
        ctx.lineWidth = 2 * scaleX
        ctx.strokeRect(rx, ry, rw, rh)
      }
      return
    }

    if (toolMode === 'layer_brush' || toolMode === 'layer_eraser') {
      paintOnActiveLayerAt(x, y, scaleX)
      return
    }

    paintMaskAt(x, y, scaleX)
  }

  const handleCanvasMouseUp = async () => {
    if (!isPainting) return
    setIsPainting(false)

    if (toolMode === 'box_select' && boxDragStart && boxDragCurrent) {
      const rw = Math.abs(boxDragCurrent.x - boxDragStart.x)
      const rh = Math.abs(boxDragCurrent.y - boxDragStart.y)
      if (rw > 8 && rh > 8) {
        setHasMask(true)
        setStatusBanner(
          `Box Selected (${Math.round(rw)}×${Math.round(rh)}px). Click "✂️ Isolate Object in Box" or ask AI Copilot!`,
        )
      }
      setBoxDragStart(null)
      setBoxDragCurrent(null)
      return
    }

    if (
      (toolMode === 'layer_brush' || toolMode === 'layer_eraser' || toolMode === 'move_layer') &&
      activeLayer
    ) {
      layerPaintCanvasRef.current = null
      moveStartRef.current = null
      await recordLayerHistory(
        layers,
        activeLayer.id,
        toolMode === 'move_layer' ? `Moved ${activeLayer.name}` : `Painted ${activeLayer.name}`,
      )
    }
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

  const getEffectiveInputDataUrl = (): string | null => {
    if (aiInputSource === 'active_layer' && activeLayer) {
      return activeLayer.dataUrl
    }
    const canvas = baseCanvasRef.current
    if (canvas && layers.length > 0) {
      return canvas.toDataURL('image/png')
    }
    return currentRevision?.dataUrl || null
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, forceNewLayer = false) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        pushRevision(reader.result, file.name, {
          mode: forceNewLayer && layers.length > 0 ? 'new_layer' : 'new_doc',
        })
        onAddScratchItem({
          kind: 'image',
          label: file.name,
          url: reader.result,
          metaText: 'Local File',
        })
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleImportFromUrl = useCallback(
    async (overrideUrl?: string, asNewLayer = dropAsNewLayer) => {
      const targetUrl = (overrideUrl ?? urlImportInput).trim()
      if (!targetUrl) return
      setImportingUrl(true)
      setStatusBanner('Importing media from URL / Google Photos link...')
      try {
        const res = await fetch('/api/assets/from-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.detail || 'URL import failed')
        const viewUrl =
          data.url ||
          `/api/view?filename=${encodeURIComponent(data.filename)}&subfolder=${encodeURIComponent(data.subfolder || '')}&type=${encodeURIComponent(data.type || 'input')}`
        await pushRevision(viewUrl, `URL: ${data.filename}`, {
          mode: asNewLayer && layers.length > 0 ? 'new_layer' : 'new_doc',
        })
        onAddScratchItem({
          kind: data.media_kind === 'video' ? 'video' : 'image',
          label: data.filename,
          url: viewUrl,
          filename: data.filename,
          subfolder: data.subfolder || '',
          type: data.type || 'input',
          metaText: 'Imported URL',
        })
        if (!overrideUrl) setUrlImportInput('')
        setStatusBanner(`Imported "${data.filename}" onto Layer Stack & Scratch Space!`)
      } catch (err) {
        setStatusBanner(`URL Import failed: ${String(err)}`)
      } finally {
        setImportingUrl(false)
      }
    },
    [urlImportInput, dropAsNewLayer, layers.length, pushRevision, onAddScratchItem],
  )

  const handleCanvasDrop = async (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      const file = files[0]
      if (file.type.startsWith('video/')) {
        const form = new FormData()
        form.append('file', file)
        setStatusBanner(`Uploading dropped video ${file.name}...`)
        const res = await fetch('/api/assets', { method: 'POST', body: form })
        const data = await res.json()
        if (res.ok && data.url) {
          onAddScratchItem({
            kind: 'video',
            label: file.name,
            url: data.url,
            filename: data.filename,
            type: 'input',
            metaText: 'Dropped Video',
          })
          onSendToVideoStudio(data.url, file.name)
        }
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          pushRevision(reader.result, file.name, {
            mode: dropAsNewLayer && layers.length > 0 ? 'new_layer' : 'new_doc',
          })
          onAddScratchItem({
            kind: 'image',
            label: file.name,
            url: reader.result,
            metaText: 'Dropped File',
          })
          setStatusBanner(
            dropAsNewLayer && layers.length > 0
              ? `Added dropped file "${file.name}" as a new Layer!`
              : `Loaded dropped file "${file.name}"`,
          )
        }
      }
      reader.readAsDataURL(file)
      return
    }

    const uriList = e.dataTransfer?.getData('text/uri-list') || ''
    const plainText = e.dataTransfer?.getData('text/plain') || ''
    const htmlText = e.dataTransfer?.getData('text/html') || ''

    let extractedUrl = ''
    if (htmlText) {
      const imgMatch = htmlText.match(/<img[^>]+src=["']([^"']+)["']/i)
      if (imgMatch && imgMatch[1].startsWith('http')) {
        extractedUrl = imgMatch[1].replace(/&amp;/g, '&')
      }
    }
    if (!extractedUrl) {
      const candidate = (uriList.split('\n')[0] || plainText).trim()
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        extractedUrl = candidate
      }
    }
    if (extractedUrl) {
      await handleImportFromUrl(extractedUrl, dropAsNewLayer)
    }
  }

  // Support Ctrl+V clipboard paste (adds as a new Layer when layers exist!)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const activeEl = document.activeElement
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return
      }
      const items = e.clipboardData?.items
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            const blob = items[i].getAsFile()
            if (blob) {
              const reader = new FileReader()
              reader.onload = () => {
                if (typeof reader.result === 'string') {
                  pushRevision(reader.result, 'Pasted Layer', {
                    mode: layers.length > 0 ? 'new_layer' : 'new_doc',
                  })
                  setStatusBanner('Pasted clipboard image as a new Layer (Ctrl+V)!')
                }
              }
              reader.readAsDataURL(blob)
              return
            }
          }
        }
      }
      const pastedText = (e.clipboardData?.getData('text/plain') || '').trim()
      if (pastedText.startsWith('http://') || pastedText.startsWith('https://')) {
        handleImportFromUrl(pastedText, layers.length > 0)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [pushRevision, handleImportFromUrl, layers.length])

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
    if (!canvas || layers.length === 0) return
    const dataUrl = canvas.toDataURL('image/png')
    onAddScratchItem({
      kind: 'image',
      label: `Composite (${layers.length}L)`,
      url: dataUrl,
      metaText: `${docSize.width}×${docSize.height}`,
    })
    setStatusBanner(`Pinned composite (${layers.length} layers) to Scratch Space!`)
  }

  const handlePinLayerToScratch = (layer: PhotoLayer) => {
    onAddScratchItem({
      kind: 'image',
      label: layer.name,
      url: layer.dataUrl,
      metaText: `Layer ${layer.width}×${layer.height}`,
    })
    setStatusBanner(`Pinned layer "${layer.name}" to Scratch Space!`)
  }

  const handleBakeAdjustments = async () => {
    if (!activeLayer) return
    const bakedUrl = await renderLayersToDataUrl(
      [{ ...activeLayer, opacity: 100, blendMode: 'source-over', offsetX: 0, offsetY: 0, scale: 1 }],
      activeLayer.width,
      activeLayer.height,
    )
    const next = layers.map((l) =>
      l.id === activeLayer.id
        ? {
            ...l,
            dataUrl: bakedUrl,
            brightness: 100,
            contrast: 100,
            saturation: 100,
            warmth: 0,
            blurPx: 0,
          }
        : l,
    )
    await recordLayerHistory(next, activeLayer.id, `Baked Adjustments (${activeLayer.name})`)
    setStatusBanner(`Baked color adjustments into layer "${activeLayer.name}".`)
  }

  const handleTransform = async (op: 'rot_cw' | 'rot_ccw' | 'flip_h' | 'flip_v') => {
    if (!activeLayer) return
    const img = await loadImageElement(activeLayer.dataUrl)
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
    const next = layers.map((l) =>
      l.id === activeLayer.id
        ? { ...l, dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height }
        : l,
    )
    const newDocW = layers.length === 1 ? c.width : docSize.width
    const newDocH = layers.length === 1 ? c.height : docSize.height
    await recordLayerHistory(next, activeLayer.id, `Transform (${op})`, newDocW, newDocH)
  }

  const handleAspectCrop = async (ratioW: number, ratioH: number) => {
    if (layers.length === 0) return
    const w = docSize.width
    const h = docSize.height
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

    const croppedLayers = await Promise.all(
      layers.map(async (layer) => {
        const singleComposite = await renderLayersToDataUrl(
          [{ ...layer, visible: true, opacity: 100, blendMode: 'source-over' }],
          w,
          h,
        )
        const img = await loadImageElement(singleComposite)
        const c = document.createElement('canvas')
        c.width = cropW
        c.height = cropH
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
        return {
          ...layer,
          dataUrl: c.toDataURL('image/png'),
          width: cropW,
          height: cropH,
          offsetX: 0,
          offsetY: 0,
          scale: 1,
        }
      }),
    )
    await recordLayerHistory(
      croppedLayers,
      activeLayer?.id || croppedLayers[0].id,
      `Crop ${ratioW}:${ratioH}`,
      cropW,
      cropH,
    )
  }

  const handleExportPNG = () => {
    const canvas = baseCanvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `studio_composite_${Date.now()}.png`
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
        canvas_image_b64: getEffectiveInputDataUrl(),
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
          canvas_image_b64: getEffectiveInputDataUrl(),
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

  const handleRunCharacterIsolation = async (forceMaskMode = false) => {
    const sourceUrl = getEffectiveInputDataUrl()
    if (!sourceUrl) {
      setStatusBanner('Load an image onto the layer stack first.')
      return
    }
    const targetMode = forceMaskMode ? 'masked' : isolationTarget
    setStatusBanner(
      'Isolating character/object via Qwen Image 2.1 & placing onto a transparent Layer...',
    )
    let inputDataUrl = sourceUrl
    if (targetMode === 'masked' && hasMask && maskCanvasRef.current) {
      inputDataUrl = await extractMaskedSubjectDataUrl(
        sourceUrl,
        maskCanvasRef.current,
        featherPx,
        false,
      )
    }
    try {
      const res = await fetch('/api/assistant/3d-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_image_b64: inputDataUrl,
          stage: 'isolate_only',
          isolation_target: targetMode,
          isolation_prompt: customIsolationPrompt,
          figurine_prepass: figurinePrepass,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActivePostProcess('replace_canvas')
        setActiveRunId(data.run.id)
        if (targetMode === 'masked') clearMask()
      }
    } catch (err) {
      setStatusBanner(`Character isolation failed: ${String(err)}`)
    }
  }

  const handleRun3DPipeline = async () => {
    const sourceUrl = getEffectiveInputDataUrl()
    if (!sourceUrl) {
      setStatusBanner('Load or isolate a character/object on a layer first.')
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
          canvas_image_b64: sourceUrl,
          texture_image_b64: secondImageB64 || sourceUrl,
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
    { id: 'layers', icon: '📑', label: 'Layers', badge: layers.length || undefined },
    { id: 'paint', icon: '🖌️', label: 'Tools' },
    { id: 'adjust', icon: '🎛️', label: 'Adjust' },
    { id: '3d', icon: '🧊', label: '3D Studio' },
    { id: 'media', icon: '📂', label: 'Source' },
    { id: 'scratch', icon: '🗂️', label: 'Scratch', badge: scratchItems.length || undefined },
  ]

  // Display layers in top-to-bottom visual order (top layer first in list, like Patchy & Photoshop)
  const layersTopDown = [...layers].reverse()

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
        onChange={(e) => handleFileUpload(e, false)}
      />
      <input
        ref={addLayerFileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => handleFileUpload(e, true)}
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
                  padding: '0.46rem 0.2rem',
                  borderRadius: 8,
                  border: isActive ? '1px solid #6366f1' : '1px solid transparent',
                  background: isActive ? 'rgba(99, 102, 241, 0.22)' : 'transparent',
                  color: isActive ? '#e0e7ff' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.63rem',
                  fontWeight: 600,
                }}
              >
                <span style={{ fontSize: '1.12rem', lineHeight: 1 }}>{tb.icon}</span>
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
            width: 300,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '0.85rem',
            gap: '0.75rem',
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
              {activeToolset === 'layers' && `📑 Patchy Multi-Layer Stack (${layers.length})`}
              {activeToolset === 'paint' && '🖌️ Paint, Box Select & Move'}
              {activeToolset === 'adjust' && '🎛️ Non-Destructive Layer Adjust'}
              {activeToolset === '3d' && '🧊 Character & 3D Studio'}
              {activeToolset === 'media' && '📂 Photo Source & URL Import'}
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

          {/* TOOLSET 0: PATCHY MULTI-LAYER STACK */}
          {activeToolset === 'layers' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.74rem' }}>
              {/* Quick Layer Creation Bar */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: '0.72rem', padding: '0.34rem 0.5rem' }}
                  onClick={() => addLayerFileInputRef.current?.click()}
                >
                  📂 + Image Layer
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: '0.72rem', padding: '0.34rem 0.5rem' }}
                  onClick={handleAddEmptyLayer}
                >
                  ➕ Empty Layer
                </button>
              </div>

              {/* Active Layer Blend Mode & Opacity Controls */}
              {activeLayer && (
                <div
                  style={{
                    padding: '0.55rem',
                    borderRadius: 8,
                    background: 'rgba(15, 23, 42, 0.75)',
                    border: '1px solid rgba(99, 102, 241, 0.35)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#a5b4fc', fontWeight: 700, fontSize: '0.7rem' }}>
                      BLEND:
                    </span>
                    <select
                      value={activeLayer.blendMode}
                      onChange={(e) =>
                        updateActiveLayer({
                          blendMode: e.target.value as GlobalCompositeOperation,
                        })
                      }
                      style={{
                        flex: 1,
                        background: '#0f172a',
                        color: 'var(--text-main)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '0.22rem 0.4rem',
                        fontSize: '0.72rem',
                      }}
                    >
                      {BLEND_MODES.map((bm) => (
                        <option key={bm.value} value={bm.value}>
                          {bm.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', minWidth: 52 }}>
                      Opacity:
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={activeLayer.opacity}
                      onChange={(e) => updateActiveLayer({ opacity: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: 32, textAlign: 'right', fontSize: '0.7rem' }}>
                      {activeLayer.opacity}%
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', minWidth: 52 }}>
                      Scale:
                    </span>
                    <input
                      type="range"
                      min={20}
                      max={250}
                      value={Math.round((activeLayer.scale || 1) * 100)}
                      onChange={(e) =>
                        updateActiveLayer({ scale: Number(e.target.value) / 100 })
                      }
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.64rem', padding: '0.08rem 0.35rem' }}
                      onClick={() => updateActiveLayer({ offsetX: 0, offsetY: 0, scale: 1 })}
                      title="Reset layer position & scale"
                    >
                      {Math.round((activeLayer.scale || 1) * 100)}% ↺
                    </button>
                  </div>
                </div>
              )}

              {/* AI Layer Routing Toggle (Per-Layer AI Generation) */}
              <div
                style={{
                  padding: '0.5rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.55)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  fontSize: '0.7rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)' }}>AI Output Target:</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button
                      type="button"
                      className={`chip ${aiOutputMode === 'new_layer' ? 'active' : ''}`}
                      style={{ fontSize: '0.65rem', padding: '0.1rem 0.38rem' }}
                      onClick={() => setAiOutputMode('new_layer')}
                    >
                      ➕ New Layer
                    </button>
                    <button
                      type="button"
                      className={`chip ${aiOutputMode === 'replace_active' ? 'active' : ''}`}
                      style={{ fontSize: '0.65rem', padding: '0.1rem 0.38rem' }}
                      onClick={() => setAiOutputMode('replace_active')}
                    >
                      🔄 Active Layer
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)' }}>AI Reads From:</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button
                      type="button"
                      className={`chip ${aiInputSource === 'composite' ? 'active' : ''}`}
                      style={{ fontSize: '0.65rem', padding: '0.1rem 0.38rem' }}
                      onClick={() => setAiInputSource('composite')}
                    >
                      🥞 Composite
                    </button>
                    <button
                      type="button"
                      className={`chip ${aiInputSource === 'active_layer' ? 'active' : ''}`}
                      style={{ fontSize: '0.65rem', padding: '0.1rem 0.38rem' }}
                      onClick={() => setAiInputSource('active_layer')}
                    >
                      📑 Active Only
                    </button>
                  </div>
                </div>
              </div>

              {/* Layer Stack List (Top-to-Bottom) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 280, overflowY: 'auto' }}>
                {layersTopDown.length === 0 ? (
                  <div
                    style={{
                      padding: '1rem',
                      textAlign: 'center',
                      border: '1px dashed var(--border)',
                      borderRadius: 8,
                      color: 'var(--text-muted)',
                      fontSize: '0.72rem',
                    }}
                  >
                    No layers yet. Drop an image onto the canvas or click <strong>+ Image Layer</strong>.
                  </div>
                ) : (
                  layersTopDown.map((layer) => {
                    const isSelected = activeLayer?.id === layer.id
                    return (
                      <div
                        key={layer.id}
                        onClick={() => setActiveLayerId(layer.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '0.38rem 0.45rem',
                          borderRadius: 8,
                          cursor: 'pointer',
                          border: isSelected
                            ? '1.5px solid #6366f1'
                            : '1px solid var(--border)',
                          background: isSelected
                            ? 'rgba(99, 102, 241, 0.18)'
                            : 'rgba(15, 23, 42, 0.65)',
                        }}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateLayerById(layer.id, { visible: !layer.visible })
                          }}
                          title={layer.visible ? 'Hide Layer' : 'Show Layer'}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            opacity: layer.visible ? 1 : 0.35,
                            padding: 0,
                          }}
                        >
                          👁️
                        </button>
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 4,
                            overflow: 'hidden',
                            border: '1px solid #334155',
                            flexShrink: 0,
                            background:
                              'repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 50% / 10px 10px',
                          }}
                        >
                          <img
                            src={layer.dataUrl}
                            alt={layer.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <input
                            type="text"
                            value={layer.name}
                            onChange={(e) => updateLayerById(layer.id, { name: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: '100%',
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-main)',
                              fontWeight: 600,
                              fontSize: '0.73rem',
                              outline: 'none',
                            }}
                          />
                          <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)' }}>
                            {BLEND_MODES.find((b) => b.value === layer.blendMode)?.label || 'Normal'} •{' '}
                            {layer.opacity}%
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateLayerById(layer.id, { locked: !layer.locked })
                          }}
                          title={layer.locked ? 'Unlock Layer' : 'Lock Layer'}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.76rem',
                            opacity: layer.locked ? 1 : 0.3,
                            padding: 0,
                          }}
                        >
                          🔒
                        </button>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleMoveLayerOrder(layer.id, 'up')
                            }}
                            title="Move Layer Up"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              fontSize: '0.58rem',
                              lineHeight: 1,
                              padding: '1px 3px',
                            }}
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleMoveLayerOrder(layer.id, 'down')
                            }}
                            title="Move Layer Down"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              fontSize: '0.58rem',
                              lineHeight: 1,
                              padding: '1px 3px',
                            }}
                          >
                            ▼
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Layer Operations Footer */}
              {activeLayer && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.67rem', textAlign: 'center', padding: '0.25rem 0.2rem' }}
                      onClick={handleDuplicateActiveLayer}
                      title="Duplicate Active Layer"
                    >
                      📑 Dup
                    </button>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.67rem', textAlign: 'center', padding: '0.25rem 0.2rem' }}
                      onClick={handleMergeLayerDown}
                      disabled={layers.length < 2}
                      title="Merge Active Layer Down"
                    >
                      ⏬ Merge
                    </button>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.67rem', textAlign: 'center', padding: '0.25rem 0.2rem' }}
                      onClick={handleFlattenAllLayers}
                      disabled={layers.length < 2}
                      title="Flatten All Layers"
                    >
                      🥞 Flatten
                    </button>
                    <button
                      type="button"
                      className="chip"
                      style={{
                        fontSize: '0.67rem',
                        textAlign: 'center',
                        padding: '0.25rem 0.2rem',
                        color: '#fca5a5',
                      }}
                      onClick={() => handleDeleteLayer(activeLayer.id)}
                      disabled={layers.length <= 1}
                      title="Delete Active Layer"
                    >
                      🗑️ Del
                    </button>
                  </div>

                  {/* Smart Cutout & Alpha Key Actions */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.68rem', textAlign: 'center' }}
                      onClick={handleKeyActiveLayerBackground}
                      title="Remove solid white/studio background color from active layer into true alpha transparency"
                    >
                      ✨ Key Solid BG → Alpha
                    </button>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.68rem', textAlign: 'center' }}
                      onClick={() => handlePinLayerToScratch(activeLayer)}
                      title="Pin only the active layer to Scratch Space"
                    >
                      📌 Layer to Scratch
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: '0.72rem', borderColor: '#6366f1' }}
                    onClick={() => {
                      setAiOutputMode('new_layer')
                      handleRunCharacterIsolation(false)
                    }}
                    disabled={Boolean(activeRunId)}
                  >
                    ✂️ AI Isolate Subject → New Transparent Layer
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TOOLSET 1: PHOTO SOURCE, GOOGLE PHOTOS URL & RECENT GENERATIONS */}
          {activeToolset === 'media' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  📂 Open as New Doc
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={() => addLayerFileInputRef.current?.click()}
                >
                  ➕ Add as Layer
                </button>
              </div>
              <button
                type="button"
                className="btn"
                style={{ fontSize: '0.76rem' }}
                onClick={handleExportPNG}
                disabled={layers.length === 0}
              >
                ⬇ Export Composite PNG
              </button>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.72rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={dropAsNewLayer}
                  onChange={(e) => setDropAsNewLayer(e.target.checked)}
                />
                <span>Drag &amp; drop / URL imports add as a new Layer on top</span>
              </label>

              {/* Google Photos / Image URL Import */}
              <div
                style={{
                  padding: '0.55rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: '0.72rem', fontWeight: 600 }}>
                  🔗 Google Photos / Web URL Import
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="text"
                    value={urlImportInput}
                    onChange={(e) => setUrlImportInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleImportFromUrl()
                    }}
                    placeholder="Paste Google Photos share link or image URL..."
                    style={{
                      flex: 1,
                      fontSize: '0.72rem',
                      padding: '0.32rem 0.45rem',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: '#0f172a',
                      color: 'var(--text-main)',
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: '0.72rem', padding: '0.3rem 0.55rem', whiteSpace: 'nowrap' }}
                    disabled={importingUrl || !urlImportInput.trim()}
                    onClick={() => handleImportFromUrl()}
                  >
                    {importingUrl ? '...' : 'Import'}
                  </button>
                </div>
                <div style={{ fontSize: '0.67rem', color: 'var(--text-muted)' }}>
                  Tip: Drag files from File Manager, drag images/links from Google Photos, or press Ctrl+V!
                </div>
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
                  Recent ComfyUI Generations (Click to Add Layer)
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
                      onClick={() =>
                        pushRevision(item.url, item.title, {
                          mode: layers.length > 0 ? 'new_layer' : 'new_doc',
                        })
                      }
                      style={{
                        cursor: 'pointer',
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid var(--border)',
                        position: 'relative',
                      }}
                      title={`Click to add layer: ${item.title}`}
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

          {/* TOOLSET 2: PATCHY PAINT, BOX SELECT, MASK & MOVE LAYER */}
          {activeToolset === 'paint' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
                fontSize: '0.75rem',
              }}
            >
              <div style={{ fontWeight: 600, color: '#a5b4fc', fontSize: '0.72rem' }}>
                AI Selection &amp; Object Box Tools:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.32rem' }}>
                <button
                  type="button"
                  className={`chip ${toolMode === 'mask_brush' ? 'active' : ''}`}
                  onClick={() => setToolMode('mask_brush')}
                  title="Paint ruby-red selection mask for AI inpainting"
                >
                  🖌️ AI Mask
                </button>
                <button
                  type="button"
                  className={`chip ${toolMode === 'box_select' ? 'active' : ''}`}
                  onClick={() => setToolMode('box_select')}
                  title="Patchy Object Box Select: drag a box around an object to isolate or edit it"
                >
                  📦 Box Select
                </button>
                <button
                  type="button"
                  className={`chip ${toolMode === 'mask_eraser' ? 'active' : ''}`}
                  onClick={() => setToolMode('mask_eraser')}
                >
                  🧽 Mask Erase
                </button>
              </div>

              <div style={{ fontWeight: 600, color: '#a5b4fc', fontSize: '0.72rem', marginTop: 2 }}>
                Direct Layer Paint &amp; Transform Tools:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.32rem' }}>
                <button
                  type="button"
                  className={`chip ${toolMode === 'layer_brush' ? 'active' : ''}`}
                  onClick={() => setToolMode('layer_brush')}
                  title="Paint color directly onto the active layer"
                >
                  🎨 Paint Layer
                </button>
                <button
                  type="button"
                  className={`chip ${toolMode === 'layer_eraser' ? 'active' : ''}`}
                  onClick={() => setToolMode('layer_eraser')}
                  title="Erase pixels to transparency on the active layer"
                >
                  🧹 Erase Layer
                </button>
                <button
                  type="button"
                  className={`chip ${toolMode === 'move_layer' ? 'active' : ''}`}
                  onClick={() => setToolMode('move_layer')}
                  title="Drag on the canvas to reposition the active layer"
                >
                  ✋ Move Layer
                </button>
              </div>

              {toolMode === 'layer_brush' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '0.45rem',
                    borderRadius: 8,
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Color:</span>
                    <input
                      type="color"
                      value={brushColor}
                      onChange={(e) => setBrushColor(e.target.value)}
                      style={{ width: 28, height: 24, border: 'none', background: 'none' }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                    <span>Flow:</span>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={brushOpacity}
                      onChange={(e) => setBrushOpacity(Number(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span>{brushOpacity}%</span>
                  </label>
                </div>
              )}

              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Brush Diameter</span>
                <span>{brushSize}px</span>
              </label>
              <input
                type="range"
                min={4}
                max={180}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
              />

              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Selection Feathering (Soft Edge)</span>
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

              {hasMask && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: '0.73rem' }}
                    onClick={() => {
                      setAiOutputMode('new_layer')
                      handleRunCharacterIsolation(true)
                    }}
                    disabled={Boolean(activeRunId)}
                  >
                    ✂️ Isolate Object in Box/Mask → New Layer (AI)
                  </button>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: '0.73rem' }}
                    onClick={handleExtractMaskToNewLayer}
                  >
                    📑 Copy Masked Pixels Directly → New Layer
                  </button>
                </div>
              )}

              <div
                style={{
                  padding: '0.55rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid var(--border)',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  lineHeight: 1.45,
                }}
              >
                <strong>Patchy Object Box &amp; Layer Workflow:</strong> Use{' '}
                <strong>📦 Box Select</strong> to drag a loose box around any object and click{' '}
                <em>Isolate Object in Box → New Layer</em>, or use <strong>✋ Move Layer</strong> to
                reposition layers over your background!
              </div>
            </div>
          )}

          {/* TOOLSET 3: NON-DESTRUCTIVE PER-LAYER ADJUSTMENTS & CROP */}
          {activeToolset === 'adjust' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
              <div style={{ fontSize: '0.71rem', color: '#a5b4fc', fontWeight: 600 }}>
                Adjusting Active Layer: {activeLayer ? activeLayer.name : 'None'}
              </div>
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Brightness</span>
                <span>{activeLayer?.brightness ?? 100}%</span>
              </label>
              <input
                type="range"
                min={40}
                max={160}
                value={activeLayer?.brightness ?? 100}
                onChange={(e) => updateActiveLayer({ brightness: Number(e.target.value) })}
                disabled={!activeLayer}
              />
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Contrast</span>
                <span>{activeLayer?.contrast ?? 100}%</span>
              </label>
              <input
                type="range"
                min={40}
                max={160}
                value={activeLayer?.contrast ?? 100}
                onChange={(e) => updateActiveLayer({ contrast: Number(e.target.value) })}
                disabled={!activeLayer}
              />
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Saturation</span>
                <span>{activeLayer?.saturation ?? 100}%</span>
              </label>
              <input
                type="range"
                min={0}
                max={200}
                value={activeLayer?.saturation ?? 100}
                onChange={(e) => updateActiveLayer({ saturation: Number(e.target.value) })}
                disabled={!activeLayer}
              />
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Warmth / Sepia</span>
                <span>{activeLayer?.warmth ?? 0}%</span>
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={activeLayer?.warmth ?? 0}
                onChange={(e) => updateActiveLayer({ warmth: Number(e.target.value) })}
                disabled={!activeLayer}
              />
              <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Gaussian Blur</span>
                <span>{activeLayer?.blurPx ?? 0}px</span>
              </label>
              <input
                type="range"
                min={0}
                max={12}
                value={activeLayer?.blurPx ?? 0}
                onChange={(e) => updateActiveLayer({ blurPx: Number(e.target.value) })}
                disabled={!activeLayer}
              />

              <div style={{ display: 'flex', gap: '0.35rem', marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, fontSize: '0.74rem' }}
                  onClick={handleBakeAdjustments}
                  disabled={!activeLayer}
                >
                  ✨ Bake to Layer
                </button>
                <button
                  type="button"
                  className="chip"
                  disabled={!activeLayer}
                  onClick={() =>
                    updateActiveLayer({
                      brightness: 100,
                      contrast: 100,
                      saturation: 100,
                      warmth: 0,
                      blurPx: 0,
                    })
                  }
                >
                  Reset
                </button>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.35rem 0' }} />
              <div style={{ fontWeight: 600 }}>Rotate &amp; Flip Active Layer</div>
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

              <div style={{ fontWeight: 600, marginTop: 4 }}>Document Aspect Crop</div>
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
                Step 1: Isolate Character / Group to Layer
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
                  📦 Box / Mask
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
                  checked={autoKeyCutoutBg}
                  onChange={(e) => setAutoKeyCutoutBg(e.target.checked)}
                />
                <span>Auto-key solid background to transparent alpha</span>
              </label>

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
                onClick={() => handleRunCharacterIsolation(false)}
                disabled={layers.length === 0 || Boolean(activeRunId)}
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
                disabled={layers.length === 0 || Boolean(activeRunId)}
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
                disabled={layers.length === 0}
              >
                📌 Pin Composite to Scratch Space
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
                              onClick={() =>
                                pushRevision(item.url, item.label, { mode: 'new_layer' })
                              }
                            >
                              ➕ Add as Layer
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                              onClick={() =>
                                pushRevision(item.url, item.label, { mode: 'new_doc' })
                              }
                            >
                              🖼️ Replace Doc
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => {
                                setSecondImageB64(item.url)
                                setSecondImageName(item.label)
                                setStatusBanner(`Set "${item.label}" as 2nd Ref / 3D Texture!`)
                              }}
                            >
                              🎨 Use as Tex/Ref
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
                                filename: item.filename || item.label,
                              })
                            }
                          >
                            🧊 Open 3D Viewer
                          </button>
                        )}
                        {item.kind === 'video' && (
                          <button
                            type="button"
                            className="chip"
                            style={{ fontSize: '0.66rem', padding: '0.12rem 0.4rem' }}
                            onClick={() => onSendToVideoStudio(item.url, item.label)}
                          >
                            🎬 Open in Video Studio
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

      {/* CENTER WORKSPACE: Multi-Layer Interactive Canvas + 3D Material Studio + Bottom Revision Strip */}
      <main
        onDragOver={(e) => {
          e.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleCanvasDrop}
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
        {isDraggingOver && (
          <div
            style={{
              position: 'absolute',
              inset: 12,
              zIndex: 50,
              borderRadius: 14,
              border: '2px dashed #6366f1',
              background: 'rgba(15, 23, 42, 0.84)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              color: '#e0e7ff',
              gap: 8,
            }}
          >
            <div style={{ fontSize: '2.4rem' }}>📥</div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>
              {layers.length > 0 && dropAsNewLayer
                ? 'Drop Photo or Google Photos Link to Add as New Layer'
                : 'Drop Photo File or Google Photos Link Here'}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#a5b4fc' }}>
              Supports File Manager files (PNG/JPG/WebP) and browser image/link drags
            </div>
          </div>
        )}

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>
              {layers.length > 0
                ? `${docSize.width}×${docSize.height} • ${layers.length} Layer${layers.length > 1 ? 's' : ''}`
                : 'Empty Canvas'}
            </span>
            {activeLayer && (
              <span
                style={{
                  background: 'rgba(99, 102, 241, 0.18)',
                  color: '#c7d2fe',
                  padding: '0.1rem 0.48rem',
                  borderRadius: 999,
                  fontSize: '0.68rem',
                  fontWeight: 600,
                }}
              >
                📑 Active: {activeLayer.name}
              </span>
            )}
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
                🖌️ Selection Active
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="chip"
              onClick={() => selectRevisionIndex(Math.max(0, activeRevIndex - 1))}
              disabled={activeRevIndex <= 0}
            >
              ↩ Undo
            </button>
            <button
              type="button"
              className="chip"
              onClick={() =>
                selectRevisionIndex(Math.min(revisions.length - 1, activeRevIndex + 1))
              }
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
            {layers.length > 0 && (
              <>
                <button
                  type="button"
                  className="chip"
                  onClick={handlePinCurrentToScratch}
                  title="Pin composited canvas to Scratch Space"
                >
                  📌 To Scratch
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: '0.18rem 0.55rem', fontSize: '0.72rem' }}
                  onClick={() => {
                    const c = baseCanvasRef.current
                    if (c) {
                      onSendToVideoStudio(
                        c.toDataURL('image/png'),
                        activeLayer?.name || 'Composite',
                      )
                    }
                  }}
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
                textureCandidateUrl={secondImageB64 || activeLayer?.dataUrl || null}
                onCaptureRenderToCanvas={(dataUrl, label) => {
                  pushRevision(dataUrl, label, { mode: 'new_layer' })
                  onAddScratchItem({
                    kind: 'image',
                    label,
                    url: dataUrl,
                    metaText: '3D Snapshot',
                  })
                  setStatusBanner('Captured 3D Render onto a new Layer & Scratch Space!')
                }}
              />
            </div>
          )}

          {layers.length > 0 ? (
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
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: showMaskOverlay ? 1 : 0,
                  cursor:
                    toolMode === 'move_layer'
                      ? 'move'
                      : toolMode === 'box_select'
                        ? 'crosshair'
                        : 'crosshair',
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
              <div style={{ fontSize: '2.2rem', marginBottom: '0.5rem' }}>📑</div>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 6 }}>
                Patchy Multi-Layer Photo &amp; 3D Studio
              </div>
              <div style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                Drag &amp; drop photos from your File Manager, drop or paste a Google Photos share
                link (`Ctrl+V`), pick from Scratch Space (`🗂️`), or ask the AI Copilot to generate
                layers!
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  justifyContent: 'center',
                  marginBottom: '0.75rem',
                }}
              >
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
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={urlImportInput}
                  onChange={(e) => setUrlImportInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleImportFromUrl()
                  }}
                  placeholder="Or paste Google Photos link / image URL..."
                  style={{
                    flex: 1,
                    fontSize: '0.75rem',
                    padding: '0.4rem 0.6rem',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: '#0f172a',
                    color: 'var(--text-main)',
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={importingUrl || !urlImportInput.trim()}
                  onClick={() => handleImportFromUrl()}
                >
                  {importingUrl ? 'Importing...' : '🔗 Import URL'}
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
              onClick={() => selectRevisionIndex(idx)}
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
              <div style={{ fontSize: '0.68rem', maxWidth: 115 }}>
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
                  {rev.layersSnapshot ? `${rev.layersSnapshot.length}L • ` : ''}
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
                  ? 'Describe what to put in selection/box...'
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
