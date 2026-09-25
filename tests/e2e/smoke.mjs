// End-to-end smoke test: builds are served with `vite preview`, driven with Playwright.
// Checks that the brain runs in real time and that the neural behaviours appear in the game.
//   npm run build && npm run e2e
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 4179;
const OUT = process.env.SHOTS ?? "test-results";
mkdirSync(OUT, { recursive: true });
const executablePath = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", process.env.DIST ?? "dist"], { stdio: "pipe", detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid);
  } catch {
    /* already gone */
  }
};
process.on("exit", stopServer);
process.on("uncaughtException", (e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("preview server did not start")), 20000);
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && (clearTimeout(t), res()));
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // network failures (e.g. web fonts blocked in CI sandboxes, favicon 404) are not app errors
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector("#intro:not([hidden])", { timeout: 60000 });
  await page.screenshot({ path: `${OUT}/01-intro.png`, timeout: 90000 });
  await page.click("#btn-start");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/02-factory.png`, timeout: 90000 });

  const poll = async (fn, timeoutMs, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await page.evaluate(fn, arg)) return (Date.now() - t0) / 1000;
      await page.waitForTimeout(100);
    }
    return -1;
  };

  // brain keeps up with real time
  const t0 = await page.evaluate(() => window.__fly.decoder && window.__fly.frames());
  await page.waitForTimeout(2000);
  const t1 = await page.evaluate(() => window.__fly.frames());
  const simMs = (t1 - t0) * 25;
  check("brain runs ~real time", simMs > 1400, `${simMs} ms simulated in 2000 ms wall (${await page.evaluate(() => window.__fly.brain.mode)})`);

  // feeding: sugar in front of the mouth -> sugar GRNs -> MN9
  await page.evaluate(() => {
    const f = window.__fly;
    f.worker.energy = 0.3;
    f.worker.commandTo(f.worker.pos.clone());
    const m = f.worker.rig.mouthWorld();
    f.tools.dropSugar(m.setY(0), 1.5);
  });
  let s = await poll(() => window.__fly.worker.stats.feeds > 0, 8000);
  await page.screenshot({ path: `${OUT}/03-feeding.png`, timeout: 90000 });
  check("sugar → MN9 → feeding", s >= 0, s >= 0 ? `after ${s.toFixed(1)} s, MN9 ${(await page.evaluate(() => window.__fly.decoder.state.rates.MN9)).toFixed(0)} Hz` : "");

  // grooming: heavy dust on the head bristles
  await page.evaluate(() => {
    const f = window.__fly;
    f.tools.cubes.forEach((c) => (c.amount = 0));
    f.worker.dust = 0.95;
  });
  s = await poll(() => window.__fly.worker.stats.grooms > 0, 8000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/04-grooming.png`, timeout: 90000 });
  check("dust → grooming DNs → grooming", s >= 0, s >= 0 ? `after ${s.toFixed(1)} s` : "");
  await poll(() => window.__fly.worker.mode !== "grooming", 10000);

  // escape: newspaper looming
  await page.evaluate(() => {
    const f = window.__fly;
    f.worker.dust = 0;
    f.tools.startSwat(f.worker.headPos, f.worker.left);
  });
  s = await poll(() => window.__fly.worker.stats.escapes + window.__fly.worker.stats.bonks > 0, 4000);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/05-escape.png`, timeout: 90000 });
  const esc = await page.evaluate(() => window.__fly.worker.stats);
  check("looming → Giant Fiber → escape (or bonk)", s >= 0, JSON.stringify({ escapes: esc.escapes, bonks: esc.bonks }));

  // Opto Lab: MDN activation -> moonwalk
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__fly.brain.setOpto("MDN", 150));
  s = await poll(() => window.__fly.worker.mode === "moonwalk", 4000);
  await page.screenshot({ path: `${OUT}/06-moonwalk.png`, timeout: 90000 });
  check("Opto Lab MDN → moonwalk", s >= 0);
  await page.evaluate(() => window.__fly.brain.setOpto("MDN", 0));

  // Opto Lab: left DNa02 -> the fly turns left (heading increases)
  await page.waitForTimeout(1000);
  const h0 = await page.evaluate(() => {
    window.__fly.brain.setOpto("DNa02L", 150);
    return window.__fly.worker.heading;
  });
  s = await poll(() => window.__fly.worker.mode === "turning", 4000);
  await page.waitForTimeout(800);
  const h1 = await page.evaluate(() => window.__fly.worker.heading);
  await page.evaluate(() => window.__fly.brain.setOpto("DNa02L", 0));
  check("Opto Lab DNa02 L → turns left", s >= 0 && h1 > h0, `heading ${h0.toFixed(2)} → ${h1.toFixed(2)} rad`);

  // bitter-laced sugar is refused: bitter GRNs suppress MN9
  await page.waitForTimeout(1500);
  const feeds0 = await page.evaluate(() => {
    const f = window.__fly;
    f.worker.commandTo(f.worker.pos.clone());
    f.worker.energy = 0.3;
    const m = f.worker.rig.mouthWorld().setY(0);
    f.tools.spray(m.clone());
    f.tools.dropSugar(m, 1.5);
    return f.worker.stats.feeds;
  });
  await page.waitForTimeout(3000);
  const bitterRes = await page.evaluate(() => ({ feeds: window.__fly.worker.stats.feeds, mn9: window.__fly.decoder.state.rates.MN9, sugar: window.__fly.worker.inputs.sugar, bitter: window.__fly.worker.inputs.bitter }));
  check("bitter + sugar → MN9 suppressed, no feeding", bitterRes.feeds === feeds0 && bitterRes.sugar > 50, JSON.stringify({ mn9: +bitterRes.mn9.toFixed(1), sugarHz: Math.round(bitterRes.sugar), bitterHz: Math.round(bitterRes.bitter) }));
  await page.evaluate(() => window.__fly.tools.cubes.forEach((c) => (c.amount = 0)));

  // economy: flies get made
  await page.evaluate(() => window.__fly.worker.backToWork());
  s = await poll(() => window.__fly.econ.earned > 0, 60000);
  check("production pays out", s >= 0, s >= 0 ? `first fly after ${s.toFixed(0)} s more` : "");
  await page.click('.tool[data-panel="opto"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/07-panels.png`, timeout: 90000 });

  // mobile layout
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.goto(`http://localhost:${PORT}/`);
  await mobile.waitForSelector("#intro:not([hidden])", { timeout: 60000 });
  await mobile.click("#btn-start");
  await mobile.waitForTimeout(2000);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await mobile.screenshot({ path: `${OUT}/08-mobile.png` });
  check("no horizontal overflow on phone", !overflow);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  stopServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
