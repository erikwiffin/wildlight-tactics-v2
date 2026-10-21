// Ability visual effects. Every ability has its own recipe, built from a few
// primitives (particles, rings, bolts, slashes, tubes, clouds...). Effects are
// cosmetic only: they read positions from the view, never touch game state,
// and may use Math.random freely (the rules never see it).

import * as THREE from 'three';
import type { Hex } from '../core/hex';
import type { BoardView } from './view';

type V3 = THREE.Vector3;

export interface FxContext {
  view: BoardView;
  caster: number;
  /** Caster's feet when the ability starts. */
  from: V3;
  target: Hex;
  /** Top of the aimed hex. */
  to: V3;
  area: Hex[];
  /** Units the ability reaches (hit or miss), in order. */
  hits: number[];
  /** Where a leaping caster lands, if it leaps. */
  landing?: Hex;
}

type Recipe = (fx: FxContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Shared resources

let dotTexture: THREE.Texture | null = null;
function dot(): THREE.Texture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

const glow = (color: number, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const ease = (k: number) => 1 - (1 - k) * (1 - k);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const up = (v: V3, y: number) => v.clone().setY(v.y + y);
const all = (ps: Promise<void>[]) => Promise.all(ps).then(() => undefined);
const later = (v: BoardView, ms: number, f: () => Promise<void>) => v.wait(ms).then(f);

/** Direction (radians, about Y) from a to b on the ground plane. */
const heading = (a: V3, b: V3) => Math.atan2(b.x - a.x, b.z - a.z);

// ---------------------------------------------------------------------------
// Primitives

interface BurstOpts {
  color: number;
  count?: number;
  speed?: number;
  rise?: number;
  gravity?: number;
  size?: number;
  life?: number;
  /** Direction bias (unit vector) for a cone instead of a sphere. */
  dir?: V3;
  cone?: number;
}

function burst(v: BoardView, at: V3, o: BurstOpts): Promise<void> {
  const n = Math.max(4, Math.round((o.count ?? 24) * (v.reducedMotion ? 0.5 : 1)));
  const pos = new Float32Array(n * 3);
  const vel: V3[] = [];
  for (let i = 0; i < n; i++) {
    let d = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
    if (o.dir) d = o.dir.clone().add(d.multiplyScalar(o.cone ?? 0.5)).normalize();
    vel.push(d.multiplyScalar((o.speed ?? 2.5) * rand(0.5, 1)).add(new THREE.Vector3(0, o.rise ?? 1, 0)));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: o.color, map: dot(), size: (o.size ?? 16) * v.pixelRatio, sizeAttenuation: false,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = 5;
  const done = v.addFx(pts);
  const life = (o.life ?? 500) / 1000;
  const g = o.gravity ?? -6;
  return v.animate(o.life ?? 500, (k) => {
    const t = k * life;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = at.x + vel[i].x * t;
      pos[i * 3 + 1] = at.y + vel[i].y * t + 0.5 * g * t * t;
      pos[i * 3 + 2] = at.z + vel[i].z * t;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 1 - k * k;
  }).then(done);
}

function ring(v: BoardView, at: V3, o: { color: number; r0?: number; r1?: number; life?: number; width?: number; hex?: boolean; y?: number }): Promise<void> {
  const geo = new THREE.RingGeometry(1 - Math.min(0.6, (o.width ?? 0.15) * 1.4), 1, o.hex ? 6 : 40);
  geo.rotateX(-Math.PI / 2);
  if (o.hex) geo.rotateY(Math.PI / 6);
  const m = new THREE.Mesh(geo, glow(o.color));
  m.position.copy(at).setY(at.y + (o.y ?? 0.06));
  const done = v.addFx(m);
  return v.animate(o.life ?? 400, (k) => {
    m.scale.setScalar(lerp(o.r0 ?? 0.2, o.r1 ?? 1.3, ease(k)));
    (m.material as THREE.MeshBasicMaterial).opacity = 1 - k;
  }).then(done);
}

function flash(v: BoardView, at: V3, o: { color: number; size?: number; life?: number }): Promise<void> {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), glow(o.color, 0.9));
  m.position.copy(at);
  const done = v.addFx(m);
  return v.animate(o.life ?? 220, (k) => {
    m.scale.setScalar((o.size ?? 0.5) * (0.4 + ease(k)));
    (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
  }).then(done);
}

/** A jagged lightning bolt (a thin tube through jittered points). */
function bolt(v: BoardView, a: V3, b: V3, o: { color: number; jag?: number; life?: number; radius?: number; flickers?: number }): Promise<void> {
  const seg = Math.max(4, Math.round(a.distanceTo(b) * 3));
  const pts: V3[] = [];
  for (let i = 0; i <= seg; i++) {
    const p = a.clone().lerp(b, i / seg);
    if (i > 0 && i < seg) p.add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(o.jag ?? 0.22));
    pts.push(p);
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1), seg * 4, (o.radius ?? 0.035) * 1.5, 5, false);
  const m = new THREE.Mesh(geo, glow(o.color));
  m.renderOrder = 6;
  const done = v.addFx(m);
  const flickers = o.flickers ?? 2;
  return v.animate(o.life ?? 260, (k) => {
    const on = Math.floor(k * (flickers * 2 + 1)) % 2 === 0;
    (m.material as THREE.MeshBasicMaterial).opacity = on ? 1 - k * 0.5 : 0.45;
  }).then(done);
}

