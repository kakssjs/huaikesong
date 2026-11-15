/**
 * Plan story renderer: a floor plan seen straight down like a drawing, raised into the furnished
 * 3D model, then walked through by a circulation line.
 *
 * Used by app/components/PlanStory.tsx, on the home page (driven by scroll) and while Agnes generates
 * renders (driven by time). Walls, openings and furniture come from Scene3D's own builders, so the
 * model is the one the project page shows for the same plan. This module pulls in three.js and is
 * only loaded on demand.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PlanGeometry, Wall } from '@i-renovation/shared/plan';
import { getMaterialPreset, type MaterialPresetId } from '@i-renovation/shared/materials';
import { addFurniture, addWall, makeMaterials } from '@/app/components/Scene3D';

/** One moment of the story. Every value runs from 0 to 1 except `spin`. */
export interface StoryFrame {
  /** Camera: 0 straight down on the drawing, 1 three-quarter view. */
  tilt: number;
  /** Walls and base grow up; outer walls lead. */
  rise: number;
  /** Floor colour: 0 the drawing tint, 1 the finished floor. */
  finish: number;
  /** Rooms are furnished one after another, largest first. */
  furnish: number;
  /** The circulation route is drawn, branch after branch. */
  route: number;
  /** Extra turn of the model in radians (idle sway). */
  spin: number;
}

/** How the flat drawing sits in the stage: CSS size, pixels per metre, plan point at the centre. */
export interface StoryView { width: number; height: number; ppm: number; cx: number; cy: number }

export interface StorySceneOptions {
  /** Margin of the drawing sheet around the plan (m). The base starts this size and tightens as it rises. */
  sheet: number;
  /** Drawing tint of each room, in plan.rooms order; floors start in these colours. */
  fills: string[];
  /** Circulation polylines in plan metres [x, y], drawn in this order. */
  routes?: [number, number][][];
  presetId?: MaterialPresetId;
  /** Smaller screens: lower pixel ratio and shadow resolution. */
  lite?: boolean;
  onContextLost?: () => void;
}

export interface StoryScene {
  resize(view: StoryView): void;
  /** Applies the frame and draws it. `time` (ms) moves the route lights once the route is complete. */
  render(frame: StoryFrame, time: number): void;
  /** Plan point (metres, y = height) to CSS pixels in the stage, for the last drawn frame. */
  project(x: number, y: number, z: number): [number, number];
  /** True while route lights are moving, so the stage keeps drawing frames. */
  animating(): boolean;
  dispose(): void;
}

