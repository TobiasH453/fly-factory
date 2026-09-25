import * as THREE from "three";
import type { MotorState } from "../brain/decoder";
import type { BrainMeta } from "../brain/types";
import { BOUNDS, type Factory, type Obstacle } from "../world/factory";
import { FlyRig } from "../world/flyModel";
import type { Particles, Popups } from "../world/effects";
import { Label } from "../world/labels";
import type { Effects } from "./economy";
import type { Production } from "./production";
import type { BossTools, Swat } from "./tools";

export type Mode =
  | "working" | "walking" | "waiting" | "commanded" | "hungry" | "exhausted"
  | "feeding" | "grooming" | "escaping" | "dazed" | "moonwalk" | "sprint" | "turning";

/** which modes are driven by the connectome (vs scripted game logic) */
export const NEURAL_MODES: ReadonlySet<Mode> = new Set(["feeding", "grooming", "escaping", "moonwalk", "sprint", "turning"]);

export interface WorkerEvents {
  log: (msg: string, kind?: "neural" | "info" | "warn") => void;
}

interface Escape {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
}

const BASE_SPEED = 5.2;
const WORKER_SCALE = 1.5;
const tmp = new THREE.Vector3();

export class WorkerFly {
  readonly rig = new FlyRig();
  readonly pos = new THREE.Vector3(-4, 0, -8);
  heading = Math.PI / 2;
  energy = 0.8;
  dust = 0.15;
  carrying = 0;
  mode: Mode = "waiting";
  /** Poisson rates (Hz) sent to the brain this frame */
  inputs: Record<string, number> = {};
  stats = { feeds: 0, grooms: 0, escapes: 0, bonks: 0, dodges: 0, eggsLost: 0, trips: 0 };

  private target: THREE.Vector3 | null = null;
  private task: "pickup" | "deposit" | "sugarbar" | "cube" | "command" | "idle" = "idle";
  private taskInc = 0;
  private actT = 0;
  private escape: Escape | null = null;
  private dazed = 0;
  private adrenaline = 0;
  private grooming = false;
  private groomT = 0;
  private feeding = false;
  private feedT = 0;
  private feedEaten = 0;
  private commandUntil = 0;
  private barCooldown = 0;
  private time = 0;
  private bubble = new Label("", { size: 0.9, bg: "rgba(20,24,32,0.82)", fg: "#fff" });
  private lastBubble = "";

  constructor(
    scene: THREE.Scene,
    private meta: BrainMeta,
    private factory: Factory,
    private prod: Production,
    private tools: BossTools,
    private particles: Particles,
    private popups: Popups,
    private fx: () => Effects,
    private ev: WorkerEvents,
  ) {
    this.rig.root.scale.setScalar(WORKER_SCALE);
    scene.add(this.rig.root);
    this.bubble.sprite.position.set(0, 4.4, 0);
    this.rig.root.add(this.bubble.sprite);
    tools.onSwatImpact = (s) => this.onSwat(s);
  }