/** An object flying from a to b along an arc, with an optional particle trail. */
async function projectile(v: BoardView, a: V3, b: V3, o: { obj: THREE.Object3D; arc?: number; life?: number; trail?: number; spin?: boolean }): Promise<void> {
  const done = v.addFx(o.obj);
  o.obj.position.copy(a);
  const yaw = heading(a, b);
  o.obj.rotation.y = yaw;
  let lastTrail = 0;
  await v.animate(o.life ?? 300, (k) => {
    o.obj.position.lerpVectors(a, b, k);
    o.obj.position.y += Math.sin(k * Math.PI) * (o.arc ?? 0.4);
    if (o.spin) o.obj.rotation.z += 0.4;
    if (o.trail !== undefined && k - lastTrail > 0.12) {
      lastTrail = k;
      void burst(v, o.obj.position.clone(), { color: o.trail, count: 4, speed: 0.4, rise: 0.1, gravity: 0, size: 9, life: 250 });
    }
  });
  done();
}

/** A partial ring that sweeps through an arc, like a blade or claw slash. */
function slash(v: BoardView, at: V3, o: { color: number; radius?: number; arc?: number; yaw?: number; tilt?: number; life?: number; thick?: number }): Promise<void> {
  const arc = o.arc ?? Math.PI * 0.8;
  const geo = new THREE.TorusGeometry((o.radius ?? 0.55) * 1.15, (o.thick ?? 0.05) * 1.7, 6, 24, arc);
  const m = new THREE.Mesh(geo, glow(o.color));
  const pivot = new THREE.Group();
  pivot.position.copy(at);
  pivot.rotation.set(o.tilt ?? 0, o.yaw ?? 0, 0);
  pivot.add(m);
  m.rotation.z = -arc / 2;
  const done = v.addFx(pivot);
  return v.animate(o.life ?? 220, (k) => {
    m.rotation.z = -arc / 2 + lerp(-0.9, 0.9, ease(k));
    m.scale.setScalar(lerp(0.8, 1.15, k));
    (m.material as THREE.MeshBasicMaterial).opacity = 1 - k * k;
  }).then(done);
}

function column(v: BoardView, at: V3, o: { color: number; height?: number; radius?: number; life?: number; fromSky?: boolean }): Promise<void> {
  const h = o.height ?? 3;
  const geo = new THREE.CylinderGeometry(o.radius ?? 0.35, o.radius ?? 0.35, h, 16, 1, true);
  geo.translate(0, h / 2, 0);
  const m = new THREE.Mesh(geo, glow(o.color, 0.7));
  m.position.copy(at);
  const done = v.addFx(m);
  return v.animate(o.life ?? 500, (k) => {
    const grow = o.fromSky ? 1 : Math.min(1, k * 3);
    m.scale.set(1 - k * 0.7, grow, 1 - k * 0.7);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
  }).then(done);
}

/** Particles rising in a helix around a point. */
function spiral(v: BoardView, at: V3, o: { color: number; count?: number; turns?: number; height?: number; radius?: number; life?: number }): Promise<void> {
  const n = o.count ?? 18;
  const pos = new Float32Array(n * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: o.color, map: dot(), size: 15 * v.pixelRatio, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const done = v.addFx(new THREE.Points(geo, mat));
  const r = o.radius ?? 0.5;
  return v.animate(o.life ?? 900, (k) => {
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const t = Math.min(1, k * 1.4 - f * 0.4);
      const a = (o.turns ?? 2) * Math.PI * 2 * (t + f);
      pos[i * 3] = at.x + Math.cos(a) * r * (1 - t * 0.5);
      pos[i * 3 + 1] = at.y + Math.max(0, t) * (o.height ?? 1.8);
      pos[i * 3 + 2] = at.z + Math.sin(a) * r * (1 - t * 0.5);
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = k < 0.8 ? 1 : (1 - k) * 5;
  }).then(done);
}

/** A tube that grows from start to end along points (tentacles, beams). */
function tube(v: BoardView, pts: V3[], o: { color: number; radius?: number; grow?: number; hold?: number; shrink?: number; additive?: boolean }): Promise<void> {
  const curve = new THREE.CatmullRomCurve3(pts);
  const segs = 40;
  const geo = new THREE.TubeGeometry(curve, segs, o.radius ?? 0.07, 6, false);
  const mat = o.additive === false
    ? new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.5, emissive: o.color, emissiveIntensity: 0.25 })
    : glow(o.color);
  const m = new THREE.Mesh(geo, mat);
  const total = geo.index!.count;
  geo.setDrawRange(0, 0);
  const done = v.addFx(m);
  const grow = o.grow ?? 180, hold = o.hold ?? 80, shrink = o.shrink ?? 180;
  return v.animate(grow, (k) => geo.setDrawRange(0, Math.floor((total * ease(k)) / 6) * 6))
    .then(() => v.wait(hold))
    .then(() => v.animate(shrink, (k) => geo.setDrawRange(0, Math.floor((total * (1 - k)) / 6) * 6)))
    .then(done);
}

