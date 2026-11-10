import React, { useEffect, useRef, useState } from 'react'
import {
  RunOutput,
  RunRecord,
  ScratchItem,
  VideoFilmstripFrame,
  VideoMetadata,
} from './api'

interface ActiveVideoItem {
  filename: string
  subfolder: string
  type: string
  url: string
  title: string
}

type VideoToolset = 'clips' | 'cut' | 'ai' | 'stitch' | 'scratch'

interface VideoStudioProps {
  runs: RunRecord[]
  scratchItems: ScratchItem[]
  onAddScratchItem: (item: Omit<ScratchItem, 'id' | 'createdAt'>) => void
  onRemoveScratchItem: (id: string) => void
  defaultSegmentSeconds: number
  incomingImageForVideo?: { url: string; label: string } | null
  onSendFrameToPhotoStudio: (frameUrl: string, label: string) => void
  onRunsUpdated: () => void
}

export function VideoStudio({
  runs,
  scratchItems,
  onAddScratchItem,
  onRemoveScratchItem,
  defaultSegmentSeconds,
  incomingImageForVideo,
  onSendFrameToPhotoStudio,
  onRunsUpdated,
}: VideoStudioProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const timelineTrackRef = useRef<HTMLDivElement | null>(null)
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null)
  const startFrameInputRef = useRef<HTMLInputElement | null>(null)
  const endFrameInputRef = useRef<HTMLInputElement | null>(null)

  // Minimizable Dock & Toolset state
  const [activeToolset, setActiveToolset] = useState<VideoToolset>('cut')
  const [leftDrawerOpen, setLeftDrawerOpen] = useState<boolean>(true)

  const [activeVideo, setActiveVideo] = useState<ActiveVideoItem | null>(null)
  const [videoMeta, setVideoMeta] = useState<VideoMetadata | null>(null)
  const [filmstrip, setFilmstrip] = useState<VideoFilmstripFrame[]>([])

  // Playback & Frame Range state
  const [isPlaying, setIsPlaying] = useState(false)
  const [loopRange, setLoopRange] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1.0)
  const [currentTime, setCurrentTime] = useState(0)
  const [trimIn, setTrimIn] = useState(0)
  const [trimOut, setTrimOut] = useState(5)
  const [draggingHandle, setDraggingHandle] = useState<'playhead' | 'in' | 'out' | null>(null)

  // Stitch Queue
  const [stitchTray, setStitchTray] = useState<ActiveVideoItem[]>([])

  // AI Video Actions state
  const [continuationPrompt, setContinuationPrompt] = useState(
    'Continue the scene smoothly with natural camera motion and cinematic lighting',
  )
  const [continuationModel, setContinuationModel] = useState<
    'video_minimax_h3_i2v_continuation' | 'video_wan2_2_14B_i2v'
  >('video_minimax_h3_i2v_continuation')

  // First-to-Last Frame (FLF2V) state
  const [flfStartB64, setFlfStartB64] = useState<string | null>(null)
  const [flfStartLabel, setFlfStartLabel] = useState<string>('None')
  const [flfEndB64, setFlfEndB64] = useState<string | null>(null)
  const [flfEndLabel, setFlfEndLabel] = useState<string>('None')
  const [flfPrompt, setFlfPrompt] = useState(
    'Smooth cinematic transition morphing naturally from the first frame to the final frame',
  )

  const [chunkSeconds, setChunkSeconds] = useState<number>(defaultSegmentSeconds || 10)
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [urlImportInput, setUrlImportInput] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [isDraggingOver, setIsDraggingOver] = useState(false)

  const fps = videoMeta?.fps || 24
  const totalDuration = videoMeta?.duration || 5.0
  const totalFrames = videoMeta?.frame_count || Math.max(1, Math.round(totalDuration * fps))
  const currentFrame = Math.min(totalFrames, Math.max(0, Math.round(currentTime * fps)))
  const trimInFrame = Math.max(0, Math.round(trimIn * fps))
  const trimOutFrame = Math.min(totalFrames, Math.max(trimInFrame + 1, Math.round(trimOut * fps)))
  const selectedFrameCount = Math.max(1, trimOutFrame - trimInFrame)
  const selectedDuration = Math.max(0.04, +(trimOut - trimIn).toFixed(2))

  const recentVideos: ActiveVideoItem[] = runs
    .flatMap((r) =>
      (r.outputs || [])
        .filter((o) => o.media_kind === 'video')
        .map((o) => ({
          filename: o.filename,
          subfolder: o.subfolder || '',
          type: o.type || 'output',
          url: o.url,
          title: r.template_title,
        })),
    )
    .slice(0, 14)

  useEffect(() => {
    if (!activeVideo && recentVideos.length > 0) {
      setActiveVideo(recentVideos[0])
    }
  }, [recentVideos.length])

  useEffect(() => {
    if (incomingImageForVideo) {
      setFlfStartB64(incomingImageForVideo.url)
      setFlfStartLabel(incomingImageForVideo.label)
      setActiveToolset('ai')
      setLeftDrawerOpen(true)
      setBusyMessage(
        `Loaded "${incomingImageForVideo.label}" as Start Frame in AI Video Studio!`,
      )
    }
  }, [incomingImageForVideo])

  // Probe video metadata and 12-frame filmstrip via FFmpeg/FFprobe
  useEffect(() => {
    if (!activeVideo) {
      setVideoMeta(null)
      setFilmstrip([])
      return
    }
    const qs = new URLSearchParams({
      filename: activeVideo.filename,
      subfolder: activeVideo.subfolder,
      type: activeVideo.type,
      count: '12',
    })
    fetch(`/api/video/filmstrip?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        if (data.meta) {
          setVideoMeta(data.meta)
          setTrimIn(0)
          setTrimOut(data.meta.duration || 5)
          setCurrentTime(0)
        }
        if (Array.isArray(data.frames)) {
          setFilmstrip(data.frames)
        }
      })
      .catch(() => {})
  }, [activeVideo])

  // Poll activeRunId when a ComfyUI video workflow is running
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
          const vidOut: RunOutput | undefined = (run.outputs || []).find(
            (o) => o.media_kind === 'video',
          )
          if (vidOut) {
            const newItem: ActiveVideoItem = {
              filename: vidOut.filename,
              subfolder: vidOut.subfolder || '',
              type: vidOut.type || 'output',
              url: vidOut.url,
              title: run.template_title,
            }
            setActiveVideo(newItem)
            onAddScratchItem({
              kind: 'video',
              label: run.template_title,
              url: vidOut.url,
              filename: vidOut.filename,
              subfolder: vidOut.subfolder,
              type: vidOut.type,
              metaText: 'AI Generated Clip',
            })
            setBusyMessage(`Completed & added to Scratch Space: ${run.template_title}`)
          } else {
            setBusyMessage(`Run finished (${run.template_title})`)
          }
        } else if (run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(timer)
          setActiveRunId(null)
          setBusyMessage(`Video run ${run.status}: ${run.error || 'Unknown error'}`)
        }
      } catch {}
    }, 1500)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [activeRunId, onRunsUpdated, onAddScratchItem])

  // Handle interactive dragging of Playhead, In-handle, or Out-handle on the timeline
  useEffect(() => {
    if (!draggingHandle) return
    const handleMouseMove = (e: MouseEvent) => {
      const track = timelineTrackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)))
      const targetSec = +(ratio * totalDuration).toFixed(2)
      const minGap = +(1 / fps).toFixed(2)

      if (draggingHandle === 'in') {
        const clampedIn = Math.min(targetSec, Math.max(0, trimOut - minGap))
        setTrimIn(clampedIn)
        seekTo(clampedIn)
      } else if (draggingHandle === 'out') {
        const clampedOut = Math.max(targetSec, Math.min(totalDuration, trimIn + minGap))
        setTrimOut(clampedOut)
        seekTo(clampedOut)
      } else if (draggingHandle === 'playhead') {
        seekTo(targetSec)
      }
    }
    const handleMouseUp = () => setDraggingHandle(null)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [draggingHandle, totalDuration, trimIn, trimOut, fps])

  const selectToolset = (ts: VideoToolset) => {
    if (activeToolset === ts && leftDrawerOpen) {
      setLeftDrawerOpen(false)
    } else {
      setActiveToolset(ts)
      setLeftDrawerOpen(true)
    }
  }

  const seekTo = (sec: number) => {
    const v = videoRef.current
    const clamped = Math.max(0, Math.min(totalDuration, sec))
    if (v) {
      v.currentTime = clamped
    }
    setCurrentTime(clamped)
  }

  const togglePlayPause = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (loopRange && (v.currentTime < trimIn || v.currentTime >= trimOut)) {
        v.currentTime = trimIn
      }
      v.play()
    } else {
      v.pause()
    }
  }

  const stepFrame = (deltaFrames: number) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    const nextTime = Math.max(
      0,
      Math.min(totalDuration, v.currentTime + deltaFrames * (1 / fps)),
    )
    seekTo(nextTime)
  }

  const uploadAndLoadFile = async (file: File) => {
    setBusyMessage(`Uploading ${file.name}...`)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/assets/upload', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Upload failed')
      const fname = data.name || file.name
      const viewUrl =
        data.url || `/api/view?${new URLSearchParams({ filename: fname, subfolder: '', type: 'input' }).toString()}`
      if (file.type.startsWith('image/')) {
        setFlfStartB64(viewUrl)
        setFlfStartLabel(fname)
        setActiveToolset('ai')
        setLeftDrawerOpen(true)
        onAddScratchItem({
          kind: 'image',
          label: fname,
          url: viewUrl,
          filename: fname,
          subfolder: '',
          type: 'input',
          metaText: 'Dropped Image',
        })
        setBusyMessage(`Loaded image "${fname}" into Start Frame & Scratch Space!`)
        return
      }
      const uploadedClip: ActiveVideoItem = {
        filename: fname,
        subfolder: '',
        type: 'input',
        url: viewUrl,
        title: `Uploaded: ${fname}`,
      }
      setActiveVideo(uploadedClip)
      onAddScratchItem({
        kind: 'video',
        label: fname,
        url: uploadedClip.url,
        filename: fname,
        subfolder: '',
        type: 'input',
        metaText: 'Uploaded Video',
      })
      setBusyMessage(`Loaded ${fname} into Video Studio & Scratch Space`)
    } catch (err) {
      setBusyMessage(`Upload error: ${String(err)}`)
    }
  }

  const handleUploadVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadAndLoadFile(file)
  }

  const handleImportFromUrl = async (rawUrl?: string) => {
    const targetUrl = (rawUrl ?? urlImportInput).trim()
    if (!targetUrl) return
    setImportingUrl(true)
    setBusyMessage('Importing media from URL / Google Photos link...')
    try {
      const res = await fetch('/api/assets/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'URL import failed')
      const fname = data.name || data.filename || 'url_import'
      const viewUrl =
        data.url || `/api/view?${new URLSearchParams({ filename: fname, subfolder: '', type: 'input' }).toString()}`
      const isVideo = data.media_kind === 'video' || /\.(mp4|webm|mov|mkv)$/i.test(fname)
      if (isVideo) {
        const clip: ActiveVideoItem = {
          filename: fname,
          subfolder: '',
          type: 'input',
          url: viewUrl,
          title: `Imported: ${fname}`,
        }
        setActiveVideo(clip)
        onAddScratchItem({
          kind: 'video',
          label: fname,
          url: viewUrl,
          filename: fname,
          subfolder: '',
          type: 'input',
          metaText: 'URL Video',
        })
        setBusyMessage(`Loaded video "${fname}" from URL into Player & Scratch Space!`)
      } else {
        setFlfStartB64(viewUrl)
        setFlfStartLabel(fname)
        setActiveToolset('ai')
        setLeftDrawerOpen(true)
        onAddScratchItem({
          kind: 'image',
          label: fname,
          url: viewUrl,
          filename: fname,
          subfolder: '',
          type: 'input',
          metaText: 'Google Photos / URL',
        })
        setBusyMessage(`Imported "${fname}" as Start Frame & pinned to Scratch Space!`)
      }
      setUrlImportInput('')
    } catch (err) {
      setBusyMessage(`URL import error: ${String(err)}`)
    } finally {
      setImportingUrl(false)
    }
  }

  const handleViewportDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingOver(false)
    const dt = e.dataTransfer
    if (dt.files && dt.files.length > 0) {
      await uploadAndLoadFile(dt.files[0])
      return
    }
    const html = dt.getData('text/html')
    if (html) {
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
      if (m && m[1]?.startsWith('http')) {
        await handleImportFromUrl(m[1])
        return
      }
    }
    const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim()
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const firstLine = uri.split(/\r?\n/)[0].trim()
      await handleImportFromUrl(firstLine)
    }
  }

  const handleExtractFrame = async (
    targetTs: number | 'last',
    destination: 'photo' | 'scratch' | 'start' | 'end',
  ) => {
    if (!activeVideo) return
    const frameLabel =
      targetTs === 'last'
        ? `End Frame (${activeVideo.filename})`
        : `Frame #${Math.round(Number(targetTs) * fps)} @ ${Number(targetTs).toFixed(2)}s`
    setBusyMessage(`Extracting lossless PNG (${frameLabel}) via FFmpeg...`)
    try {
      const res = await fetch('/api/video/extract-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeVideo.filename,
          subfolder: activeVideo.subfolder,
          type: activeVideo.type,
          timestamp: targetTs,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Frame extraction failed')

      // Always add extracted frame to Scratch Space so user has it handy
      onAddScratchItem({
        kind: 'image',
        label: frameLabel,
        url: data.url,
        filename: data.filename,
        subfolder: '',
        type: 'input',
        metaText: `${data.width || ''}×${data.height || ''} PNG`,
      })

      if (destination === 'photo') {
        onSendFrameToPhotoStudio(data.url, frameLabel)
      } else if (destination === 'start') {
        setFlfStartB64(data.url)
        setFlfStartLabel(frameLabel)
        setBusyMessage(`Set Start Frame to ${frameLabel} (also saved to Scratch Space)`)
      } else if (destination === 'end') {
        setFlfEndB64(data.url)
        setFlfEndLabel(frameLabel)
        setBusyMessage(`Set End Frame to ${frameLabel} (also saved to Scratch Space)`)
      } else {
        setBusyMessage(`Pinned ${frameLabel} to Scratch Space!`)
      }
    } catch (err) {
      setBusyMessage(`Frame extraction failed: ${String(err)}`)
    }
  }

  const handleCutFrameRange = async (mode: 'keep_range' | 'remove_range') => {
    if (!activeVideo) return
    const actionDesc =
      mode === 'keep_range'
        ? `Cutting selected frames [${trimInFrame} → ${trimOutFrame}] (${selectedDuration}s)`
        : `Splicing out frames [${trimInFrame} → ${trimOutFrame}] and keeping outside frames`
    setBusyMessage(`${actionDesc} with FFmpeg...`)
    try {
      const res = await fetch('/api/video/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeVideo.filename,
          subfolder: activeVideo.subfolder,
          type: activeVideo.type,
          start_sec: trimIn,
          end_sec: trimOut,
          mode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Cut failed')
      const title =
        mode === 'keep_range'
          ? `Cut Frames ${trimInFrame}–${trimOutFrame} (${selectedDuration}s)`
          : `Spliced (Removed ${trimInFrame}–${trimOutFrame})`
      const cutItem: ActiveVideoItem = {
        filename: data.filename,
        subfolder: '',
        type: 'output',
        url: data.url,
        title,
      }
      setActiveVideo(cutItem)
      onAddScratchItem({
        kind: 'video',
        label: title,
        url: data.url,
        filename: data.filename,
        subfolder: '',
        type: 'output',
        metaText: `${data.meta?.duration || selectedDuration}s MP4`,
      })
      setBusyMessage(`Saved "${title}" to Player & Scratch Space!`)
    } catch (err) {
      setBusyMessage(`FFmpeg cut failed: ${String(err)}`)
    }
  }

  const handleStitchClips = async () => {
    if (stitchTray.length < 2) return
    setBusyMessage(`Stitching ${stitchTray.length} clips with FFmpeg...`)
    try {
      const res = await fetch('/api/video/stitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: stitchTray.map((c) => ({
            filename: c.filename,
            subfolder: c.subfolder,
            type: c.type,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Stitch failed')
      const title = `Stitched (${stitchTray.length} clips)`
      const stitchedItem: ActiveVideoItem = {
        filename: data.filename,
        subfolder: '',
        type: 'output',
        url: data.url,
        title,
      }
      setActiveVideo(stitchedItem)
      onAddScratchItem({
        kind: 'video',
        label: title,
        url: data.url,
        filename: data.filename,
        subfolder: '',
        type: 'output',
        metaText: `${data.meta?.duration || ''}s MP4`,
      })
      setBusyMessage(`Stitched video ready & pinned to Scratch Space: ${data.filename}`)
    } catch (err) {
      setBusyMessage(`FFmpeg stitch failed: ${String(err)}`)
    }
  }

  const handleRunVideoContinuation = async () => {
    if (!activeVideo) return
    setBusyMessage('Extracting final frame via FFmpeg & starting AI Video Continuation...')
    try {
      const frameRes = await fetch('/api/video/extract-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeVideo.filename,
          subfolder: activeVideo.subfolder,
          type: activeVideo.type,
          timestamp: 'last',
        }),
      })
      const frameData = await frameRes.json()
      if (!frameRes.ok) throw new Error(frameData.detail || 'Final frame extraction failed')

      setStitchTray((prev) =>
        prev.some((x) => x.filename === activeVideo.filename) ? prev : [...prev, activeVideo],
      )

      const execRes = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: continuationModel,
          prompt: continuationPrompt,
          canvas_filename: frameData.filename,
        }),
      })
      const execData = await execRes.json()
      if (execData.run?.id) {
        setActiveRunId(execData.run.id)
        setBusyMessage(`Running ${continuationModel} from final frame (${frameData.filename})...`)
      }
    } catch (err) {
      setBusyMessage(`Continuation error: ${String(err)}`)
    }
  }

  const handleRunFirstLastFrameBridge = async () => {
    if (!flfStartB64) {
      setBusyMessage('Select a Start Frame first.')
      return
    }
    setBusyMessage('Starting Wan 2.2 14B Video Generation...')
    try {
      const isDual = Boolean(flfEndB64)
      const tid = isDual ? 'video_wan2_2_14B_flf2v' : 'video_wan2_2_14B_i2v'

      const resolvePayloadImage = async (val: string | null) => {
        if (!val) return { b64: null, fname: null }
        if (val.startsWith('data:')) return { b64: val, fname: null }
        try {
          const u = new URL(val, window.location.origin)
          const fn = u.searchParams.get('filename')
          if (fn) return { b64: null, fname: fn }
        } catch {}
        return { b64: val, fname: null }
      }

      const startResolved = await resolvePayloadImage(flfStartB64)
      const endResolved = await resolvePayloadImage(flfEndB64)

      const res = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: tid,
          prompt: flfPrompt,
          canvas_image_b64: startResolved.b64,
          canvas_filename: startResolved.fname,
          second_image_b64: endResolved.b64,
          second_filename: endResolved.fname,
        }),
      })
      const data = await res.json()
      if (data.run?.id) {
        setActiveRunId(data.run.id)
        setBusyMessage(`Running ${tid} in ComfyUI...`)
      }
    } catch (err) {
      setBusyMessage(`FLF2V failed: ${String(err)}`)
    }
  }

  const readUploadToDataUrl = (
    e: React.ChangeEvent<HTMLInputElement>,
    cb: (dataUrl: string, name: string) => void,
  ) => {
    const f = e.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      if (typeof r.result === 'string') cb(r.result, f.name)
    }
    r.readAsDataURL(f)
  }

  // Nearest filmstrip thumbnail previews for In and Out handles
  const nearestInThumb =
    filmstrip.length > 0
      ? filmstrip.reduce((prev, curr) =>
          Math.abs(curr.timestamp - trimIn) < Math.abs(prev.timestamp - trimIn) ? curr : prev,
        )
      : null
  const nearestOutThumb =
    filmstrip.length > 0
      ? filmstrip.reduce((prev, curr) =>
          Math.abs(curr.timestamp - trimOut) < Math.abs(prev.timestamp - trimOut) ? curr : prev,
        )
      : null

  const toolsetButtons: Array<{ id: VideoToolset; icon: string; label: string; badge?: number }> = [
    { id: 'clips', icon: '📂', label: 'Clips' },
    { id: 'cut', icon: '✂️', label: 'Frame Cut' },
    { id: 'ai', icon: '⏩', label: 'AI Video' },
    { id: 'stitch', icon: '🔗', label: 'Stitch', badge: stitchTray.length },
    { id: 'scratch', icon: '🗂️', label: 'Scratch', badge: scratchItems.length },
  ]

  const inPct = Math.max(0, Math.min(100, (trimIn / totalDuration) * 100))
  const outPct = Math.max(0, Math.min(100, (trimOut / totalDuration) * 100))
  const playheadPct = Math.max(0, Math.min(100, (currentTime / totalDuration) * 100))

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
        ref={videoUploadInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={handleUploadVideoFile}
      />
      <input
        ref={startFrameInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) =>
          readUploadToDataUrl(e, (url, name) => {
            setFlfStartB64(url)
            setFlfStartLabel(name)
          })
        }
      />
      <input
        ref={endFrameInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) =>
          readUploadToDataUrl(e, (url, name) => {
            setFlfEndB64(url)
            setFlfEndLabel(name)
          })
        }
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
                  fontSize: '0.63rem',
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
            width: 300,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: '0.85rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
            overflowY: 'auto',
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
              {activeToolset === 'clips' && '📂 Video Clip Library'}
              {activeToolset === 'cut' && '✂️ Frame-Range Cut & Splice'}
              {activeToolset === 'ai' && '⏩ AI Continuation & Morph'}
              {activeToolset === 'stitch' && `🔗 FFmpeg Stitch Queue (${stitchTray.length})`}
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

          {/* TOOLSET 1: VIDEO CLIPS LIBRARY */}
          {activeToolset === 'clips' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', fontSize: '0.78rem' }}
                onClick={() => videoUploadInputRef.current?.click()}
              >
                📂 Open Video File (MP4/WebM/MOV)
              </button>

              {/* Google Photos / Video or Image URL Import */}
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
                  🔗 Google Photos / Media URL Import
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="text"
                    value={urlImportInput}
                    onChange={(e) => setUrlImportInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleImportFromUrl()
                    }}
                    placeholder="Paste video URL or Google Photos link..."
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
                  Tip: Drag video or image files directly from your File Manager onto the player!
                </div>
              </div>

              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                Recent Generated &amp; Cut Clips:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {recentVideos.map((v, idx) => (
                  <div
                    key={`${v.filename}-${idx}`}
                    onClick={() => setActiveVideo(v)}
                    style={{
                      padding: '0.45rem 0.55rem',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: '0.73rem',
                      border:
                        activeVideo?.filename === v.filename
                          ? '1px solid #6366f1'
                          : '1px solid var(--border)',
                      background:
                        activeVideo?.filename === v.filename
                          ? 'rgba(99, 102, 241, 0.16)'
                          : 'rgba(15, 23, 42, 0.6)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      🎬 {v.title}
                    </span>
                    <button
                      type="button"
                      className="chip"
                      style={{ fontSize: '0.64rem', padding: '0.1rem 0.35rem' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setStitchTray((prev) => [...prev, v])
                      }}
                    >
                      + Stitch
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TOOLSET 2: PRECISION FRAME-RANGE CUTTER */}
          {activeToolset === 'cut' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
                fontSize: '0.75rem',
              }}
            >
              <div
                style={{
                  padding: '0.6rem',
                  borderRadius: 8,
                  background: 'rgba(99, 102, 241, 0.12)',
                  border: '1px solid rgba(99, 102, 241, 0.35)',
                }}
              >
                <div style={{ fontWeight: 700, color: '#a5b4fc', marginBottom: 4 }}>
                  Selected Frame Subset
                </div>
                <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                  Frames {trimInFrame} → {trimOutFrame}{' '}
                  <span style={{ color: '#34d399' }}>({selectedFrameCount} frames)</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Time: {trimIn.toFixed(2)}s → {trimOut.toFixed(2)}s ({selectedDuration}s @ {fps}{' '}
                  fps)
                </div>
              </div>

              {/* Live In-Frame and Out-Frame Preview Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                <div
                  style={{
                    padding: '0.4rem',
                    borderRadius: 6,
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid #10b981',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '0.68rem', color: '#34d399', fontWeight: 700 }}>
                    [ IN: Frame #{trimInFrame}
                  </div>
                  {nearestInThumb && (
                    <img
                      src={nearestInThumb.data_url}
                      alt="In Frame"
                      style={{
                        width: '100%',
                        height: 60,
                        objectFit: 'cover',
                        borderRadius: 4,
                        margin: '4px 0',
                      }}
                    />
                  )}
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, trimOutFrame - 1)}
                    value={trimInFrame}
                    onChange={(e) => {
                      const f = Math.max(0, Number(e.target.value))
                      const sec = +(f / fps).toFixed(2)
                      setTrimIn(Math.min(sec, trimOut - 0.05))
                      seekTo(sec)
                    }}
                    className="search-input"
                    style={{ width: '100%', fontSize: '0.72rem', padding: '0.2rem 0.35rem' }}
                  />
                </div>

                <div
                  style={{
                    padding: '0.4rem',
                    borderRadius: 6,
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid #f59e0b',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '0.68rem', color: '#fbbf24', fontWeight: 700 }}>
                    OUT: Frame #{trimOutFrame} ]
                  </div>
                  {nearestOutThumb && (
                    <img
                      src={nearestOutThumb.data_url}
                      alt="Out Frame"
                      style={{
                        width: '100%',
                        height: 60,
                        objectFit: 'cover',
                        borderRadius: 4,
                        margin: '4px 0',
                      }}
                    />
                  )}
                  <input
                    type="number"
                    min={trimInFrame + 1}
                    max={totalFrames}
                    value={trimOutFrame}
                    onChange={(e) => {
                      const f = Math.min(totalFrames, Number(e.target.value))
                      const sec = +(f / fps).toFixed(2)
                      setTrimOut(Math.max(sec, trimIn + 0.05))
                      seekTo(sec)
                    }}
                    className="search-input"
                    style={{ width: '100%', fontSize: '0.72rem', padding: '0.2rem 0.35rem' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  type="button"
                  className="chip"
                  style={{ flex: 1 }}
                  onClick={() => setTrimIn(Number(currentTime.toFixed(2)))}
                >
                  [ Set In @ Playhead
                </button>
                <button
                  type="button"
                  className="chip"
                  style={{ flex: 1 }}
                  onClick={() => setTrimOut(Number(currentTime.toFixed(2)))}
                >
                  ] Set Out @ Playhead
                </button>
              </div>

              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '0.76rem' }}
                onClick={() => handleCutFrameRange('keep_range')}
                disabled={!activeVideo}
              >
                ✂️ Cut &amp; Keep Selected Frames [{trimInFrame}–{trimOutFrame}]
              </button>

              <button
                type="button"
                className="btn"
                style={{ fontSize: '0.75rem', borderColor: '#f43f5e', color: '#fda4af' }}
                onClick={() => handleCutFrameRange('remove_range')}
                disabled={!activeVideo}
              >
                🗑️ Remove Selected Frames (Splice Outside)
              </button>

              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Every cut clip is automatically loaded in the player and saved into your{' '}
                <strong>Scratch Space (`🗂️`)</strong> so you never lose your original clip.
              </div>
            </div>
          )}

          {/* TOOLSET 3: AI VIDEO CONTINUATION & FIRST-LAST FRAME */}
          {activeToolset === 'ai' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.7rem',
                fontSize: '0.75rem',
              }}
            >
              <div
                style={{
                  padding: '0.65rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.45rem',
                }}
              >
                <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
                  ⏩ AI Video Continuation (Extend Clip)
                </div>
                <select
                  value={continuationModel}
                  onChange={(e) => setContinuationModel(e.target.value as any)}
                  style={{
                    background: 'var(--bg-main)',
                    color: 'var(--text-main)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '0.28rem 0.45rem',
                    fontSize: '0.72rem',
                  }}
                >
                  <option value="video_minimax_h3_i2v_continuation">
                    MiniMax H3: Video Continuation
                  </option>
                  <option value="video_wan2_2_14B_i2v">Wan 2.2 14B: Image to Video</option>
                </select>
                <textarea
                  rows={2}
                  className="search-input"
                  value={continuationPrompt}
                  onChange={(e) => setContinuationPrompt(e.target.value)}
                  placeholder="Describe what happens next..."
                  style={{ fontSize: '0.73rem', resize: 'vertical' }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: '0.75rem' }}
                  onClick={handleRunVideoContinuation}
                  disabled={!activeVideo || Boolean(activeRunId)}
                >
                  ⏩ Extend Video from Final Frame
                </button>
              </div>

              <div
                style={{
                  padding: '0.65rem',
                  borderRadius: 8,
                  background: 'rgba(30, 41, 59, 0.55)',
                  border: '1px solid rgba(99, 102, 241, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.45rem',
                }}
              >
                <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
                  🌉 First-to-Last Frame Morph (Wan 2.2)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                  <div
                    style={{
                      padding: '0.35rem',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'rgba(15, 23, 42, 0.7)',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '0.66rem', fontWeight: 600, marginBottom: 4 }}>
                      Start Frame
                    </div>
                    {flfStartB64 ? (
                      <img
                        src={flfStartB64}
                        alt="Start"
                        style={{
                          width: '100%',
                          height: 60,
                          objectFit: 'cover',
                          borderRadius: 4,
                          marginBottom: 4,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          height: 60,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-muted)',
                          fontSize: '0.66rem',
                        }}
                      >
                        Empty
                      </div>
                    )}
                    <button
                      type="button"
                      className="chip"
                      style={{ width: '100%', fontSize: '0.66rem' }}
                      onClick={() => startFrameInputRef.current?.click()}
                    >
                      {flfStartB64 ? 'Change' : '+ Upload'}
                    </button>
                  </div>

                  <div
                    style={{
                      padding: '0.35rem',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'rgba(15, 23, 42, 0.7)',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '0.66rem', fontWeight: 600, marginBottom: 4 }}>
                      End Frame (Opt)
                    </div>
                    {flfEndB64 ? (
                      <img
                        src={flfEndB64}
                        alt="End"
                        style={{
                          width: '100%',
                          height: 60,
                          objectFit: 'cover',
                          borderRadius: 4,
                          marginBottom: 4,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          height: 60,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-muted)',
                          fontSize: '0.66rem',
                        }}
                      >
                        Single I2V
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 3 }}>
                      <button
                        type="button"
                        className="chip"
                        style={{ flex: 1, fontSize: '0.66rem' }}
                        onClick={() => endFrameInputRef.current?.click()}
                      >
                        {flfEndB64 ? 'Change' : '+ End'}
                      </button>
                      {flfEndB64 && (
                        <button
                          type="button"
                          className="chip"
                          style={{ fontSize: '0.66rem' }}
                          onClick={() => {
                            setFlfEndB64(null)
                            setFlfEndLabel('None')
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <textarea
                  rows={2}
                  className="search-input"
                  value={flfPrompt}
                  onChange={(e) => setFlfPrompt(e.target.value)}
                  placeholder="Describe motion or transition..."
                  style={{ fontSize: '0.73rem', resize: 'vertical' }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: '0.75rem' }}
                  onClick={handleRunFirstLastFrameBridge}
                  disabled={!flfStartB64 || Boolean(activeRunId)}
                >
                  {flfEndB64
                    ? '🌉 Generate First-to-Last Frame Video'
                    : '🎬 Animate Start Frame (Wan 2.2)'}
                </button>
              </div>

              <div
                style={{
                  padding: '0.55rem',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid var(--border)',
                  fontSize: '0.72rem',
                }}
              >
                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Segmented Upscale Chunk Size:</span>
                  <span>{chunkSeconds}s</span>
                </label>
                <input
                  type="range"
                  min={4}
                  max={30}
                  step={2}
                  value={chunkSeconds}
                  onChange={(e) => setChunkSeconds(Number(e.target.value))}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </div>
            </div>
          )}

          {/* TOOLSET 4: FFMPEG MULTI-CLIP STITCH QUEUE */}
          {activeToolset === 'stitch' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.75rem' }}>
              {activeVideo && (
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: '0.75rem' }}
                  onClick={() => setStitchTray((prev) => [...prev, activeVideo])}
                >
                  ➕ Add Current Player Clip to Queue
                </button>
              )}
              {stitchTray.length === 0 ? (
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Add 2 or more clips from the Clip Library or Scratch Space to concatenate them
                  into one normalized MP4 with FFmpeg.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {stitchTray.map((c, idx) => (
                    <div
                      key={`${c.filename}-${idx}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '0.72rem',
                        padding: '0.35rem 0.5rem',
                        background: 'rgba(30, 41, 59, 0.7)',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {idx + 1}. {c.title || c.filename}
                      </span>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#fca5a5',
                          cursor: 'pointer',
                        }}
                        onClick={() => setStitchTray((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: '0.75rem', marginTop: 4 }}
                    onClick={handleStitchClips}
                    disabled={stitchTray.length < 2}
                  >
                    🔗 Stitch {stitchTray.length} Clips into MP4
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TOOLSET 5: SHARED SCRATCH SPACE */}
          {activeToolset === 'scratch' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, fontSize: '0.73rem' }}
                  onClick={() => handleExtractFrame(currentTime, 'scratch')}
                  disabled={!activeVideo}
                >
                  📌 Pin Playhead Frame
                </button>
                {activeVideo && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: '0.73rem' }}
                    onClick={() => {
                      onAddScratchItem({
                        kind: 'video',
                        label: activeVideo.title,
                        url: activeVideo.url,
                        filename: activeVideo.filename,
                        subfolder: activeVideo.subfolder,
                        type: activeVideo.type,
                        metaText: `${totalDuration}s Clip`,
                      })
                      setBusyMessage(`Pinned clip "${activeVideo.title}" to Scratch Space!`)
                    }}
                  >
                    📌 Pin Clip
                  </button>
                )}
              </div>

              {scratchItems.length === 0 ? (
                <div
                  style={{
                    padding: '1.2rem',
                    textAlign: 'center',
                    border: '1px dashed var(--border)',
                    borderRadius: 8,
                    color: 'var(--text-muted)',
                    fontSize: '0.73rem',
                  }}
                >
                  Scratch Space is empty. Cut a frame range, pin a playhead frame, or save a cutout
                  from Photo Studio!
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
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
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
                        >
                          ✕
                        </button>
                      </div>

                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {item.kind === 'video' && item.filename && (
                          <>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.65rem', padding: '0.12rem 0.4rem' }}
                              onClick={() =>
                                setActiveVideo({
                                  filename: item.filename!,
                                  subfolder: item.subfolder || '',
                                  type: item.type || 'output',
                                  url: item.url,
                                  title: item.label,
                                })
                              }
                            >
                              ▶ Load in Player
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.65rem', padding: '0.12rem 0.4rem' }}
                              onClick={() =>
                                setStitchTray((prev) => [
                                  ...prev,
                                  {
                                    filename: item.filename!,
                                    subfolder: item.subfolder || '',
                                    type: item.type || 'output',
                                    url: item.url,
                                    title: item.label,
                                  },
                                ])
                              }
                            >
                              + Stitch Queue
                            </button>
                          </>
                        )}
                        {item.kind === 'image' && (
                          <>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.65rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => {
                                setFlfStartB64(item.url)
                                setFlfStartLabel(item.label)
                                setActiveToolset('ai')
                              }}
                            >
                              🟢 Set Start
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.65rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => {
                                setFlfEndB64(item.url)
                                setFlfEndLabel(item.label)
                                setActiveToolset('ai')
                              }}
                            >
                              🔴 Set End
                            </button>
                            <button
                              type="button"
                              className="chip"
                              style={{ fontSize: '0.65rem', padding: '0.12rem 0.4rem' }}
                              onClick={() => onSendFrameToPhotoStudio(item.url, item.label)}
                            >
                              🖼️ Edit in Photo
                            </button>
                          </>
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

      {/* MAIN VIDEO VIEWPORT & INTERACTIVE FRAME-RANGE TIMELINE */}
      <main
        onDragOver={(e) => {
          e.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleViewportDrop}
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
            <div style={{ fontSize: '2.4rem' }}>🎬</div>
            <div style={{ fontSize: '1rem', fontWeight: 700 }}>
              Drop Video File, Image Frame, or Google Photos Link Here
            </div>
            <div style={{ fontSize: '0.78rem', color: '#a5b4fc' }}>
              Videos load into the Player • Photos load into Start Frame &amp; Scratch Space
            </div>
          </div>
        )}
        {/* Top Metadata & Frame Actions Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.48rem 0.9rem',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            fontSize: '0.75rem',
            flexWrap: 'wrap',
            gap: '0.4rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            <span style={{ fontWeight: 700 }}>
              {activeVideo ? activeVideo.title : 'No Video Loaded'}
            </span>
            {videoMeta && (
              <span
                style={{
                  fontSize: '0.69rem',
                  color: '#a5b4fc',
                  background: 'rgba(99, 102, 241, 0.16)',
                  padding: '0.12rem 0.5rem',
                  borderRadius: 999,
                  fontWeight: 600,
                }}
              >
                {videoMeta.width}×{videoMeta.height} • {fps} fps • {totalFrames} frames (
                {totalDuration}s)
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="chip"
              onClick={() => handleExtractFrame(currentTime, 'scratch')}
              disabled={!activeVideo}
              title="Extract lossless PNG at playhead and pin to Scratch Space"
            >
              📌 Pin Frame #{currentFrame} to Scratch
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: '0.73rem', padding: '0.22rem 0.6rem' }}
              onClick={() => handleExtractFrame(currentTime, 'photo')}
              disabled={!activeVideo}
            >
              📸 Edit Frame #{currentFrame} in Photo Studio
            </button>
          </div>
        </div>

        {busyMessage && (
          <div
            style={{
              padding: '0.38rem 0.9rem',
              background: 'rgba(99, 102, 241, 0.16)',
              borderBottom: '1px solid rgba(99, 102, 241, 0.35)',
              color: '#c7d2fe',
              fontSize: '0.74rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>
              {activeRunId ? '⏳ ' : '🎬 '}
              {busyMessage}
            </span>
            <button
              type="button"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
              onClick={() => setBusyMessage(null)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Theater Video Player */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0.85rem',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {activeVideo ? (
            <>
              <video
                ref={videoRef}
                src={activeVideo.url}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime
                  if (loopRange && t >= trimOut) {
                    e.currentTarget.currentTime = trimIn
                    setCurrentTime(trimIn)
                  } else {
                    setCurrentTime(t)
                  }
                }}
                onClick={togglePlayPause}
                style={{
                  maxWidth: '100%',
                  maxHeight: '54vh',
                  borderRadius: 10,
                  boxShadow: '0 16px 44px rgba(0,0,0,0.75)',
                  border: '1px solid #334155',
                  background: '#000',
                  cursor: 'pointer',
                }}
              />

              {/* Custom Precision NLE Transport Bar */}
              <div
                style={{
                  marginTop: '0.65rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  padding: '0.4rem 0.75rem',
                  borderRadius: 999,
                  background: 'rgba(15, 23, 42, 0.92)',
                  border: '1px solid var(--border)',
                  fontSize: '0.74rem',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: '0.22rem 0.65rem', fontSize: '0.74rem', borderRadius: 999 }}
                  onClick={togglePlayPause}
                >
                  {isPlaying ? '⏸ Pause' : '▶ Play'}
                </button>

                <button
                  type="button"
                  className="chip"
                  onClick={() => seekTo(trimIn)}
                  title="Jump to In Point"
                >
                  |[ In
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => stepFrame(-10)}
                  title="Back 10 Frames"
                >
                  ⏮ -10f
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => stepFrame(-1)}
                  title="Back 1 Frame"
                >
                  ⏪ -1f
                </button>

                <div
                  style={{
                    padding: '0.18rem 0.65rem',
                    borderRadius: 6,
                    background: '#090d16',
                    border: '1px solid #334155',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    color: '#e2e8f0',
                    minWidth: 165,
                    textAlign: 'center',
                  }}
                >
                  Frame <strong>{currentFrame}</strong> / {totalFrames} • {currentTime.toFixed(2)}s
                </div>

                <button
                  type="button"
                  className="chip"
                  onClick={() => stepFrame(1)}
                  title="Forward 1 Frame"
                >
                  +1f ⏩
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => stepFrame(10)}
                  title="Forward 10 Frames"
                >
                  +10f ⏭
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => seekTo(trimOut)}
                  title="Jump to Out Point"
                >
                  Out ]|
                </button>

                <button
                  type="button"
                  className={`chip ${loopRange ? 'active' : ''}`}
                  onClick={() => setLoopRange((v) => !v)}
                  title="Loop playback between [In and Out] markers"
                >
                  🔁 Loop [In→Out]
                </button>

                <select
                  value={playbackRate}
                  onChange={(e) => {
                    const r = Number(e.target.value)
                    setPlaybackRate(r)
                    if (videoRef.current) videoRef.current.playbackRate = r
                  }}
                  style={{
                    background: '#090d16',
                    color: 'var(--text-main)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '0.15rem 0.35rem',
                    fontSize: '0.7rem',
                  }}
                  title="Playback Speed"
                >
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1.0×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2}>2.0×</option>
                </select>
              </div>
            </>
          ) : (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem',
                border: '1px dashed var(--border)',
                borderRadius: 12,
                color: 'var(--text-muted)',
                maxWidth: 440,
              }}
            >
              <div style={{ fontSize: '2.2rem', marginBottom: '0.5rem' }}>🎬</div>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 6 }}>
                No Video Loaded
              </div>
              <div style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                Open an MP4/WebM file, pick a clip from the left `📂 Clips` drawer, or animate a
                frame in `⏩ AI Video`!
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => videoUploadInputRef.current?.click()}
              >
                📂 Open Video File
              </button>
            </div>
          )}
        </div>

        {/* BOTTOM NLE TIMELINE: Interactive Dual-Handle Frame-Range Selector & Filmstrip */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: '0.6rem 0.95rem 0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.45rem',
            userSelect: 'none',
          }}
        >
          {/* Timeline Header & Direct Range Actions */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.73rem',
              flexWrap: 'wrap',
              gap: '0.4rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontWeight: 700, color: '#e2e8f0' }}>
                ✂️ Frame-Range Timeline Selector:
              </span>
              <span
                style={{
                  background: 'rgba(16, 185, 129, 0.16)',
                  color: '#34d399',
                  padding: '0.1rem 0.5rem',
                  borderRadius: 6,
                  fontFamily: 'monospace',
                  fontWeight: 600,
                }}
              >
                [ IN: Frame {trimInFrame} ({trimIn.toFixed(2)}s) → OUT: Frame {trimOutFrame} (
                {trimOut.toFixed(2)}s) ] • {selectedFrameCount} frames ({selectedDuration}s)
              </span>
            </div>

            {activeVideo && (
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem', borderColor: '#10b981' }}
                  onClick={() => setTrimIn(Number(currentTime.toFixed(2)))}
                >
                  [ Set In Here
                </button>
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem', borderColor: '#f59e0b' }}
                  onClick={() => setTrimOut(Number(currentTime.toFixed(2)))}
                >
                  Set Out Here ]
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: '0.71rem', padding: '0.18rem 0.6rem' }}
                  onClick={() => handleCutFrameRange('keep_range')}
                >
                  ✂️ Cut &amp; Keep [{trimInFrame}–{trimOutFrame}]
                </button>
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem', color: '#fda4af' }}
                  onClick={() => handleCutFrameRange('remove_range')}
                  title="Delete the selected frames and splice the remaining video together"
                >
                  🗑️ Splice Out Range
                </button>
              </div>
            )}
          </div>

          {/* Interactive Filmstrip Track with Draggable IN / OUT Brackets and Playhead */}
          <div
            ref={timelineTrackRef}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).dataset.handle) return
              const rect = e.currentTarget.getBoundingClientRect()
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)))
              seekTo(+(ratio * totalDuration).toFixed(2))
              setDraggingHandle('playhead')
            }}
            style={{
              position: 'relative',
              height: 68,
              borderRadius: 8,
              overflow: 'hidden',
              background: '#090d16',
              border: '1px solid #334155',
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            {/* Filmstrip Thumbnails Background */}
            {filmstrip.map((f) => (
              <div
                key={f.index}
                style={{
                  flex: 1,
                  height: '100%',
                  position: 'relative',
                  borderRight: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <img
                  src={f.data_url}
                  alt={`f=${f.frame_number}`}
                  draggable={false}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                    pointerEvents: 'none',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    bottom: 2,
                    left: 3,
                    fontSize: '0.58rem',
                    background: 'rgba(0,0,0,0.72)',
                    color: '#cbd5e1',
                    padding: '0 3px',
                    borderRadius: 3,
                    pointerEvents: 'none',
                  }}
                >
                  #{f.frame_number ?? Math.round(f.timestamp * fps)}
                </span>
              </div>
            ))}

            {/* Dimmed Overlay Left of IN */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: `${inPct}%`,
                background: 'rgba(7, 10, 18, 0.76)',
                pointerEvents: 'none',
              }}
            />

            {/* Dimmed Overlay Right of OUT */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${outPct}%`,
                right: 0,
                background: 'rgba(7, 10, 18, 0.76)',
                pointerEvents: 'none',
              }}
            />

            {/* Highlighted Active Selection Box [IN -> OUT] */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${inPct}%`,
                width: `${Math.max(0.5, outPct - inPct)}%`,
                borderTop: '3px solid #10b981',
                borderBottom: '3px solid #10b981',
                background: 'rgba(16, 185, 129, 0.08)',
                pointerEvents: 'none',
              }}
            />

            {/* Draggable LEFT [ IN Handle */}
            <div
              data-handle="in"
              onMouseDown={(e) => {
                e.stopPropagation()
                setDraggingHandle('in')
              }}
              title={`Drag IN Handle (Frame #${trimInFrame}, ${trimIn.toFixed(2)}s)`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `calc(${inPct}% - 7px)`,
                width: 14,
                background: '#10b981',
                borderRadius: '6px 0 0 6px',
                cursor: 'ew-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#052e16',
                fontWeight: 900,
                fontSize: '0.7rem',
                zIndex: 5,
                boxShadow: '0 0 8px rgba(0,0,0,0.8)',
              }}
            >
              [
            </div>

            {/* Draggable RIGHT OUT ] Handle */}
            <div
              data-handle="out"
              onMouseDown={(e) => {
                e.stopPropagation()
                setDraggingHandle('out')
              }}
              title={`Drag OUT Handle (Frame #${trimOutFrame}, ${trimOut.toFixed(2)}s)`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `calc(${outPct}% - 7px)`,
                width: 14,
                background: '#f59e0b',
                borderRadius: '0 6px 6px 0',
                cursor: 'ew-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#451a03',
                fontWeight: 900,
                fontSize: '0.7rem',
                zIndex: 5,
                boxShadow: '0 0 8px rgba(0,0,0,0.8)',
              }}
            >
              ]
            </div>

            {/* Draggable Playhead Needle */}
            <div
              data-handle="playhead"
              onMouseDown={(e) => {
                e.stopPropagation()
                setDraggingHandle('playhead')
              }}
              title={`Playhead: Frame #${currentFrame} (${currentTime.toFixed(2)}s)`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `calc(${playheadPct}% - 1.5px)`,
                width: 3,
                background: '#f43f5e',
                cursor: 'ew-resize',
                zIndex: 6,
                boxShadow: '0 0 6px rgba(244, 63, 94, 0.9)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: -5,
                  width: 13,
                  height: 11,
                  background: '#f43f5e',
                  clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                }}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
