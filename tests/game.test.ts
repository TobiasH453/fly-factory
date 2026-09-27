import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Decoder } from "../src/brain/decoder";
import type { BrainFrame, BrainMeta } from "../src/brain/types";
import { UPGRADES, available, buy, earn, effects, newEcon } from "../src/game/economy";

const meta = JSON.parse(readFileSync(new URL("../src/data/meta.json", import.meta.url), "utf8")) as BrainMeta;
const names = Object.keys(meta.populations);

function frame(rates: Record<string, number>): BrainFrame {
  return {
    t: 0,
    windowMs: 25,
    popRates: Float32Array.from(names, (n) => rates[n] ?? 0),
    spikes: new Uint16Array(),
    spikeCounts: new Uint8Array(),
    activeNeurons: 0,
    dilation: 1,
  };
}

describe("decoder", () => {
  it("MN9 above threshold means feeding", () => {
    const d = new Decoder(meta, names);
    for (let k = 0; k < 40; k++) d.push(frame({ MN9: meta.channels.feed.canonical_hz }));
    expect(d.state.feed).toBeGreaterThan(1);
    for (let k = 0; k < 40; k++) d.push(frame({}));
    expect(d.state.feed).toBeLessThan(0.1);
  });

  it("Giant Fiber crossing triggers exactly one escape per volley", () => {
    const d = new Decoder(meta, names);
    let triggers = 0;
    for (let k = 0; k < 30; k++) triggers += d.push(frame({ GF: 250 })).escapeTrigger ? 1 : 0;
    expect(triggers).toBe(1);
    for (let k = 0; k < 30; k++) d.push(frame({}));
    for (let k = 0; k < 30; k++) triggers += d.push(frame({ GF: 250 })).escapeTrigger ? 1 : 0;
    expect(triggers).toBe(2);
  });

  it("looming DNs on the left point the threat left; DNa02 R-L gives yaw", () => {
    const d = new Decoder(meta, names);
    for (let k = 0; k < 40; k++) d.push(frame({ escL: 200, DNa02R: 120 }));
    expect(d.state.threatSide).toBeLessThan(-0.5);
    expect(d.state.turn).toBeGreaterThan(0.5);
  });
});

describe("economy", () => {
  it("first upgrade is affordable after a few flies", () => {
    const s = newEcon();
    const first = Math.min(...available(s).map((u) => u.cost));
    const flies = Math.ceil((first - s.money) / effects(s.owned).flyValue);
    expect(flies).toBeLessThanOrEqual(4);
  });

  it("buying respects money and prerequisites", () => {
    const s = newEcon();
    expect(buy(s, "heatlamp")).toBe(false); // requires dropper2
    expect(buy(s, "dropper2")).toBe(false); // too poor
    s.money = 1000;
    expect(buy(s, "dropper2")).toBe(true);
    expect(buy(s, "dropper2")).toBe(false); // already owned
    expect(buy(s, "heatlamp")).toBe(true);
    expect(s.money).toBe(1000 - 25 - 90);
    expect(effects(s.owned).incubTime).toBe(3.5);
  });

  it("every upgrade is reachable", () => {
    const s = newEcon();
    s.money = 1e9;
    for (let round = 0; round < UPGRADES.length; round++) for (const u of available(s)) buy(s, u.id);
    expect(s.owned.length).toBe(UPGRADES.length);
    const fx = effects(s.owned);
    expect(fx.flyValue).toBe((6 + 4) * 2);
    expect(fx.carry).toBe(3);
  });

  it("earning counts flies", () => {
    const s = newEcon();
    earn(s, 12);
    expect(s.flies).toBe(1);
    expect(s.money).toBe(22);
  });
});
