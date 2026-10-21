// three.js board view. Reads GameState, never mutates it. Float math is fine
// here: nothing in the render layer feeds back into the rules.

import * as THREE from 'three';
import { DIRS, hexKey, type Dir, type Hex } from '../core/hex';
import { getMap } from '../core/map';
import { abilityArea } from '../core/engine';
import { getAbility, MONSTER_BY_ID } from '../core/monsters';
import type { GameState, TeamId, Unit } from '../core/types';
import { buildMonsterModel } from './models';

const SQRT3 = Math.sqrt(3);
const LEVEL = 0.42;
const BASE_Y = 0.3;
export const TEAM_COLORS = [0x38d6ff, 0xff7a3d] as const;
const TEAM_CSS = ['#38d6ff', '#ff7a3d'];

export function hexToWorld(h: Hex): THREE.Vector3 {
  return new THREE.Vector3(SQRT3 * (h.q + h.r / 2), 0, 1.5 * h.r);
}
const topY = (h: number) => BASE_Y + h * LEVEL;

export type HighlightKind = 'move' | 'target' | 'area' | 'danger' | 'facing' | 'select' | 'blocked';
const HL_COLORS: Record<HighlightKind, number> = {
  move: 0x3aa0ff,
  target: 0xffd23a,
  area: 0xff4d6d,
  danger: 0xff4d6d,
  facing: 0x7dffb0,
  select: 0xffffff,
  blocked: 0x7c8296,
};

interface Tween {
  start: number;
  dur: number;
  step: (k: number) => void;
  done: () => void;
}

interface UnitView {
  id: number;
  root: THREE.Group;
  model: THREE.Group;
  ring: THREE.Mesh;
  arrow: THREE.Mesh;
  label: HTMLDivElement;
  hpFill: HTMLDivElement;
  status: HTMLDivElement;
  tile: Hex;
  alive: boolean;
}

