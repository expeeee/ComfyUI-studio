import React, { useEffect, useRef, useState } from 'react'
import {
  RunOutput,
  RunRecord,
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

interface VideoStudioProps {
  runs: RunRecord[]
  defaultSegmentSeconds: number
  incomingImageForVideo?: { url: string; label: string } | null
  onSendFrameToPhotoStudio: (frameUrl: string, label: string) => void
  onRunsUpdated: () => void
}

export function VideoStudio({
  runs,
  defaultSegmentSeconds,
  incomingImageForVideo,
  onSendFrameToPhotoStudio,
  onRunsUpdated,
}: VideoStudioProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null)
  const startFrameInputRef = useRef<HTMLInputElement | null>(null)
  const endFrameInputRef = useRef<HTMLInputElement | null>(null)

  const [activeVideo, setActiveVideo] = useState<ActiveVideoItem | null>(null)
  const [videoMeta, setVideoMeta] = useState<VideoMetadata | null>(null)
  const [filmstrip, setFilmstrip] = useState<VideoFilmstripFrame[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [trimIn, setTrimIn] = useState(0)
  const [trimOut, setTrimOut] = useState(5)

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

  // Segmented Batch Upscale / I2V state
  const [chunkSeconds, setChunkSeconds] = useState<number>(defaultSegmentSeconds || 10)
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

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
    .slice(0, 12)

  // Auto-select most recent video if none selected
  useEffect(() => {
    if (!activeVideo && recentVideos.length > 0) {
      setActiveVideo(recentVideos[0])
    }
  }, [recentVideos.length])

  // If an image was sent from Photo Studio, load it as Start Frame for I2V / FLF2V
  useEffect(() => {
    if (incomingImageForVideo) {
      setFlfStartB64(incomingImageForVideo.url)
      setFlfStartLabel(incomingImageForVideo.label)
      setBusyMessage(
        `Loaded "${incomingImageForVideo.label}" from Photo Studio as Start Frame! You can animate it below.`,
      )
    }
  }, [incomingImageForVideo])

  // Probe video metadata and filmstrip via FFmpeg/FFprobe whenever activeVideo changes
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
      count: '8',
    })
    fetch(`/api/video/filmstrip?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        if (data.meta) {
          setVideoMeta(data.meta)
          setTrimIn(0)
          setTrimOut(data.meta.duration || 5)
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
            setBusyMessage(`Completed: ${run.template_title}`)
          } else {
            setBusyMessage(`Run finished (${run.template_title})`)
          }
        } else if (run.status === 'failed' || run.status === 'cancelled') {
          clearInterval(timer)
          setActiveRunId(null)
          setBusyMessage(`Video run ${run.status}: ${run.error || 'Unknown error'}`)
        }
      } catch {
        // ignore transient polling errors
      }
    }, 1500)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [activeRunId, onRunsUpdated])

  const handleUploadVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusyMessage(`Uploading ${file.name}...`)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/assets/upload', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Upload failed')
      const fname = data.name || file.name
      const qs = new URLSearchParams({ filename: fname, subfolder: '', type: 'input' })
      setActiveVideo({
        filename: fname,
        subfolder: '',
        type: 'input',
        url: `/api/view?${qs.toString()}`,
        title: `Uploaded: ${fname}`,
      })
      setBusyMessage(`Loaded ${fname} into Video Studio`)
    } catch (err) {
      setBusyMessage(`Video upload error: ${String(err)}`)
    }
  }

  const stepFrame = (deltaFrames: number) => {
    const v = videoRef.current
    if (!v) return
    const fps = videoMeta?.fps || 24
    const nextTime = Math.max(
      0,
      Math.min(v.duration || 9999, v.currentTime + deltaFrames * (1 / fps)),
    )
    v.pause()
    v.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const handleCaptureFrameToPhotoStudio = async (targetTs?: number | 'last') => {
    if (!activeVideo) return
    const ts = targetTs ?? currentTime
    setBusyMessage(`Extracting lossless PNG frame via FFmpeg at ${ts === 'last' ? 'end' : `${ts.toFixed(2)}s`}...`)
    try {
      const res = await fetch('/api/video/extract-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeVideo.filename,
          subfolder: activeVideo.subfolder,
          type: activeVideo.type,
          timestamp: ts,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Frame extraction failed')
      onSendFrameToPhotoStudio(
        data.url,
        `Frame @ ${data.timestamp}s (${activeVideo.filename})`,
      )
    } catch (err) {
      setBusyMessage(`Frame extraction failed: ${String(err)}`)
    }
  }

  const handleSetFrameAsFLFEndpoint = async (which: 'start' | 'end') => {
    if (!activeVideo) return
    setBusyMessage(`Extracting current frame as ${which.toUpperCase()} frame via FFmpeg...`)
    try {
      const res = await fetch('/api/video/extract-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeVideo.filename,
          subfolder: activeVideo.subfolder,
          type: activeVideo.type,
          timestamp: currentTime,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Frame extract failed')
      if (which === 'start') {
        setFlfStartB64(data.url)
        setFlfStartLabel(`${activeVideo.filename} @ ${data.timestamp}s`)
      } else {
        setFlfEndB64(data.url)
        setFlfEndLabel(`${activeVideo.filename} @ ${data.timestamp}s`)
      }
      setBusyMessage(`Set ${which.toUpperCase()} frame to ${data.filename}`)
    } catch (err) {
      setBusyMessage(`Failed to extract frame: ${String(err)}`)
    }
  }

  const handleTrimClip = async () => {
    if (!activeVideo) return
    setBusyMessage(`Trimming clip [${trimIn.toFixed(2)}s → ${trimOut.toFixed(2)}s] with FFmpeg...`)
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
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Trim failed')
      const trimmedItem: ActiveVideoItem = {
        filename: data.filename,
        subfolder: '',
        type: 'output',
        url: data.url,
        title: `Trimmed (${trimIn.toFixed(1)}s–${trimOut.toFixed(1)}s)`,
      }
      setActiveVideo(trimmedItem)
      setBusyMessage(`Trimmed clip saved: ${data.filename}`)
    } catch (err) {
      setBusyMessage(`FFmpeg trim failed: ${String(err)}`)
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
      const stitchedItem: ActiveVideoItem = {
        filename: data.filename,
        subfolder: '',
        type: 'output',
        url: data.url,
        title: `Stitched (${stitchTray.length} clips)`,
      }
      setActiveVideo(stitchedItem)
      setBusyMessage(`Stitched video ready: ${data.filename}`)
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

      // Add current video to stitch tray automatically so user can 1-click stitch when done
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
        // If it's a /api/view?filename=... URL, parse filename
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

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '310px 1fr 350px',
        height: 'calc(100vh - 58px)',
        overflow: 'hidden',
        background: 'var(--bg-main)',
      }}
    >
      {/* LEFT PANEL: Video Sources, FFmpeg Trim & Stitch Tray */}
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          padding: '0.85rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9rem',
          overflowY: 'auto',
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
            1. Video Clip Library
          </div>
          <input
            ref={videoUploadInputRef}
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={handleUploadVideoFile}
          />
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', fontSize: '0.78rem' }}
            onClick={() => videoUploadInputRef.current?.click()}
          >
            📂 Open Video File (MP4/WebM/MOV)
          </button>

          {recentVideos.length > 0 && (
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Recent Generated Clips:
              </div>
              {recentVideos.map((v, idx) => (
                <div
                  key={`${v.filename}-${idx}`}
                  onClick={() => setActiveVideo(v)}
                  style={{
                    padding: '0.4rem 0.55rem',
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
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 190,
                    }}
                  >
                    🎬 {v.title}
                  </span>
                  <button
                    type="button"
                    className="chip"
                    style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setStitchTray((prev) => [...prev, v])
                    }}
                    title="Add to FFmpeg Stitch Tray"
                  >
                    + Stitch
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* FFmpeg Trim Section */}
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
          <div style={{ fontWeight: 700 }}>✂️ FFmpeg Clip Trimmer</div>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <label style={{ flex: 1 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>In (s)</span>
              <input
                type="number"
                step={0.1}
                min={0}
                value={trimIn}
                onChange={(e) => setTrimIn(Number(e.target.value))}
                className="search-input"
                style={{ width: '100%', padding: '0.25rem 0.4rem', fontSize: '0.74rem' }}
              />
            </label>
            <label style={{ flex: 1 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>Out (s)</span>
              <input
                type="number"
                step={0.1}
                min={0.1}
                value={trimOut}
                onChange={(e) => setTrimOut(Number(e.target.value))}
                className="search-input"
                style={{ width: '100%', padding: '0.25rem 0.4rem', fontSize: '0.74rem' }}
              />
            </label>
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
            className="btn"
            style={{ fontSize: '0.75rem' }}
            onClick={handleTrimClip}
            disabled={!activeVideo}
          >
            ✂️ Trim Clip with FFmpeg
          </button>
        </div>

        {/* FFmpeg Multi-Clip Stitch Tray */}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>🔗 FFmpeg Stitch Queue ({stitchTray.length})</span>
            {activeVideo && (
              <button
                type="button"
                className="chip"
                style={{ fontSize: '0.66rem', padding: '0.1rem 0.4rem' }}
                onClick={() => setStitchTray((prev) => [...prev, activeVideo])}
              >
                + Add Current
              </button>
            )}
          </div>
          {stitchTray.length === 0 ? (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              Add 2 or more clips to concatenate them into one seamless MP4.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {stitchTray.map((c, idx) => (
                <div
                  key={`${c.filename}-${idx}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '0.7rem',
                    padding: '0.2rem 0.4rem',
                    background: 'rgba(30, 41, 59, 0.7)',
                    borderRadius: 4,
                  }}
                >
                  <span>
                    {idx + 1}. {c.filename}
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
                style={{ fontSize: '0.74rem', marginTop: 4 }}
                onClick={handleStitchClips}
                disabled={stitchTray.length < 2}
              >
                🔗 Stitch {stitchTray.length} Clips into MP4
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* CENTER WORKSPACE: Video Player, Frame Scrubber & FFmpeg Filmstrip */}
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#070a12',
        }}
      >
        {/* Top Metadata & Frame Capture Toolbar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.55rem 0.9rem',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            fontSize: '0.76rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontWeight: 700 }}>
              {activeVideo ? activeVideo.title : 'No Video Selected'}
            </span>
            {videoMeta && (
              <span
                style={{
                  fontSize: '0.7rem',
                  color: '#a5b4fc',
                  background: 'rgba(99, 102, 241, 0.15)',
                  padding: '0.12rem 0.5rem',
                  borderRadius: 999,
                }}
              >
                {videoMeta.width}×{videoMeta.height} • {videoMeta.fps} fps • {videoMeta.duration}s (
                {videoMeta.frame_count} frames)
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <button
              type="button"
              className="chip"
              onClick={() => stepFrame(-1)}
              disabled={!activeVideo}
              title="Step Back 1 Frame"
            >
              ⏮ -1f
            </button>
            <span style={{ fontSize: '0.72rem', minWidth: 52, textAlign: 'center' }}>
              {currentTime.toFixed(2)}s
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => stepFrame(1)}
              disabled={!activeVideo}
              title="Step Forward 1 Frame"
            >
              +1f ⏭
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: '0.74rem', padding: '0.25rem 0.65rem' }}
              onClick={() => handleCaptureFrameToPhotoStudio()}
              disabled={!activeVideo}
              title="Extract lossless PNG via FFmpeg and open in Photo Studio for editing or 3D"
            >
              📸 Capture Frame to Photo Studio
            </button>
          </div>
        </div>

        {busyMessage && (
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

        {/* Video Viewport */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            overflow: 'hidden',
          }}
        >
          {activeVideo ? (
            <video
              ref={videoRef}
              src={activeVideo.url}
              controls
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              style={{
                maxWidth: '100%',
                maxHeight: '62vh',
                borderRadius: 10,
                boxShadow: '0 14px 40px rgba(0,0,0,0.65)',
                border: '1px solid #334155',
                background: '#000',
              }}
            />
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
                Open an MP4/WebM file on the left, select a recent video generation, or animate a
                frame from Photo Studio on the right!
              </div>
            </div>
          )}
        </div>

        {/* Bottom FFmpeg Visual Filmstrip Scrubber */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: '0.55rem 0.9rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.7rem',
              color: 'var(--text-muted)',
            }}
          >
            <span>FFmpeg Timeline Filmstrip (Click any frame to jump playhead)</span>
            {activeVideo && (
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.66rem', padding: '0.1rem 0.4rem' }}
                  onClick={() => handleSetFrameAsFLFEndpoint('start')}
                >
                  Set Playhead as Start Frame
                </button>
                <button
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.66rem', padding: '0.1rem 0.4rem' }}
                  onClick={() => handleSetFrameAsFLFEndpoint('end')}
                >
                  Set Playhead as End Frame
                </button>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', minHeight: 58 }}>
            {filmstrip.map((f) => (
              <div
                key={f.index}
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = f.timestamp
                    setCurrentTime(f.timestamp)
                  }
                }}
                style={{
                  position: 'relative',
                  cursor: 'pointer',
                  borderRadius: 6,
                  overflow: 'hidden',
                  border:
                    Math.abs(currentTime - f.timestamp) < 0.45
                      ? '2px solid #6366f1'
                      : '1px solid var(--border)',
                  flexShrink: 0,
                }}
              >
                <img
                  src={f.data_url}
                  alt={`t=${f.timestamp}s`}
                  style={{ width: 92, height: 54, objectFit: 'cover', display: 'block' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    bottom: 2,
                    right: 4,
                    fontSize: '0.62rem',
                    background: 'rgba(0,0,0,0.7)',
                    padding: '0 4px',
                    borderRadius: 3,
                  }}
                >
                  {f.timestamp}s
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* RIGHT PANEL: AI Video Continuation & First-to-Last Frame Studio */}
      <aside
        style={{
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          padding: '0.85rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9rem',
          overflowY: 'auto',
        }}
      >
        {/* AI Video Continuation */}
        <div
          style={{
            padding: '0.7rem',
            borderRadius: 8,
            background: 'rgba(15, 23, 42, 0.65)',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            fontSize: '0.75rem',
          }}
        >
          <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
            ⏩ AI Video Continuation (Extend Clip)
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Uses FFmpeg (`-sseof`) to extract the exact final frame of the current video and
            generates a seamless continuation clip in ComfyUI.
          </div>
          <select
            value={continuationModel}
            onChange={(e) => setContinuationModel(e.target.value as any)}
            style={{
              background: 'var(--bg-main)',
              color: 'var(--text-main)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '0.3rem 0.45rem',
              fontSize: '0.73rem',
            }}
          >
            <option value="video_minimax_h3_i2v_continuation">
              MiniMax H3: Video Continuation (Ready)
            </option>
            <option value="video_wan2_2_14B_i2v">Wan 2.2 14B: Image to Video (Ready)</option>
          </select>
          <textarea
            rows={2}
            className="search-input"
            value={continuationPrompt}
            onChange={(e) => setContinuationPrompt(e.target.value)}
            placeholder="Describe what happens next..."
            style={{ fontSize: '0.74rem', resize: 'vertical' }}
          />
          <button
            type="button"
            className="btn btn-primary"
            style={{ fontSize: '0.76rem' }}
            onClick={handleRunVideoContinuation}
            disabled={!activeVideo || Boolean(activeRunId)}
          >
            ⏩ Extend Video from Final Frame
          </button>
        </div>

        {/* First-to-Last Frame Bridge / Image-to-Video */}
        <div
          style={{
            padding: '0.7rem',
            borderRadius: 8,
            background: 'rgba(30, 41, 59, 0.55)',
            border: '1px solid rgba(99, 102, 241, 0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            fontSize: '0.75rem',
          }}
        >
          <div style={{ fontWeight: 700, color: '#a5b4fc' }}>
            🌉 First-to-Last Frame & Photo Animation
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            Provide a Start Frame (and optional End Frame) to run{' '}
            <strong>Wan 2.2 14B First-Last Frame to Video</strong> (`video_wan2_2_14B_flf2v`).
          </div>

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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
            <div
              style={{
                padding: '0.4rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'rgba(15, 23, 42, 0.7)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.68rem', fontWeight: 600, marginBottom: 4 }}>
                Start Frame
              </div>
              {flfStartB64 ? (
                <img
                  src={flfStartB64}
                  alt="Start"
                  style={{
                    width: '100%',
                    height: 68,
                    objectFit: 'cover',
                    borderRadius: 4,
                    marginBottom: 4,
                  }}
                />
              ) : (
                <div
                  style={{
                    height: 68,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '0.68rem',
                  }}
                >
                  Empty
                </div>
              )}
              <button
                type="button"
                className="chip"
                style={{ width: '100%', fontSize: '0.68rem' }}
                onClick={() => startFrameInputRef.current?.click()}
              >
                {flfStartB64 ? 'Change Start' : '+ Load Start'}
              </button>
            </div>

            <div
              style={{
                padding: '0.4rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'rgba(15, 23, 42, 0.7)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.68rem', fontWeight: 600, marginBottom: 4 }}>
                End Frame (Optional)
              </div>
              {flfEndB64 ? (
                <img
                  src={flfEndB64}
                  alt="End"
                  style={{
                    width: '100%',
                    height: 68,
                    objectFit: 'cover',
                    borderRadius: 4,
                    marginBottom: 4,
                  }}
                />
              ) : (
                <div
                  style={{
                    height: 68,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '0.68rem',
                  }}
                >
                  Single I2V Mode
                </div>
              )}
              <div style={{ display: 'flex', gap: 3 }}>
                <button
                  type="button"
                  className="chip"
                  style={{ flex: 1, fontSize: '0.68rem' }}
                  onClick={() => endFrameInputRef.current?.click()}
                >
                  {flfEndB64 ? 'Change' : '+ End'}
                </button>
                {flfEndB64 && (
                  <button
                    type="button"
                    className="chip"
                    style={{ fontSize: '0.68rem' }}
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
            style={{ fontSize: '0.74rem', resize: 'vertical' }}
          />
          <button
            type="button"
            className="btn btn-primary"
            style={{ fontSize: '0.76rem' }}
            onClick={handleRunFirstLastFrameBridge}
            disabled={!flfStartB64 || Boolean(activeRunId)}
          >
            {flfEndB64
              ? '🌉 Generate First-to-Last Frame Video'
              : '🎬 Animate Start Frame (Wan 2.2 14B)'}
          </button>
        </div>

        {/* Segmented Chunk Info */}
        <div
          style={{
            padding: '0.65rem',
            borderRadius: 8,
            background: 'rgba(15, 23, 42, 0.65)',
            border: '1px solid var(--border)',
            fontSize: '0.73rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
          }}
        >
          <div style={{ fontWeight: 700 }}>🎞️ FFmpeg Segmented Batch Settings</div>
          <label style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Chunk Size for Long Videos:</span>
            <span>{chunkSeconds}s</span>
          </label>
          <input
            type="range"
            min={4}
            max={30}
            step={2}
            value={chunkSeconds}
            onChange={(e) => setChunkSeconds(Number(e.target.value))}
          />
          <div style={{ fontSize: '0.69rem', color: 'var(--text-muted)' }}>
            Long video workflows automatically split into {chunkSeconds}s chunks with FFmpeg and
            stitch the upscaled outputs seamlessly.
          </div>
        </div>
      </aside>
    </div>
  )
}
