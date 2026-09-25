import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Renderer, camera, lights and picking helpers. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  follow: THREE.Object3D | null = null;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9fd4ff);
    this.scene.fog = new THREE.Fog(0x9fd4ff, 90, 190);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    this.camera.position.set(4, 27, 33);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-2, 1, -7);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 110;
    this.controls.screenSpacePanning = false;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.5);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-30, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -55;
    sc.right = 55;
    sc.top = 45;
    sc.bottom = -45;
    sc.near = 10;
    sc.far = 150;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    window.addEventListener("resize", () => this.resize());
    this.resize();
    if (this.camera.aspect < 1) {
      // portrait: look down on the production line from higher up
      this.camera.position.set(-2, 44, 20);
      this.controls.target.set(-2, 0, -9);
    }
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // portrait phones: widen the view so the production line still fits
    this.camera.fov = this.camera.aspect < 1 ? Math.min(80, 50 + (1 - this.camera.aspect) * 45) : 50;
    this.camera.updateProjectionMatrix();
  }

  ndc(ev: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  groundPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.ground, p) ? p : null;
  }

  pick(ndc: THREE.Vector2, objects: THREE.Object3D[]): THREE.Intersection | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(objects, true);
    return hits[0] ?? null;
  }

  setFollow(obj: THREE.Object3D | null) {
    this.follow = obj;
  }

  update(dt: number) {
    if (this.follow) {
      const want = this.follow.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const k = 1 - Math.exp(-dt * 4);
      const delta = want.clone().sub(this.controls.target).multiplyScalar(k);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      const dist = this.camera.position.distanceTo(this.controls.target);
      if (dist > 30) {
        const dir = this.camera.position.clone().sub(this.controls.target).normalize();
        this.camera.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(dist, 18, k));
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
