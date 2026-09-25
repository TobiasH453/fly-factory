import "./ui/styles.css";
import * as THREE from "three";
import { BrainClient } from "./brain/client";
import { Decoder, type MotorState } from "./brain/decoder";
import type { BrainMeta } from "./brain/types";
import metaJson from "./data/meta.json";
import brainUrl from "./data/brain.bin?url";
import neuronsUrl from "./data/neurons.bin?url";
import ghostUrl from "./data/ghost.bin?url";
import { UPGRADES, available, buy, earn, effects, load, newEcon, save } from "./game/economy";
import { Production } from "./game/production";
import { BossTools } from "./game/tools";
import { WorkerFly } from "./game/workerFly";
import { Particles, Popups } from "./world/effects";
import { BOUNDS, Factory } from "./world/factory";
import { Label } from "./world/labels";
import { Stage } from "./world/stage";
import { Swarm } from "./world/swarm";
import { Neuroscope, parseNeurons } from "./ui/neuroscope";
import { Hud, OptoLab, Shop } from "./ui/panels";

const meta = metaJson as unknown as BrainMeta;
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

async function fetchBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}`);
  return r.arrayBuffer();
}

interface Pad {
  id: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  label: Label;
}

async function boot() {
  const [brainBuf, neuronsBuf, ghostBuf] = await Promise.all([fetchBin(brainUrl), fetchBin(neuronsUrl), fetchBin(ghostUrl)]);
  $("#loading-msg").textContent = `Starting ${meta.n.toLocaleString()} neurons and ${meta.nnz.toLocaleString()} connections…`;
  const brain = new BrainClient(meta, brainBuf);

  const stage = new Stage($("#stage"));
  const factory = new Factory(stage.scene);
  const particles = new Particles(stage.scene);
  const popups = new Popups(stage.scene);
  const swarm = new Swarm(stage.scene);
  const econ = load() ?? newEcon();
  const fx = () => effects(econ.owned);
  const hud = new Hud();
  const log = (m: string, k: "neural" | "info" | "warn" = "info") => hud.log(m, k);

  const prod = new Production(factory, fx, (value) => {
    earn(econ, value);
    const f = fx();
    swarm.spawn(factory.hatchTop.clone(), f.paint, f.golden);
    popups.spawn(`+$${value}`, factory.hatchTop.clone().add(new THREE.Vector3(0, 3, 0)), "#7dff8a", 1.4);
  });
  const tools = new BossTools(stage.scene, particles);
  const worker = new WorkerFly(stage.scene, meta, factory, prod, tools, particles, popups, fx, { log });

  // restore purchased visuals
  const applyVisuals = () => {
    const f = fx();
    if (f.incubators > 1) factory.showIncubator(1);
    if (f.sugarBar) factory.showDispenser();
    if (econ.owned.includes("scrubber")) factory.showScrubber();
    factory.neonSign.visible = f.neon;
  };
  applyVisuals();
  swarm.populate(Math.min(econ.flies, 320), fx().paint, fx().golden);
  swarm.count = econ.flies;

  // ---------------------------------------------------------------- buy pads
  const pads: Pad[] = [];
  for (const u of UPGRADES) {
    const g = new THREE.Group();
    g.position.set(u.pad[0], 0, u.pad[1]);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.3, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x2fb344, emissive: 0x2fb344, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }),
    );
    mesh.position.y = 0.15;
    mesh.userData.upgrade = u.id;
    const label = new Label(`${u.name}\n$${u.cost}`, { size: 1.5, bg: "rgba(20,24,32,0.85)", fg: "#7dff8a" });
    label.sprite.position.y = 2.6;
    g.add(mesh, label.sprite);
    g.visible = false;
    stage.scene.add(g);
    pads.push({ id: u.id, group: g, mesh, label });
  }
  const shop = new Shop($("#shop"), (id) => doBuy(id));
  const refreshPads = () => {
    const av = new Set(available(econ).map((u) => u.id));
    for (const p of pads) {
      p.group.visible = av.has(p.id);
      const u = UPGRADES.find((x) => x.id === p.id)!;
      const ok = econ.money >= u.cost;
      const m = p.mesh.material as THREE.MeshStandardMaterial;
      m.color.set(ok ? 0x2fb344 : 0xd9534f);
      m.emissive.set(ok ? 0x2fb344 : 0x7a1f1d);
      p.label.set(`${u.name}\n$${u.cost}`);
    }
    if ($("#shop").classList.contains("open")) shop.render(econ);
  };
  const doBuy = (id: string) => {
    const u = UPGRADES.find((x) => x.id === id)!;
    if (buy(econ, id)) {
      log(`Bought ${u.name}: ${u.desc}`, "info");
      popups.spawn(`${u.name}!`, new THREE.Vector3(u.pad[0], 4, u.pad[1]), "#ffe14d", 1.4, 2);
      particles.burst(new THREE.Vector3(u.pad[0], 0.5, u.pad[1]), 40, 8, { life: 1.2, size: 0.6, color: 0xffe14d, gravity: 6 });
      applyVisuals();
      save(econ);
    } else if (econ.money < u.cost) {
      log(`Need $${u.cost - Math.floor(econ.money)} more for ${u.name}`, "warn");
    }
    refreshPads();
  };
  refreshPads();

  // ---------------------------------------------------------------- brain wiring
  $("#loading-msg").textContent = "Waiting for the first spikes…";
  await brain.whenReady;
  const decoder = new Decoder(meta, brain.popNames);
  const geo = parseNeurons(neuronsBuf, ghostBuf);
  const scope = new Neuroscope($("#neuroscope"), meta, geo);
  new OptoLab($("#opto"), meta, brain, log);
  let escapeLatch = false;
  let frames = 0;
  brain.onFrame((f) => {
    decoder.push(f);
    if (decoder.state.escapeTrigger) escapeLatch = true;
    scope.onFrame(f);
    frames++;
  });
  const monitorTex = new THREE.CanvasTexture(scope.monitorCanvas);
  monitorTex.colorSpace = THREE.SRGBColorSpace;
  (factory.monitor.material as THREE.MeshBasicMaterial).map = monitorTex;
  (factory.monitor.material as THREE.MeshBasicMaterial).needsUpdate = true;

  // ---------------------------------------------------------------- panels
  const toggle = (id: string, force?: boolean) => {
    const el = $("#" + id);
    const open = force ?? !el.classList.contains("open");
    if (open && (id === "opto" || id === "shop")) for (const o of ["opto", "shop"]) if (o !== id) toggle(o, false);
    el.classList.toggle("open", open);
    hud.setPanelState(id, open);
    if (id === "shop" && open) shop.render(econ);
  };
  hud.onToggle = (id) => toggle(id);
  document.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = () => toggle(b.dataset.close!, false)));

  let following = false;
  $("#btn-follow").onclick = () => {
    following = !following;
    stage.setFollow(following ? worker.rig.root : null);
    $("#btn-follow").textContent = following ? "🎥 Free camera" : "🎥 Follow worker";
  };
  $("#btn-help").onclick = () => ($("#intro").hidden = false);
  $("#btn-start").onclick = () => {
    $("#intro").hidden = true;
    if (window.innerWidth > 900) toggle("neuroscope", true);
  };

  // ---------------------------------------------------------------- input
  const canvas = stage.renderer.domElement;
  let down: { x: number; y: number; t: number } | null = null;
  hud.onTool = (t) => {
    $("#stage").className = `tool-${t}`;
  };
  hud.setTool("command");
  const inFloor = (p: THREE.Vector3) => p.x > BOUNDS.minX - 1 && p.x < BOUNDS.maxX + 1 && p.z > BOUNDS.minZ - 1 && p.z < BOUNDS.maxZ + 1;

  canvas.addEventListener("pointerdown", (ev) => {
    down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    if (hud.tool === "blower") {
      const p = stage.groundPoint(stage.ndc(ev));
      if (p && inFloor(p)) {
        stage.controls.enabled = false;
        tools.startBlower(p);
        canvas.setPointerCapture(ev.pointerId);
      }
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (tools.blower.active) {
      const p = stage.groundPoint(stage.ndc(ev));
      if (p) tools.moveBlower(p);
    }
  });
  const endPointer = (ev: PointerEvent) => {
    if (tools.blower.active) {
      tools.stopBlower();
      stage.controls.enabled = true;
      down = null;
      return;
    }
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    down = null;
    if (moved > 6) return; // that was a camera drag
    click(stage.ndc(ev));
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => {
    tools.stopBlower();
    stage.controls.enabled = true;
    down = null;
  });

  const click = (ndc: THREE.Vector2) => {
    const padHit = stage.pick(ndc, pads.filter((p) => p.group.visible).map((p) => p.mesh));
    if (padHit) {
      doBuy(padHit.object.userData.upgrade as string);
      return;
    }
    const flyHit = stage.pick(ndc, [worker.rig.hitbox]);
    const p = stage.groundPoint(ndc);
    switch (hud.tool) {
      case "command":
        if (flyHit) worker.backToWork();
        else if (p && inFloor(p)) {
          worker.commandTo(p);
          particles.burst(p.clone().setY(0.2), 12, 3, { life: 0.6, size: 0.5, color: 0xffb000 });
        }
        break;
      case "sugar":
        if (p && inFloor(p)) tools.dropSugar(flyHit ? worker.rig.mouthWorld().setY(0).addScaledVector(worker.forward, 0.6) : p);
        break;
      case "bitter":
        if (flyHit) tools.spray(worker.pos.clone());
        else if (p && inFloor(p)) tools.spray(p);
        break;
      case "swat": {
        const head = worker.headPos;
        let dir = p ? p.clone().sub(worker.pos).setY(0) : new THREE.Vector3();
        if (flyHit || dir.length() < 1.5) dir = worker.left.multiplyScalar(Math.random() < 0.5 ? 1 : -1);
        if (!tools.startSwat(head, dir)) log("One swat at a time!", "warn");
        break;
      }
      case "blower":
        break;
    }
  };

  // expose for the end-to-end smoke test and curious devtools users
  (window as unknown as Record<string, unknown>).__fly = { stage, scope, worker, brain, decoder, econ, tools, factory, prod, meta, frames: () => frames, renders: () => renders };

  // ---------------------------------------------------------------- loop
  $("#loading").hidden = true;
  $("#intro").hidden = false;
  log(`Brain online: ${meta.n.toLocaleString()} neurons, ${meta.nnz.toLocaleString()} connections (${brain.mode})`, "info");

  let last = performance.now();
  let sendT = 0;
  let saveT = 0;
  let padT = 0;
  let renders = 0;
  const step = (dt: number) => {
    sendT += dt;
    if (sendT > 0.04) {
      sendT = 0;
      brain.setInputs(worker.sense());
    }
    const m: MotorState = { ...decoder.state, escapeTrigger: escapeLatch };
    escapeLatch = false;
    prod.update(dt);
    tools.update(dt, worker.pos);
    worker.update(dt, m);
    factory.update(dt, fx().beltSpeed);
    swarm.update(dt);
    particles.update(dt);
    popups.update(dt);
  };
  const loop = () => {
    renders++;
    const now = performance.now();
    // game time follows wall time even on slow machines: fixed substeps of <= 50 ms
    let frameDt = Math.min(0.25, (now - last) / 1000);
    const dt = frameDt;
    last = now;
    while (frameDt > 1e-4) {
      const h = Math.min(0.05, frameDt);
      step(h);
      frameDt -= h;
    }
    const m = decoder.state;
    hud.update(dt, worker, econ);
    scope.update(dt, m, worker.inputs, worker.mode);
    monitorTex.needsUpdate = true;
    padT += dt;
    if (padT > 0.5) {
      padT = 0;
      refreshPads();
      for (const p of pads) if (p.group.visible) p.mesh.position.y = 0.15 + Math.abs(Math.sin(now / 400)) * 0.08;
    }
    saveT += dt;
    if (saveT > 5) {
      saveT = 0;
      save(econ);
    }
    stage.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot().catch((e) => {
  console.error(e);
  $("#loading-msg").textContent = `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
});
