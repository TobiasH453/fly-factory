import * as THREE from "three";

const lowPoly = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...extra });

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  return m;
}

export interface FlyPose {
  /** forward walking speed (units/s); negative = walking backwards */
  speed: number;
  /** yaw rate (rad/s) for leg animation */
  turn: number;
  /** 0..1 foreleg grooming intensity */
  groom: number;
  /** 0..1 proboscis extension */
  proboscis: number;
  /** 0..1 wing buzz */
  wings: number;
  /** 0..1 head wobble (dazed) */
  dazed: number;
  /** 0..1 collapsed/sitting */
  sit: number;
  /** eggs carried */
  carrying: number;
  /** golden eggs? */
  golden: boolean;
  /** head yaw offset (rad) */
  look: number;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  side: 1 | -1;
  idx: number;
  tripod: 0 | 1;
}

/** The worker fly: a procedural low-poly rig built from primitives. */
export class FlyRig {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly head = new THREE.Group();
  private proboscis: THREE.Group;
  private wings: THREE.Mesh[] = [];
  private legs: Leg[] = [];
  private eggs: THREE.Mesh[] = [];
  private eggMat = lowPoly(0xfff6e0);
  private goldMat = lowPoly(0xffc930, { metalness: 0.5, roughness: 0.3, emissive: 0x6b4a00, emissiveIntensity: 0.3 });
  private phase = 0;
  private groomPhase = 0;
  private wingPhase = 0;
  private t = 0;
  readonly hitbox: THREE.Mesh;

