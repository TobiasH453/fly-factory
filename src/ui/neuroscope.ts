import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MotorState } from "../brain/decoder";
import type { BrainFrame, BrainMeta } from "../brain/types";

export const POP_COLORS: Record<string, string> = {
  sugar: "#ffffff", bitter: "#8bd34a", dust: "#d2bf8e", wind: "#9ad7ff", hearing: "#d7a6ff",
  loomL: "#ff9f43", loomR: "#ff9f43", MN9: "#ff6fb5", GF: "#ff4d4d", DNa02L: "#4dd2ff", DNa02R: "#4dd2ff",
  DNa01L: "#35a9d6", DNa01R: "#35a9d6", MDN: "#b18cff", DNp09: "#7dff8a", escL: "#ffb347", escR: "#ffb347",
  groom: "#ffe14d",
};

const GROUP_COLORS = [0x6d7c8d, 0x9ad7ff, 0x9ad7ff, 0x8aa0b8, 0xffb35c, 0xff6f91, 0xff6fb5, 0xc7a0ff];

export interface NeuronGeometry {
  pos: Float32Array; // n*3 normalized
  group: Uint8Array;
  ghost: Float32Array; // m*3
}

export function parseNeurons(buf: ArrayBuffer, ghostBuf: ArrayBuffer): NeuronGeometry {
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true);
  const pos = new Float32Array(buf.slice(8, 8 + n * 12));
  const group = new Uint8Array(buf.slice(8 + n * 12, 8 + n * 13));
  const gdv = new DataView(ghostBuf);
  const m = gdv.getUint32(4, true);
  const gi = new Int16Array(ghostBuf.slice(8, 8 + m * 6));
  const ghost = new Float32Array(m * 3);
  for (let k = 0; k < m * 3; k++) ghost[k] = gi[k] / 32767;
  return { pos, group, ghost };
}

/** FlyWire coordinates: x = left/right, y = dorsal->ventral, z = anterior/posterior */
function toScene(src: Float32Array, dst: Float32Array) {
  for (let i = 0; i < src.length; i += 3) {
    dst[i] = src[i] * 3;
    dst[i + 1] = -src[i + 1] * 3;
    dst[i + 2] = src[i + 2] * 3;
  }
}

