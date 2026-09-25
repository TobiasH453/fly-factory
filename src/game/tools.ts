import * as THREE from "three";
import type { Particles } from "../world/effects";

export type ToolId = "command" | "sugar" | "bitter" | "blower" | "swat";

export interface SugarCube {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vy: number;
  amount: number; // 1 = fresh cube, 0 = eaten
  laced: number; // 0..1 bitter contamination
  landed: boolean;
}

interface Cloud {
  pos: THREE.Vector3;
  intensity: number;
  radius: number;
  t: number;
}

export interface Swat {
  mesh: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  done: boolean;
}

const tmp = new THREE.Vector3();

/** The boss's tools and the physical stimuli they create in the world. */
export class BossTools {
  cubes: SugarCube[] = [];
  clouds: Cloud[] = [];
  swat: Swat | null = null;
  blower: { mesh: THREE.Group; pos: THREE.Vector3; active: boolean };
  private cubeGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  private cubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, flatShading: true });
  private lacedMat = new THREE.MeshStandardMaterial({ color: 0xa8e063, roughness: 0.35, flatShading: true });
  private t = 0;
  onSwatImpact: ((s: Swat) => void) | null = null;

  constructor(private scene: THREE.Scene, private particles: Particles) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 12), new THREE.MeshStandardMaterial({ color: 0xff7a1a, flatShading: true }));
    body.rotation.x = Math.PI / 2;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.7, 2.2, 10), new THREE.MeshStandardMaterial({ color: 0x333333, flatShading: true }));
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = 1.8;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 0.3), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    handle.position.set(0, 1.1, -0.2);
    g.add(body, nozzle, handle);
    g.visible = false;
    scene.add(g);
    this.blower = { mesh: g, pos: new THREE.Vector3(), active: false };
  }

  dropSugar(at: THREE.Vector3, fromHeight = 9) {
    if (this.cubes.length > 6) this.removeCube(this.cubes[0]);
    const mesh = new THREE.Mesh(this.cubeGeo, this.cubeMat);
    mesh.castShadow = true;
    const pos = at.clone().setY(fromHeight);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.cubes.push({ mesh, pos, vy: 0, amount: 1, laced: 0, landed: false });
  }

  removeCube(c: SugarCube) {
    this.scene.remove(c.mesh);
    this.cubes = this.cubes.filter((x) => x !== c);
  }

  spray(at: THREE.Vector3) {
    this.clouds.push({ pos: at.clone().setY(1.5), intensity: 1, radius: 5, t: 0 });
    for (let k = 0; k < 60; k++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(9);
      this.particles.emit(at.clone().setY(1.5), v, { life: 2.5, size: 1.4, color: 0x8bd34a, drag: 2.2, gravity: -0.3 });
    }
  }

  startBlower(at: THREE.Vector3) {
    this.blower.active = true;
    this.blower.pos.copy(at).setY(2);
    this.blower.mesh.visible = true;
  }

  moveBlower(at: THREE.Vector3) {
    this.blower.pos.copy(at).setY(2);
  }

  stopBlower() {
    this.blower.active = false;
    this.blower.mesh.visible = false;
  }

  /** Swing a newspaper at `target` (the fly's head at launch), coming in along `approachDir`. */
  startSwat(target: THREE.Vector3, approachDir: THREE.Vector3) {
    if (this.swat && !this.swat.done) return false;
    const g = new THREE.Group();
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 5, 12), new THREE.MeshStandardMaterial({ color: 0xf2efe6, flatShading: true }));
    roll.rotation.z = Math.PI / 2;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0xd9534f }));
    band.rotation.z = Math.PI / 2;
    const print = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 3.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x777777, wireframe: true }));
    print.rotation.z = Math.PI / 2;
    g.add(roll, band, print);
    g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    const from = target.clone().addScaledVector(approachDir.clone().setY(0).normalize(), 7).setY(target.y + 8);
    g.position.copy(from);
    g.lookAt(target);
    this.scene.add(g);
    // random swing speed: fast swings sometimes beat the Giant Fiber
    this.swat = { mesh: g, from, to: target.clone(), t: 0, dur: 0.38 + Math.random() * 0.5, done: false };
    return true;
  }

  // ---------------------------------------------------------------- sensing
  /** sugar concentration (0..1) and bitterness (0..1) of food within reach of the mouth */
  tasteAt(mouth: THREE.Vector3): { sugar: number; bitter: number; cube: SugarCube | null } {
    let best: SugarCube | null = null;
    let bd = Infinity;
    for (const c of this.cubes) {
      if (!c.landed || c.amount <= 0) continue;
      const d = tmp.copy(c.pos).setY(0).distanceTo(mouth.clone().setY(0));
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (!best || bd > 2.6) return { sugar: 0, bitter: 0, cube: null };
    const reach = THREE.MathUtils.clamp((2.6 - bd) / 0.8, 0, 1);
    return { sugar: reach * (0.55 + 0.45 * best.amount), bitter: reach * best.laced, cube: best };
  }

  /** bitter aerosol at a point (0..1) */
  bitterAt(p: THREE.Vector3): number {
    let s = 0;
    for (const c of this.clouds) {
      const d = tmp.copy(c.pos).setY(0).distanceTo(p.clone().setY(0));
      s += c.intensity * THREE.MathUtils.clamp(1 - d / c.radius, 0, 1);
    }
    return Math.min(1, s);
  }

  /** wind from the leaf blower at a point (0..1) and its direction */
  windAt(p: THREE.Vector3): { strength: number; dir: THREE.Vector3 } {
    if (!this.blower.active) return { strength: 0, dir: new THREE.Vector3() };
    const dir = p.clone().sub(this.blower.pos).setY(0);
    const d = dir.length();
    return { strength: THREE.MathUtils.clamp(1 - (d - 3) / 11, 0, 1), dir: dir.normalize() };
  }

  /** closest nearby sugar cube a hungry fly could walk to */
  nearestCube(p: THREE.Vector3, maxDist = 18): SugarCube | null {
    let best: SugarCube | null = null;
    let bd = maxDist;
    for (const c of this.cubes) {
      if (!c.landed || c.amount <= 0.05) continue;
      const d = c.pos.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  update(dt: number, flyPos: THREE.Vector3) {
    this.t += dt;
    for (const c of this.cubes) {
      if (!c.landed) {
        c.vy -= 30 * dt;
        c.pos.y += c.vy * dt;
        if (c.pos.y <= 0.45) {
          c.pos.y = 0.45;
          c.landed = true;
          for (let k = 0; k < 8; k++) this.particles.emit(c.pos, new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).multiplyScalar(3), { life: 0.5, size: 0.35, color: 0xffffff, gravity: 8 });
        }
      }
      // bitter clouds lace sugar
      c.laced = Math.max(c.laced * Math.exp(-dt / 25), this.bitterAt(c.pos) * 0.9);
      c.mesh.material = c.laced > 0.25 ? this.lacedMat : this.cubeMat;
      const s = 0.25 + 0.75 * c.amount;
      c.mesh.scale.setScalar(s);
      c.mesh.position.copy(c.pos).setY(0.45 * s);
    }
    for (const c of this.cubes.filter((x) => x.amount <= 0.02)) this.removeCube(c);

    for (const c of this.clouds) {
      c.t += dt;
      c.intensity = Math.exp(-c.t / 4.5);
      if (Math.random() < dt * 12) {
        const v = new THREE.Vector3(Math.random() - 0.5, 0.2, Math.random() - 0.5).multiplyScalar(2);
        const p = c.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * c.radius, 0, (Math.random() - 0.5) * c.radius));
        this.particles.emit(p, v, { life: 1.8, size: 1.2 * c.intensity + 0.2, color: 0x8bd34a, drag: 1 });
      }
    }
    this.clouds = this.clouds.filter((c) => c.intensity > 0.03);

    if (this.blower.active) {
      const dir = flyPos.clone().sub(this.blower.pos).setY(0).normalize();
      this.blower.mesh.position.copy(this.blower.pos);
      this.blower.mesh.lookAt(this.blower.pos.clone().add(dir));
      for (let k = 0; k < 3; k++) {
        const v = dir.clone().multiplyScalar(14 + Math.random() * 6).add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.3) * 2, (Math.random() - 0.5) * 3));
        this.particles.emit(this.blower.pos.clone().addScaledVector(dir, 2.6), v, { life: 0.9, size: 0.3, color: 0xe8f6ff, drag: 0.6 });
      }
    }

    const s = this.swat;
    if (s && !s.done) {
      s.t += dt;
      const u = Math.min(1, s.t / s.dur);
      const e = u * u; // accelerating swing
      s.mesh.position.lerpVectors(s.from, s.to, e);
      s.mesh.rotation.x += dt * 2;
      if (u >= 1) {
        s.done = true;
        this.onSwatImpact?.(s);
        setTimeout(() => this.scene.remove(s.mesh), 450);
      }
    }
  }

  /** angular size (deg) of the incoming newspaper as seen from a point */
  loomAngle(eye: THREE.Vector3): number {
    const s = this.swat;
    if (!s || s.done) return 0;
    const d = Math.max(0.3, s.mesh.position.distanceTo(eye));
    return THREE.MathUtils.radToDeg(2 * Math.atan(2.5 / d));
  }
}