export class BoardView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  onTap: (hex: Hex | null) => void = () => {};
  /** Animation speed multiplier (spectator fast-forward). */
  speed = 1;

  private container: HTMLElement;
  private overlay: HTMLDivElement;
  private mapId: string;
  private rulesVersion: number;
  private tileMeshes = new Map<string, THREE.Mesh>();
  private tileHeights = new Map<string, number>();
  private highlights = new Map<string, THREE.Mesh>();
  private beaconRings: THREE.Mesh[] = [];
  private beaconCrystals: THREE.Mesh[] = [];
  private hazardGroup = new THREE.Group();
  /** Landing areas of charging abilities, so incoming blasts are visible. */
  private pendingGroup = new THREE.Group();
  private units = new Map<number, UnitView>();
  private tweens: Tween[] = [];
  private yawIndex = 0;
  private yaw = 0;
  private zoom = 1;
  private pan = new THREE.Vector3();
  private elevation = THREE.MathUtils.degToRad(38);
  private boardRadius: number;
  private activeUnit: number | null = null;
  private clock = new THREE.Clock();

  constructor(container: HTMLElement, state: GameState) {
    this.container = container;
    this.mapId = state.config.mapId;
    this.rulesVersion = state.config.rulesVersion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0b0f1a);
    container.appendChild(this.renderer.domElement);
    this.overlay = document.createElement('div');
    this.overlay.className = 'board-overlay';
    container.appendChild(this.overlay);

    const map = getMap(this.mapId, this.rulesVersion).def;
    this.boardRadius = Math.max(...map.tiles.map((t) => hexToWorld(t).length())) + 1.1;
    this.buildLights();
    this.buildBoard();
    this.scene.add(this.hazardGroup);
    this.scene.add(this.pendingGroup);
    for (const u of state.units) this.addUnit(u);
    this.sync(state);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindInput();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.container.innerHTML = '';
  }

  // -------------------------------------------------------------------------
  // Scene construction

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1408, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const c = sun.shadow.camera;
    c.left = c.bottom = -16;
    c.right = c.top = 16;
    c.near = 1;
    c.far = 50;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  private buildBoard(): void {
    const map = getMap(this.mapId, this.rulesVersion).def;
    const topColors = [0x4c6b4a, 0x5f7f52, 0x7a8d5c, 0x9a9a6e];
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3226, roughness: 0.95 });
    const roughTop = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x45434d, roughness: 0.9, flatShading: true });
    const lavaMat = new THREE.MeshStandardMaterial({ color: 0x5a1a08, emissive: 0xff5a1f, emissiveIntensity: 0.9, roughness: 0.6 });
    const topMats = topColors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const hlGeo = new THREE.CircleGeometry(0.9, 6);
    hlGeo.rotateX(-Math.PI / 2);
    hlGeo.rotateY(Math.PI / 6);

    for (const t of map.tiles) {
      const k = hexKey(t);
      const top = t.terrain === 'void' ? -0.35 : topY(t.h);
      const height = top + 1;
      const geo = new THREE.CylinderGeometry(0.97, 0.97, height, 6, 1);
      // CylinderGeometry's first vertex sits on +z, which is already pointy-top.
      const topMat = t.terrain === 'void' ? lavaMat : t.terrain === 'rough' ? roughTop : topMats[Math.min(t.h, 3)];
      const mesh = new THREE.Mesh(geo, [sideMat, topMat, sideMat]);
      const p = hexToWorld(t);
      mesh.position.set(p.x, top - height / 2, p.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.userData.hex = { q: t.q, r: t.r };
      this.scene.add(mesh);
      this.tileMeshes.set(k, mesh);
      this.tileHeights.set(k, t.h);
      if (t.terrain === 'void') mesh.castShadow = false;

      if (t.terrain === 'blocked') {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.75, 0), rockMat);
        rock.position.set(p.x, top + 0.45, p.z);
        rock.scale.set(1, 1.3, 1);
        rock.rotation.y = (t.q * 7 + t.r * 3) * 0.7;
        rock.castShadow = true;
        rock.userData.hex = { q: t.q, r: t.r };
        this.scene.add(rock);
      }
      const hl = new THREE.Mesh(
        hlGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      hl.position.set(p.x, top + 0.02, p.z);
      hl.visible = false;
      hl.renderOrder = 2;
      this.scene.add(hl);
      this.highlights.set(k, hl);
    }

    map.beacons.forEach((b) => {
      const p = hexToWorld(b);
      const top = topY(this.tileHeights.get(hexKey(b)) ?? 0);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.07, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0.4 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = Math.PI / 6;
      ring.position.set(p.x, top + 0.05, p.z);
      this.scene.add(ring);
      this.beaconRings.push(ring);
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.22, 0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, flatShading: true }),
      );
      crystal.position.set(p.x, top + 1.9, p.z);
      crystal.scale.set(1, 1.6, 1);
      this.scene.add(crystal);
      this.beaconCrystals.push(crystal);
    });
  }

  private addUnit(u: Unit): void {
    const def = MONSTER_BY_ID[u.defId];
    const root = new THREE.Group();
    const model = buildMonsterModel(def.id, def.color);
    model.scale.setScalar(1.35);
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.userData.unit = u.id;
      }
    });
    root.add(model);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.06, 6, 24),
      new THREE.MeshBasicMaterial({ color: TEAM_COLORS[u.team] }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.04;
    root.add(ring);
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.3, 3),
      new THREE.MeshBasicMaterial({ color: TEAM_COLORS[u.team] }),
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.04, 0.62);
    model.add(arrow);
    this.scene.add(root);

    const label = document.createElement('div');
    label.className = 'unit-label';
    label.innerHTML = `<div class="hp"><div class="hp-fill"></div></div><div class="status"></div>`;
    label.style.setProperty('--team', TEAM_CSS[u.team]);
    this.overlay.appendChild(label);
    this.units.set(u.id, {
      id: u.id,
      root,
      model,
      ring,
      arrow,
      label,
      hpFill: label.querySelector('.hp-fill') as HTMLDivElement,
      status: label.querySelector('.status') as HTMLDivElement,
      tile: u.pos,
      alive: true,
    });
    this.placeUnit(u.id, u.pos);
  }

  // -------------------------------------------------------------------------
  // State sync

  /** Snap every visual to the state (call after animations). */
  sync(state: GameState): void {
    for (const u of state.units) {
      const v = this.units.get(u.id)!;
      if (!u.alive) {
        v.root.visible = false;
        v.label.style.display = 'none';
        v.alive = false;
        continue;
      }
      // Scrubbing backwards can bring a unit back.
      v.root.visible = true;
      v.root.scale.setScalar(1);
      v.root.rotation.y = 0;
      v.label.style.display = '';
      v.alive = true;
      this.placeUnit(u.id, u.pos);
      this.setFacing(u.id, u.facing);
      v.hpFill.style.width = `${(100 * u.hp) / u.maxHp}%`;
      v.status.textContent = u.statuses.map((s) => STATUS_ICON[s.id]).join('');
      const camo = u.statuses.some((s) => s.id === 'camo');
      v.model.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'opacity' in m) {
          m.transparent = camo;
          m.opacity = camo ? 0.45 : 1;
        }
      });
    }
    state.beacons.forEach((b, i) => this.setBeaconOwner(i, b.owner));
    this.syncHazards(state);
    this.syncPending(state);
    this.activeUnit = state.turn?.unit ?? null;
  }

  setBeaconOwner(i: number, owner: TeamId | null): void {
    const color = owner === null ? 0xdddddd : TEAM_COLORS[owner];
    for (const mesh of [this.beaconRings[i], this.beaconCrystals[i]]) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.color.setHex(color);
      m.emissive.setHex(color);
    }
  }

  syncPending(state: GameState): void {
    this.pendingGroup.clear();
    const ring = new THREE.RingGeometry(0.62, 0.86, 6);
    ring.rotateX(-Math.PI / 2);
    ring.rotateY(Math.PI / 6);
    for (const c of state.pending) {
      const caster = state.units[c.caster];
      const ab = getAbility(caster.defId, c.ability);
      const mat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[caster.team], transparent: true, opacity: 0.8, depthWrite: false });
      for (const h of abilityArea(state, ab, caster.pos, c.target)) {
        const m = new THREE.Mesh(ring, mat);
        const p = this.unitWorld(h);
        m.position.set(p.x, p.y + 0.04, p.z);
        m.renderOrder = 3;
        this.pendingGroup.add(m);
      }
    }
  }

  syncHazards(state: GameState): void {
    this.hazardGroup.clear();
    const geo = new THREE.ConeGeometry(0.08, 0.35, 4);
    for (const z of state.hazards) {
      const mat = new THREE.MeshStandardMaterial({ color: TEAM_COLORS[z.team], emissive: TEAM_COLORS[z.team], emissiveIntensity: 0.5 });
      const p = hexToWorld(z.pos);
      const y = topY(this.tileHeights.get(hexKey(z.pos)) ?? 0);
      for (let i = 0; i < 5; i++) {
        const spike = new THREE.Mesh(geo, mat);
        const a = (i / 5) * Math.PI * 2 + z.pos.q;
        const rr = i === 0 ? 0 : 0.42;
        spike.position.set(p.x + Math.cos(a) * rr, y + 0.17, p.z + Math.sin(a) * rr);
        this.hazardGroup.add(spike);
      }
    }
  }

  private unitWorld(h: Hex): THREE.Vector3 {
    const p = hexToWorld(h);
    p.y = topY(this.tileHeights.get(hexKey(h)) ?? 0);
    return p;
  }

  private placeUnit(id: number, h: Hex): void {
    const v = this.units.get(id)!;
    v.tile = h;
    v.root.position.copy(this.unitWorld(h));
  }

  private setFacing(id: number, d: Dir): void {
    const v = this.units.get(id)!;
    const w = hexToWorld(DIRS[d]);
    v.model.rotation.y = Math.atan2(w.x, w.z);
  }

  // -------------------------------------------------------------------------
  // Highlights and labels

  clearHighlights(): void {
    for (const hl of this.highlights.values()) hl.visible = false;
  }

  highlight(hexes: Hex[], kind: HighlightKind): void {
    for (const h of hexes) {
      const hl = this.highlights.get(hexKey(h));
      if (!hl) continue;
      (hl.material as THREE.MeshBasicMaterial).color.setHex(HL_COLORS[kind]);
      (hl.material as THREE.MeshBasicMaterial).opacity = kind === 'area' || kind === 'select' ? 0.65 : kind === 'blocked' ? 0.4 : 0.5;
      hl.visible = true;
    }
  }

  /** Persistent tag above a unit, e.g. "85% · 32". Pass null to clear all. */
  setHp(id: number, hp: number, maxHp: number): void {
    this.units.get(id)!.hpFill.style.width = `${(100 * Math.max(0, hp)) / maxHp}%`;
  }

  previewFacing(id: number, d: Dir): void {
    this.setFacing(id, d);
  }

  setTags(tags: Map<number, string> | null): void {
    for (const v of this.units.values()) {
      let tag = v.label.querySelector('.tag') as HTMLDivElement | null;
      const text = tags?.get(v.id);
      if (!text) {
        tag?.remove();
        continue;
      }
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'tag';
        v.label.prepend(tag);
      }
      tag.textContent = text;
    }
  }

  floatText(at: Hex, text: string, cls: string): void {
    const el = document.createElement('div');
    el.className = `float-text ${cls}`;
    el.textContent = text;
    const world = this.unitWorld(at);
    world.y += 1.6;
    el.dataset.x = String(world.x);
    el.dataset.y = String(world.y);
    el.dataset.z = String(world.z);
    this.overlay.appendChild(el);
    this.positionEl(el, world);
    setTimeout(() => el.remove(), 1100);
  }

  // -------------------------------------------------------------------------
  // Animation

  private tween(dur: number, step: (k: number) => void): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.push({ start: performance.now(), dur: dur / this.speed, step, done: resolve });
    });
  }

  async animatePath(id: number, path: Hex[], msPerStep = 140): Promise<void> {
    const v = this.units.get(id)!;
    let from = v.tile;
    for (const h of path) {
      const a = this.unitWorld(from);
      const b = this.unitWorld(h);
      const hop = Math.abs(b.y - a.y) > 0.01 ? 0.5 : 0.12;
      const w = hexToWorld(h).sub(hexToWorld(from));
      v.model.rotation.y = Math.atan2(w.x, w.z);
      await this.tween(msPerStep, (k) => {
        v.root.position.lerpVectors(a, b, k);
        v.root.position.y += Math.sin(k * Math.PI) * hop;
      });
      v.tile = h;
      from = h;
    }
  }

  async animateSlide(id: number, path: Hex[]): Promise<void> {
    const v = this.units.get(id)!;
    const a = v.root.position.clone();
    const b = this.unitWorld(path[path.length - 1]);
    await this.tween(120 + 60 * path.length, (k) => v.root.position.lerpVectors(a, b, 1 - (1 - k) * (1 - k)));
    v.tile = path[path.length - 1];
  }

  async animateLunge(id: number, toward: Hex): Promise<void> {
    const v = this.units.get(id)!;
    const base = v.root.position.clone();
    const dir = this.unitWorld(toward).sub(base).setY(0);
    if (dir.lengthSq() < 0.001) {
      await this.tween(220, (k) => (v.root.position.y = base.y + Math.sin(k * Math.PI) * 0.35));
      return;
    }
    dir.normalize().multiplyScalar(0.45);
    v.model.rotation.y = Math.atan2(dir.x, dir.z);
    await this.tween(220, (k) => {
      const s = Math.sin(k * Math.PI);
      v.root.position.set(base.x + dir.x * s, base.y, base.z + dir.z * s);
    });
  }

  async animateHitFlash(id: number): Promise<void> {
    const v = this.units.get(id)!;
    const base = v.root.position.clone();
    await this.tween(200, (k) => {
      v.root.position.x = base.x + Math.sin(k * Math.PI * 6) * 0.08 * (1 - k);
    });
    v.root.position.copy(base);
  }

  async animateKo(id: number): Promise<void> {
    const v = this.units.get(id)!;
    v.label.style.display = 'none';
    await this.tween(450, (k) => {
      v.root.scale.setScalar(1 - k);
      v.root.rotation.y = k * Math.PI * 2;
    });
    v.root.visible = false;
    v.alive = false;
  }

  async animateArea(hexes: Hex[], color: number): Promise<void> {
    const flashes = hexes.map((h) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.85, 2.4, 6, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.position.copy(this.unitWorld(h)).setY(this.unitWorld(h).y + 1.2);
      this.scene.add(m);
      return m;
    });
    await this.tween(380, (k) => {
      for (const f of flashes) {
        (f.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k);
        f.scale.set(1, 0.4 + k, 1);
      }
    });
    for (const f of flashes) this.scene.remove(f);
  }

  wait(ms: number): Promise<void> {
    return this.tween(ms, () => {});
  }

  // -------------------------------------------------------------------------
  // Camera

  rotate(step: 1 | -1): void {
    const from = this.yaw;
    this.yawIndex += step;
    const to = (this.yawIndex * Math.PI) / 3;
    this.tween(260, (k) => {
      this.yaw = from + (to - from) * (1 - (1 - k) * (1 - k));
      this.updateCamera();
    });
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.updateCamera();
  }

  /** Half the view height (world units) that fits the whole board at zoom 1. */
  private baseHalfH(): number {
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
    // Portrait screens are width-limited, so look down more steeply to make hexes taller.
    this.elevation = THREE.MathUtils.degToRad(aspect < 0.9 ? 55 : 38);
    const R = this.boardRadius;
    return Math.max(R * Math.sin(this.elevation) + 1.2, (R + 0.3) / aspect);
  }

  /**
   * Pan and zoom so these hexes fill the view (auto-zoom). Falls back to the
   * whole board when they nearly cover it anyway.
   */
  frameHexes(hexes: Hex[]): void {
    if (!hexes.length) return;
    const halfH0 = this.baseHalfH();
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
    const sinE = Math.sin(this.elevation);
    const cosE = Math.cos(this.elevation);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const toward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const h of hexes) {
      const p = this.unitWorld(h);
      const sx = p.x * right.x + p.z * right.z;
      const sy = -(p.x * toward.x + p.z * toward.z) * sinE + p.y * cosE;
      x0 = Math.min(x0, sx - 1.1);
      x1 = Math.max(x1, sx + 1.1);
      y0 = Math.min(y0, sy - 1.8); // extra room for the board buttons
      y1 = Math.max(y1, sy + 2.2 * cosE + 0.9); // room for models and HP bars
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let zoom = Math.min(halfH0 / ((y1 - y0) / 2), (halfH0 * aspect) / ((x1 - x0) / 2));
    zoom = THREE.MathUtils.clamp(zoom, 1, 2.2);
    const targetPan = new THREE.Vector3();
    if (zoom >= 1.12) {
      const b = (0.6 * cosE - cy) / sinE;
      targetPan.copy(right).multiplyScalar(cx).addScaledVector(toward, b);
      targetPan.y = 0;
    } else zoom = 1;
    const fromPan = this.pan.clone();
    const fromZoom = this.zoom;
    this.tween(380, (k) => {
      const e = 1 - (1 - k) * (1 - k);
      this.pan.lerpVectors(fromPan, targetPan, e);
      this.zoom = fromZoom + (zoom - fromZoom) * e;
      this.updateCamera();
    });
  }

  /** Zoom back out to the whole board. */
  frameAll(): void {
    const fromPan = this.pan.clone();
    const fromZoom = this.zoom;
    this.tween(300, (k) => {
      this.pan.lerpVectors(fromPan, new THREE.Vector3(), k);
      this.zoom = fromZoom + (1 - fromZoom) * k;
      this.updateCamera();
    });
  }

  private updateCamera(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    const halfH = this.baseHalfH() / this.zoom;
    const cam = this.camera;
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    const target = new THREE.Vector3(this.pan.x, 0.6, this.pan.z);
    const dist = 40;
    cam.position.set(
      target.x + Math.sin(this.yaw) * Math.cos(this.elevation) * dist,
      target.y + Math.sin(this.elevation) * dist,
      target.z + Math.cos(this.yaw) * Math.cos(this.elevation) * dist,
    );
    cam.lookAt(target);
    cam.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Input: tap to pick, one-finger drag to pan, pinch / wheel to zoom.

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt: { x: number; y: number; t: number } | null = null;
    let dragged = false;
    let pinchDist = 0;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
        dragged = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        dragged = true;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) this.setZoom(this.zoom * (d / pinchDist));
        pinchDist = d;
        return;
      }
      if (downAt && Math.hypot(cur.x - downAt.x, cur.y - downAt.y) > 10) dragged = true;
      if (dragged) this.panBy(cur.x - prev.x, cur.y - prev.y);
    });
    const up = (e: PointerEvent) => {
      const wasSingle = pointers.size === 1;
      pointers.delete(e.pointerId);
      if (wasSingle && downAt && !dragged && e.type === 'pointerup') this.onTap(this.pick(e.clientX, e.clientY));
      if (pointers.size === 0) downAt = null;
      pinchDist = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private setZoom(z: number): void {
    this.zoom = THREE.MathUtils.clamp(z, 1, 3);
    if (this.zoom === 1) this.pan.set(0, 0, 0);
    this.updateCamera();
  }

  private panBy(dx: number, dy: number): void {
    if (this.zoom <= 1) return;
    const worldPerPx = (this.camera.top - this.camera.bottom) / (this.container.clientHeight || 1);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.pan.addScaledVector(right, -dx * worldPerPx);
    this.pan.addScaledVector(fwd, (-dy * worldPerPx) / Math.sin(this.elevation));
    this.pan.clampLength(0, this.boardRadius * 0.8);
    this.updateCamera();
  }

  /** Screen position (client px) of a hex's top center. Used by tests. */
  screenOf(h: Hex): { x: number; y: number } {
    const p = this.unitWorld(h).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  private raycaster = new THREE.Raycaster();

  pick(clientX: number, clientY: number): Hex | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [...this.tileMeshes.values()];
    for (const v of this.units.values()) if (v.alive) targets.push(v.model);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      const unitId = hit.object.userData.unit as number | undefined;
      if (unitId !== undefined) return this.units.get(unitId)!.tile;
      const hex = hit.object.userData.hex as Hex | undefined;
      if (hex) return hex;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Per-frame

  private positionEl(el: HTMLElement, world: THREE.Vector3): void {
    const p = world.clone().project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -100%)`;
  }

  private frame(): void {
    const now = performance.now();
    const t = this.clock.getElapsedTime();
    const running = this.tweens;
    this.tweens = [];
    for (const tw of running) {
      const k = Math.min(1, (now - tw.start) / tw.dur);
      tw.step(k);
      if (k >= 1) tw.done();
      else this.tweens.push(tw);
    }
    this.beaconCrystals.forEach((c, i) => {
      c.rotation.y = t * 0.8 + i;
      c.position.y = c.userData.baseY ?? (c.userData.baseY = c.position.y);
      c.position.y = c.userData.baseY + Math.sin(t * 2 + i) * 0.12;
    });
    const pulse = 0.45 + 0.4 * Math.abs(Math.sin(t * 3));
    for (const m of this.pendingGroup.children) ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = pulse;
    for (const v of this.units.values()) {
      if (!v.alive) continue;
      const active = v.id === this.activeUnit;
      v.ring.scale.setScalar(active ? 1 + Math.sin(t * 5) * 0.08 : 1);
      animateIdle(v.model, t + v.id);
      const head = v.root.position.clone();
      head.y += 1.75;
      this.positionEl(v.label, head);
    }
    for (const el of this.overlay.querySelectorAll<HTMLElement>('.float-text')) {
      this.positionEl(el, new THREE.Vector3(Number(el.dataset.x), Number(el.dataset.y), Number(el.dataset.z)));
    }
    this.renderer.render(this.scene, this.camera);
  }
}

function animateIdle(model: THREE.Group, t: number): void {
  const body = model.getObjectByName('body');
  if (body) body.position.y = (body.userData.baseY ??= body.position.y) + Math.sin(t * 2.2) * 0.03;
  for (const name of ['wingL', 'wingR']) {
    const w = model.getObjectByName(name);
    if (w) w.rotation.z = (name === 'wingL' ? 1 : -1) * (0.3 + Math.sin(t * 9) * 0.45);
  }
}

export const STATUS_ICON: Record<string, string> = {
  slow: '🐌',
  stun: '💫',
  poison: '☠',
  regen: '✚',
  shield: '🛡',
  thorns: '✴',
  camo: '👁',
  fortify: '⬢',
};

export const teamCss = (t: TeamId) => TEAM_CSS[t];