/** Soft puffs that swell and fade (ink, dust, storm clouds). */
function cloud(v: BoardView, at: V3, o: { color: number; puffs?: number; radius?: number; life?: number; opacity?: number; y?: number; additive?: boolean }): Promise<void> {
  const g = new THREE.Group();
  const mat = o.additive
    ? glow(o.color, o.opacity ?? 0.6)
    : new THREE.MeshBasicMaterial({ color: o.color, transparent: true, opacity: o.opacity ?? 0.75, depthWrite: false });
  const n = o.puffs ?? 6;
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const puffs: { m: THREE.Mesh; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(geo, mat);
    const a = (i / n) * Math.PI * 2;
    const r = (o.radius ?? 0.5) * rand(0.2, 1);
    m.position.set(Math.cos(a) * r, rand(0, 0.25), Math.sin(a) * r);
    g.add(m);
    puffs.push({ m, s: rand(0.18, 0.32) });
  }
  g.position.copy(at).setY(at.y + (o.y ?? 0.3));
  const done = v.addFx(g);
  return v.animate(o.life ?? 900, (k) => {
    for (const p of puffs) p.m.scale.setScalar(p.s * (0.4 + ease(Math.min(1, k * 2.5))));
    mat.opacity = (o.opacity ?? 0.75) * (k < 0.6 ? 1 : (1 - k) / 0.4);
  }).then(done);
}

/** Spikes erupting from the ground on a hex. */
function eruption(v: BoardView, at: V3, o: { color: number; count?: number; height?: number; life?: number }): Promise<void> {
  const g = new THREE.Group();
  const geo = new THREE.ConeGeometry(0.07, 1, 4);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: o.color, emissive: o.color, emissiveIntensity: 0.6, transparent: true });
  const spikes: THREE.Mesh[] = [];
  for (let i = 0; i < (o.count ?? 5); i++) {
    const m = new THREE.Mesh(geo, mat);
    const a = rand(0, Math.PI * 2), r = rand(0, 0.55);
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    m.rotation.set(rand(-0.3, 0.3), 0, rand(-0.3, 0.3));
    g.add(m);
    spikes.push(m);
  }
  g.position.copy(at);
  const done = v.addFx(g);
  const h = o.height ?? 0.6;
  return v.animate(o.life ?? 450, (k) => {
    const rise = k < 0.3 ? ease(k / 0.3) * 1.3 : lerp(1.3, 0.6, (k - 0.3) / 0.7);
    for (const m of spikes) m.scale.set(1, h * rise, 1);
    mat.opacity = k < 0.7 ? 1 : (1 - k) / 0.3;
  }).then(done);
}

/** A rotating star glyph on the ground (charge-ups). */
function glyph(v: BoardView, at: V3, o: { color: number; points?: number; radius?: number; life?: number; spin?: number }): Promise<void> {
  const n = o.points ?? 6;
  const pts: V3[] = [];
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = (i % 2 ? 0.45 : 1) * (o.radius ?? 0.8);
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0), n * 8, 0.025, 4, true);
  const m = new THREE.Mesh(geo, glow(o.color));
  m.position.copy(at).setY(at.y + 0.08);
  const done = v.addFx(m);
  return v.animate(o.life ?? 700, (k) => {
    m.rotation.y = k * (o.spin ?? 2.5);
    m.scale.setScalar(lerp(0.3, 1, ease(Math.min(1, k * 2))));
    (m.material as THREE.MeshBasicMaterial).opacity = k < 0.7 ? 1 : (1 - k) / 0.3;
  }).then(done);
}

/** A bubble around a unit. */
function bubble(v: BoardView, unit: number, o: { color: number; life?: number; hex?: boolean }): Promise<void> {
  const geo = o.hex ? new THREE.CylinderGeometry(0.85, 0.85, 1.6, 6, 1, true) : new THREE.SphereGeometry(0.85, 16, 12);
  if (o.hex) geo.translate(0, 0.8, 0);
  const m = new THREE.Mesh(geo, glow(o.color, 0.5));
  if (!o.hex) m.position.y = 0.6;
  const root = v.unitObject(unit);
  root.add(m);
  return v.animate(o.life ?? 600, (k) => {
    m.scale.setScalar(k < 0.25 ? ease(k / 0.25) : 1 + Math.sin(k * 20) * 0.02);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.5 * (k < 0.7 ? 1 : (1 - k) / 0.3);
  }).then(() => {
    m.removeFromParent();
    geo.dispose();
    (m.material as THREE.Material).dispose();
  });
}

function quill(color: number, len = 0.45): THREE.Mesh {
  const geo = new THREE.ConeGeometry(0.035, len, 4);
  geo.rotateX(Math.PI / 2);
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8 }));
}

function orb(color: number, r = 0.12): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), glow(color));
}

/** Hop the caster in place (stomps, roars). */
function hop(v: BoardView, unit: number, height = 0.5, life = 260): Promise<void> {
  const root = v.unitObject(unit);
  const base = root.position.y;
  return v.animate(life, (k) => {
    root.position.y = base + Math.sin(k * Math.PI) * height;
  }).then(() => {
    root.position.y = base;
  });
}

/** Lunge toward a point and back, optionally further and faster than a basic attack. */
function lunge(v: BoardView, unit: number, toward: V3, dist = 0.45, life = 220): Promise<void> {
  const root = v.unitObject(unit);
  const base = root.position.clone();
  const d = toward.clone().sub(base).setY(0);
  if (d.lengthSq() < 1e-4) return hop(v, unit);
  d.normalize().multiplyScalar(dist);
  return v.animate(life, (k) => {
    const s = Math.sin(k * Math.PI);
    root.position.set(base.x + d.x * s, base.y, base.z + d.z * s);
  }).then(() => {
    root.position.copy(base);
  });
}

