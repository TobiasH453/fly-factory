import * as THREE from "three";
import { babyFlyGeometry } from "./flyModel";

const MAX = 320;
const PALETTE = [0xff5a5a, 0xffc930, 0x5ad1ff, 0x7dff8a, 0xc77dff, 0xff8ad8, 0xffffff];

interface Baby {
  p: THREE.Vector3;
  v: THREE.Vector3;
  phase: number;
  color: THREE.Color;
}

/** Show-off baby flies circling the factory ceiling. Pure decoration: no brain. */
export class Swarm {
  readonly mesh: THREE.InstancedMesh;
  private flies: Baby[] = [];
  private dummy = new THREE.Object3D();
  private center = new THREE.Vector3(0, 19, -2);
  private t = 0;
  count = 0;

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.6 });
    this.mesh = new THREE.InstancedMesh(babyFlyGeometry(), mat, MAX);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  spawn(from: THREE.Vector3, colorful: boolean, golden: boolean) {
    this.count++;
    const color = new THREE.Color(golden && !colorful ? 0xffd34d : colorful ? PALETTE[Math.floor(Math.random() * PALETTE.length)] : 0x5a4030);
    const b: Baby = {
      p: from.clone(),
      v: new THREE.Vector3((Math.random() - 0.5) * 4, 9 + Math.random() * 4, (Math.random() - 0.5) * 4),
      phase: Math.random() * 100,
      color,
    };
    if (this.flies.length >= MAX) this.flies.shift();
    this.flies.push(b);
  }

  /** restore a swarm from a save without the launch animation */
  populate(n: number, colorful: boolean, golden: boolean) {
    for (let k = 0; k < Math.min(n, MAX); k++) {
      this.spawn(this.center.clone().add(new THREE.Vector3((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 30)), colorful, golden);
    }
    this.count = n;
  }

  update(dt: number) {
    this.t += dt;
    const c = this.center;
    for (let i = 0; i < this.flies.length; i++) {
      const b = this.flies[i];
      // orbit around the centre with a wobbly wander
      const toC = c.clone().sub(b.p);
      const tangent = new THREE.Vector3(-toC.z, 0, toC.x).normalize();
      const radial = new THREE.Vector3(toC.x, 0, toC.z);
      const rDist = radial.length();
      const acc = tangent.multiplyScalar(6)
        .add(radial.normalize().multiplyScalar((rDist - 16) * 0.6))
        .add(new THREE.Vector3(Math.sin(this.t * 1.3 + b.phase) * 5, (c.y + Math.sin(b.phase + this.t * 0.7) * 3 - b.p.y) * 1.5, Math.cos(this.t * 1.1 + b.phase * 1.7) * 5));
      b.v.addScaledVector(acc, dt);
      b.v.multiplyScalar(Math.exp(-dt * 0.9));
      b.p.addScaledVector(b.v, dt);
      this.dummy.position.copy(b.p);
      this.dummy.lookAt(b.p.clone().add(b.v));
      const s = 1.4 + Math.sin(this.t * 40 + b.phase) * 0.05;
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, b.color);
    }
    this.mesh.count = this.flies.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
