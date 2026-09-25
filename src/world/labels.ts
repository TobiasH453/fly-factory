import * as THREE from "three";

export interface LabelOpts {
  size?: number; // world height of the sprite
  bg?: string;
  fg?: string;
  border?: string;
  font?: string;
  padding?: number;
  maxWidth?: number;
}

/** Billboard text label drawn onto a canvas. */
export class Label {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private tex: THREE.CanvasTexture;
  private text = "";

  constructor(text: string, private opts: LabelOpts = {}) {
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 10;
    this.set(text);
  }

  set(text: string) {
    if (text === this.text) return;
    this.text = text;
    const o = this.opts;
    const lines = text.split("\n");
    const px = 64;
    const font = o.font ?? `600 ${px}px Fredoka, "Trebuchet MS", "Arial Rounded MT Bold", system-ui, sans-serif`;
    const pad = o.padding ?? 22;
    this.ctx.font = font;
    const w = Math.ceil(Math.max(...lines.map((l) => this.ctx.measureText(l).width)) + pad * 2);
    const h = Math.ceil(lines.length * px * 1.15 + pad * 1.5);
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
      // GPU texture storage is immutable: a resized canvas needs a fresh texture
      this.tex.dispose();
      this.tex = new THREE.CanvasTexture(this.canvas);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.anisotropy = 4;
      const mat = this.sprite.material as THREE.SpriteMaterial;
      mat.map = this.tex;
      mat.needsUpdate = true;
    } else {
      this.ctx.clearRect(0, 0, w, h);
    }
    const c = this.ctx;
    c.font = font;
    if (o.bg) {
      c.fillStyle = o.bg;
      roundRect(c, 4, 4, w - 8, h - 8, 26);
      c.fill();
      if (o.border) {
        c.lineWidth = 8;
        c.strokeStyle = o.border;
        c.stroke();
      }
    }
    c.fillStyle = o.fg ?? "#fff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    if (!o.bg) {
      c.lineWidth = 12;
      c.strokeStyle = "rgba(0,0,0,0.65)";
      lines.forEach((l, i) => c.strokeText(l, w / 2, pad * 0.75 + px * 1.15 * (i + 0.5)));
    }
    lines.forEach((l, i) => c.fillText(l, w / 2, pad * 0.75 + px * 1.15 * (i + 0.5)));
    this.tex.needsUpdate = true;
    const size = o.size ?? 1.6;
    this.sprite.scale.set((size * w) / h, size, 1);
  }
}

export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
