'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { generatePlanGeometry, planFromRects, type PlanGeometry, type PlanRoom, type RoomRect } from '@i-renovation/shared/plan';
import type { MaterialPresetId } from '@i-renovation/shared/materials';
import type { StoryFrame, StoryScene, StoryView } from '@/lib/plan-story-scene';

/*
 * Plan story: one floor plan is read room by room, drawn as a 2D drawing, raised into the 3D model,
 * furnished, and walked through. The drawing is SVG and the model is three.js (lib/plan-story-scene.ts,
 * loaded only when the stage comes near the screen); they share one top-down view, so the drawing
 * dissolves into the model without a jump, and the room labels follow the rooms into 3D.
 *
 * <PlanStory /> is the home-page section, driven by scroll.
 * <PlanBuildLoader /> plays the same story by itself while Agnes generates renders.
 */

type Point = [number, number];

const SHEET = 1.2; // drawing margin around the plan (m); the dimension lines sit in it
const PAD = 0.45;  // space between the sheet and the stage edge (m)
const PUBLIC = /客厅|起居|餐|玄关|门厅|走廊|过道|走道/;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const seg = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** The story at position p (0 → 1): drawing phases, then the 3D frame. */
function storyAt(p: number, spin = 0) {
  return {
    scan: seg(p, 0.02, 0.17),
    walls: seg(p, 0.12, 0.27),
    openings: seg(p, 0.22, 0.31),
    dims: seg(p, 0.25, 0.33),
    handoff: seg(p, 0.35, 0.45),
    frame: {
      tilt: easeInOut(seg(p, 0.37, 0.62)),
      rise: seg(p, 0.39, 0.62),
      finish: seg(p, 0.42, 0.62),
      furnish: seg(p, 0.62, 0.84),
      route: seg(p, 0.83, 0.97),
      spin,
    } satisfies StoryFrame,
  };
}

/** Drawing tints, from the site palette, by room type. */
function roomFill(name: string): string {
  if (/卫|浴|洗手/.test(name)) return '#e3ebef';
  if (/厨|餐/.test(name)) return '#eee8e3';
  if (/卧|睡|书房|儿童/.test(name)) return '#e6eaed';
  if (/阳台|露台/.test(name)) return '#e8ece6';
  return '#f0ece6';
}

const fmt = (v: number) => v.toFixed(3);

interface Drawing {
  rooms: { name: string; area: number; x: number; y: number; w: number; d: number; fill: string }[];
  walls: { d: string; width: number }[];
  windows: { x: number; y: number; len: number; thick: number; angle: number }[];
  doors: { leaf: string; arc: string }[];
  entrance: Point | null;
  area: number;
}

