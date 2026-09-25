import * as THREE from "three";
import { Label } from "./labels";

const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, flatShading: true, ...extra });

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.castShadow = true;
  b.receiveShadow = true;
  return b;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, seg = 16) {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  c.castShadow = true;
  c.receiveShadow = true;
  return c;
}

function studTexture(base: string, stud: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(0,0,0,0.08)";
  g.lineWidth = 3;
  g.strokeRect(0, 0, 128, 128);
  for (const [x, y] of [[32, 32], [96, 32], [32, 96], [96, 96]]) {
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.beginPath();
    g.arc(x + 3, y + 4, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = stud;
    g.beginPath();
    g.arc(x, y, 18, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function beltTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b2f36";
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = "#3d434d";
  for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 14, 32);
  g.fillStyle = "#f5c518";
  for (let x = 0; x < 128; x += 32) {
    g.beginPath();
    g.moveTo(x + 18, 8);
    g.lineTo(x + 28, 16);
    g.lineTo(x + 18, 24);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export interface Incubator {
  group: THREE.Group;
  dome: THREE.Mesh;
  eggSlots: THREE.Mesh[];
  label: Label;
  deposit: THREE.Vector3;
  pipeStart: THREE.Vector3;
  lamp: THREE.PointLight;
}

export const BOUNDS = { minX: -40, maxX: 40, minZ: -27, maxZ: 27 };

/** Static factory geometry + handles the game animates. */
export class Factory {
  readonly group = new THREE.Group();
  readonly obstacles: Obstacle[] = [];
  readonly clickables: THREE.Object3D[] = [];
  readonly beltTextures: THREE.Texture[] = [];

  // key points
  readonly dropperSpout = new THREE.Vector3(-30, 3.2, -15);
  readonly beltStart = new THREE.Vector3(-30, 1.25, -15);
  readonly beltEnd = new THREE.Vector3(-12.5, 1.25, -15);
  readonly trayPos = new THREE.Vector3(-9, 0, -15);
  readonly pickup = new THREE.Vector3(-9, 0, -10.8);
  readonly hatchery = new THREE.Vector3(32, 0, -8);
  readonly hatchTop = new THREE.Vector3(32, 7.2, -8);
  readonly sugarStation = new THREE.Vector3(-28, 0, 14);
  readonly sugarFeedPoint = new THREE.Vector3(-28, 0, 17.6);
  readonly idleSpot = new THREE.Vector3(0, 0, 2);

  trayEggs: THREE.Mesh[] = [];
  incubators: Incubator[] = [];
  dispenser!: THREE.Group;
  dropper!: THREE.Group;
  hatch!: THREE.Group;
  monitor!: THREE.Mesh;
  scrubber!: THREE.Group;
  neonSign!: THREE.Group;
  private dropperPiston!: THREE.Mesh;
  private hatchLight!: THREE.PointLight;
  private fans: THREE.Object3D[] = [];
  private t = 0;
  eggMat = mat(0xfff6e0);
  goldMat = mat(0xffc930, { metalness: 0.5, roughness: 0.3, emissive: 0x6b4a00, emissiveIntensity: 0.3 });

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.buildShell();
    this.buildDropper();
    this.buildBelt(this.beltStart, this.beltEnd);
    this.buildTray();
    this.addIncubator(new THREE.Vector3(8, 0, -16));
    this.addIncubator(new THREE.Vector3(21, 0, -16), false);
    this.buildHatchery();
    this.buildDispenser();
    this.buildBossOffice();
    this.buildMonitor();
    this.buildScrubber();
    this.buildNeon();
  }

  private buildShell() {
    const floorTex = studTexture("#6fbf4a", "#7fd35a");
    floorTex.repeat.set(42, 30);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(84, 1, 60), mat(0xffffff, { map: floorTex, flatShading: false }));
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    floor.name = "floor";
    this.group.add(floor);
    // work floor (grey studs) under the production line
    const workTex = studTexture("#9aa3ad", "#aab3bd");
    workTex.repeat.set(36, 11);
    const work = new THREE.Mesh(new THREE.BoxGeometry(72, 0.12, 22), mat(0xffffff, { map: workTex, flatShading: false }));
    work.position.set(0, 0.06, -14);
    work.receiveShadow = true;
    this.group.add(work);
    // outer baseplate
    const outerTex = studTexture("#4f9a38", "#5aab41");
    outerTex.repeat.set(80, 60);
    const outer = new THREE.Mesh(new THREE.BoxGeometry(320, 1, 240), mat(0xffffff, { map: outerTex, flatShading: false }));
    outer.position.y = -0.62;
    outer.receiveShadow = true;
    this.group.add(outer);

    const wallMat = mat(0xe8e2d6);
    const trim = mat(0xd9534f);
    this.group.add(box(84, 14, 1, wallMat, 0, 7, -30.5));
    this.group.add(box(1, 14, 61, wallMat, -42.5, 7, 0));
    this.group.add(box(1, 14, 61, wallMat, 42.5, 7, 0));
    this.group.add(box(84, 1, 1.4, trim, 0, 14.2, -30.5));
    this.group.add(box(1.4, 1, 61, trim, -42.5, 14.2, 0));
    this.group.add(box(1.4, 1, 61, trim, 42.5, 14.2, 0));
    // windows
    const glass = mat(0xbfe6ff, { emissive: 0x3a6f95, emissiveIntensity: 0.35 });
    for (const z of [-18, -4, 10, 22]) {
      const w1 = box(0.3, 4, 7, glass, -42, 8.5, z);
      const w2 = box(0.3, 4, 7, glass, 42, 8.5, z);
      w1.castShadow = w2.castShadow = false;
      this.group.add(w1, w2);
    }
    // yellow safety stripes along the production floor
    const stripe = mat(0xf5c518);
    this.group.add(box(72, 0.14, 0.4, stripe, 0, 0.08, -3));
    // factory sign on the back wall
    const sign = new Label("FLY FACTORY", { size: 3.4, bg: "#d9534f", fg: "#fff", border: "#fff" });
    sign.sprite.position.set(-18, 11.2, -29.7);
    this.group.add(sign.sprite);
  }

  private buildDropper() {
    const g = new THREE.Group();
    g.position.set(-30, 0, -21);
    const purple = mat(0x7b4bd8);
    const dark = mat(0x3b2a66);
    g.add(box(7, 6, 6, purple, 0, 3, 0));
    g.add(box(7.4, 0.6, 6.4, dark, 0, 6.2, 0));
    // hopper full of eggs
    const hopper = cyl(3.2, 1.6, 3, mat(0xb9a4f5, { transparent: true, opacity: 0.75 }), 8);
    hopper.position.set(0, 8, 0);
    g.add(hopper);
    for (let k = 0; k < 9; k++) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), this.eggMat);
      e.scale.set(0.85, 1.15, 0.85);
      e.position.set(Math.cos(k * 1.9) * 1.6 * ((k % 3) / 3 + 0.3), 8.6 + (k % 2) * 0.5, Math.sin(k * 1.9) * 1.4 * ((k % 3) / 3 + 0.3));
      g.add(e);
    }
    // spout pointing at the belt
    const spout = cyl(0.8, 0.8, 3, dark, 10);
    spout.rotation.x = Math.PI / 2;
    spout.position.set(0, 3.2, 3.6);
    g.add(spout);
    this.dropperPiston = box(1.2, 0.6, 1.2, mat(0xf5c518), 0, 4.6, 2.2);
    g.add(this.dropperPiston);
    const label = new Label("EGG DROPPER", { size: 1.3, bg: "#3b2a66", fg: "#fff" });
    label.sprite.position.set(0, 11.2, 0);
    g.add(label.sprite);
    this.dropper = g;
    this.group.add(g);
    this.obstacles.push({ x: -30, z: -21, r: 5 });
  }

  private buildBelt(a: THREE.Vector3, b: THREE.Vector3) {
    const len = a.distanceTo(b);
    const tex = beltTexture();
    tex.repeat.set(len / 2, 1);
    this.beltTextures.push(tex);
    const frame = box(len + 0.8, 1, 2.8, mat(0x55606e), (a.x + b.x) / 2, 0.5, a.z);
    const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 2.2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    top.position.set((a.x + b.x) / 2, 1.05, a.z);
    top.receiveShadow = true;
    this.group.add(frame, top);
    for (let x = a.x; x <= b.x; x += 3) {
      const leg = box(0.3, 0.9, 2.4, mat(0x3b434d), x, 0.45, a.z);
      this.group.add(leg);
    }
    this.obstacles.push({ x: (a.x + b.x) / 2, z: a.z, r: 2 });
  }

  private buildTray() {
    const g = new THREE.Group();
    g.position.copy(this.trayPos);
    const wood = mat(0xc78a4a);
    g.add(box(5, 0.8, 4.4, wood, 0, 0.9, 0));
    g.add(box(5.4, 0.9, 0.4, mat(0xa06a35), 0, 1.5, -2.2));
    g.add(box(5.4, 0.9, 0.4, mat(0xa06a35), 0, 1.5, 2.2));
    g.add(box(0.4, 0.9, 4.4, mat(0xa06a35), -2.6, 1.5, 0));
    g.add(box(0.4, 0.9, 4.4, mat(0xa06a35), 2.6, 1.5, 0));
    g.add(box(4.6, 0.5, 4, mat(0x6d4a2a), 0, 0.25, 0));
    for (let k = 0; k < 12; k++) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), this.eggMat);
      e.scale.set(0.85, 1.15, 0.85);
      const col = k % 4;
      const row = Math.floor(k / 4) % 3;
      const layer = k >= 12 ? 1 : 0;
      e.position.set(-1.6 + col * 1.07, 1.75 + layer * 0.7, -1.2 + row * 1.2);
      e.castShadow = true;
      e.visible = false;
      g.add(e);
      this.trayEggs.push(e);
    }
    const label = new Label("EGG TRAY", { size: 1.1, bg: "#a06a35", fg: "#fff" });
    label.sprite.position.set(0, 4.2, 0);
    g.add(label.sprite);
    this.group.add(g);
    this.obstacles.push({ x: this.trayPos.x, z: this.trayPos.z, r: 3.2 });
  }

  private addIncubator(pos: THREE.Vector3, visible = true) {
    const g = new THREE.Group();
    g.position.copy(pos);
    g.add(cyl(3.6, 3.9, 1.8, mat(0xe0663a), 16).translateY(0.9));
    g.add(cyl(3.7, 3.7, 0.3, mat(0x8a3a20), 16).translateY(1.9));
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(3.3, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.38, roughness: 0.1, emissive: 0xff8a00, emissiveIntensity: 0.15 }),
    );
    dome.position.y = 2;
    g.add(dome);
    const lamp = new THREE.PointLight(0xff9a3c, 6, 10, 2);
    lamp.position.set(0, 4, 0);
    g.add(lamp);
    const slots: THREE.Mesh[] = [];
    for (let k = 0; k < 6; k++) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), this.eggMat);
      e.scale.set(0.85, 1.15, 0.85);
      const a = (k / 6) * Math.PI * 2;
      e.position.set(Math.cos(a) * 1.5, 2.6, Math.sin(a) * 1.5);
      e.visible = false;
      g.add(e);
      slots.push(e);
    }
    // pipe to the hatchery (goes up from the dome)
    const pipeMat = mat(0x9fb3c8, { metalness: 0.4, roughness: 0.4 });
    const up = cyl(0.55, 0.55, 5, pipeMat, 10);
    up.position.set(0, 7.2, -1.2);
    g.add(up);
    const label = new Label(`INCUBATOR`, { size: 1.1, bg: "#8a3a20", fg: "#fff" });
    label.sprite.position.set(0, 11, 0);
    g.add(label.sprite);
    g.visible = visible;
    this.group.add(g);
    const inc: Incubator = {
      group: g, dome, eggSlots: slots, label,
      deposit: new THREE.Vector3(pos.x, 0, pos.z + 5.2),
      pipeStart: new THREE.Vector3(pos.x, 9.7, pos.z - 1.2),
      lamp,
    };
    this.incubators.push(inc);
    if (visible) this.obstacles.push({ x: pos.x, z: pos.z, r: 4.3 });
    // overhead pipe run to the hatchery
    const run = new THREE.Vector3(this.hatchTop.x, 9.7, pos.z - 1.2);
    const lenX = run.x - inc.pipeStart.x;
    const horiz = cyl(0.55, 0.55, lenX, pipeMat, 10);
    horiz.rotation.z = Math.PI / 2;
    horiz.position.set(inc.pipeStart.x + lenX / 2, 9.7, pos.z - 1.2);
    horiz.visible = visible;
    horiz.name = "pipe";
    this.group.add(horiz);
    (inc as Incubator & { pipe?: THREE.Mesh }).pipe = horiz;
  }

  showIncubator(i: number) {
    const inc = this.incubators[i] as Incubator & { pipe?: THREE.Mesh };
    if (inc.group.visible) return;
    inc.group.visible = true;
    if (inc.pipe) inc.pipe.visible = true;
    this.obstacles.push({ x: inc.group.position.x, z: inc.group.position.z, r: 4.3 });
  }

  /** path an incubated egg takes to the hatchery */
  pipePath(i: number): THREE.Vector3[] {
    const inc = this.incubators[i];
    const p0 = inc.group.position.clone().setY(3);
    return [p0, inc.pipeStart.clone(), new THREE.Vector3(this.hatchTop.x, 9.7, inc.pipeStart.z),
      new THREE.Vector3(this.hatchTop.x, 9.7, this.hatchTop.z), this.hatchTop.clone().setY(6)];
  }

  private buildHatchery() {
    const g = new THREE.Group();
    g.position.copy(this.hatchery);
    const teal = mat(0x1fb5a8);
    g.add(box(6, 5, 6, teal, 0, 2.5, 0));
    g.add(box(6.4, 0.6, 6.4, mat(0x0f6e66), 0, 5.2, 0));
    const tube = cyl(1.6, 2.2, 2.4, mat(0xc7fff8, { transparent: true, opacity: 0.6 }), 12);
    tube.position.y = 6.6;
    g.add(tube);
    // pipe from the incubators arrives from above
    const drop = cyl(0.55, 0.55, 3.5, mat(0x9fb3c8, { metalness: 0.4, roughness: 0.4 }), 10);
    drop.position.set(0, 9.5, 0);
    g.add(drop);
    this.hatchLight = new THREE.PointLight(0x7dfff0, 0, 12, 2);
    this.hatchLight.position.set(0, 8, 0);
    g.add(this.hatchLight);
    const label = new Label("HATCHERY", { size: 1.3, bg: "#0f6e66", fg: "#fff" });
    label.sprite.position.set(0, 12.6, 0);
    g.add(label.sprite);
    this.hatch = g;
    this.group.add(g);
    this.obstacles.push({ x: this.hatchery.x, z: this.hatchery.z, r: 4.6 });
    // launch pad
    const pad = cyl(3.4, 3.4, 0.2, mat(0x19d3c5, { emissive: 0x0a5a55, emissiveIntensity: 0.5 }), 20);
    pad.position.set(this.hatchery.x - 6.5, 0.1, this.hatchery.z + 4);
    this.group.add(pad);
  }

  flashHatch() {
    this.hatchLight.intensity = 30;
  }

  private buildDispenser() {
    const g = new THREE.Group();
    g.position.copy(this.sugarStation);
    const red = mat(0xe8423f);
    g.add(box(4, 5.5, 3, red, 0, 2.75, 0));
    const globe = new THREE.Mesh(new THREE.SphereGeometry(2, 14, 10), mat(0xe6f7ff, { transparent: true, opacity: 0.5, roughness: 0.1 }));
    globe.position.y = 7.2;
    g.add(globe);
    for (let k = 0; k < 10; k++) {
      const cube = box(0.55, 0.55, 0.55, mat(0xffffff), Math.cos(k * 2.3) * 1.1, 6.5 + (k % 3) * 0.45, Math.sin(k * 2.3) * 1.1);
      cube.rotation.set(k, k * 0.7, 0);
      g.add(cube);
    }
    g.add(box(1.6, 0.8, 0.6, mat(0x333333), 0, 1.4, 1.6));
    const label = new Label("SUGAR BAR", { size: 1.2, bg: "#b22b28", fg: "#fff" });
    label.sprite.position.set(0, 10.3, 0);
    g.add(label.sprite);
    g.visible = false;
    this.dispenser = g;
    this.group.add(g);
  }

  showDispenser() {
    if (this.dispenser.visible) return;
    this.dispenser.visible = true;
    this.obstacles.push({ x: this.sugarStation.x, z: this.sugarStation.z, r: 3 });
  }

  private buildBossOffice() {
    const g = new THREE.Group();
    g.position.set(31, 0, 19);
    const plat = mat(0x5b6b7d);
    g.add(box(14, 4, 10, plat, 0, 2, 0));
    const glass = new THREE.MeshStandardMaterial({ color: 0xaee3ff, transparent: true, opacity: 0.35, roughness: 0.05 });
    const rail1 = new THREE.Mesh(new THREE.BoxGeometry(14, 2, 0.2), glass);
    rail1.position.set(0, 5, -5);
    const rail2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 10), glass);
    rail2.position.set(-7, 5, 0);
    g.add(rail1, rail2);
    g.add(box(5, 1.4, 2.4, mat(0x7a4b2a), 0, 4.7, -1));
    g.add(box(1.8, 2.6, 1.8, mat(0x222222), 0, 5.3, 1.3));
    g.add(box(1.4, 1, 0.1, mat(0x111111, { emissive: 0x2255ff, emissiveIntensity: 0.6 }), 0, 6, -1.8));
    // stairs
    for (let k = 0; k < 5; k++) g.add(box(3, 0.8 * (k + 1), 1.2, plat, -8.6 + 0, 0.4 * (k + 1), -4 + k * 1.2 + 6));
    const label = new Label("BOSS OFFICE", { size: 1.3, bg: "#222", fg: "#ffd21f" });
    label.sprite.position.set(0, 9, 0);
    g.add(label.sprite);
    this.group.add(g);
    this.obstacles.push({ x: 31, z: 19, r: 8 });
  }

  private buildMonitor() {
    const frame = box(21, 12, 0.8, mat(0x1d232b), 14, 7.6, -29.8);
    this.group.add(frame);
    this.monitor = new THREE.Mesh(new THREE.PlaneGeometry(20, 11), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.monitor.position.set(14, 7.6, -29.35);
    this.group.add(this.monitor);
    const label = new Label("WORKER #1 · LIVE BRAIN ACTIVITY", { size: 1.0, bg: "#1d232b", fg: "#7dfff0" });
    label.sprite.position.set(14, 14.4, -29.2);
    this.group.add(label.sprite);
  }

  private buildScrubber() {
    const g = new THREE.Group();
    g.position.set(-14, 0, 20);
    g.add(box(4, 6, 4, mat(0x4aa3df), 0, 3, 0));
    for (const s of [-1, 1]) {
      const fan = new THREE.Group();
      fan.position.set(s * 1.3, 4.2, 2.05);
      for (let k = 0; k < 4; k++) {
        const blade = box(0.25, 1.1, 0.05, mat(0xffffff), 0, 0.45, 0);
        const holder = new THREE.Group();
        holder.rotation.z = (k * Math.PI) / 2;
        holder.add(blade);
        fan.add(holder);
      }
      g.add(fan);
      this.fans.push(fan);
    }
    const label = new Label("AIR SCRUBBER", { size: 1.0, bg: "#2a6f9e", fg: "#fff" });
    label.sprite.position.set(0, 7.6, 0);
    g.add(label.sprite);
    g.visible = false;
    this.scrubber = g;
    this.group.add(g);
  }

  showScrubber() {
    if (this.scrubber.visible) return;
    this.scrubber.visible = true;
    this.obstacles.push({ x: -14, z: 20, r: 3 });
  }

  private buildNeon() {
    const g = new THREE.Group();
    const l = new Label("★ FLY TYCOON ★", { size: 3, fg: "#ff5ad8" });
    l.sprite.position.set(-18, 5.5, -29.4);
    g.add(l.sprite);
    const light = new THREE.PointLight(0xff5ad8, 20, 18, 2);
    light.position.set(-18, 6, -27);
    g.add(light);
    g.visible = false;
    this.neonSign = g;
    this.group.add(g);
  }

  setTrayCount(n: number, golden: boolean) {
    this.trayEggs.forEach((e, i) => {
      e.visible = i < n;
      e.material = golden ? this.goldMat : this.eggMat;
    });
  }

  setIncubatorEggs(i: number, n: number, golden: boolean) {
    this.incubators[i].eggSlots.forEach((e, k) => {
      e.visible = k < n;
      e.material = golden ? this.goldMat : this.eggMat;
    });
  }

  pumpDropper() {
    this.dropperPiston.position.y = 3.9;
  }

  update(dt: number, beltSpeed: number) {
    this.t += dt;
    for (const t of this.beltTextures) t.offset.x -= (dt * beltSpeed) / 2;
    this.dropperPiston.position.y += (4.6 - this.dropperPiston.position.y) * Math.min(1, dt * 6);
    this.hatchLight.intensity *= Math.exp(-dt * 4);
    for (const f of this.fans) f.rotation.z += dt * 12;
    this.incubators.forEach((inc, i) => {
      inc.lamp.intensity = 5 + Math.sin(this.t * 3 + i) * 1.5;
    });
  }
}