/** Carry a unit's model to a point along an arc (leaps); the later slide event then has nothing left to do. */
function carry(v: BoardView, unit: number, to: V3, arc: number, life: number): Promise<void> {
  const root = v.unitObject(unit);
  const from = root.position.clone();
  return v.animate(life, (k) => {
    root.position.lerpVectors(from, to, ease(k));
    root.position.y += Math.sin(k * Math.PI) * arc;
  });
}

/** Positions of the units an ability reaches (falls back to the aimed hex). */
const hitPoints = (fx: FxContext, lift = 0.6) =>
  fx.hits.length ? fx.hits.map((id) => fx.view.unitAnchor(id, lift)) : [up(fx.to, lift)];

// ---------------------------------------------------------------------------
// Colors

const C = {
  white: 0xffffff,
  ember: 0xff8a3d,
  nanite: 0x5ff3ff,
  plate: 0x7fd8ff,
  stone: 0xc9b38a,
  fox: 0xff7a2f,
  phase: 0xc77dff,
  poison: 0x7dff6a,
  frost: 0x7aa8ff,
  pollen: 0xffe066,
  heal: 0x63f2a0,
  petal: 0xff8fd8,
  emerald: 0x2cff9a,
  quill: 0xd9c7a3,
  thorn: 0xb7ff5c,
  volt: 0x9fe8ff,
  storm: 0x4a5577,
  stun: 0xffe94a,
  shade: 0x9b6bff,
  void: 0x2a1640,
  octo: 0xd25b85,
  ink: 0x120c1c,
  jamRed: 0xff3b5c,
  jamCyan: 0x2bf0ff,
};

// ---------------------------------------------------------------------------
// One recipe per ability