/** The 2D drawing of a plan: walls cut at openings, window marks, door leaves and swings. */
function drawPlan(plan: PlanGeometry): Drawing {
  const roomAt = (x: number, y: number) => plan.rooms.find((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.d);
  const walls: Drawing['walls'] = [];
  const windows: Drawing['windows'] = [];
  const doors: Drawing['doors'] = [];
  let entrance: Point | null = null;
  for (const wall of [...plan.walls].sort((a, b) => Number(b.exterior) - Number(a.exterior))) {
    const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (len < 0.05) continue;
    const ux = (wall.x2 - wall.x1) / len;
    const uy = (wall.y2 - wall.y1) / len;
    const at = (s: number): Point => [wall.x1 + ux * s, wall.y1 + uy * s];
    const run = (a: number, b: number) => {
      if (b - a < 0.02) return;
      const [x1, y1] = at(a);
      const [x2, y2] = at(b);
      walls.push({ d: `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`, width: wall.thickness });
    };
    // Solid stretches between openings; the wall ends reach half a thickness further so corners close.
    let from = -wall.thickness / 2;
    for (const o of [...wall.openings].sort((a, b) => a.offset - b.offset)) {
      run(from, o.offset - o.width / 2);
      from = Math.max(from, o.offset + o.width / 2);
    }
    run(from, len + wall.thickness / 2);

    for (const o of wall.openings) {
      const [cx, cy] = at(o.offset);
      if (o.type === 'window') {
        windows.push({ x: cx, y: cy, len: o.width, thick: wall.thickness, angle: Math.abs(uy) > 0.5 ? 90 : 0 });
        continue;
      }
      // A door swings into the more private side; an entrance door swings inward.
      const normals: Point[] = [[-uy, ux], [uy, -ux]];
      const score = (n: Point) => {
        const room = roomAt(cx + n[0] * 0.6, cy + n[1] * 0.6);
        return room ? (PUBLIC.test(room.name) ? 1 : 2) : 0;
      };
      const n = score(normals[1]) > score(normals[0]) ? normals[1] : normals[0];
      const [hx, hy] = at(o.offset - o.width / 2);
      const [ex, ey] = at(o.offset + o.width / 2);
      const lx = hx + n[0] * o.width;
      const ly = hy + n[1] * o.width;
      const sweep = (lx - hx) * (ey - hy) - (ly - hy) * (ex - hx) > 0 ? 1 : 0;
      doors.push({
        leaf: `M ${fmt(hx)} ${fmt(hy)} L ${fmt(lx)} ${fmt(ly)}`,
        arc: `M ${fmt(lx)} ${fmt(ly)} A ${fmt(o.width)} ${fmt(o.width)} 0 0 ${sweep} ${fmt(ex)} ${fmt(ey)}`,
      });
      if (wall.exterior && !entrance) {
        const out = score(normals[0]) === 0 ? normals[0] : normals[1];
        entrance = [cx + out[0] * 0.8, cy + out[1] * 0.8];
      }
    }
  }
  return {
    rooms: plan.rooms.map((r) => ({ name: r.name, area: r.area, x: r.x, y: r.y, w: r.w, d: r.d, fill: roomFill(r.name) })),
    walls,
    windows,
    doors,
    entrance,
    area: plan.rooms.reduce((sum, r) => sum + r.area, 0),
  };
}

/** Dimension lines go on the sides away from the entrance, so the 入户 tag never sits on them. */
function dimSides(drawing: Drawing, W: number, D: number) {
  const [ex, ey] = drawing.entrance ?? [W / 2, D / 2];
  return { top: ey > D, right: ex < 0 };
}

/** Top-down fit of the drawing in the stage; the SVG viewBox uses the same "meet" fit. */
function fitView(width: number, height: number, plan: PlanGeometry): StoryView {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const ppm = Math.min(w / (plan.width + 2 * (SHEET + PAD)), h / (plan.depth + 2 * (SHEET + PAD)));
  return { width: w, height: h, ppm, cx: plan.width / 2, cy: plan.depth / 2 };
}

type Reader = (now: number) => { p: number; spin?: number };

interface StageProps {
  plan: PlanGeometry;
  routes?: Point[][];
  presetId?: MaterialPresetId;
  /** Story position for the current animation frame. */
  read: Reader;
  /** Show the finished state without motion (reduced motion). */
  still: boolean;
  className?: string;
}

function PlanStage({ plan, routes, presetId, read, still, className }: StageProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const drawing = useMemo(() => drawPlan(plan), [plan]);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scanRef = useRef<SVGGElement>(null);
  const openRef = useRef<SVGGElement>(null);
  const dimsRef = useRef<SVGGElement>(null);
  const roomRefs = useRef<(SVGRectElement | null)[]>([]);
  const wallRefs = useRef<(SVGPathElement | null)[]>([]);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tagRef = useRef<HTMLDivElement>(null);
  const dimLabelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const stage = stageRef.current;
    const host = hostRef.current;
    const svg = svgRef.current;
    if (!stage || !host || !svg) return;
    let engine: StoryScene | null = null;
    let live = false;
    let loading = false;
    let disposed = false;
    let near = false;
    let raf = 0;
    let dirty = true;
    let lastP = -1;
    let lastSpin = 0;
    let lastDraw = 0;
    let view = fitView(stage.clientWidth, stage.clientHeight, plan);
    const W = plan.width;
    const D = plan.depth;
    const dims = dimSides(drawing, W, D);

    const paint = (now: number) => {
      const state = still ? { p: 1, spin: 0 } : readRef.current(now);
      const p = clamp01(state.p);
      const spin = state.spin ?? 0;
      const moving = live && !still && engine!.animating();
      if (!dirty && p === lastP && spin === lastSpin && !(moving && now - lastDraw > 32)) return;
      dirty = false;
      lastP = p;
      lastSpin = spin;
      lastDraw = now;
      const s = storyAt(p, spin);
      // Without the 3D engine (still loading, or no WebGL) the drawing simply stays on screen.
      const handoff = live ? s.handoff : 0;

      svg.style.opacity = String(1 - seg(handoff, 0.3, 1));
      const scanY = lerp(-SHEET, D + SHEET * 0.5, s.scan);
      scanRef.current?.setAttribute('transform', `translate(0 ${fmt(scanY)})`);
      if (scanRef.current) scanRef.current.style.opacity = String(Math.sin(Math.PI * s.scan));
      drawing.rooms.forEach((room, i) => {
        const el = roomRefs.current[i];
        if (el) el.style.opacity = String(seg(scanY, room.y - 0.2, room.y + Math.min(room.d, 2.5)));
      });
      const n = Math.max(1, drawing.walls.length);
      drawing.walls.forEach((_, i) => {
        const el = wallRefs.current[i];
        const start = (i / n) * 0.55;
        if (el) el.style.strokeDashoffset = String(1 - seg(s.walls, start, start + 0.45));
      });
      if (openRef.current) openRef.current.style.opacity = String(s.openings);
      if (dimsRef.current) dimsRef.current.style.opacity = String(s.dims);

      host.style.opacity = String(live ? seg(handoff, 0, 0.5) : 0);
      if (live) engine!.render(s.frame, still ? 0 : now);

      // Labels: on the drawing at first, then floating above their rooms in 3D.
      const tilt = live ? s.frame.tilt : 0;
      const to = (x: number, y: number, z: number): Point =>
        live ? engine!.project(x, y, z) : [view.width / 2 + (x - view.cx) * view.ppm, view.height / 2 + (z - view.cy) * view.ppm];
      const lift = lerp(0.1, plan.wallHeight + 0.45, tilt);
      const chip = String(seg(tilt, 0.25, 0.75));
      const place = (el: HTMLElement | null, [x, y]: Point, opacity: number, turn = '') => {
        if (!el) return;
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)${turn}`;
        el.style.opacity = String(opacity);
      };
      drawing.rooms.forEach((room, i) => {
        const el = labelRefs.current[i];
        place(el, to(room.x + room.w / 2, lift, room.y + room.d / 2), seg(scanY, room.y + room.d * 0.4, room.y + room.d * 0.4 + 0.9));
        el?.style.setProperty('--chip', chip);
      });
      if (drawing.entrance) {
        place(tagRef.current, to(drawing.entrance[0], 0.1, drawing.entrance[1]), s.openings);
        tagRef.current?.style.setProperty('--chip', chip);
      }
      const dimOpacity = s.dims * (1 - handoff);
      place(dimLabelRefs.current[0], to(W / 2, 0, dims.top ? -0.95 : D + 0.95), dimOpacity);
      place(dimLabelRefs.current[1], to(dims.right ? W + 0.95 : -0.95, 0, D / 2), dimOpacity, ' rotate(-90deg)');
    };

    const loop = (now: number) => { raf = requestAnimationFrame(loop); paint(now); };
    const start = () => { if (!raf && near && !document.hidden && !still) raf = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const repaint = () => { dirty = true; if (!raf) paint(performance.now()); };

    const load = () => {
      if (loading || disposed) return;
      loading = true;
      import('@/lib/plan-story-scene')
        .then(({ createStoryScene }) => {
          if (disposed) return;
          try {
            engine = createStoryScene(host, plan, {
              sheet: SHEET,
              fills: drawing.rooms.map((r) => r.fill),
              routes,
              presetId,
              lite: window.innerWidth < 768,
              onContextLost: () => { live = false; repaint(); },
            });
            engine.resize(view);
            live = true;
          } catch {
            engine = null; // no WebGL: the finished drawing stays
          }
          repaint();
        })
        .catch(() => { /* chunk failed to load: the drawing stays */ });
    };

    const io = new IntersectionObserver(([entry]) => {
      near = entry.isIntersecting;
      if (near) { load(); start(); } else stop();
    }, { rootMargin: '60% 0px' });
    io.observe(stage);
    const ro = new ResizeObserver(() => {
      view = fitView(stage.clientWidth, stage.clientHeight, plan);
      engine?.resize(view);
      repaint();
    });
    ro.observe(stage);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    repaint();

    return () => {
      disposed = true;
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      engine?.dispose();
      engine = null;
    };
  }, [plan, routes, presetId, still, drawing]);

  const W = plan.width;
  const D = plan.depth;
  const box = `${-SHEET - PAD} ${-SHEET - PAD} ${W + 2 * (SHEET + PAD)} ${D + 2 * (SHEET + PAD)}`;
  const dims = dimSides(drawing, W, D);
  const hy = dims.top ? -0.62 : D + 0.62; // width dimension line
  const hs = dims.top ? -1 : 1;           // extension lines point away from the plan
  const vx = dims.right ? W + 0.62 : -0.62;
  const vs = dims.right ? 1 : -1;
  return (
    <div ref={stageRef} className={`plan-stage${className ? ` ${className}` : ''}`}>
      <div ref={hostRef} className="plan-stage-canvas" aria-hidden="true" />
      <svg ref={svgRef} className="plan-stage-drawing" viewBox={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <pattern id={`${uid}-grid`} width="0.5" height="0.5" patternUnits="userSpaceOnUse">
            <path d="M 0.5 0 L 0 0 0 0.5" className="grid-line" />
          </pattern>
          <linearGradient id={`${uid}-scan`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8d7f78" stopOpacity="0" />
            <stop offset="1" stopColor="#8d7f78" stopOpacity="0.16" />
          </linearGradient>
          <clipPath id={`${uid}-sheet`}>
            <rect x={-SHEET} y={-SHEET} width={W + 2 * SHEET} height={D + 2 * SHEET} rx="0.3" />
          </clipPath>
        </defs>
        <rect className="sheet" x={-SHEET} y={-SHEET} width={W + 2 * SHEET} height={D + 2 * SHEET} rx="0.3" />
        <rect x={-SHEET} y={-SHEET} width={W + 2 * SHEET} height={D + 2 * SHEET} fill={`url(#${uid}-grid)`} clipPath={`url(#${uid}-sheet)`} />
        {drawing.rooms.map((r, i) => (
          <rect key={`${r.name}-${i}`} ref={(el) => { roomRefs.current[i] = el; }} x={r.x} y={r.y} width={r.w} height={r.d} fill={r.fill} />
        ))}
        <g ref={scanRef} className="scan" clipPath={`url(#${uid}-sheet)`}>
          <rect x={-SHEET} y={-1.6} width={W + 2 * SHEET} height={1.6} fill={`url(#${uid}-scan)`} />
          <line x1={-SHEET} x2={W + SHEET} y1={0} y2={0} />
        </g>
        <g className="walls">
          {drawing.walls.map((w, i) => (
            <path key={i} ref={(el) => { wallRefs.current[i] = el; }} d={w.d} pathLength={1} strokeWidth={w.width} />
          ))}
        </g>
        <g ref={openRef} className="openings">
          {drawing.windows.map((w, i) => (
            <g key={`w${i}`} transform={`translate(${fmt(w.x)} ${fmt(w.y)}) rotate(${w.angle})`}>
              <rect x={-w.len / 2} y={-w.thick / 2} width={w.len} height={w.thick} />
              <line x1={-w.len / 2} x2={w.len / 2} y1={0} y2={0} />
            </g>
          ))}
          {drawing.doors.map((d, i) => (
            <g key={`d${i}`}>
              <path d={d.leaf} className="leaf" />
              <path d={d.arc} className="swing" />
            </g>
          ))}
        </g>
        <g ref={dimsRef} className="dims">
          <path d={`M 0 ${hy - hs * 0.37} V ${hy + hs * 0.18} M ${W} ${hy - hs * 0.37} V ${hy + hs * 0.18} M 0 ${hy} H ${W}`} />
          <path d={`M ${vx - vs * 0.37} 0 H ${vx + vs * 0.18} M ${vx - vs * 0.37} ${D} H ${vx + vs * 0.18} M ${vx} 0 V ${D}`} />
          <path className="tick" d={`M -0.12 ${hy + 0.12} L 0.12 ${hy - 0.12} M ${W - 0.12} ${hy + 0.12} L ${W + 0.12} ${hy - 0.12} M ${vx - 0.12} 0.12 L ${vx + 0.12} -0.12 M ${vx - 0.12} ${D + 0.12} L ${vx + 0.12} ${D - 0.12}`} />
        </g>
      </svg>
      <div className="plan-stage-labels" aria-hidden="true">
        {drawing.rooms.map((r, i) => (
          <div key={`${r.name}-${i}`} ref={(el) => { labelRefs.current[i] = el; }} className="plan-stage-label">
            <b>{r.name}</b>
            <small>{r.area.toFixed(1)}㎡</small>
          </div>
        ))}
        {drawing.entrance && <div ref={tagRef} className="plan-stage-label plan-stage-tag"><b>入户</b></div>}
        <div ref={(el) => { dimLabelRefs.current[0] = el; }} className="plan-stage-dim">{W.toFixed(1)} m</div>
        <div ref={(el) => { dimLabelRefs.current[1] = el; }} className="plan-stage-dim">{D.toFixed(1)} m</div>
      </div>
    </div>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/* ---------- Home page section ---------- */

// Sample plan for the home page (5 rooms, 96 m²), with doors and windows placed as plan reading would
// report them, so it runs through the same planFromRects as a recognised plan.
const DEMO_ROOMS: RoomRect[] = [
  { name: '主卧', x: 0, y: 0, w: 4.2, d: 3.6, openings: [
    { type: 'window', side: 'W', pos: 0.5, size: 0.45 },
    { type: 'door', side: 'S', pos: 0.81, size: 0.19 },
  ] },
  { name: '卫生间', x: 4.2, y: 0, w: 2.2, d: 3.6, openings: [
    { type: 'window', side: 'N', pos: 0.75, size: 0.32 },
    { type: 'door', side: 'S', pos: 0.5, size: 0.36 },
  ] },
  { name: '次卧', x: 6.4, y: 0, w: 5.6, d: 3.6, openings: [
    { type: 'window', side: 'N', pos: 0.18, size: 0.25 },
    { type: 'window', side: 'E', pos: 0.5, size: 0.4 },
    { type: 'door', side: 'S', pos: 0.107, size: 0.143 },
  ] },
  { name: '客厅', x: 0, y: 3.6, w: 7.6, d: 4.4, openings: [
    { type: 'window', side: 'W', pos: 0.5, size: 0.4 },
    { type: 'window', side: 'S', pos: 0.13, size: 0.2 },
    { type: 'door', side: 'S', pos: 0.86, size: 0.13 },
  ] },
  { name: '厨房', x: 7.6, y: 3.6, w: 4.4, d: 4.4, openings: [
    { type: 'window', side: 'S', pos: 0.5, size: 0.35 },
    { type: 'door', side: 'W', pos: 0.45, size: 0.27 },
  ] },
];
const DEMO_PLAN = planFromRects(DEMO_ROOMS);
// Circulation illustration, entrance first, then from the living room to each room (plan metres).
const DEMO_ROUTES: Point[][] = [
  [[6.54, 9.0], [6.54, 8.0], [6.6, 7.0], [6.6, 6.1]],
  [[6.6, 6.1], [7.05, 5.75], [7.6, 5.58], [8.4, 5.15]],
  [[6.6, 6.1], [6.85, 4.7], [7.0, 3.6], [7.25, 2.75], [7.5, 2.1]],
  [[6.6, 6.1], [6.2, 4.6], [5.4, 4.0], [5.3, 3.6], [5.0, 2.95]],
  [[6.6, 6.1], [5.9, 4.15], [4.4, 3.95], [3.4, 3.6], [3.55, 2.3]],
];
const DEMO_FACTS = (() => {
  const openings = DEMO_PLAN.walls.flatMap((w) => w.openings);
  return {
    area: DEMO_PLAN.rooms.reduce((sum, r) => sum + r.area, 0),
    rooms: DEMO_PLAN.rooms.length,
    doors: openings.filter((o) => o.type === 'door').length,
    windows: openings.filter((o) => o.type === 'window').length,
  };
})();

const STEPS = [
  { title: '识别户型', body: '上传或手绘户型图，识别出房间、面积与门窗位置。' },
  { title: '二维施工图', body: '墙体、门窗与尺寸画成二维图，逐项可以核对。' },
  { title: '同源 3D', body: '同一份平面数据拉伸出墙体与门窗，不用另外建模。' },
  { title: '家具与动线', body: '按房间类型摆放家具；金色线是从入户到各房间的动线示意。' },
];
const STEP_AT = [0, 0.2, 0.36, 0.62, 1];

export default function PlanStory() {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const railRefs = useRef<(HTMLElement | null)[]>([]);
  const progress = useRef(0);
  const [active, setActive] = useState(0);
  const still = useReducedMotion();

  useEffect(() => {
    const section = sectionRef.current;
    const track = trackRef.current;
    if (!section || !track) return;
    // Pin below the top bar, whatever height it wraps to on small screens.
    const bar = document.querySelector<HTMLElement>('.topbar');
    let top = 64;
    const syncTop = () => {
      top = bar?.offsetHeight || 64;
      section.style.setProperty('--plan-top', `${top}px`);
    };
    syncTop();
    const barObserver = bar ? new ResizeObserver(syncTop) : null;
    if (bar) barObserver?.observe(bar);
    if (still) return () => barObserver?.disconnect();

    let current = -1;
    const onScroll = () => {
      const rect = track.getBoundingClientRect();
      const pinned = (track.firstElementChild as HTMLElement | null)?.offsetHeight ?? window.innerHeight;
      const range = rect.height - pinned;
      const p = range > 0 ? clamp01((top - rect.top) / range) : 0;
      progress.current = p;
      let step = 0;
      for (let i = 0; i < STEPS.length; i++) if (p >= STEP_AT[i]) step = i;
      if (step !== current) { current = step; setActive(step); }
      railRefs.current.forEach((el, i) => { if (el) el.style.transform = `scaleX(${seg(p, STEP_AT[i], STEP_AT[i + 1]).toFixed(3)})`; });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      barObserver?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [still]);

  const read = useCallback<Reader>(() => ({ p: progress.current }), []);

  return (
    <section ref={sectionRef} className="plan-story" data-mode={still ? 'still' : 'motion'} aria-labelledby="plan-story-title">
      <header className="home-section plan-story-head">
        <p className="editorial-kicker">FROM PLAN TO 3D</p>
        <h2 id="plan-story-title">从一张户型图，到看得见的家</h2>
        <p className="lead">户型识别、二维施工图和 3D 模型用的是同一份平面数据，墙、门、窗与尺寸彼此对得上。</p>
      </header>
      <div ref={trackRef} className="plan-story-track">
        <div className="plan-story-pin">
          <ol className="plan-story-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className={i === active ? 'is-active' : i < active ? 'is-done' : undefined}>
                <i className="plan-story-rail" aria-hidden="true"><b ref={(el) => { railRefs.current[i] = el; }} /></i>
                <span className="plan-story-no">0{i + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="plan-story-visual">
            <PlanStage plan={DEMO_PLAN} routes={DEMO_ROUTES} read={read} still={still} className="plan-story-stage" />
            <p className="plan-story-caption">
              <span>示意户型</span>
              <span>{DEMO_FACTS.area.toFixed(1)}㎡</span>
              <span>{DEMO_FACTS.rooms}<span> 个房间</span></span>
              <span>{DEMO_FACTS.doors}<span> 扇门</span></span>
              <span>{DEMO_FACTS.windows}<span> 扇窗</span></span>
              <span className="plan-story-note">尺寸以现场量房为准</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- Waiting animation while Agnes generates renders ---------- */

/** Build once with the drawing, then sway, fold back to the drawing and rebuild, until unmounted. */
function loopAt(t: number): { p: number; spin: number } {
  if (t < 10) return { p: t / 10, spin: 0 };
  const u = (t - 10) % 16.5;
  if (u < 8) return { p: 1, spin: 0.3 * Math.sin((u / 8) * Math.PI * 2) };
  if (u < 10.5) return { p: 1 - 0.64 * easeInOut((u - 8) / 2.5), spin: 0 };
  return { p: 0.36 + 0.64 * ((u - 10.5) / 6), spin: 0 };
}

interface LoaderProps {
  geometry?: PlanGeometry | null;
  rooms?: PlanRoom[];
  presetId?: MaterialPresetId;
  title: string;
  /** Room being regenerated, shown after the title. */
  room?: string;
  detail?: string;
  /** "done/total", e.g. "2/5". */
  progress?: string;
}

export function PlanBuildLoader({ geometry, rooms, presetId, title, room, detail, progress }: LoaderProps) {
  const still = useReducedMotion();
  // The project page reloads its data every few seconds; rebuild only when the plan itself changes.
  const key = JSON.stringify(geometry ?? rooms ?? null);
  const plan = useMemo(() => {
    const g = geometry ?? (rooms?.length ? generatePlanGeometry(rooms) : null);
    return g && g.rooms.length > 0 ? g : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const startedAt = useRef<number | null>(null);
  const read = useCallback<Reader>((now) => {
    if (startedAt.current === null) startedAt.current = now;
    return loopAt((now - startedAt.current) / 1000);
  }, []);
  const m = progress?.match(/^(\d+)\/(\d+)$/);
  const fraction = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;

  return (
    <div className="plan-loader" role="status" aria-live="polite">
      {plan && <PlanStage plan={plan} presetId={presetId} read={read} still={still} className="plan-loader-stage" />}
      <div className="plan-loader-caption">
        <span className="plan-loader-pulse" aria-hidden="true" />
        <div className="plan-loader-text">
          <strong><span>{title}</span>{room && <span> {room}</span>}{progress && <span className="plan-loader-count"> {progress}</span>}</strong>
          {detail && <small>{detail}</small>}
        </div>
        {fraction !== null && <div className="brief-bar"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></div>}
      </div>
    </div>
  );
}
