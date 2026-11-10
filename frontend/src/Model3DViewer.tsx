import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

interface Model3DViewerProps {
  url: string
  filename: string
  height?: number
  textureCandidateUrl?: string | null
  onCaptureRenderToCanvas?: (dataUrl: string, label: string) => void
}

const MATERIAL_PRESETS = [
  { id: 'original', label: 'Original', color: '#ffffff', roughness: 0.45, metalness: 0.1 },
  { id: 'clay', label: 'Studio Clay', color: '#cbd5e1', roughness: 0.65, metalness: 0.05 },
  { id: 'gold', label: 'Gold Armor', color: '#fbbf24', roughness: 0.22, metalness: 0.88 },
  { id: 'bronze', label: 'Antique Bronze', color: '#d97706', roughness: 0.35, metalness: 0.78 },
  { id: 'jade', label: 'Polished Jade', color: '#10b981', roughness: 0.18, metalness: 0.15 },
  { id: 'crimson', label: 'Crimson Matte', color: '#ef4444', roughness: 0.5, metalness: 0.2 },
  { id: 'obsidian', label: 'Obsidian', color: '#334155', roughness: 0.15, metalness: 0.65 },
]

function ensureBoxUVs(geometry: THREE.BufferGeometry) {
  if (geometry.hasAttribute('uv')) return
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) return
  const size = new THREE.Vector3()
  box.getSize(size)
  const pos = geometry.getAttribute('position')
  const norm = geometry.getAttribute('normal')
  if (!pos) return
  const uvs = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = (pos.getX(i) - box.min.x) / (size.x || 1)
    const y = (pos.getY(i) - box.min.y) / (size.y || 1)
    const z = (pos.getZ(i) - box.min.z) / (size.z || 1)
    if (norm) {
      const nx = Math.abs(norm.getX(i))
      const ny = Math.abs(norm.getY(i))
      const nz = Math.abs(norm.getZ(i))
      if (nz >= nx && nz >= ny) {
        uvs[i * 2] = x
        uvs[i * 2 + 1] = y
      } else if (nx >= ny) {
        uvs[i * 2] = z
        uvs[i * 2 + 1] = y
      } else {
        uvs[i * 2] = x
        uvs[i * 2 + 1] = z
      }
    } else {
      uvs[i * 2] = x
      uvs[i * 2 + 1] = y
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
}