const RECIPES: Record<string, Recipe> = {
  // Bulwark Rhino ----------------------------------------------------------
  /** Upward horn thrust: a white-hot arc and ember sparks. */
  gore: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx);
    void lunge(v, fx.caster, fx.to, 0.5, 240);
    await v.wait(90);
    await all([
      slash(v, p, { color: C.ember, radius: 0.5, yaw: heading(fx.from, fx.to), tilt: Math.PI / 2, arc: Math.PI * 0.7, thick: 0.07 }),
      burst(v, p, { color: C.ember, count: 18, speed: 2.4, rise: 1.6 }),
    ]);
  },
  /** Full-body charge: dust behind, a cone shockwave and a screen shake on impact. */
  ram: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.4);
    void burst(v, up(fx.from, 0.1), { color: C.stone, count: 16, speed: 1.2, rise: 0.4, gravity: -1, size: 18, life: 600 });
    await lunge(v, fx.caster, fx.to, 0.75, 200);
    v.shake(0.25, 260);
    const dir = p.clone().sub(fx.from).setY(0).normalize();
    await all([
      ring(v, fx.to, { color: C.stone, r0: 0.3, r1: 1.6, width: 0.25, life: 380 }),
      burst(v, p, { color: C.ember, count: 26, speed: 3.5, rise: 0.6, dir, cone: 0.6 }),
      flash(v, p, { color: C.white, size: 0.45 }),
    ]);
  },
  /** Hex plates orbit in and lock into a nanite shell. */
  plate: async (fx) => {
    const v = fx.view;
    const g = new THREE.Group();
    const plates: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.22, 6), glow(C.plate, 0.9));
      g.add(m);
      plates.push(m);
    }
    const c = v.unitAnchor(fx.caster, 0.7);
    g.position.copy(c);
    const done = v.addFx(g);
    await v.animate(420, (k) => {
      plates.forEach((m, i) => {
        const a = (i / 6) * Math.PI * 2 + k * 5;
        const r = lerp(1.4, 0.7, ease(k));
        m.position.set(Math.cos(a) * r, Math.sin(i) * 0.3 * (1 - k), Math.sin(a) * r);
        m.lookAt(g.position.clone().add(m.position.clone().multiplyScalar(2)));
      });
    });
    done();
    await all([bubble(v, fx.caster, { color: C.plate, hex: true, life: 700 }), ring(v, fx.from, { color: C.plate, hex: true, r0: 0.6, r1: 1.1 })]);
  },
  /** Leap and slam: hex shockwave, rock debris, heavy shake. */
  stomp: async (fx) => {
    const v = fx.view;
    await hop(v, fx.caster, 0.8, 300);
    v.shake(0.35, 320);
    await all([
      ring(v, fx.from, { color: C.stone, hex: true, r0: 0.3, r1: 2.0, width: 0.3, life: 450 }),
      later(v, 80, () => ring(v, fx.from, { color: C.ember, hex: true, r0: 0.2, r1: 1.6, width: 0.12, life: 380 })),
      burst(v, up(fx.from, 0.1), { color: C.stone, count: 30, speed: 2.8, rise: 2, gravity: -9, size: 16, life: 650 }),
    ]);
  },

  // Phase Fox --------------------------------------------------------------
  /** Two jaw arcs snapping shut. */
  bite: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.5);
    void lunge(v, fx.caster, fx.to, 0.45, 180);
    await v.wait(70);
    const yaw = heading(fx.from, fx.to);
    await all([
      slash(v, up(p, 0.25), { color: C.fox, radius: 0.5, yaw, tilt: 1.1, arc: Math.PI * 0.7, thick: 0.1, life: 340 }),
      slash(v, up(p, -0.25), { color: C.fox, radius: 0.5, yaw: yaw + Math.PI, tilt: 1.1, arc: Math.PI * 0.7, thick: 0.1, life: 340 }),
      slash(v, up(p, 0.25), { color: C.white, radius: 0.45, yaw, tilt: 1.1, arc: Math.PI * 0.6, thick: 0.04, life: 300 }),
      slash(v, up(p, -0.25), { color: C.white, radius: 0.45, yaw: yaw + Math.PI, tilt: 1.1, arc: Math.PI * 0.6, thick: 0.04, life: 300 }),
      later(v, 150, () => all([flash(v, p, { color: C.fox, size: 0.7, life: 280 }), burst(v, p, { color: C.fox, count: 24, speed: 2.2, size: 18, life: 450 })])),
    ]);
  },
  /** Blink: violet implosion where the fox was, a streak, and an X-slash where it lands. */
  phase: async (fx) => {
    const v = fx.view;
    const land = fx.landing ? v.hexWorld(fx.landing) : fx.to;
    const [p] = hitPoints(fx, 0.6);
    await all([
      burst(v, up(fx.from, 0.5), { color: C.phase, count: 22, speed: 1.8, rise: 0.3, gravity: 0, life: 350 }),
      bolt(v, up(fx.from, 0.5), up(land, 0.5), { color: C.phase, jag: 0.05, radius: 0.05, life: 220, flickers: 0 }),
      carry(v, fx.caster, land, 0, 60), // a blink: there almost instantly
    ]);
    await all([
      flash(v, up(land, 0.5), { color: C.phase, size: 0.4 }),
      slash(v, p, { color: C.phase, radius: 0.45, yaw: heading(land, fx.to) + 0.6, tilt: 0.9, life: 200 }),
      later(v, 80, () => slash(v, p, { color: C.white, radius: 0.45, yaw: heading(land, fx.to) - 0.6, tilt: -0.9, life: 200 })),
    ]);
  },
  /** Three parallel claw streaks, then green venom dripping. */
  rend: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    void lunge(v, fx.caster, fx.to, 0.5, 200);
    await v.wait(80);
    const yaw = heading(fx.from, fx.to);
    await all([
      ...[-0.2, 0, 0.2].map((dy, i) => later(v, i * 45, () => slash(v, up(p, dy), { color: i === 1 ? C.white : C.poison, radius: 0.55, yaw, tilt: 0.9, arc: Math.PI * 0.6, thick: 0.09, life: 360 }))),
      later(v, 140, () => flash(v, p, { color: C.poison, size: 0.65, life: 280 })),
      later(v, 150, () => burst(v, p, { color: C.poison, count: 30, speed: 1.2, rise: 0.3, gravity: -4, size: 18, life: 800 })),
    ]);
  },
  /** A low sweeping arc, then frost-blue rings tightening around the target's legs. */
  hamstring: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.15);
    void lunge(v, fx.caster, fx.to, 0.45, 200);
    await v.wait(80);
    await all([
      slash(v, p, { color: C.white, radius: 0.65, yaw: heading(fx.from, fx.to), tilt: 0, arc: Math.PI * 0.9, thick: 0.06, life: 260 }),
      later(v, 120, () => burst(v, p, { color: C.frost, count: 14, speed: 1.4, rise: 0.2, gravity: -2, life: 400 })),
    ]);
    await all([0, 90, 180].map((d) => later(v, d, () => ring(v, fx.to, { color: C.frost, r0: 1.0, r1: 0.3, width: 0.18, life: 340, y: 0.15 }))));
  },

  // Lumen Moth -------------------------------------------------------------
  /** A stream of glittering pollen motes arcing to the target. */
  dust: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    const a = v.unitAnchor(fx.caster, 0.7);
    await all([0, 60, 120, 180].map((d, i) => later(v, d, () => projectile(v, a, p, { obj: orb(C.pollen, 0.06 + i * 0.01), arc: 0.6 + i * 0.1, life: 300, trail: C.pollen }))));
    await burst(v, p, { color: C.pollen, count: 16, speed: 1.4, rise: 0.8, gravity: -1, size: 10, life: 400 });
  },
  /** A shaft of light from above and rising green motes. */
  mend: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0);
    await all([
      column(v, p, { color: C.heal, height: 3.2, radius: 0.32, life: 600, fromSky: true }),
      spiral(v, p, { color: C.heal, count: 14, turns: 1, height: 1.6, radius: 0.35, life: 700 }),
    ]);
  },
  /** Petals burst outward from the bloom's heart; light rises over every ally it touches. */
  bloom: async (fx) => {
    const v = fx.view;
    const petals = new THREE.Group();
    const items: { m: THREE.Mesh; a: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const g = new THREE.CircleGeometry(0.16, 5);
      g.scale(1, 0.5, 1);
      const m = new THREE.Mesh(g, glow(i % 2 ? C.petal : C.heal, 0.9));
      petals.add(m);
      items.push({ m, a: (i / 12) * Math.PI * 2 });
    }
    petals.position.copy(fx.to).setY(fx.to.y + 0.4);
    const done = v.addFx(petals);
    await all([
      v.animate(700, (k) => {
        for (const it of items) {
          const r = ease(k) * 1.4;
          it.m.position.set(Math.cos(it.a + k) * r, Math.sin(k * Math.PI) * 0.5, Math.sin(it.a + k) * r);
          it.m.rotation.set(k * 6, it.a, 0);
          (it.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
        }
      }).then(done),
      ...hitPoints(fx, 0).map((h, i) => later(v, 150 + i * 60, () => column(v, h, { color: C.petal, height: 1.6, radius: 0.3, life: 500 }))),
    ]);
  },
  /** An emerald helix that keeps winding up around the ally. */
  regen: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0);
    await all([
      spiral(v, p, { color: C.emerald, count: 24, turns: 3, height: 1.9, radius: 0.55, life: 1000 }),
      ring(v, p, { color: C.emerald, r0: 0.3, r1: 0.8, life: 600 }),
    ]);
  },

  // Quill Porcupine --------------------------------------------------------
  /** One quill fired point-blank and a puncture spark. */
  jab: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.5);
    void lunge(v, fx.caster, fx.to, 0.25, 150);
    await projectile(v, v.unitAnchor(fx.caster, 0.5), p, { obj: quill(C.quill, 0.6), arc: 0, life: 160, trail: C.quill });
    await all([
      flash(v, p, { color: C.white, size: 0.7, life: 280 }),
      flash(v, p, { color: C.quill, size: 1.0, life: 220 }),
      slash(v, p, { color: C.quill, radius: 0.35, yaw: heading(fx.from, fx.to) + 0.8, tilt: 0.8, arc: Math.PI * 0.5, thick: 0.08, life: 320 }),
      slash(v, p, { color: C.white, radius: 0.35, yaw: heading(fx.from, fx.to) - 0.8, tilt: -0.8, arc: Math.PI * 0.5, thick: 0.08, life: 320 }),
      ring(v, p.clone().setY(p.y - 0.5), { color: C.quill, r0: 0.2, r1: 1.0, width: 0.18, life: 380 }),
      burst(v, p, { color: C.quill, count: 22, speed: 2.4, rise: 0.4, size: 18, life: 420 }),
    ]);
  },
  /** Quills launched skyward, then raining down across the area. */
  volley: async (fx) => {
    const v = fx.view;
    const a = v.unitAnchor(fx.caster, 0.6);
    await burst(v, a, { color: C.quill, count: 10, speed: 2, rise: 4, gravity: 0, size: 8, life: 250 });
    const drops = fx.area.flatMap((h) => [h, h]).map((h, i) =>
      later(v, i * 25, async () => {
        const g = v.hexWorld(h).add(new THREE.Vector3(rand(-0.35, 0.35), 0, rand(-0.35, 0.35)));
        const q = quill(C.quill, 0.5);
        q.rotation.x = Math.PI / 2;
        await projectile(v, up(g, 3), g, { obj: q, arc: 0, life: 200 });
        await burst(v, g, { color: C.stone, count: 5, speed: 0.8, rise: 0.6, size: 10, life: 250 });
      }),
    );
    await all(drops);
  },
  /** Spikes erupt across the area with a spray of dirt. */
  spikes: async (fx) => {
    const v = fx.view;
    await all(fx.area.map((h, i) => later(v, i * 35, () => all([
      eruption(v, v.hexWorld(h), { color: C.thorn, count: 4, height: 0.55, life: 500 }),
      burst(v, v.hexWorld(h), { color: C.stone, count: 6, speed: 1, rise: 1.2, size: 12, life: 350 }),
    ]))));
  },
  /** The porcupine bristles: quills flare out in every direction, then a thorn ring settles. */
  bristle: async (fx) => {
    const v = fx.view;
    const c = v.unitAnchor(fx.caster, 0.5);
    await hop(v, fx.caster, 0.2, 160);
    await all([
      ...Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        const end = c.clone().add(new THREE.Vector3(Math.cos(a) * 1.1, rand(0, 0.6), Math.sin(a) * 1.1));
        return projectile(v, c, end, { obj: quill(C.thorn, 0.45), arc: 0.1, life: 240 });
      }),
      burst(v, c, { color: C.thorn, count: 18, speed: 2, rise: 0.4, gravity: -2, size: 13, life: 450 }),
      later(v, 120, () => ring(v, fx.from, { color: C.thorn, r0: 0.5, r1: 0.9, width: 0.2, life: 500 })),
    ]);
  },

  // Arc Eel ----------------------------------------------------------------
  /** A single crackling bolt that flickers three times. */
  zap: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    await all([
      bolt(v, v.unitAnchor(fx.caster, 0.8), p, { color: C.volt, flickers: 3, life: 320 }),
      later(v, 60, () => flash(v, p, { color: C.volt, size: 0.35 })),
      later(v, 60, () => burst(v, p, { color: C.volt, count: 12, speed: 2.2, rise: 0.5, gravity: -2, size: 9, life: 280 })),
    ]);
  },
  /** A straight piercing beam: a bright head races down the line, crackling at every hex. */
  lance: async (fx) => {
    const v = fx.view;
    const a = v.unitAnchor(fx.caster, 0.6);
    const end = fx.area.length ? up(v.hexWorld(fx.area[fx.area.length - 1]), 0.6) : up(fx.to, 0.6);
    const head = orb(C.white, 0.18);
    await all([
      tube(v, [a, a.clone().lerp(end, 0.5), end], { color: C.volt, radius: 0.09, grow: 220, hold: 120, shrink: 160 }),
      projectile(v, a, end, { obj: head, arc: 0, life: 220, trail: C.volt }),
      ...fx.area.map((h, i) => later(v, 40 + i * 40, () => bolt(v, up(v.hexWorld(h), 0.2), up(v.hexWorld(h), 1.1), { color: C.white, jag: 0.3, life: 200 }))),
    ]);
  },
  /** Dark clouds roil over the area and lightning hammers down on every hex. */
  storm: async (fx) => {
    const v = fx.view;
    void cloud(v, fx.to, { color: C.storm, puffs: 9, radius: 1.4, y: 2.6, life: 1100, opacity: 0.85 });
    await v.wait(250);
    v.shake(0.3, 500);
    await all(fx.area.map((h, i) => later(v, i * 70, () => {
      const g = up(v.hexWorld(h), 0.1);
      return all([
        bolt(v, up(g, 2.6), g, { color: C.volt, jag: 0.35, radius: 0.045, flickers: 1, life: 260 }),
        flash(v, g, { color: C.white, size: 0.35, life: 160 }),
        ring(v, g, { color: C.volt, r0: 0.1, r1: 0.7, life: 280 }),
      ]);
    })));
  },
  /** Arcs crawl around the target and yellow stun sparks orbit its head. */
  static: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    await bolt(v, v.unitAnchor(fx.caster, 0.8), p, { color: C.stun, jag: 0.12, radius: 0.025, flickers: 1, life: 160 });
    await all([
      ...Array.from({ length: 5 }, (_, i) => later(v, i * 50, () => {
        const a = rand(0, Math.PI * 2);
        const b = a + rand(1, 2);
        const at = (x: number) => p.clone().add(new THREE.Vector3(Math.cos(x) * 0.45, rand(-0.3, 0.4), Math.sin(x) * 0.45));
        return bolt(v, at(a), at(b), { color: C.stun, jag: 0.1, radius: 0.02, life: 180 });
      })),
      spiral(v, up(p, 0.6), { color: C.stun, count: 6, turns: 2, height: 0.05, radius: 0.35, life: 700 }),
    ]);
  },

  // Shade Lynx -------------------------------------------------------------
  /** A diagonal triple rake in shadow violet. */
  claw: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    void lunge(v, fx.caster, fx.to, 0.5, 200);
    await v.wait(80);
    const yaw = heading(fx.from, fx.to);
    await all([
      ...[-0.16, 0, 0.16].map((d, i) => later(v, i * 35, () => slash(v, up(p, d), { color: i === 1 ? C.white : C.shade, radius: 0.58, yaw: yaw + 0.4, tilt: 0.7, arc: Math.PI * 0.65, thick: 0.09, life: 360 }))),
      later(v, 120, () => flash(v, p, { color: C.shade, size: 0.65, life: 280 })),
      later(v, 120, () => burst(v, p, { color: C.shade, count: 24, speed: 2.0, rise: 0.3, size: 18, life: 450 })),
    ]);
  },
  /** The lynx coils in shadow, then a huge crescent cut and a burst of darkness. */
  ambush: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    await cloud(v, fx.from, { color: C.void, puffs: 5, radius: 0.4, life: 260, opacity: 0.8 });
    void lunge(v, fx.caster, fx.to, 0.7, 180);
    await v.wait(60);
    v.shake(0.2, 220);
    await all([
      slash(v, p, { color: C.shade, radius: 0.85, yaw: heading(fx.from, fx.to), tilt: 0.35, arc: Math.PI * 1.1, thick: 0.1, life: 260 }),
      later(v, 60, () => slash(v, p, { color: C.white, radius: 0.7, yaw: heading(fx.from, fx.to), tilt: 0.35, arc: Math.PI * 0.9, thick: 0.04, life: 220 })),
      later(v, 80, () => burst(v, p, { color: C.shade, count: 26, speed: 2.8, rise: 0.4, gravity: -2, life: 450 })),
    ]);
  },
  /** A dashed leap trail, a dust ring on landing, then a downward rake. */
  pounce: async (fx) => {
    const v = fx.view;
    const land = fx.landing ? v.hexWorld(fx.landing) : fx.to;
    const pts = Array.from({ length: 8 }, (_, i) => {
      const k = i / 7;
      return fx.from.clone().lerp(land, k).setY(lerp(fx.from.y, land.y, k) + Math.sin(k * Math.PI) * 1.4 + 0.3);
    });
    await all([
      carry(v, fx.caster, land, 1.4, 320),
      ...pts.map((pt, i) => later(v, i * 35, () => flash(v, pt, { color: C.shade, size: 0.12, life: 300 }))),
    ]);
    await all([
      ring(v, land, { color: C.stone, r0: 0.2, r1: 0.9, width: 0.25, life: 320 }),
      ...hitPoints(fx, 0.6).map((p) => slash(v, p, { color: C.shade, radius: 0.45, yaw: heading(land, fx.to), tilt: Math.PI / 2 - 0.3, life: 220 })),
    ]);
  },
  /** The lynx dissolves into drifting motes and a shimmer ring. */
  camo: async (fx) => {
    const v = fx.view;
    const c = v.unitAnchor(fx.caster, 0.5);
    await all([
      burst(v, c, { color: C.shade, count: 26, speed: 0.6, rise: 0.8, gravity: 0, size: 12, life: 800 }),
      ring(v, fx.from, { color: C.shade, r0: 0.9, r1: 0.4, width: 0.08, life: 500 }),
      later(v, 200, () => ring(v, fx.from, { color: C.white, r0: 0.3, r1: 1, width: 0.04, life: 500 })),
    ]);
  },

  // Ink Octopus ------------------------------------------------------------
  /** A tentacle whips out along a curve, cracks, and snaps back. */
  lash: async (fx) => {
    const v = fx.view;
    const a = v.unitAnchor(fx.caster, 0.4);
    const [p] = hitPoints(fx, 0.5);
    const mid = a.clone().lerp(p, 0.5).add(new THREE.Vector3(0, 1.1, 0));
    await all([
      tube(v, [a, mid, p], { color: C.octo, radius: 0.1, grow: 180, hold: 90, shrink: 180, additive: false }),
      later(v, 160, () => all([flash(v, p, { color: C.white, size: 0.3, life: 140 }), burst(v, p, { color: C.octo, count: 10, speed: 1.6, rise: 0.5, life: 280 })])),
    ]);
  },
  /** A tentacle reaches out and its glowing suckers clamp on before it hauls back. */
  pull: async (fx) => {
    const v = fx.view;
    const a = v.unitAnchor(fx.caster, 0.4);
    const [p] = hitPoints(fx, 0.5);
    const mid = a.clone().lerp(p, 0.5).add(new THREE.Vector3(0, 0.8, 0));
    await all([
      tube(v, [a, mid, p], { color: C.octo, radius: 0.11, grow: 240, hold: 220, shrink: 240, additive: false }),
      later(v, 220, () => all([0, 1, 2].map((i) => later(v, i * 50, () => ring(v, p.clone().setY(p.y - 0.4 + i * 0.25), { color: C.petal, r0: 0.25, r1: 0.4, width: 0.3, life: 300, y: 0 }))))),
    ]);
  },
  /** An ink blob arcs over and bursts into a spreading black cloud. */
  ink: async (fx) => {
    const v = fx.view;
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.2, metalness: 0.4 }));
    await projectile(v, v.unitAnchor(fx.caster, 0.6), up(fx.to, 0.3), { obj: blob, arc: 1.2, life: 380, spin: true });
    await all([
      burst(v, up(fx.to, 0.3), { color: C.phase, count: 10, speed: 2, rise: 1, size: 10, life: 350 }),
      ...fx.area.map((h, i) => later(v, i * 30, () => cloud(v, v.hexWorld(h), { color: C.ink, puffs: 4, radius: 0.35, life: 900, opacity: 0.8, y: 0.2 }))),
    ]);
  },
  /** Glitch: red and cyan squares jitter around the target while a ring spins backwards. */
  jam: async (fx) => {
    const v = fx.view;
    const [p] = hitPoints(fx, 0.6);
    await bolt(v, v.unitAnchor(fx.caster, 0.7), p, { color: C.jamCyan, jag: 0.02, radius: 0.02, flickers: 0, life: 120 });
    const g = new THREE.Group();
    const sq: THREE.Mesh[] = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rand(0.08, 0.2), rand(0.04, 0.12)), glow(i % 2 ? C.jamRed : C.jamCyan, 0.9));
      g.add(m);
      sq.push(m);
    }
    g.position.copy(p);
    const done = v.addFx(g);
    await all([
      v.animate(600, (k) => {
        for (const m of sq) {
          if (Math.random() < 0.5) m.position.set(rand(-0.5, 0.5), rand(-0.5, 0.6), rand(-0.5, 0.5));
          m.lookAt(v.camera.position);
          (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
        }
      }).then(done),
      glyph(v, fx.to, { color: C.jamRed, points: 12, radius: 0.6, life: 600, spin: -6 }),
    ]);
  },
};

