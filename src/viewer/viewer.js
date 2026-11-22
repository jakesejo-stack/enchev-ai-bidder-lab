// Interactive 3D lot viewer (drag / swipe / arrow keys to rotate). Loaded lazily.
// Shows the ORIGINAL E&A concept model. TODO(approved-asset): when an approved, commercially
// licensed vehicle GLB exists, set lot.modelUrl to it — nothing else needs to change.
// Never leaves a black box: any WebGL failure, context loss or load error shows the poster image.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

function normalise(obj, length) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) obj.rotation.y = Math.PI / 2;
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  box.getSize(size);
  obj.scale.multiplyScalar(length / Math.max(size.x, size.z, 1e-6));
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= box.min.y;
  return obj;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,0.9)'); r.addColorStop(0.6, 'rgba(0,0,0,0.45)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * @param {HTMLElement} host
 * @param {{ modelUrl: string, onState?: (s: string, detail?: string) => void, reducedMotion?: boolean, maxDpr?: number }} opts
 */
export function mountViewer(host, opts) {
  const state = (s, d) => { host.dataset.viewer = s; opts.onState && opts.onState(s, d); };
  let renderer;
  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D модел на лота. Плъзни или използвай стрелките, за да го завъртиш.');
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    state('fallback', 'webgl');
    return { destroy() {} };
  }
  host.appendChild(canvas);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxDpr || 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.45, metalness: 0.3 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.003; shadow.scale.set(3.2, 5.6, 1);
  scene.add(shadow);
  scene.add(new THREE.HemisphereLight(0x9aa3b5, 0x050507, 0.35));
  const spot = (color, intensity, pos) => {
    const l = new THREE.SpotLight(color, intensity, 0, 0.5, 0.8, 2);
    l.position.set(...pos); l.target.position.set(0, 0.5, 0);
    scene.add(l, l.target);
  };
  spot(0xffffff, 300, [4, 7, 5]);
  spot(0xe53745, 520, [-6, 2.5, -4]);
  spot(0xc6d6ff, 260, [6, 3, -5]);

  const turntable = new THREE.Group();
  scene.add(turntable);
  let yaw = -0.55, velocity = 0, dragging = false, lastX = 0, lastInput = 0, visible = true, raf = 0, dirty = true, destroyed = false, lastFrame = 0;
  // Phones / low-core devices: 30 fps is plenty for a turntable and keeps the main thread free for live bids.
  const minFrameMs = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4 ? 33 : 0;

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the 4.6 m car: closer on wide frames, further on narrow ones.
    const dist = camera.aspect < 1.2 ? 8.4 : camera.aspect < 1.9 ? 7.0 : 6.3;
    camera.position.set(0, 1.45, dist);
    camera.lookAt(0, 0.5, 0);
    camera.updateProjectionMatrix();
    dirty = true; loop();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  function frame(t) {
    raf = 0;
    if (destroyed || !visible || renderer.getContext().isContextLost()) return;
    if (minFrameMs && !dragging && t - lastFrame < minFrameMs) { loop(); return; }
    lastFrame = t;
    const idle = !dragging && t - lastInput > 2500;
    if (!dragging) {
      yaw += velocity;
      velocity *= 0.93;
      if (Math.abs(velocity) < 1e-4) velocity = 0;
    }
    const auto = idle && !opts.reducedMotion;
    if (auto) yaw += 0.0025;
    turntable.rotation.y = yaw;
    renderer.render(scene, camera);
    dirty = false;
    if (auto || velocity !== 0 || dragging) loop();
  }
  function loop() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastInput = performance.now(); canvas.setPointerCapture(e.pointerId); loop(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    velocity = dx * 0.006; yaw += velocity; lastInput = performance.now(); loop();
  });
  const end = () => { dragging = false; lastInput = performance.now(); loop(); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      velocity = e.key === 'ArrowLeft' ? -0.06 : 0.06;
      lastInput = performance.now(); loop();
    }
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); state('fallback', 'context-lost'); });
  canvas.addEventListener('webglcontextrestored', () => {
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    state('ready'); dirty = true; loop();
  });
  const io = new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); if (visible) loop(); });
  io.observe(host);
  const onVis = () => { if (!document.hidden) loop(); };
  document.addEventListener('visibilitychange', onVis);

  state('loading');
  new GLTFLoader().loadAsync(opts.modelUrl).then((gltf) => {
    if (destroyed) return;
    turntable.add(normalise(gltf.scene, 4.6));
    resize();
    state('ready');
  }).catch((err) => state('fallback', 'model: ' + (err && err.message)));

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      renderer.dispose();
      canvas.remove();
    },
  };
}