/** 3D point cloud of the simulated neurons at their real FlyWire positions, flashing on spikes. */
export class BrainCloud {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 100);
  private controls: OrbitControls | null = null;
  private glow: Float32Array;
  private glowAttr: THREE.BufferAttribute;
  private visible = true;

  constructor(private container: HTMLElement, geo: NeuronGeometry) {
    const n = geo.group.length;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      container.textContent = "WebGL unavailable";
    }
    this.glow = new Float32Array(n);
    this.glowAttr = new THREE.BufferAttribute(this.glow, 1);
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x070b12);
    container.prepend(this.renderer.domElement);
    this.camera.position.set(0, 0.6, 5.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.enableZoom = false;
    this.controls.enablePan = false;

    // ghost: sampled positions of the whole 139k-neuron brain
    const gpos = new Float32Array(geo.ghost.length);
    toScene(geo.ghost, gpos);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(gpos, 3));
    this.scene.add(new THREE.Points(gg, new THREE.PointsMaterial({ color: 0x40546b, size: 0.018, transparent: true, opacity: 0.35, depthWrite: false })));

    const pos = new Float32Array(n * 3);
    toScene(geo.pos, pos);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      c.set(GROUP_COLORS[geo.group[i]] ?? 0x8899aa);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("glow", this.glowAttr);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      vertexShader: `
        attribute float glow; varying vec3 vC; varying float vG;
        void main(){ vC = color; vG = glow; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = (1.6 + glow * 7.0) * (4.0 / -mv.z) * 1.5; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vC; varying float vG;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard;
          vec3 hot = mix(vC * 0.35, vec3(1.0, 0.95, 0.7), vG);
          gl_FragColor = vec4(hot, (0.25 + vG * 0.75) * (1.0 - r * 4.0)); }`,
    });
    this.scene.add(new THREE.Points(g, mat));
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  private size = "";

  resize() {
    if (!this.renderer) return;
    const w = Math.round(this.container.clientWidth || 300);
    const h = Math.round(this.container.clientHeight || 190);
    if (`${w}x${h}` === this.size || w < 10) return;
    this.size = `${w}x${h}`;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setVisible(v: boolean) {
    this.visible = v;
  }

  onFrame(f: BrainFrame) {
    for (let k = 0; k < f.spikes.length; k++) this.glow[f.spikes[k]] = 1;
  }

  private acc = 0;

  render(dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 30) return; // 30 fps is plenty for the brain view
    const step = this.acc;
    this.acc = 0;
    const decay = Math.exp(-step * 5);
    for (let i = 0; i < this.glow.length; i++) this.glow[i] *= decay;
    if (!this.visible || !this.renderer) return;
    this.glowAttr.needsUpdate = true;
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/** Scrolling spike raster of the input and readout populations (CPU pixel buffer, no GPU readbacks). */
export class Raster {
  readonly rows: string[];
  private rowOf: Int16Array[]; // neuron -> rows
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private px: Uint32Array;
  private rowColor: Uint32Array;
  private pxPerMs: number;
  private carry = 0;
  private dirty = true;
  private static BG = 0xff120b07; // #070b12 as ABGR

  constructor(readonly canvas: HTMLCanvasElement, meta: BrainMeta, windowSec = 4) {
    this.rows = Object.keys(meta.populations);
    const lists: number[][] = Array.from({ length: meta.n }, () => []);
    this.rows.forEach((name, r) => meta.populations[name].nodes.forEach((i) => lists[i].push(r)));
    this.rowOf = lists.map((l) => Int16Array.from(l));
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    this.img = this.ctx.createImageData(canvas.width, canvas.height);
    this.px = new Uint32Array(this.img.data.buffer);
    this.px.fill(Raster.BG);
    this.rowColor = Uint32Array.from(this.rows, (r) => {
      const c = new THREE.Color(POP_COLORS[r] ?? "#ffffff");
      return (0xff << 24) | (Math.round(c.b * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.r * 255);
    });
    this.pxPerMs = canvas.width / (windowSec * 1000);
  }

  push(f: BrainFrame) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px = this.px;
    this.carry += f.windowMs * this.pxPerMs;
    const dx = Math.floor(this.carry);
    this.carry -= dx;
    if (dx > 0) {
      for (let y = 0; y < H; y++) {
        const o = y * W;
        px.copyWithin(o, o + dx, o + W);
        px.fill(Raster.BG, o + W - dx, o + W);
      }
    }
    const rh = H / this.rows.length;
    const span = Math.max(1, dx);
    for (let k = 0; k < f.spikes.length; k++) {
      const rows = this.rowOf[f.spikes[k]];
      for (let j = 0; j < rows.length; j++) {
        const r = rows[j];
        const x = Math.min(W - 2, W - span + Math.floor(Math.random() * span) - 1);
        const y = Math.min(H - 2, Math.floor(r * rh + Math.random() * (rh - 2)));
        const c = this.rowColor[r];
        const o = y * W + x;
        px[o] = c;
        px[o + 1] = c;
        px[o + W] = c;
        px[o + W + 1] = c;
      }
    }
    this.dirty = true;
  }

  /** copy the pixel buffer to the canvas (call at display rate, not per brain frame) */
  paint() {
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.putImageData(this.img, 0, 0);
  }
}

interface MeterEl {
  root: HTMLElement;
  fill: HTMLElement;
  val: HTMLElement;
  max: number;
}

/** Channel meters + raster + 3D brain in the side panel, and the big in-world monitor. */
export class Neuroscope {
  readonly cloud: BrainCloud;
  readonly raster: Raster;
  private meters: Record<string, MeterEl> = {};
  private stats: HTMLElement;
  monitorCanvas = document.createElement("canvas");
  private monitorCtx: CanvasRenderingContext2D;
  private lastFrame: BrainFrame | null = null;
  private monitorT = 0;

  constructor(private root: HTMLElement, private meta: BrainMeta, geo: NeuronGeometry) {
    const body = root.querySelector(".body") as HTMLElement;
    body.innerHTML = `
      <p class="note">Live leaky integrate-and-fire simulation of the worker's brain: ${meta.n.toLocaleString()} FlyWire neurons,
      ${meta.nnz.toLocaleString()} connections (${meta.synapses.toLocaleString()} synapses), the activity-pruned part of the
      ${meta.full_brain.neurons.toLocaleString()}-neuron connectome. Drag to rotate.</p>
      <div id="brain3d"><div class="legend">grey haze: whole brain · dots: simulated neurons · flashes: spikes</div></div>
      <div class="section-title">Motor readouts (decoded behaviour)</div>
      <div class="meters" id="m-out"></div>
      <div class="section-title">Sensory inputs (Poisson rate)</div>
      <div class="meters" id="m-in"></div>
      <div class="section-title">Spike raster (last 4 s)</div>
      <canvas id="raster" width="600" height="300"></canvas>
      <div class="brainstats" id="brainstats"></div>`;
    this.cloud = new BrainCloud(body.querySelector("#brain3d") as HTMLElement, geo);
    const rc = body.querySelector("#raster") as HTMLCanvasElement;
    this.raster = new Raster(rc, meta);
    this.stats = body.querySelector("#brainstats") as HTMLElement;
    const ch = meta.channels;
    const out: [string, string, string, number, number][] = [
      ["MN9", "Feed · MN9", "MN9", ch.feed.threshold_hz, 120],
      ["groom", "Groom · DNs", "groom", ch.groom.threshold_hz, 260],
      ["GF", "Escape · Giant Fiber", "GF", ch.escape.threshold_hz, 300],
      ["DNa02L", "Turn L · DNa02", "DNa02L", ch.turnL.threshold_hz, 160],
      ["DNa02R", "Turn R · DNa02", "DNa02R", ch.turnR.threshold_hz, 160],
      ["DNp09", "Forward · DNp09", "DNp09", ch.forward.threshold_hz, 160],
      ["MDN", "Backward · MDN", "MDN", ch.backward.threshold_hz, 160],
    ];
    const mOut = body.querySelector("#m-out") as HTMLElement;
    for (const [key, label, pop, thr, max] of out) this.meters[key] = this.addMeter(mOut, label, POP_COLORS[pop], thr, max);
    const mIn = body.querySelector("#m-in") as HTMLElement;
    for (const pop of ["sugar", "bitter", "dust", "wind", "loomL", "loomR"]) {
      this.meters["in:" + pop] = this.addMeter(mIn, meta.populations[pop].label, POP_COLORS[pop], -1, 150);
    }
    this.monitorCanvas.width = 1024;
    this.monitorCanvas.height = 564;
    this.monitorCtx = this.monitorCanvas.getContext("2d", { willReadFrequently: true })!;
  }

  private addMeter(parent: HTMLElement, label: string, color: string, thr: number, max: number): MeterEl {
    const el = document.createElement("div");
    el.className = "meter";
    el.innerHTML = `<span class="lbl">${label}</span><div class="track"><div class="fill" style="background:${color === "#ffffff" ? "#c9d3de" : color};width:0%"></div>${
      thr > 0 ? `<div class="thr" style="left:${Math.min(100, (thr / max) * 100)}%" title="decoder threshold ${thr} Hz"></div>` : ""
    }</div><span class="val">0 Hz</span>`;
    parent.appendChild(el);
    return { root: el, fill: el.querySelector(".fill") as HTMLElement, val: el.querySelector(".val") as HTMLElement, max };
  }

  isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  onFrame(f: BrainFrame) {
    this.lastFrame = f;
    this.cloud.onFrame(f);
    this.raster.push(f);
  }

  private paintT = 0;

  update(dt: number, m: MotorState, inputs: Record<string, number>, mode: string) {
    const open = this.isOpen();
    this.cloud.setVisible(open);
    this.cloud.render(dt);
    this.paintT += dt;
    if (open && this.paintT > 1 / 20) {
      this.paintT = 0;
      this.raster.paint();
    }
    if (open) {
      const ch = this.meta.channels;
      const thr: Record<string, number> = {
        MN9: ch.feed.threshold_hz, groom: ch.groom.threshold_hz, GF: ch.escape.threshold_hz,
        DNa02L: ch.turnL.threshold_hz, DNa02R: ch.turnR.threshold_hz, DNp09: ch.forward.threshold_hz, MDN: ch.backward.threshold_hz,
      };
      for (const [k, el] of Object.entries(this.meters)) {
        const isIn = k.startsWith("in:");
        const v = isIn ? inputs[k.slice(3)] ?? 0 : m.rates[k] ?? 0;
        el.fill.style.width = `${Math.min(100, (v / el.max) * 100)}%`;
        el.val.textContent = `${v.toFixed(0)} Hz`;
        if (!isIn) el.root.classList.toggle("on", v >= thr[k]);
      }
      const f = this.lastFrame;
      if (f) {
        this.stats.innerHTML = `brain time ${(f.t / 1000).toFixed(1)} s · speed ${f.dilation.toFixed(2)}× real time · ${f.activeNeurons.toLocaleString()} neurons off rest · ${f.spikes.length} spiking / ${f.windowMs} ms`;
      }
    }
    this.monitorT += dt;
    if (this.monitorT > 1 / 12) {
      this.monitorT = 0;
      this.drawMonitor(m, inputs, mode);
    }
  }

  /** composite for the big factory wall screen */
  private drawMonitor(m: MotorState, inputs: Record<string, number>, mode: string) {
    this.raster.paint();
    const c = this.monitorCtx;
    const W = this.monitorCanvas.width;
    const H = this.monitorCanvas.height;
    c.fillStyle = "#070b12";
    c.fillRect(0, 0, W, H);
    c.drawImage(this.raster.canvas, 16, 60, 600, H - 76);
    c.font = "800 30px Trebuchet MS, sans-serif";
    c.fillStyle = "#7dfff0";
    c.fillText(`STATE: ${mode.toUpperCase()}`, 16, 42);
    const rows = this.raster.rows;
    c.font = "600 12px Trebuchet MS, sans-serif";
    rows.forEach((r, i) => {
      c.fillStyle = POP_COLORS[r] ?? "#fff";
      c.fillText(this.meta.populations[r].label.split(" (")[0], 20, 60 + ((H - 76) / rows.length) * (i + 0.7));
    });
    const bars: [string, number, number, string][] = [
      ["FEED  MN9", m.rates.MN9 ?? 0, this.meta.channels.feed.threshold_hz, POP_COLORS.MN9],
      ["GROOM", m.rates.groom ?? 0, this.meta.channels.groom.threshold_hz, POP_COLORS.groom],
      ["ESCAPE  GF", m.rates.GF ?? 0, this.meta.channels.escape.threshold_hz, POP_COLORS.GF],
      ["TURN L", m.rates.DNa02L ?? 0, this.meta.channels.turnL.threshold_hz, POP_COLORS.DNa02L],
      ["TURN R", m.rates.DNa02R ?? 0, this.meta.channels.turnR.threshold_hz, POP_COLORS.DNa02R],
      ["BACK  MDN", m.rates.MDN ?? 0, this.meta.channels.backward.threshold_hz, POP_COLORS.MDN],
      ["SUGAR in", inputs.sugar ?? 0, -1, "#e8eef5"],
      ["DUST in", inputs.dust ?? 0, -1, POP_COLORS.dust],
      ["LOOM in", Math.max(inputs.loomL ?? 0, inputs.loomR ?? 0), -1, POP_COLORS.loomL],
    ];
    const x0 = 640;
    bars.forEach(([label, v, thr, col], i) => {
      const y = 70 + i * 52;
      c.fillStyle = "#9fb3c8";
      c.font = "700 18px Trebuchet MS, sans-serif";
      c.fillText(label, x0, y);
      c.fillStyle = "#1b2430";
      c.fillRect(x0, y + 8, 360, 18);
      c.fillStyle = col;
      c.fillRect(x0, y + 8, Math.min(360, (v / 260) * 360), 18);
      if (thr > 0) {
        c.fillStyle = "#fff";
        c.fillRect(x0 + (thr / 260) * 360, y + 4, 3, 26);
      }
      c.fillStyle = "#e8eef5";
      c.font = "700 16px Trebuchet MS, sans-serif";
      c.fillText(`${v.toFixed(0)} Hz`, x0 + 300, y);
    });
  }
}
