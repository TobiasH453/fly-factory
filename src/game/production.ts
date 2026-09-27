import * as THREE from "three";
import type { Factory } from "../world/factory";
import type { Effects } from "./economy";

const TRAY_MAX = 12;
const EGG_GAP = 1.25;

interface BeltEgg {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  vy: number;
}

interface PipeEgg {
  mesh: THREE.Mesh;
  path: THREE.Vector3[];
  seg: number;
  u: number;
}

/** Egg dropper -> belt -> tray;  incubators -> pipe -> hatchery. */
export class Production {
  tray = 0;
  incub: number[][] = [[], []];
  private belt: BeltEgg[] = [];
  private pipe: PipeEgg[] = [];
  private dropT = 1.5;
  private eggGeo = new THREE.SphereGeometry(0.42, 8, 6);

  constructor(
    private f: Factory,
    private fx: () => Effects,
    private onHatch: (value: number) => void,
  ) {}

  private eggMesh(): THREE.Mesh {
    const m = new THREE.Mesh(this.eggGeo, this.fx().golden ? this.f.goldMat : this.f.eggMat);
    m.scale.set(0.85, 1.15, 0.85);
    m.castShadow = true;
    this.f.group.add(m);
    return m;
  }

  takeEggs(n: number): number {
    const k = Math.min(n, this.tray);
    this.tray -= k;
    return k;
  }

  /** incubator with free room, preferring the emptiest; -1 if all full */
  freeIncubator(): number {
    const fx = this.fx();
    let best = -1;
    for (let i = 0; i < fx.incubators; i++) {
      if (this.incub[i].length < fx.incubCapacity && (best < 0 || this.incub[i].length < this.incub[best].length)) best = i;
    }
    return best;
  }

  deposit(i: number, n: number): number {
    const room = this.fx().incubCapacity - this.incub[i].length;
    const k = Math.max(0, Math.min(room, n));
    for (let j = 0; j < k; j++) this.incub[i].push(-j * 0.35);
    return k;
  }

  update(dt: number) {
    const fx = this.fx();
    const start = this.f.beltStart;
    const end = this.f.beltEnd;
    // dropper
    this.dropT -= dt;
    const blocked = this.belt.some((e) => e.x - start.x < EGG_GAP);
    if (this.dropT <= 0 && !blocked) {
      this.dropT = fx.dropInterval * (0.85 + Math.random() * 0.3);
      const m = this.eggMesh();
      this.belt.push({ mesh: m, x: start.x, y: this.f.dropperSpout.y, vy: 0 });
      this.f.pumpDropper();
    }
    // belt (eggs queue up when the tray is full)
    this.belt.sort((a, b) => b.x - a.x);
    let limit = end.x;
    for (let k = 0; k < this.belt.length; k++) {
      const e = this.belt[k];
      if (e.y > start.y) {
        e.vy -= 30 * dt;
        e.y = Math.max(start.y + 0.45, e.y + e.vy * dt);
        if (e.y <= start.y + 0.45) e.y = start.y;
      }
      e.x = Math.min(limit, e.x + fx.beltSpeed * dt);
      limit = e.x - EGG_GAP;
      e.mesh.position.set(e.x, e.y + 0.45, start.z);
      e.mesh.rotation.z -= fx.beltSpeed * dt * 1.5;
    }
    const first = this.belt[0];
    if (first && first.x >= end.x - 1e-6 && this.tray < TRAY_MAX) {
      this.tray++;
      this.f.group.remove(first.mesh);
      this.belt.shift();
    }
    this.f.setTrayCount(this.tray, fx.golden);

    // incubators
    for (let i = 0; i < 2; i++) {
      const eggs = this.incub[i];
      for (let k = 0; k < eggs.length; k++) eggs[k] += dt;
      while (eggs.length && eggs[0] >= fx.incubTime) {
        eggs.shift();
        const m = this.eggMesh();
        this.pipe.push({ mesh: m, path: this.f.pipePath(i), seg: 0, u: 0 });
      }
      this.f.setIncubatorEggs(i, eggs.length, fx.golden);
      const inc = this.f.incubators[i];
      if (inc.group.visible) {
        const pct = eggs.length ? Math.min(90, Math.floor((Math.max(0, eggs[0]) / fx.incubTime) * 10) * 10) : 0;
        inc.label.set(eggs.length ? `INCUBATOR  ${eggs.length}/${fx.incubCapacity} · ${pct}%` : `INCUBATOR  0/${fx.incubCapacity}`);
      }
    }
    // pipe to hatchery
    for (let k = this.pipe.length - 1; k >= 0; k--) {
      const p = this.pipe[k];
      const a = p.path[p.seg];
      const b = p.path[p.seg + 1];
      const len = a.distanceTo(b) || 1;
      p.u += (12 * dt) / len;
      if (p.u >= 1) {
        p.u = 0;
        p.seg++;
        if (p.seg >= p.path.length - 1) {
          this.f.group.remove(p.mesh);
          this.pipe.splice(k, 1);
          this.f.flashHatch();
          this.onHatch(fx.flyValue);
          continue;
        }
      }
      p.mesh.position.lerpVectors(p.path[p.seg], p.path[p.seg + 1], p.u);
    }
  }
}
