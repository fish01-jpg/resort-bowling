import * as THREE from 'https://esm.sh/three@0.169.0';
import { LANE, PIN_SPOTS, gutterCrossSection } from './constants.js';

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

/** Dusk outside the windows: deep violet sky into a burning horizon. */
function duskWindowTexture() {
  const c = makeCanvas(256, 384);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0.0, '#241444');
  g.addColorStop(0.35, '#5b2a63');
  g.addColorStop(0.62, '#c2485e');
  g.addColorStop(0.82, '#ff8c42');
  g.addColorStop(1.0, '#ffd9a0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // low sun
  ctx.fillStyle = 'rgba(255,242,204,0.95)';
  ctx.beginPath();
  ctx.arc(c.width * 0.68, c.height * 0.74, 30, 0, Math.PI * 2);
  ctx.fill();
  // cloud streaks
  ctx.fillStyle = 'rgba(60,30,70,0.45)';
  for (let i = 0; i < 5; i++) {
    const y = c.height * (0.18 + i * 0.11);
    ctx.fillRect(c.width * (0.05 + (i % 2) * 0.2), y, c.width * 0.7, 6 + i * 2);
  }
  // sea shimmer
  ctx.fillStyle = 'rgba(255,180,120,0.5)';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(c.width * Math.random() * 0.8, c.height * (0.86 + i * 0.017), 10 + Math.random() * 30, 2);
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

/** Patterned resort carpet for the approach area. */
function carpetTexture() {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1f3a38';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(247,177,103,0.35)';
  ctx.lineWidth = 3;
  for (let y = 0; y < 256; y += 64) {
    for (let x = 0; x < 256; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x + 32, y + 6);
      ctx.lineTo(x + 58, y + 32);
      ctx.lineTo(x + 32, y + 58);
      ctx.lineTo(x + 6, y + 32);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = 'rgba(14,125,134,0.5)';
      ctx.beginPath();
      ctx.arc(x + 32, y + 32, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

// ---------- pin profile ----------

const PIN_PROFILE = [
  [0.0, 0.0], [0.055, 0.015], [0.057, 0.12], [0.033, 0.20], [0.028, 0.26],
  [0.036, 0.30], [0.048, 0.335], [0.043, 0.365], [0.018, 0.381], [0.0, 0.381],
];

function buildPinMesh() {
  const pts = PIN_PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(pts, 32);
  const mat = new THREE.MeshStandardMaterial({
    map: pinBandTexture(),
    roughness: 0.32,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

// ---------- the scene ----------

export function createScene(canvasParent) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  canvasParent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a1018');
  scene.fog = new THREE.Fog('#241a20', 26, 64);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.5, -3.2);
  camera.lookAt(0, 0.4, 8);

  // ---- lights: warm lounge interior, dusk outside ----
  const hemi = new THREE.HemisphereLight('#ffd9b8', '#2b1d18', 0.5);
  scene.add(hemi);
  // low sun raking in through the windows
  const sun = new THREE.DirectionalLight('#ffb36b', 1.5);
  sun.position.set(3.2, 3.4, 4.5);
  sun.target.position.set(-0.4, 0, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -4;
  sun.shadow.camera.right = 4;
  sun.shadow.camera.top = 24;
  sun.shadow.camera.bottom = -4;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 26;
  scene.add(sun, sun.target);
  // warm downlights along the lane
  for (const z of [2, 9, 15.5]) {
    const p = new THREE.PointLight('#ffd9a0', 14, 9, 2);
    p.position.set(0, 2.7, z);
    scene.add(p);
  }
  // pin deck spot — the rack is the star of the show
  const spot = new THREE.SpotLight('#fff2dc', 60, 12, 0.5, 0.5, 1.6);
  spot.position.set(0, 2.8, 16.6);
  spot.target.position.set(0, 0.2, LANE.pinZ + 0.4);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  scene.add(spot, spot.target);

  const laneLen = LANE.deckEndZ - LANE.approachStartZ;
  const laneCz = (LANE.approachStartZ + LANE.deckEndZ) / 2;

  // ---- lane (top surface at y=0) ----
  const laneMat = new THREE.MeshStandardMaterial({ map: woodLaneTexture(), roughness: 0.28 });
  const lane = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.1, laneLen), laneMat);
  lane.position.set(0, -0.05, laneCz);
  lane.receiveShadow = true;
  scene.add(lane);

  // ---- real gutters: open half-pipe channels (rim meets the lane edge) ----
  const gutterMat = new THREE.MeshStandardMaterial({
    color: '#151d1f', roughness: 0.3, metalness: 0.45,
  });
  for (const side of [-1, 1]) {
    // a curved band: the contact arc plus material thickness OUTSIDE it, so
    // the ball rolls on exactly the surface the physics trimesh uses
    const shape = new THREE.Shape();
    const band = gutterCrossSection(side, 'band');
    band.forEach(([x, y], i) => {
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: laneLen, steps: 1, bevelEnabled: false,
    });
    const g = new THREE.Mesh(geo, gutterMat);
    g.position.z = LANE.approachStartZ;
    g.receiveShadow = true;
    scene.add(g);
  }

  // ---- division caps: raised rails from the gutter rim to the walls ----
  const capMat = new THREE.MeshStandardMaterial({ color: '#4a3423', roughness: 0.55 });
  for (const side of [-1, 1]) {
    // from the gutter lining's outer rim (0.79) to the wall base (1.10)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.2, laneLen), capMat);
    cap.position.set(side * 0.945, 0.0, laneCz);
    cap.receiveShadow = true;
    cap.castShadow = true;
    scene.add(cap);
  }

  // ---- room: side walls with dusk windows, ceiling with light coves ----
  const wallMat = new THREE.MeshStandardMaterial({ color: '#8a6350', roughness: 0.95 });
  const winTex = duskWindowTexture();
  // the shell must enclose the chase camera (which pulls back to z ≈ -4.8)
  const roomZmin = -5.75, roomZmax = 21.25;
  const roomLen = roomZmax - roomZmin, roomCz = (roomZmin + roomZmax) / 2;
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.0, roomLen), wallMat);
    wall.position.set(side * 1.275, 1.5, roomCz);
    wall.receiveShadow = true;
    scene.add(wall);
    for (const z of [1.5, 8, 14.5]) {
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 1.7, 1.9),
        new THREE.MeshStandardMaterial({ map: winTex, emissive: '#ff8c42', emissiveIntensity: 0.7, emissiveMap: winTex })
      );
      win.position.set(side * 1.09, 1.5, z);
      scene.add(win);
    }
  }
  // back wall behind the player — BEHIND the chase camera's farthest pull-back
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.0, 0.3), wallMat);
  backWall.position.set(0, 1.5, roomZmin + 0.15);
  scene.add(backWall);

  // ceiling
  const ceilMat = new THREE.MeshStandardMaterial({ color: '#241a16', roughness: 0.9 });
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.12, roomLen), ceilMat);
  ceiling.position.set(0, 3.02, roomCz);
  scene.add(ceiling);
  // light coves: warm emissive strips running down the lane
  const coveMat = new THREE.MeshBasicMaterial({ color: '#ffd9a0' });
  for (const side of [-1, 1]) {
    const cove = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, roomLen - 1), coveMat);
    cove.position.set(side * 0.85, 2.95, roomCz);
    scene.add(cove);
  }

  // carpeted approach
  const carpet = new THREE.Mesh(
    new THREE.BoxGeometry(2.9, 0.02, 1.0),
    new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.95 })
  );
  carpet.position.set(0, -0.011, -3.3);
  carpet.receiveShadow = true;
  scene.add(carpet);
  // dark base slab under everything (no voids between structures) —
  // STOPS at the deck end so it cannot bridge the pit opening
  const slabMat = new THREE.MeshStandardMaterial({ color: '#161210', roughness: 1 });
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(2.9, 0.1, LANE.deckEndZ - roomZmin),
    slabMat
  );
  slab.position.set(0, -0.36, (roomZmin + LANE.deckEndZ) / 2);
  scene.add(slab);
  // side slivers beside the pit, so the shell still has no gaps
  for (const side of [-1, 1]) {
    const sliver = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.1, roomZmax - LANE.deckEndZ),
      slabMat
    );
    sliver.position.set(side * 1.3, -0.36, (LANE.deckEndZ + roomZmax) / 2);
    scene.add(sliver);
  }

  // ---- the pit + pinsetter housing (fallen pins drop out of sight) ----
  const pitMat = new THREE.MeshStandardMaterial({ color: '#07090a', roughness: 1 });
  const pitFloor = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 2.4), pitMat);
  pitFloor.position.set(0, LANE.pitFloorY - 0.05, LANE.pitZ + 1.2);
  scene.add(pitFloor);
  for (const side of [-1, 1]) {
    const pitWall = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 2.4), pitMat);
    pitWall.position.set(side * 1.02, LANE.pitFloorY + 0.4, LANE.pitZ + 1.2);
    scene.add(pitWall);
  }
  // pinsetter housing: masks everything above the pit opening, carries the sign
  const housingMat = new THREE.MeshStandardMaterial({ color: '#12312d', roughness: 0.7, metalness: 0.15 });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(2.9, 2.45, 1.9), housingMat);
  housing.position.set(0, 1.775, LANE.pitZ + 1.1);
  housing.castShadow = true;
  scene.add(housing);
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(2.35, 0.6, 0.06),
    new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.8 })
  );
  sign.position.set(0, 2.1, LANE.pitZ + 0.13);
  scene.add(sign);

  // ---- ball ----
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(LANE.ballRadius, 48, 32),
    new THREE.MeshPhysicalMaterial({
      color: '#0d6e75', roughness: 0.18, metalness: 0.05,
      clearcoat: 1, clearcoatRoughness: 0.12,
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

  // ---- pins ----
  const pins = PIN_SPOTS.map(() => buildPinMesh());
  pins.forEach((p) => scene.add(p));

  // ---- sweep bar (pinsetter sweep: dark body, accent stripe) ----
  const sweep = new THREE.Group();
  const sweepBody = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.28, 0.12),
    new THREE.MeshStandardMaterial({ color: '#1c2b2e', roughness: 0.5, metalness: 0.2 })
  );
  sweepBody.castShadow = true;
  sweep.add(sweepBody);
  const sweepStripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.06, 0.13),
    new THREE.MeshStandardMaterial({ color: '#ff6b4a', roughness: 0.4 })
  );
  sweepStripe.position.y = 0.08;
  sweep.add(sweepStripe);
  sweep.position.set(0, 2.2, 17.9);
  scene.add(sweep);

  // ---- dusk sky dome (seen through the windows) ----
  {
    const c = makeCanvas(16, 256);
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#1d1440');
    grad.addColorStop(0.35, '#5b2a63');
    grad.addColorStop(0.6, '#c2485e');
    grad.addColorStop(0.82, '#ff8c42');
    grad.addColorStop(1.0, '#ffd9a0');
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
        color: '#ffd9a0',
        transparent: true,
        opacity: 0.75 - (i / n) * 0.55,
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