/** Charge-up effects for abilities that resolve later. */
const CHARGES: Record<string, Recipe> = {
  /** Dark clouds gather over the target while sparks climb the eel. */
  storm: async (fx) => {
    const v = fx.view;
    await all([
      cloud(v, fx.to, { color: C.storm, puffs: 6, radius: 0.9, y: 2.4, life: 800, opacity: 0.6 }),
      spiral(v, v.unitAnchor(fx.caster, 0), { color: C.volt, count: 12, turns: 2, height: 1.4, radius: 0.4, life: 700 }),
    ]);
  },
  /** A slowly turning flower glyph is drawn on the target hex. */
  bloom: async (fx) => {
    const v = fx.view;
    await all([
      glyph(v, fx.to, { color: C.petal, points: 5, radius: 0.9, life: 800, spin: 1.5 }),
      spiral(v, v.unitAnchor(fx.caster, 0.3), { color: C.heal, count: 10, turns: 1, height: 0.8, radius: 0.3, life: 600 }),
    ]);
  },
};

export const VFX_ABILITIES = Object.keys(RECIPES);
export const VFX_CHARGES = Object.keys(CHARGES);

/** Play an ability's effect ('charge' for the charge-up of a charged ability). Unknown ids get a simple flash. */
export function playFx(ability: string, fx: FxContext, phase: 'cast' | 'charge' = 'cast'): Promise<void> {
  const r = (phase === 'charge' ? CHARGES : RECIPES)[ability];
  return (r ?? fallback)(fx);
}

const fallback: Recipe = async (fx) => {
  await flash(fx.view, up(fx.to, 0.5), { color: C.white, size: 0.4 });
};