export function Model3DViewer({
  url,
  filename,
  height = 320,
  textureCandidateUrl,
  onCaptureRenderToCanvas,
}: Model3DViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const loadedRootRef = useRef<THREE.Object3D | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRotate, setAutoRotate] = useState(true)
  const [wireframe, setWireframe] = useState(false)

  const [activePreset, setActivePreset] = useState('original')
  const [tintColor, setTintColor] = useState('#ffffff')
  const [roughness, setRoughness] = useState(0.45)
  const [metalness, setMetalness] = useState(0.1)
  const [bgColor, setBgColor] = useState('#0b0f19')
  const [appliedTexture, setAppliedTexture] = useState(false)
  const [exportingGlb, setExportingGlb] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    setLoading(true)
    setError(null)
    setAppliedTexture(false)

    const width = container.clientWidth || 360

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(bgColor)
    sceneRef.current = scene

    const grid = new THREE.GridHelper(4, 12, 0x334155, 0x1e293b)
    grid.position.y = -1
    grid.name = '__studio_grid__'
    scene.add(grid)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100)
    camera.position.set(2.2, 1.5, 2.5)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: true,
    })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18
    rendererRef.current = renderer

    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.35)
    scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.3)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 1.15)
    fillLight.position.set(-4, 3, -4)
    scene.add(fillLight)

    const rimLight = new THREE.DirectionalLight(0xfde68a, 0.85)
    rimLight.position.set(0, -4, 3)
    scene.add(rimLight)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.autoRotate = autoRotate
    controls.autoRotateSpeed = 1.6
    controlsRef.current = controls

    let disposed = false
    const ext = filename.toLowerCase().split('.').pop() || 'glb'

    const fitAndAddObject = (obj: THREE.Object3D) => {
      if (disposed) return
      obj.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh
          if (mesh.geometry) {
            mesh.geometry.computeVertexNormals()
            ensureBoxUVs(mesh.geometry)
          }
          if (!mesh.material) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              roughness: 0.45,
              metalness: 0.1,
            })
          }
        }
      })

      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const scale = 1.8 / maxDim

      obj.scale.multiplyScalar(scale)
      box.setFromObject(obj)
      box.getCenter(center)
      obj.position.sub(center)
      box.setFromObject(obj)
      grid.position.y = box.min.y - 0.02

      scene.add(obj)
      loadedRootRef.current = obj
      setLoading(false)
    }

    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader()
      loader.load(
        url,
        (gltf) => fitAndAddObject(gltf.scene),
        undefined,
        (err) => {
          if (!disposed) {
            setError(`Failed to load GLB/GLTF: ${String(err)}`)
            setLoading(false)
          }
        },
      )
    } else if (ext === 'obj') {
      const loader = new OBJLoader()
      loader.load(
        url,
        (obj) => fitAndAddObject(obj),
        undefined,
        (err) => {
          if (!disposed) {
            setError(`Failed to load OBJ: ${String(err)}`)
            setLoading(false)
          }
        },
      )
    } else if (ext === 'ply') {
      const loader = new PLYLoader()
      loader.load(
        url,
        (geometry) => {
          geometry.computeVertexNormals()
          ensureBoxUVs(geometry)
          const hasVertexColors = geometry.hasAttribute('color')
          const material = new THREE.MeshStandardMaterial({
            color: hasVertexColors ? 0xffffff : 0x94a3b8,
            vertexColors: hasVertexColors,
            roughness: 0.45,
            metalness: 0.1,
          })
          const mesh = new THREE.Mesh(geometry, material)
          fitAndAddObject(mesh)
        },
        undefined,
        (err) => {
          if (!disposed) {
            setError(`Failed to load PLY: ${String(err)}`)
            setLoading(false)
          }
        },
      )
    } else {
      setError(`Preview not supported for .${ext} files — use Download below`)
      setLoading(false)
    }

    let animId = 0
    const animate = () => {
      if (disposed) return
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const handleResize = () => {
      if (!container || disposed) return
      const w = container.clientWidth || 360
      camera.aspect = w / height
      camera.updateProjectionMatrix()
      renderer.setSize(w, height)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      disposed = true
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', handleResize)
      controls.dispose()
      renderer.dispose()
    }
  }, [url, filename, height])

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(bgColor)
    }
  }, [bgColor])

  useEffect(() => {
    const root = loadedRootRef.current
    if (!root) return
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m && 'wireframe' in m) {
            const std = m as THREE.MeshStandardMaterial
            std.wireframe = wireframe
            if ('color' in std && activePreset !== 'original') {
              std.color.set(tintColor)
            }
            if ('roughness' in std) std.roughness = roughness
            if ('metalness' in std) std.metalness = metalness
            std.needsUpdate = true
          }
        }
      }
    })
  }, [wireframe, tintColor, roughness, metalness, activePreset])

  const applyMaterialPreset = (presetId: string) => {
    const p = MATERIAL_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    setActivePreset(p.id)
    setTintColor(p.color)
    setRoughness(p.roughness)
    setMetalness(p.metalness)
  }

  const handleApplyCanvasTexture = (texUrl: string) => {
    const root = loadedRootRef.current
    if (!root || !texUrl) return
    const loader = new THREE.TextureLoader()
    loader.load(texUrl, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.needsUpdate = true

      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh
          if (mesh.geometry) ensureBoxUVs(mesh.geometry)
          mesh.material = new THREE.MeshStandardMaterial({
            map: texture,
            color: new THREE.Color(tintColor),
            roughness,
            metalness,
            wireframe,
          })
        }
      })
      setAppliedTexture(true)
    })
  }

  const handleCaptureToCanvas = () => {
    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!renderer || !scene || !camera || !onCaptureRenderToCanvas) return

    // Temporarily hide grid so the captured 3D render is clean
    const grid = scene.getObjectByName('__studio_grid__')
    const prevVis = grid ? grid.visible : true
    if (grid) grid.visible = false
    renderer.render(scene, camera)
    const dataUrl = renderer.domElement.toDataURL('image/png')
    if (grid) grid.visible = prevVis
    renderer.render(scene, camera)

    onCaptureRenderToCanvas(dataUrl, `3D Render (${activePreset})`)
  }

  const handleExportTexturedGLB = () => {
    const root = loadedRootRef.current
    if (!root) return
    setExportingGlb(true)
    const exporter = new GLTFExporter()
    exporter.parse(
      root,
      (result) => {
        setExportingGlb(false)
        const blob =
          result instanceof ArrayBuffer
            ? new Blob([result], { type: 'model/gltf-binary' })
            : new Blob([JSON.stringify(result)], { type: 'application/json' })
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        const stem = filename.replace(/\.[^/.]+$/, '')
        link.download = `${stem}_${activePreset}.glb`
        link.click()
      },
      (err) => {
        setExportingGlb(false)
        setError(`GLB export failed: ${String(err)}`)
      },
      { binary: true },
    )
  }

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        background: '#0b0f19',
        position: 'relative',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height, cursor: 'grab' }} />

      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(11, 15, 25, 0.75)',
            fontSize: '0.82rem',
            color: 'var(--text-muted)',
          }}
        >
          Loading 3D mesh ({filename})...
        </div>
      )}

      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            textAlign: 'center',
            background: 'rgba(11, 15, 25, 0.9)',
            fontSize: '0.8rem',
            color: '#fca5a5',
          }}
        >
          <div style={{ fontSize: '1.4rem', marginBottom: '0.3rem' }}>🧊</div>
          <div>{error}</div>
        </div>
      )}

      {/* Interactive Material, Color & Texture Bar */}
      <div
        style={{
          padding: '0.55rem 0.7rem',
          borderTop: '1px solid var(--border)',
          background: 'rgba(15, 23, 42, 0.95)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem',
          fontSize: '0.74rem',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 2 }}>
            Material:
          </span>
          {MATERIAL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip ${activePreset === p.id ? 'active' : ''}`}
              style={{ padding: '0.15rem 0.45rem', fontSize: '0.68rem' }}
              onClick={() => applyMaterialPreset(p.id)}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: p.color,
                  marginRight: 4,
                }}
              />
              {p.label}
            </button>
          ))}
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 4,
              cursor: 'pointer',
            }}
            title="Custom 3D Base Color"
          >
            <input
              type="color"
              value={tintColor}
              onChange={(e) => {
                setActivePreset('custom')
                setTintColor(e.target.value)
              }}
              style={{ width: 20, height: 20, border: 'none', padding: 0, background: 'none' }}
            />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>Color</span>
          </label>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 4,
              cursor: 'pointer',
            }}
            title="3D Viewport Backdrop Color"
          >
            <input
              type="color"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              style={{ width: 20, height: 20, border: 'none', padding: 0, background: 'none' }}
            />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>Backdrop</span>
          </label>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Rough:</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={roughness}
                onChange={(e) => setRoughness(Number(e.target.value))}
                style={{ width: 65 }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Metal:</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={metalness}
                onChange={(e) => setMetalness(Number(e.target.value))}
                style={{ width: 65 }}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {textureCandidateUrl && (
              <button
                type="button"
                className={`chip ${appliedTexture ? 'active' : ''}`}
                style={{ padding: '0.18rem 0.5rem', fontSize: '0.7rem' }}
                onClick={() => handleApplyCanvasTexture(textureCandidateUrl)}
                title="Wrap the current Photo Studio canvas image onto this 3D mesh"
              >
                🎨 Wrap Canvas Texture
              </button>
            )}
            {onCaptureRenderToCanvas && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
                onClick={handleCaptureToCanvas}
                title="Capture the current 3D view & lighting as a new Photo Studio layer"
              >
                📸 Send 3D Render to Canvas
              </button>
            )}
            <button
              type="button"
              className="chip"
              style={{ padding: '0.18rem 0.5rem', fontSize: '0.7rem' }}
              onClick={handleExportTexturedGLB}
              disabled={exportingGlb}
            >
              {exportingGlb ? 'Exporting...' : '⬇ Export Textured .GLB'}
            </button>
            <button
              type="button"
              className={`chip ${autoRotate ? 'active' : ''}`}
              style={{ padding: '0.18rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() => setAutoRotate((v) => !v)}
            >
              Auto-Rotate
            </button>
            <button
              type="button"
              className={`chip ${wireframe ? 'active' : ''}`}
              style={{ padding: '0.18rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() => setWireframe((v) => !v)}
            >
              Wireframe
            </button>
            <button
              type="button"
              className="chip"
              style={{ padding: '0.18rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() => controlsRef.current?.reset()}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
