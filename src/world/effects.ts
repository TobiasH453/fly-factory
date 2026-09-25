import * as THREE from "three";
import { Label } from "./labels";

interface Particle {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
  drag: number;
  gravity: number;
}

/** Simple CPU particle system rendered as a single Points object. */
export class Particles {
  readonly points: THREE.Points;
  private ps: Particle[] = [];
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;

  constructor(scene: THREE.Scene, private max = 1500) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: `
        attribute float size; varying vec3 vColor; varying float vA; uniform float scale;
        void main(){ vColor = color; vA = clamp(size*4.0, 0.0, 1.0);
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vColor; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard;
          gl_FragColor = vec4(vColor, (1.0 - r*4.0) * 0.85 * vA); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, opts: { life?: number; size?: number; color?: number; drag?: number; gravity?: number } = {}) {
    if (this.ps.length >= this.max) {
      const dead = this.ps.findIndex((q) => !q.alive);
      if (dead < 0) return;
      this.ps.splice(dead, 1);
    }
    this.ps.push({
      alive: true, p: p.clone(), v: v.clone(), life: 0, max: opts.life ?? 1,
      size: opts.size ?? 0.5, color: new THREE.Color(opts.color ?? 0xffffff),
      drag: opts.drag ?? 1.5, gravity: opts.gravity ?? 0,
    });
  }

  burst(p: THREE.Vector3, n: number, speed: number, opts: Parameters<Particles["emit"]>[2] = {}) {
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      this.emit(p, v, opts);
    }
  }

  update(dt: number) {
    let k = 0;
    for (const q of this.ps) {
      q.life += dt;
      if (q.life >= q.max) q.alive = false;
      if (!q.alive) continue;
      q.v.multiplyScalar(Math.exp(-q.drag * dt));
      q.v.y -= q.gravity * dt;
      q.p.addScaledVector(q.v, dt);
      if (k >= this.max) break;
      const f = 1 - q.life / q.max;
      this.pos.set([q.p.x, q.p.y, q.p.z], k * 3);
      this.col.set([q.color.r, q.color.g, q.color.b], k * 3);
      this.size[k] = q.size * Math.min(1, f * 3);
      k++;
    }
    this.ps = this.ps.filter((q) => q.alive);
    this.geo.setDrawRange(0, k);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("size") as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface Popup {
  label: Label;
  t: number;
  max: number;
  vy: number;
}

/** Floating text popups ("+$12", "BONK!"). */
export class Popups {
  private list: Popup[] = [];
  constructor(private scene: THREE.Scene) {}

  spawn(text: string, at: THREE.Vector3, color = "#ffe14d", size = 1.2, max = 1.4) {
    const label = new Label(text, { size, fg: color });
    label.sprite.position.copy(at);
    this.scene.add(label.sprite);
    this.list.push({ label, t: 0, max, vy: 2.2 });
  }

  update(dt: number) {
    for (const p of this.list) {
      p.t += dt;
      p.label.sprite.position.y += p.vy * dt;
      (p.label.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - (p.t / p.max) ** 2);
    }
    for (const p of this.list.filter((q) => q.t >= q.max)) this.scene.remove(p.label.sprite);
    this.list = this.list.filter((q) => q.t < q.max);
  }
}