const BASE_H = 0.32;           // base thickness (m)
const BASE_MARGIN = 0.5;       // base margin around the plan once raised (m)
const CUT = 1.15;              // outer walls facing the camera are cut at this height, like a plan section (m)
const ROUTE_Y = 0.2;           // route height: above the floor slabs and rugs (m)
const PHI_TOP = 0.001;         // camera angle from vertical: straight down
const PHI_3D = 0.72;           // three-quarter view
const THETA_TOP = Math.PI / 2; // camera south of the plan: plan north at the top of the screen, as in the drawing
const THETA_3D = Math.PI / 2 + 0.6; // swung toward the south-west corner
const DIST = 80;
const RADIAL = 6;
const WET = /卫|浴|洗手|厨|阳台|露台/;
const PASSAGE = /走廊|过道|走道|通道/;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const seg = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,247,230,1)');
  g.addColorStop(0.28, 'rgba(244,214,162,.8)');
  g.addColorStop(1, 'rgba(232,196,138,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createStoryScene(host: HTMLElement, plan: PlanGeometry, opts: StorySceneOptions): StoryScene {
  const preset = getMaterialPreset(opts.presetId ?? 'quiet-luxury');
  const materials = makeMaterials(preset);
  const W = plan.width;
  const D = plan.depth;
  const span = Math.max(W, D);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lite ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in this three.js; radius softens instead
  renderer.shadowMap.autoUpdate = false;        // shadows only change when walls or furniture move
  const canvas = renderer.domElement;
  host.appendChild(canvas);
  let lost = false;
  const onLost = (event: Event) => { event.preventDefault(); lost = true; opts.onContextLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  const scene = new THREE.Scene();
  // The model (with its light) turns around the plan centre for the idle sway; the camera stays put,
  // so the shadows do not need recomputing while it turns.
  const pivot = new THREE.Group();
  pivot.position.set(W / 2, 0, D / 2);
  scene.add(pivot);
  const model = new THREE.Group();
  model.position.set(-W / 2, 0, -D / 2);
  pivot.add(model);

  scene.add(new THREE.AmbientLight(preset.light.ambient, preset.light.ambientIntensity * 0.75));
  scene.add(new THREE.HemisphereLight('#ffffff', preset.background, 0.55));
  const sun = new THREE.DirectionalLight(new THREE.Color(preset.light.sun).lerp(new THREE.Color('#ffffff'), 0.6), preset.light.sunIntensity);
  // Key light from the camera's left: the faces in view are lit and shadows fall away from the viewer.
  sun.position.set(W / 2 - span * 0.75, span * 1.5, D / 2 + span * 0.35);
  sun.target.position.set(W / 2, 0, D / 2);
  sun.castShadow = true;
  const reach = span * 0.75 + opts.sheet + 1;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: span * 4 });
  sun.shadow.mapSize.set(opts.lite ? 1024 : 2048, opts.lite ? 1024 : 2048);
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  model.add(sun, sun.target);

  // Soft shadow of the base on the page; the plane itself is invisible.
  const groundMat = new THREE.ShadowMaterial({ color: '#2a2622', opacity: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(W / 2, -BASE_H - 0.002, D / 2);
  ground.receiveShadow = true;
  model.add(ground);

  // The drawing sheet, which thickens into the model's base.
  const sheetW = W + opts.sheet * 2;
  const sheetD = D + opts.sheet * 2;
  const base = new THREE.Mesh(
    new RoundedBoxGeometry(sheetW, BASE_H, sheetD, 4, 0.14),
    new THREE.MeshStandardMaterial({ color: '#f6f4f0', roughness: 0.92, metalness: 0 }),
  );
  base.position.set(W / 2, -BASE_H / 2, D / 2);
  base.castShadow = true;
  base.receiveShadow = true;
  model.add(base);

  // Floors start in the drawing tint and turn into the finished floor (stone in wet rooms).
  const floorColor = new THREE.Color(preset.floor.color);
  const floors = plan.rooms.map((room, i) => {
    const finish = WET.test(room.name)
      ? new THREE.Color(preset.stone.color)
      : floorColor.clone().offsetHSL(((i % 4) - 1.5) * 0.012, 0, ((i % 3) - 1) * 0.025);
    const drawn = new THREE.Color(opts.fills[i] ?? '#ecebe8');
    const mat = new THREE.MeshStandardMaterial({ color: drawn.clone(), roughness: preset.floor.roughness, metalness: preset.floor.metalness });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.05, room.w - 0.02), 0.1, Math.max(0.05, room.d - 0.02)), mat);
    mesh.position.set(room.x + room.w / 2, 0.05, room.y + room.d / 2);
    mesh.receiveShadow = true;
    model.add(mesh);
    return { mat, drawn, finish };
  });

  // Walls with their openings, glass, frames and door leaves; outer walls rise first. Outer walls facing
  // the camera are cut low (openings cut with them) so the rooms behind stay in view.
  const toCamera = [Math.cos(THETA_3D), Math.sin(THETA_3D)];
  const facesCamera = (wall: Wall) => {
    if (!wall.exterior) return false;
    const horizontal = Math.abs(wall.y2 - wall.y1) < 1e-6;
    const out = horizontal ? [0, wall.y1 < D / 2 ? -1 : 1] : [wall.x1 < W / 2 ? -1 : 1, 0];
    return out[0] * toCamera[0] + out[1] * toCamera[1] > 0.3;
  };
  const cutWall = (wall: Wall): Wall => ({
    ...wall,
    height: Math.min(wall.height, CUT),
    openings: wall.openings
      .filter((o) => o.sill < CUT - 0.15)
      .map((o) => ({ ...o, height: Math.min(o.height, CUT - o.sill) })),
  });
  const walls = [...plan.walls]
    .sort((a, b) => Number(b.exterior) - Number(a.exterior))
    .map((wall) => {
      const group = new THREE.Group();
      addWall(scene, facesCamera(wall) ? cutWall(wall) : wall, group, materials); // the builder adds the group to the scene…
      model.add(group);                                                            // …so it is moved under the model
      group.scale.y = 0.001;
      return group;
    });

  // Furniture per room, largest room first; each lands around its room centre.
  const furniture = plan.rooms
    .filter((room) => !PASSAGE.test(room.name))
    .sort((a, b) => b.area - a.area)
    .map((room) => {
      const cx = room.x + room.w / 2;
      const cz = room.y + room.d / 2;
      const outer = new THREE.Group();
      outer.position.set(cx, 0, cz);
      const inner = new THREE.Group();
      inner.position.set(-cx, 0, -cz);
      addFurniture(inner, room, materials);
      outer.add(inner);
      outer.visible = false;
      model.add(outer);
      return outer;
    });

  // Circulation route: a warm line with a soft halo and a light travelling along it.
  const glow = glowTexture();
  // The halo uses normal blending so the branches that meet in the living room do not burn to white.
  const coreMat = new THREE.MeshBasicMaterial({ color: '#d9a85a', toneMapped: false });
  const haloMat = new THREE.MeshBasicMaterial({ color: '#f1d7a4', transparent: true, opacity: 0.38, depthWrite: false, toneMapped: false });
  // Where walls hide the route it still shows faintly, so every branch can be followed to its room.
  const ghostMat = new THREE.MeshBasicMaterial({
    color: '#c99a52', transparent: true, opacity: 0.42, depthWrite: false, depthFunc: THREE.GreaterDepth, toneMapped: false,
  });
  const routes = (opts.routes ?? []).filter((points) => points.length >= 2).map((points) => {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, ROUTE_Y, y)), false, 'centripetal');
    const length = curve.getLength();
    const segments = Math.max(16, Math.round(length * 16));
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, 0.05, RADIAL, false), coreMat);
    const halo = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, 0.13, RADIAL, false), haloMat);
    const light = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    light.scale.setScalar(0.6);
    const ghost = new THREE.Mesh(core.geometry, ghostMat); // shares the core's geometry, so its draw range too
    for (const item of [core, ghost, halo, light]) { item.visible = false; model.add(item); }
    return { curve, length, segments, core, ghost, halo, light };
  });
  const routeTotal = routes.reduce((sum, r) => sum + r.length, 0);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, DIST * 3);
  const topTarget = new THREE.Vector3(W / 2, 0, D / 2);
  const fitTarget = new THREE.Vector3(W / 2, 0, D / 2);
  const target = new THREE.Vector3();
  let fitZoom = 1;
  let view: StoryView = { width: 1, height: 1, ppm: 1, cx: W / 2, cy: D / 2 };
  const aim = (phi: number, theta: number, at: THREE.Vector3) => {
    camera.position.set(
      at.x + DIST * Math.sin(phi) * Math.cos(theta),
      at.y + DIST * Math.cos(phi),
      at.z + DIST * Math.sin(phi) * Math.sin(theta),
    );
    camera.lookAt(at);
    camera.updateMatrixWorld();
  };

  let shadowKey = '';
  let routeDone = false;
  const point = new THREE.Vector3();

  return {
    resize(next) {
      view = next;
      renderer.setSize(next.width, next.height, false);
      const hw = next.width / 2 / next.ppm;
      const hh = next.height / 2 / next.ppm;
      Object.assign(camera, { left: -hw, right: hw, top: hh, bottom: -hh, zoom: 1 });
      camera.updateProjectionMatrix();
      topTarget.set(next.cx, 0, next.cy);
      // Fit the raised model, at rest, into the stage for the three-quarter view.
      const centre = new THREE.Vector3(W / 2, plan.wallHeight * 0.3, D / 2);
      aim(PHI_3D, THETA_3D, centre);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const x of [-BASE_MARGIN, W + BASE_MARGIN]) {
        for (const y of [-BASE_H, plan.wallHeight]) {
          for (const z of [-BASE_MARGIN, D + BASE_MARGIN]) {
            point.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
            x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
            y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
          }
        }
      }
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      fitTarget.copy(centre).addScaledVector(right, (x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2);
      fitZoom = Math.min((2 * hw) / (x1 - x0), (2 * hh) / (y1 - y0)) * 0.9;
    },

    render(frame, time) {
      if (lost) return;
      const tilt = clamp01(frame.tilt);
      target.lerpVectors(topTarget, fitTarget, tilt);
      camera.zoom = lerp(1, fitZoom, tilt);
      camera.updateProjectionMatrix();
      aim(lerp(PHI_TOP, PHI_3D, tilt), lerp(THETA_TOP, THETA_3D, tilt), target);
      pivot.rotation.y = -frame.spin;

      const rise = easeOut(clamp01(frame.rise));
      base.scale.set(lerp(1, (W + BASE_MARGIN * 2) / sheetW, rise), lerp(0.04, 1, rise), lerp(1, (D + BASE_MARGIN * 2) / sheetD, rise));
      base.position.y = (-BASE_H * base.scale.y) / 2;
      groundMat.opacity = 0.16 * rise;

      const finish = clamp01(frame.finish);
      for (const floor of floors) floor.mat.color.lerpColors(floor.drawn, floor.finish, finish);

      walls.forEach((group, i) => {
        const start = (i / Math.max(1, walls.length)) * 0.45;
        group.scale.y = Math.max(0.001, easeOut(seg(frame.rise, start, start + 0.55)));
      });

      furniture.forEach((group, i) => {
        const start = (i / Math.max(1, furniture.length)) * 0.55;
        const t = seg(frame.furnish, start, start + 0.45);
        group.visible = t > 0;
        group.position.y = (1 - easeOut(t)) * 1.2;
        group.scale.setScalar(Math.max(0.001, easeOutBack(t)));
      });

      // Route: branches drawn one after another, a light at the drawing tip; once complete,
      // a light keeps travelling along every branch.
      const drawn = clamp01(frame.route) * routeTotal;
      routeDone = routes.length > 0 && frame.route >= 1;
      let before = 0;
      for (const [i, r] of routes.entries()) {
        const f = clamp01((drawn - before) / r.length);
        before += r.length;
        const count = Math.floor(f * r.segments) * RADIAL * 6;
        r.core.geometry.setDrawRange(0, count);
        r.halo.geometry.setDrawRange(0, count);
        r.core.visible = r.ghost.visible = r.halo.visible = count > 0;
        let at = -1;
        if (routeDone) at = (time / 2600 + i * 0.29) % 1;
        else if (f > 0 && f < 1) at = f;
        r.light.visible = at >= 0;
        if (at >= 0) {
          r.light.position.copy(r.curve.getPointAt(at));
          r.light.material.opacity = routeDone ? Math.sin(Math.PI * at) ** 0.6 : 1;
        }
      }

      const key = `${rise.toFixed(4)}|${clamp01(frame.furnish).toFixed(4)}`;
      if (key !== shadowKey) { shadowKey = key; renderer.shadowMap.needsUpdate = true; }
      renderer.render(scene, camera);
    },

    project(x, y, z) {
      point.set(x, y, z);
      model.localToWorld(point);
      point.project(camera);
      return [((point.x + 1) / 2) * view.width, ((1 - point.y) / 2) * view.height];
    },

    animating: () => routeDone && !lost,

    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      const textures = new Set<THREE.Texture>();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        for (const material of Array.isArray(m) ? m : m ? [m] : []) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          material.dispose();
        }
      });
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
