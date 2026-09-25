/** Tycoon economy: upgrades and their effects. Pure logic (unit-tested). */

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  cost: number;
  requires?: string[];
  /** where the buy pad sits on the factory floor */
  pad: [number, number];
}

export const UPGRADES: UpgradeDef[] = [
  { id: "dropper2", name: "Egg Dropper II", desc: "Eggs drop 40% faster", cost: 25, pad: [-30, -9] },
  { id: "basket", name: "Egg Basket", desc: "Worker carries 2 eggs per trip", cost: 60, pad: [-13, -6] },
  { id: "heatlamp", name: "Heat Lamps", desc: "Incubation 6s → 3.5s", cost: 90, pad: [8, -6], requires: ["dropper2"] },
  { id: "sugarbar", name: "Sugar Bar", desc: "Worker walks to the sugar bar when tired (eating is still neural)", cost: 120, pad: [-28, 21] },
  { id: "belt2", name: "Turbo Belt", desc: "Conveyor speed ×2", cost: 150, pad: [-21, -9], requires: ["dropper2"] },
  { id: "scrubber", name: "Air Scrubber", desc: "Half as much dust lands on the worker", cost: 180, pad: [-14, 25] },
  { id: "golden", name: "Golden Eggs", desc: "Every fly is worth ×2", cost: 260, pad: [-2, -6], requires: ["heatlamp"] },
  { id: "dropper3", name: "Egg Dropper III", desc: "Eggs drop even faster", cost: 320, pad: [-30, -5], requires: ["dropper2", "belt2"] },
  { id: "paint", name: "Fly Paint Shop", desc: "Colourful flies, +$4 each", cost: 380, pad: [25, 2], requires: ["golden"] },
  { id: "incubator2", name: "Incubator #2", desc: "A second incubator", cost: 480, pad: [21, -6], requires: ["heatlamp"] },
  { id: "cart", name: "Egg Cart", desc: "Worker carries 3 eggs per trip", cost: 550, pad: [-9, -3], requires: ["basket"] },
  { id: "neon", name: "Neon Sign", desc: "Pure bragging rights", cost: 1000, pad: [-18, -24], requires: ["paint"] },
];

export interface EconState {
  money: number;
  earned: number;
  flies: number;
  owned: string[];
}

export function newEcon(): EconState {
  return { money: 10, earned: 0, flies: 0, owned: [] };
}

export interface Effects {
  dropInterval: number;
  beltSpeed: number;
  carry: number;
  incubTime: number;
  incubators: number;
  incubCapacity: number;
  flyValue: number;
  dustMul: number;
  sugarBar: boolean;
  paint: boolean;
  golden: boolean;
  neon: boolean;
}

export function effects(owned: readonly string[]): Effects {
  const has = (id: string) => owned.includes(id);
  let value = 6;
  if (has("paint")) value += 4;
  if (has("golden")) value *= 2;
  return {
    dropInterval: has("dropper3") ? 1.7 : has("dropper2") ? 2.6 : 4.2,
    beltSpeed: has("belt2") ? 6 : 3,
    carry: has("cart") ? 3 : has("basket") ? 2 : 1,
    incubTime: has("heatlamp") ? 3.5 : 6,
    incubators: has("incubator2") ? 2 : 1,
    incubCapacity: 6,
    flyValue: value,
    dustMul: has("scrubber") ? 0.5 : 1,
    sugarBar: has("sugarbar"),
    paint: has("paint"),
    golden: has("golden"),
    neon: has("neon"),
  };
}

export function isUnlocked(s: EconState, u: UpgradeDef): boolean {
  return !s.owned.includes(u.id) && (u.requires ?? []).every((r) => s.owned.includes(r));
}

export function available(s: EconState): UpgradeDef[] {
  return UPGRADES.filter((u) => isUnlocked(s, u));
}

export function buy(s: EconState, id: string): boolean {
  const u = UPGRADES.find((x) => x.id === id);
  if (!u || !isUnlocked(s, u) || s.money < u.cost) return false;
  s.money -= u.cost;
  s.owned.push(u.id);
  return true;
}

export function earn(s: EconState, amount: number) {
  s.money += amount;
  s.earned += amount;
  s.flies += 1;
}

const SAVE_KEY = "fly-factory-save-v1";

export function save(s: EconState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: progress just isn't kept */
  }
}

export function load(): EconState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as EconState;
    if (typeof s.money !== "number" || !Array.isArray(s.owned)) return null;
    s.owned = s.owned.filter((id) => UPGRADES.some((u) => u.id === id));
    return s;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}