  constructor(opts: { hardHat?: boolean } = {}) {
    const bodyMat = lowPoly(0x9a6a3a);
    const darkMat = lowPoly(0x4a3020);
    const eyeMat = lowPoly(0xd8231f, { roughness: 0.35, emissive: 0x400000, emissiveIntensity: 0.4 });
    this.root.add(this.body);
    this.body.position.y = 1.25;

    const thorax = mesh(new THREE.SphereGeometry(0.75, 10, 8), bodyMat);
    thorax.scale.set(1, 0.9, 1.05);
    this.body.add(thorax);
    const abdomen = mesh(new THREE.SphereGeometry(0.8, 10, 8), bodyMat);
    abdomen.scale.set(0.95, 0.82, 1.35);
    abdomen.position.set(0, -0.05, -1.35);
    this.body.add(abdomen);
    for (let k = 0; k < 3; k++) {
      const band = mesh(new THREE.TorusGeometry(0.66 - k * 0.12, 0.09, 5, 14), darkMat, false);
      band.position.set(0, -0.05, -1.05 - k * 0.42);
      band.scale.set(1.1, 0.95, 1);
      this.body.add(band);
    }

    // head
    this.head.position.set(0, 0.2, 0.95);
    this.body.add(this.head);
    const skull = mesh(new THREE.SphereGeometry(0.5, 10, 8), darkMat);
    skull.scale.set(1.1, 0.95, 0.85);
    this.head.add(skull);
    for (const s of [-1, 1]) {
      const eye = mesh(new THREE.SphereGeometry(0.34, 10, 8), eyeMat);
      eye.position.set(0.36 * s, 0.1, 0.12);
      eye.scale.set(0.8, 1, 0.9);
      this.head.add(eye);
      const ant = mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.45, 5), darkMat);
      ant.position.set(0.12 * s, 0.35, 0.38);
      ant.rotation.set(0.5, 0, 0.35 * s);
      this.head.add(ant);
    }
    if (opts.hardHat !== false) {
      const hatMat = lowPoly(0xffd21f, { roughness: 0.4 });
      const dome = mesh(new THREE.SphereGeometry(0.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
      dome.position.set(0, 0.33, -0.05);
      dome.scale.set(1.05, 0.8, 1.05);
      this.head.add(dome);
      const brim = mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.06, 14), hatMat);
      brim.position.set(0, 0.33, 0.02);
      this.head.add(brim);
      const ridge = mesh(new THREE.BoxGeometry(0.12, 0.12, 0.9), hatMat);
      ridge.position.set(0, 0.7, -0.05);
      this.head.add(ridge);
    }
    // proboscis: pivot under the head
    this.proboscis = new THREE.Group();
    this.proboscis.position.set(0, -0.35, 0.25);
    const pro = mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.7, 6), darkMat);
    pro.position.y = -0.35;
    const tip = mesh(new THREE.SphereGeometry(0.14, 6, 5), lowPoly(0xcf8f70));
    tip.position.y = -0.72;
    this.proboscis.add(pro, tip);
    this.head.add(this.proboscis);

    // wings
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xcfefff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, roughness: 0.2,
    });
    for (const s of [-1, 1]) {
      const w = mesh(new THREE.CircleGeometry(0.8, 12), wingMat, false);
      w.geometry.scale(0.55, 1.4, 1);
      w.geometry.translate(0, -1.1, 0);
      w.position.set(0.3 * s, 0.55, -0.2);
      w.rotation.set(-Math.PI / 2 + 0.15, 0, 0.35 * s);
      this.wings.push(w);
      this.body.add(w);
    }

    // legs
    const legMat = darkMat;
    const zs = [0.45, 0.05, -0.4];
    for (const side of [-1, 1] as const) {
      for (let k = 0; k < 3; k++) {
        const hip = new THREE.Group();
        hip.position.set(0.55 * side, -0.35, zs[k]);
        const upper = mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.95, 5), legMat);
        upper.position.set(0.42 * side, 0.12, 0);
        upper.rotation.z = (Math.PI / 2 - 0.35) * side;
        hip.add(upper);
        const knee = new THREE.Group();
        knee.position.set(0.85 * side, 0.3, 0);
        const lower = mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.35, 5), legMat);
        lower.position.set(0.12 * side, -0.62, 0);
        lower.rotation.z = 0.18 * side;
        knee.add(lower);
        hip.add(knee);
        this.body.add(hip);
        const tripod = ((k + (side === 1 ? 1 : 0)) % 2) as 0 | 1;
        this.legs.push({ hip, knee, side, idx: k, tripod });
      }
    }

    // carried eggs
    for (let k = 0; k < 3; k++) {
      const egg = mesh(new THREE.SphereGeometry(0.34, 10, 8), this.eggMat);
      egg.scale.set(0.85, 1.15, 0.85);
      egg.position.set((k - 1) * 0.55, -0.55, 1.45);
      egg.visible = false;
      this.eggs.push(egg);
      this.body.add(egg);
    }

    // invisible generous click target
    this.hitbox = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    this.hitbox.position.y = 1.3;
    this.root.add(this.hitbox);
  }

  /** world position of the proboscis tip region (for taste) */
  mouthWorld(target = new THREE.Vector3()) {
    return this.head.localToWorld(target.set(0, -0.9, 0.4));
  }

  update(dt: number, p: FlyPose) {
    this.t += dt;
    const moving = Math.abs(p.speed) + Math.abs(p.turn) * 0.8;
    this.phase += dt * (moving * 2.4) * Math.sign(p.speed || 1);
    this.groomPhase += dt * 14;
    this.wingPhase += dt * 60;

    // body bob + sitting
    const bob = moving > 0.05 ? Math.abs(Math.sin(this.phase * 2)) * 0.06 : 0;
    this.body.position.y = 1.25 - p.sit * 0.75 + bob;
    this.body.rotation.x = -p.groom * 0.18 + p.sit * 0.1;

    // legs: tripod gait
    for (const L of this.legs) {
      const off = L.tripod === 0 ? 0 : Math.PI;
      const ph = this.phase + off;
      let swing = moving > 0.05 ? Math.sin(ph) * 0.45 : 0;
      let lift = moving > 0.05 ? Math.max(0, Math.cos(ph)) * 0.35 : 0;
      let kneeBend = 0;
      if (L.idx === 0 && p.groom > 0.05) {
        // forelegs up to the head, rubbing
        const g = Math.min(1, p.groom);
        const rub = Math.sin(this.groomPhase + (L.side === 1 ? 0 : Math.PI)) * 0.25;
        swing = THREE.MathUtils.lerp(swing, -1.0 + rub, g);
        lift = THREE.MathUtils.lerp(lift, 0.9, g);
        kneeBend = g * 1.1;
      }
      if (p.sit > 0) lift -= p.sit * 0.35;
      L.hip.rotation.y = swing * -L.side;
      L.hip.rotation.z = lift * L.side;
      L.knee.rotation.z = kneeBend * -L.side * 0.6;
    }

    // wings
    const buzz = Math.min(1, p.wings);
    for (let k = 0; k < this.wings.length; k++) {
      const s = k === 0 ? -1 : 1;
      const flap = buzz > 0.02 ? Math.sin(this.wingPhase) * 0.9 * buzz : 0;
      this.wings[k].rotation.set(-Math.PI / 2 + 0.15 + buzz * 0.9, flap * 0.3, (0.35 + buzz * 0.9 + flap) * s);
    }

    // head
    const wob = p.dazed > 0 ? Math.sin(this.t * 9) * 0.35 * p.dazed : 0;
    this.head.rotation.set(p.groom * 0.35 + p.proboscis * 0.2, p.look + wob, wob * 0.5);
    // proboscis extension
    const ext = THREE.MathUtils.clamp(p.proboscis, 0, 1);
    this.proboscis.scale.set(1, 0.25 + ext * 1.1, 1);
    this.proboscis.rotation.x = 0.5 - ext * 0.35;

    for (let k = 0; k < this.eggs.length; k++) {
      this.eggs[k].visible = k < p.carrying;
      this.eggs[k].material = p.golden ? this.goldMat : this.eggMat;
    }
  }
}

/** Geometry for the tiny show-off baby flies (merged into one mesh for instancing). */
export function babyFlyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.SphereGeometry(0.28, 6, 5);
  body.scale(0.9, 0.8, 1.5);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.2, 6, 5);
  head.translate(0, 0.03, 0.42);
  parts.push(head);
  for (const s of [-1, 1]) {
    const w = new THREE.CircleGeometry(0.35, 6);
    w.scale(0.6, 1.3, 1);
    w.rotateX(-Math.PI / 2);
    w.rotateY(0.5 * s);
    w.translate(0.3 * s, 0.18, -0.2);
    parts.push(w);
  }
  return mergeGeometries(parts);
}

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.computeVertexNormals();
    pos.push(...(g.getAttribute("position").array as Float32Array));
    nor.push(...(g.getAttribute("normal").array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
