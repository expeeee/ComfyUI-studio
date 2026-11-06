import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

interface Model3DViewerProps {
  url: string
  filename: string
}

export function Model3DViewer({ url, filename }: Model3DViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const loadedRootRef = useRef<THREE.Object3D | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRotate, setAutoRotate] = useState(true)
  const [wireframe, setWireframe] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    setLoading(true)
    setError(null)

    const width = container.clientWidth || 340
    const height = 300

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0b0f19)

    const grid = new THREE.GridHelper(4, 12, 0x334155, 0x1e293b)
    grid.position.y = -1
    scene.add(grid)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100)
    camera.position.set(2.2, 1.6, 2.6)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15

    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.3)
    scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 1.1)
    fillLight.position.set(-4, 3, -4)
    scene.add(fillLight)

    const rimLight = new THREE.DirectionalLight(0xfde68a, 0.8)
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
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const scale = 1.8 / maxDim

      obj.scale.multiplyScalar(scale)
      box.setFromObject(obj)
      box.getCenter(center)
      obj.position.sub(center)
      // Place bottom of bounding box slightly above grid
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
      const w = container.clientWidth || 340
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
  }, [url, filename])

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  useEffect(() => {
    const root = loadedRootRef.current
    if (!root) return
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m && 'wireframe' in m) {
            ;(m as THREE.MeshStandardMaterial).wireframe = wireframe
          }
        }
      }
    })
  }, [wireframe])

  const handleResetCamera = () => {
    if (controlsRef.current) {
      controlsRef.current.reset()
    }
  }

  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        background: '#0b0f19',
        position: 'relative',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: 300, cursor: 'grab' }} />

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

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.4rem 0.65rem',
          borderTop: '1px solid var(--border)',
          background: 'rgba(15, 23, 42, 0.9)',
          fontSize: '0.74rem',
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>
          Three.js Orbit Viewer • Drag to rotate, Scroll to zoom
        </span>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <button
            type="button"
            className={`chip ${autoRotate ? 'active' : ''}`}
            style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
            onClick={() => setAutoRotate((v) => !v)}
          >
            Auto-Rotate
          </button>
          <button
            type="button"
            className={`chip ${wireframe ? 'active' : ''}`}
            style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
            onClick={() => setWireframe((v) => !v)}
          >
            Wireframe
          </button>
          <button
            type="button"
            className="chip"
            style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
            onClick={handleResetCamera}
          >
            Reset View
          </button>
        </div>
      </div>
    </div>
  )
}