  get headPos(): THREE.Vector3 {
    return this.rig.head.getWorldPosition(new THREE.Vector3());
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** the fly's left, in world space (FlyRig faces +z; its left is local +x) */
  get left(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  isNeural(): boolean {
    return NEURAL_MODES.has(this.mode);
  }

  /** Boss command: walk to a point and wait there. */
  commandTo(p: THREE.Vector3) {
    this.target = p.clone().setY(0);
    this.task = "command";
    this.commandUntil = this.time + 1e9;
    this.ev.log("Boss: \"Go stand over there!\"", "info");
  }

  backToWork() {
    this.task = "idle";
    this.target = null;
    this.ev.log("Boss: \"Back to work!\"", "info");
  }

  // ------------------------------------------------------------------ sensing
  /** Encode the world around the fly as Poisson rates of sensory neuron populations. */
  sense(): Record<string, number> {
    const env = this.meta.envelope_hz;
    const mouth = this.rig.mouthWorld();
    const taste = this.tools.tasteAt(mouth);
    const aerosol = this.tools.bitterAt(this.pos);
    const wind = this.tools.windAt(this.pos);
    const head = this.headPos;
    const L = this.left;
    const eyeL = head.clone().addScaledVector(L, 0.45);
    const eyeR = head.clone().addScaledVector(L, -0.45);
    let loomL = 0;
    let loomR = 0;
    if (this.tools.swat && !this.tools.swat.done) {
      const toObj = this.tools.swat.mesh.position.clone().sub(head);
      const lateral = toObj.clone().setY(0).normalize().dot(L); // +1 = on the fly's left
      const visL = THREE.MathUtils.clamp(0.5 + 0.9 * lateral, 0.1, 1);
      const visR = THREE.MathUtils.clamp(0.5 - 0.9 * lateral, 0.1, 1);
      const drive = (deg: number) => THREE.MathUtils.clamp((deg - 6) / 34, 0, 1);
      loomL = env.loomL * drive(this.tools.loomAngle(eyeL)) * visL;
      loomR = env.loomR * drive(this.tools.loomAngle(eyeR)) * visR;
    }
    this.inputs = {
      sugar: env.sugar * taste.sugar,
      bitter: env.bitter * Math.min(1, Math.max(taste.bitter, aerosol)),
      dust: Math.min(env.dust, 25 * this.dust + 30 * wind.strength),
      wind: env.wind * wind.strength,
      loomL,
      loomR,
    };
    return this.inputs;
  }

  // ------------------------------------------------------------------ behaviour
  update(dt: number, m: MotorState) {
    this.time += dt;
    const fx = this.fx();
    const rates = m.rates;
    let speed = 0; // signed walking speed for the rig
    let turnRate = 0;
    this.adrenaline = Math.max(0, this.adrenaline - dt);
    this.barCooldown = Math.max(0, this.barCooldown - dt);

    // --- Giant Fiber: escape take-off (can interrupt anything but an escape in progress)
    if (m.escapeTrigger && !this.escape) this.startEscape(m.threatSide, rates.GF ?? 0);

    // --- grooming / feeding state with hysteresis on the neural drives
    if (this.grooming) {
      this.groomT += dt;
      if (m.groom < 0.6 && this.groomT > 0.8) {
        this.grooming = false;
        this.ev.log(`Groomed for ${this.groomT.toFixed(1)} s (grooming DNs peaked; dust now ${(this.dust * 100).toFixed(0)}%)`, "neural");
      }
    } else if (m.groom >= 1 && !this.escape) {
      this.grooming = true;
      this.groomT = 0;
      this.stats.grooms++;
    }
    const taste = this.tools.tasteAt(this.rig.mouthWorld());
    if (this.feeding) {
      this.feedT += dt;
      if (m.feed < 0.6) {
        this.feeding = false;
        if (this.feedEaten > 0.02) this.ev.log(`Stopped eating after ${this.feedT.toFixed(1)} s (+${Math.round(this.feedEaten * 100)}% energy)`, "neural");
        else this.ev.log("Proboscis extended, but there was nothing to eat", "neural");
      }
    } else if (m.feed >= 1 && !this.escape) {
      this.feeding = true;
      this.feedT = 0;
      this.feedEaten = 0;
      this.stats.feeds++;
      this.ev.log(`MN9 fired at ${(rates.MN9 ?? 0).toFixed(0)} Hz → proboscis extension, eating`, "neural");
    } else if (taste.cube && taste.bitter > 0.3 && taste.sugar > 0.3 && Math.random() < dt * 0.5) {
      this.ev.log("Tasted the laced sugar: bitter GRNs keep MN9 quiet, food refused", "neural");
    }

    const mn9Norm = THREE.MathUtils.clamp((rates.MN9 ?? 0) / (this.meta.channels.feed.canonical_hz || 80), 0, 1.2);

    if (this.escape) {
      // ------------------------------------------------ ballistic escape flight
      const e = this.escape;
      e.t += dt;
      const u = Math.min(1, e.t / e.dur);
      this.pos.lerpVectors(e.from, e.to, u);
      this.pos.y = Math.sin(u * Math.PI) * 6.5;
      const dir = e.to.clone().sub(e.from);
      this.heading = Math.atan2(dir.x, dir.z);
      if (u >= 1) {
        this.pos.y = 0;
        this.escape = null;
        this.adrenaline = 8;
        this.particles.burst(this.pos.clone().setY(0.2), 12, 4, { life: 0.6, size: 0.6, color: 0xcfc6b0, gravity: 3 });
      }
      this.mode = "escaping";
    } else if (this.dazed > 0) {
      this.dazed -= dt;
      this.mode = "dazed";
    } else if (this.grooming) {
      // ------------------------------------------------ neural: grooming bout
      this.mode = "grooming";
      const g = rates.groom ?? 0;
      this.dust = Math.max(0, this.dust - 0.0022 * g * dt);
      if (this.dust > 0.05 && Math.random() < dt * 20) {
        const p = this.headPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.2, (Math.random() - 0.5) * 1.5));
        this.particles.emit(p, new THREE.Vector3((Math.random() - 0.5) * 2, 1.2, (Math.random() - 0.5) * 2), { life: 0.9, size: 0.35, color: 0xb8ab90, gravity: 1.5 });
      }
    } else if (this.feeding) {
      // ------------------------------------------------ neural: feeding
      this.mode = "feeding";
      if (taste.cube) {
        const bite = 0.0045 * (rates.MN9 ?? 0) * dt;
        taste.cube.amount = Math.max(0, taste.cube.amount - bite * 0.8);
        const gain = Math.min(1 - this.energy, bite);
        this.energy += gain;
        this.feedEaten += gain;
      }
    } else if (m.backward >= 1) {
      // ------------------------------------------------ neural: MDN moonwalk
      this.mode = "moonwalk";
      speed = -2.8 * Math.min(2, m.backward);
      turnRate = -m.turn * 2.5; // +turn = right = decreasing heading
    } else if (m.forward >= 1) {
      // ------------------------------------------------ neural: DNp09 forward run
      this.mode = "sprint";
      speed = 7 * Math.min(1.6, m.forward);
      turnRate = -m.turn * 2.5; // +turn = right = decreasing heading
    } else if (Math.abs(m.turn) > 0.35) {
      // ------------------------------------------------ neural: DNa02 steering
      this.mode = "turning";
      turnRate = -m.turn * 3.2;
      speed = 1.5;
    } else {
      // ------------------------------------------------ scripted work loop
      const r = this.scriptedStep(dt, fx);
      speed = r.speed;
      turnRate = r.turn;
    }

    // movement (shared by scripted and neural locomotion)
    if (!this.escape) {
      this.heading += turnRate * dt;
      if (speed !== 0) {
        const f = this.forward;
        this.pos.addScaledVector(f, speed * dt);
        this.collide();
      }
    }

    // metabolism and dust
    const exertion = Math.abs(speed) / BASE_SPEED;
    this.energy = Math.max(0, this.energy - dt * (0.0035 + 0.011 * exertion * (1 + 0.25 * this.carrying)));
    if (this.adrenaline > 0 && Math.random() < dt * 8) {
      this.particles.emit(this.pos.clone().setY(1.5), new THREE.Vector3(0, 1.5, 0), { life: 0.6, size: 0.3, color: 0xff5a5a });
    }
    if (this.dust > 0.35 && Math.random() < dt * this.dust * 6) {
      const p = this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 1 + Math.random() * 1.2, (Math.random() - 0.5) * 2.4));
      this.particles.emit(p, new THREE.Vector3(0, 0.3, 0), { life: 1.2, size: 0.28, color: 0x9b8f75 });
    }
    const wind = this.tools.windAt(this.pos);
    if (wind.strength > 0) this.dust = Math.max(0, this.dust - 0.08 * wind.strength * dt); // physically blown off

    // animate
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.heading;
    this.rig.update(dt, {
      speed,
      turn: turnRate,
      groom: this.grooming ? Math.min(1, 0.55 + m.groom * 0.25) : Math.min(0.3, m.groom * 0.3),
      proboscis: mn9Norm,
      wings: this.escape ? 1 : Math.min(0.6, m.escape * 0.6),
      dazed: this.dazed > 0 ? 1 : 0,
      sit: this.mode === "exhausted" ? 1 : 0,
      carrying: this.carrying,
      golden: fx.golden,
      look: THREE.MathUtils.clamp(-m.turn * 0.6, -0.6, 0.6),
    });
    this.updateBubble(m);
  }

  private scriptedStep(dt: number, fx: Effects): { speed: number; turn: number } {
    const prod = this.prod;
    const f = this.factory;
    const tired = this.energy < 0.3;
    if (this.energy <= 0.001) {
      this.mode = "exhausted";
      const cube = this.tools.nearestCube(this.pos, 4);
      if (!cube) return { speed: 0, turn: 0 };
      // crawl to food right next to it
      return this.steer(cube.pos, 0.9, 0.8);
    }

    // choose a task
    if (this.task === "command") {
      if (this.target && this.pos.distanceTo(this.target) < 0.8 && this.commandUntil > this.time + 1e8) {
        this.commandUntil = this.time + 6;
      }
      if (this.time > this.commandUntil) this.task = "idle";
    }
    if (this.task !== "command") {
      const cube = tired ? this.tools.nearestCube(this.pos) : null;
      if (cube) {
        this.task = "cube";
        this.target = cube.pos.clone().setY(0);
      } else if (tired && fx.sugarBar && this.barCooldown <= 0) {
        this.task = "sugarbar";
        this.target = f.sugarFeedPoint.clone();
      } else if (this.carrying > 0 && (this.carrying >= fx.carry || prod.tray === 0)) {
        const inc = this.task === "deposit" ? this.taskInc : prod.freeIncubator();
        if (inc >= 0) {
          this.task = "deposit";
          this.taskInc = inc;
          this.target = f.incubators[inc].deposit.clone();
        } else {
          this.task = "idle";
          this.target = f.incubators[0].deposit.clone().add(new THREE.Vector3(-3, 0, 2));
        }
      } else if (prod.tray > 0 || this.carrying < fx.carry) {
        this.task = "pickup";
        this.target = f.pickup.clone();
      }
    }
    if (!this.target) return { speed: 0, turn: 0 };

    const d = tmp.copy(this.target).sub(this.pos).setY(0).length();
    const arriveR = this.task === "cube" ? 2.0 : 0.9;
    if (d > arriveR) {
      this.actT = 0;
      this.mode = this.task === "command" ? "commanded" : tired ? "hungry" : this.carrying ? "working" : "walking";
      return this.steer(this.target, arriveR, 1);
    }
    // arrived
    this.actT += dt;
    this.mode = this.task === "command" ? "commanded" : this.task === "cube" || this.task === "sugarbar" ? "hungry" : "working";
    if (this.task === "pickup" && this.actT > 0.35) {
      const want = fx.carry - this.carrying;
      const got = prod.takeEggs(want);
      if (got > 0) {
        this.carrying += got;
        this.addDust(0.035 * got, fx);
        this.actT = 0;
      } else if (this.carrying > 0 && this.actT > 1.5) {
        this.task = "deposit";
        this.taskInc = Math.max(0, prod.freeIncubator());
      } else {
        this.mode = "waiting";
      }
      // face the tray
      return { speed: 0, turn: this.faceTurn(f.trayPos) };
    }
    if (this.task === "deposit" && this.actT > 0.4) {
      const put = prod.deposit(this.taskInc, this.carrying);
      if (put > 0) {
        this.carrying -= put;
        this.stats.trips++;
        this.addDust(0.06 * put, fx);
        const inc = f.incubators[this.taskInc].group.position;
        this.particles.burst(inc.clone().setY(2.5), 14, 3, { life: 0.9, size: 0.7, color: 0xd8cbb0, gravity: 1 });
      }
      this.task = "idle";
      this.actT = 0;
      return { speed: 0, turn: this.faceTurn(f.incubators[this.taskInc].group.position) };
    }
    if (this.task === "sugarbar" && this.actT > 0.6) {
      // the dispenser pops a cube out in front of the fly; eating it is up to the brain
      const at = this.pos.clone().addScaledVector(this.forward, 1.8);
      this.tools.dropSugar(at, 3);
      this.barCooldown = 12;
      this.task = "cube";
      this.ev.log("Sugar bar dispensed a cube", "info");
      return { speed: 0, turn: 0 };
    }
    if (this.task === "cube") {
      // stand at the food and let the brain decide (sugar GRNs -> MN9)
      const cube = this.tools.nearestCube(this.pos, 3.5);
      if (!cube || this.energy > 0.95) this.task = "idle";
      return { speed: 0, turn: cube ? this.faceTurn(cube.pos) : 0 };
    }
    if (this.task === "command") this.mode = "waiting";
    return { speed: 0, turn: 0 };
  }

  private addDust(x: number, fx: Effects) {
    this.dust = Math.min(1, this.dust + x * fx.dustMul);
  }

  private faceTurn(p: THREE.Vector3): number {
    const want = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
    const diff = angleDiff(want, this.heading);
    return THREE.MathUtils.clamp(diff * 6, -5, 5);
  }

  /** steer toward p; returns speed and yaw rate */
  private steer(p: THREE.Vector3, arriveR: number, speedMul: number): { speed: number; turn: number } {
    const toT = p.clone().sub(this.pos).setY(0);
    const dist = toT.length();
    const desired = toT.normalize();
    // obstacle avoidance: repulsion from obstacles ahead
    for (const o of this.factory.obstacles) {
      const away = tmp.set(this.pos.x - o.x, 0, this.pos.z - o.z);
      const d = away.length() - o.r;
      if (d < 3.5 && d > -2) {
        const ahead = new THREE.Vector3(o.x - this.pos.x, 0, o.z - this.pos.z).normalize().dot(desired);
        if (ahead > 0.2) {
          const side = new THREE.Vector3(-desired.z, 0, desired.x);
          const s = Math.sign(side.dot(away)) || 1;
          desired.addScaledVector(side, s * (3.5 - d) * 0.5 * ahead);
        }
      }
    }
    const want = Math.atan2(desired.x, desired.z);
    const diff = angleDiff(want, this.heading);
    const turn = THREE.MathUtils.clamp(diff * 5, -5, 5);
    let speed = BASE_SPEED * speedMul;
    speed *= this.energy < 0.25 ? 0.45 + this.energy * 2.2 : 1;
    speed *= this.dust > 0.7 ? 0.6 : 1;
    speed *= this.adrenaline > 0 ? 1.7 : 1;
    speed *= Math.max(0.2, Math.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    if (dist < arriveR + 1.5) speed *= Math.max(0.3, (dist - arriveR) / 1.5 + 0.3);
    return { speed, turn };
  }

  private collide() {
    for (const o of this.factory.obstacles as Obstacle[]) {
      const dx = this.pos.x - o.x;
      const dz = this.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + 1.3;
      if (d < min && d > 1e-6) {
        this.pos.x = o.x + (dx / d) * min;
        this.pos.z = o.z + (dz / d) * min;
      }
    }
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, BOUNDS.minX, BOUNDS.maxX);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, BOUNDS.minZ, BOUNDS.maxZ);
  }

  private startEscape(threatSide: number, gfHz: number) {
    // jump away from the side whose looming DNs are more active (+ randomness)
    const L = this.left;
    const away = threatSide > 0.15 ? L.clone() : threatSide < -0.15 ? L.clone().negate() : this.forward.negate();
    away.add(this.forward.multiplyScalar(0.4 * (Math.random() - 0.3))).normalize();
    away.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.9);
    const dist = 7 + Math.random() * 7;
    const to = this.pos.clone().addScaledVector(away, dist).setY(0);
    to.x = THREE.MathUtils.clamp(to.x, BOUNDS.minX + 2, BOUNDS.maxX - 2);
    to.z = THREE.MathUtils.clamp(to.z, BOUNDS.minZ + 2, BOUNDS.maxZ - 2);
    for (const o of this.factory.obstacles) {
      const d = Math.hypot(to.x - o.x, to.z - o.z);
      if (d < o.r + 1) to.add(new THREE.Vector3(to.x - o.x, 0, to.z - o.z).normalize().multiplyScalar(o.r + 1.5 - d));
    }
    this.escape = { from: this.pos.clone().setY(0), to, t: 0, dur: 0.9 + dist * 0.03 };
    this.stats.escapes++;
    this.grooming = false;
    this.feeding = false;
    const side = threatSide > 0.15 ? "right" : threatSide < -0.15 ? "left" : "ahead";
    this.ev.log(`Giant Fiber spiked (${gfHz.toFixed(0)} Hz) → escape take-off, threat from the ${side}`, "neural");
    if (this.carrying > 0) {
      this.stats.eggsLost += this.carrying;
      this.popups.spawn(`-${this.carrying} egg${this.carrying > 1 ? "s" : ""}`, this.pos.clone().setY(3), "#ff8a8a", 1);
      this.particles.burst(this.pos.clone().setY(0.4), 20, 5, { life: 0.8, size: 0.5, color: 0xfff6c0, gravity: 9 });
      this.carrying = 0;
      this.task = "idle";
    }
  }

  private onSwat(s: Swat) {
    const head = this.headPos;
    const hit = head.distanceTo(s.to) < 1.8 && !this.escape;
    if (hit) {
      this.stats.bonks++;
      this.dazed = 1.8;
      this.energy = Math.max(0, this.energy - 0.05);
      this.popups.spawn("BONK!", head.clone().setY(head.y + 2.5), "#ff5a5a", 1.8);
      this.particles.burst(head, 16, 5, { life: 0.5, size: 0.5, color: 0xffe14d });
      this.ev.log("BONK! The Giant Fiber didn't fire in time", "warn");
      this.grooming = false;
      this.feeding = false;
    } else {
      this.stats.dodges++;
      this.popups.spawn("WHIFF!", s.to.clone().setY(s.to.y + 1.5), "#9ad7ff", 1.5);
    }
  }

  private updateBubble(m: MotorState) {
    const r = m.rates;
    const hz = (k: string) => `${Math.round(r[k] ?? 0)} Hz`;
    const txt: Record<Mode, string> = {
      working: `WORKING${this.carrying ? `  (${this.carrying} egg${this.carrying > 1 ? "s" : ""})` : ""}`,
      walking: "WORKING",
      waiting: "WAITING",
      commanded: "YES BOSS",
      hungry: "HUNGRY...",
      exhausted: "Zzz (no energy)",
      feeding: `EATING · MN9 ${hz("MN9")}`,
      grooming: `GROOMING · DNs ${hz("groom")}`,
      escaping: `ESCAPE! · GF ${hz("GF")}`,
      dazed: "@_@",
      moonwalk: `MOONWALK · MDN ${hz("MDN")}`,
      sprint: `RUNNING · DNp09 ${hz("DNp09")}`,
      turning: `TURNING · DNa02 ${m.turn > 0 ? "R" : "L"}`,
    };
    const t = txt[this.mode];
    if (t !== this.lastBubble) {
      this.lastBubble = t;
      this.bubble.set(t);
    }
    const mat = this.bubble.sprite.material as THREE.SpriteMaterial;
    mat.color.set(this.isNeural() ? 0x9dfff4 : 0xffffff);
    this.bubble.sprite.position.y = 4.4 - (this.mode === "exhausted" ? 0.8 : 0);
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
