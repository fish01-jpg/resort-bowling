import * as THREE from 'https://esm.sh/three@0.169.0';
import { LANE, PIN_SPOTS, COLORS } from './constants.js';

// ---------- procedural textures (pure canvas — no CORS/taint concerns) ----------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function woodLaneTexture() {
  const c = makeCanvas(512, 2048);
  const ctx = c.getContext('2d');
  const boards = 15;
  const bw = c.width / boards;
  for (let i = 0; i < boards; i++) {
    const t = 0.86 + Math.random() * 0.18;
    const base = [230 * t, 195 * t, 145 * t];
    ctx.fillStyle = `rgb(${base.map((v) => Math.round(v)).join(',')})`;
    ctx.fillRect(i * bw, 0, bw + 1, c.height);
    // grain streaks
    for (let g = 0; g < 22; g++) {
      ctx.fillStyle = `rgba(120,80,40,${0.03 + Math.random() * 0.05})`;
      const y = Math.random() * c.height;
      ctx.fillRect(i * bw + Math.random() * bw, y, 1 + Math.random() * 2, 30 + Math.random() * 160);
    }
  }
  // lane runs z in [approachStartZ, deckEndZ] mapped to v in [1 (near), 0 (far)]
  const zToV = (z) => 1 - (z - LANE.approachStartZ) / (LANE.deckEndZ - LANE.approachStartZ);
  // arrows: 7 chevrons at z = 4.57
  ctx.fillStyle = 'rgba(60,40,20,0.85)';
  for (let i = -3; i <= 3; i++) {
    const x = c.width / 2 + i * (bw * 2);
    const v = zToV(4.57);
    const y = v * c.height;
    ctx.beginPath();
    ctx.moveTo(x, y - 26);
    ctx.lineTo(x - 11, y + 8);
    ctx.lineTo(x + 11, y + 8);
    ctx.closePath();
    ctx.fill();
  }
  // approach dots at z = -0.4
  ctx.fillStyle = 'rgba(60,40,20,0.7)';
  for (const i of [-2, -1, 0, 1, 2]) {
    const x = c.width / 2 + i * (bw * 2.2);
    const y = zToV(-0.45) * c.height;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  // foul line
  ctx.fillStyle = 'rgba(40,30,20,0.9)';
  ctx.fillRect(0, zToV(0.02) * c.height, c.width, 5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function pinBandTexture() {
  const c = makeCanvas(64, 64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f8f6ef';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#e03a2f';
  ctx.fillRect(0, 22, 64, 7);
  ctx.fillRect(0, 34, 64, 7);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function sunsetWindowTexture() {
  const c = makeCanvas(256, 384);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#ffd9a0');
  g.addColorStop(0.45, '#ff9d6e');
  g.addColorStop(1, '#c95d7c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // sun
  ctx.fillStyle = 'rgba(255,240,200,0.9)';
  ctx.beginPath();
  ctx.arc(c.width / 2, c.height * 0.62, 54, 0, Math.PI * 2);
  ctx.fill();
  // palm silhouette
  ctx.fillStyle = 'rgba(70,30,50,0.55)';
  ctx.fillRect(c.width * 0.18, c.height * 0.45, 8, c.height * 0.4);
  for (let a = 0; a < 6; a++) {
    ctx.save();
    ctx.translate(c.width * 0.18 + 4, c.height * 0.45);
    ctx.rotate((-70 + a * 26) * Math.PI / 180);
    ctx.fillRect(0, -3, 70, 6);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function signTexture() {
  const c = makeCanvas(1024, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#12312d';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#f7f1e6';
  ctx.lineWidth = 8;
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28);
  ctx.fillStyle = '#ff6b4a';
  ctx.font = '700 110px Chillax, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SUNSET LANES', c.width / 2, c.height / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- pin profile ----------

const PIN_PROFILE = [
  [0.0, 0.0], [0.055, 0.015], [0.057, 0.12], [0.033, 0.20], [0.028, 0.26],
  [0.036, 0.30], [0.048, 0.335], [0.043, 0.365], [0.018, 0.381], [0.0, 0.381],
];

function buildPinMesh() {
  const pts = PIN_PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(pts, 24);
  const mat = new THREE.MeshStandardMaterial({
    map: pinBandTexture(),
    roughness: 0.35,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

function buildPalm() {
  const g = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#8a5a3a', roughness: 0.9 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.2, 8), trunkMat);
  trunk.position.y = 1.1;
  trunk.castShadow = true;
  g.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: '#2e7d4f', roughness: 0.8 });
  for (let i = 0; i < 6; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), leafMat);
    leaf.scale.set(1, 0.22, 0.5);
    const a = (i / 6) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.55, 2.25, Math.sin(a) * 0.55);
    leaf.rotation.y = -a;
    leaf.rotation.z = 0.35;
    leaf.castShadow = true;
    g.add(leaf);
  }
  return g;
}

// ---------- the scene ----------

export function createScene(canvasParent) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  canvasParent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 26, 60);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.5, -3.2);
  camera.lookAt(0, 0.4, 8);

  // lights
  const hemi = new THREE.HemisphereLight('#fff3e0', '#0f2e2b', 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffe3b0', 1.9);
  sun.position.set(2.5, 5.5, 2.0);
  sun.target.position.set(0, 0, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -4;
  sun.shadow.camera.right = 4;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -4;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 24;
  scene.add(sun, sun.target);

  // lane + approach — must cover the release point (z=-1.8) and the full rack
  const laneLen = LANE.deckEndZ - LANE.approachStartZ;
  const laneMat = new THREE.MeshStandardMaterial({ map: woodLaneTexture(), roughness: 0.32 });
  const lane = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.1, laneLen), laneMat);
  lane.position.set(0, -0.05, (LANE.approachStartZ + LANE.deckEndZ) / 2);
  lane.receiveShadow = true;
  scene.add(lane);

  // gutters
  const gutterMat = new THREE.MeshStandardMaterial({ color: '#3a4a4f', roughness: 0.5 });
  for (const side of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, laneLen), gutterMat);
    g.position.set(side * 0.645, LANE.gutterFloorY - 0.05, (LANE.approachStartZ + LANE.deckEndZ) / 2);
    g.receiveShadow = true;
    scene.add(g);
  }

  // pit (dark end, starts at deckEndZ)
  const pitMat = new THREE.MeshStandardMaterial({ color: '#101c1a', roughness: 1 });
  const pit = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.05, 2.4), pitMat);
  pit.position.set(0, -0.33, LANE.pitZ + 1.1);
  scene.add(pit);
  const curtain = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 1.6, 0.1),
    new THREE.MeshStandardMaterial({ color: '#12312d', roughness: 1 })
  );
  curtain.position.set(0, 0.5, LANE.pitZ + 2.3);
  scene.add(curtain);

  // sign
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.65, 0.06),
    new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.8 })
  );
  sign.position.set(0, 1.9, LANE.pitZ + 2.2);
  scene.add(sign);

  // side walls + sunset windows
  const wallMat = new THREE.MeshStandardMaterial({ color: '#bfe0d8', roughness: 0.95 });
  const winTex = sunsetWindowTexture();
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 24), wallMat);
    wall.position.set(side * 1.15, 1.2, 8);
    scene.add(wall);
    for (const z of [2, 8, 14]) {
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 1.3, 1.6),
        new THREE.MeshStandardMaterial({ map: winTex, emissive: '#ff9d6e', emissiveIntensity: 0.55, emissiveMap: winTex })
      );
      win.position.set(side * 1.09, 1.45, z);
      scene.add(win);
    }
  }

  // palms
  const palm1 = buildPalm(); palm1.position.set(-1.7, -0.1, 3);
  const palm2 = buildPalm(); palm2.position.set(1.7, -0.1, 12); palm2.scale.set(1.2, 1.2, 1.2);
  scene.add(palm1, palm2);

  // ball
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(LANE.ballRadius, 48, 32),
    new THREE.MeshPhysicalMaterial({
      color: '#0d6e75', roughness: 0.22, metalness: 0.05,
      clearcoat: 1, clearcoatRoughness: 0.15,
    })
  );
  ball.castShadow = true;
  scene.add(ball);
  // finger holes (three dark dots, child spheres)
  const holeMat = new THREE.MeshStandardMaterial({ color: '#083c42', roughness: 0.6 });
  for (const [hx, hz] of [[0, 0.05], [0.025, 0.08], [-0.025, 0.08]]) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), holeMat);
    h.position.set(hx, LANE.ballRadius * 0.86, hz);
    ball.add(h);
  }

  // pins
  const pins = PIN_SPOTS.map(() => buildPinMesh());
  pins.forEach((p) => scene.add(p));

  // sweep bar
  const sweep = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.28, 0.12),
    new THREE.MeshStandardMaterial({ color: '#ff6b4a', roughness: 0.4 })
  );
  sweep.position.set(0, 2.2, 17.9);
  sweep.castShadow = true;
  scene.add(sweep);

  // sky gradient dome (canvas texture on an inverted sphere)
  {
    const c = makeCanvas(16, 256);
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#8fcdc0');   // zenith aqua
    grad.addColorStop(0.42, '#cfe9df'); // mid sky
    grad.addColorStop(0.58, '#ffdcb2');  // warm horizon band
    grad.addColorStop(1.0, '#ffbf94');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(55, 24, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
    );
    scene.add(sky);
  }

  // aim guide — fading dots along the projected path (position + aim + hook curve)
  const aimGuide = (() => {
    const group = new THREE.Group();
    group.visible = false;
    const dots = [];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#173f3a',
        transparent: true,
        opacity: 0.55 - (i / n) * 0.45,
        depthWrite: false,
      });
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), mat);
      dot.rotation.x = -Math.PI / 2;
      dot.position.y = 0.006;
      group.add(dot);
      dots.push(dot);
    }
    scene.add(group);
    return { group, dots };
  })();

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  return { renderer, scene, camera, ball, pins, sweep, sun, aimGuide };
}
