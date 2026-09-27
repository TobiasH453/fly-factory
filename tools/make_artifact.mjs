// Turn the single-file build (dist-single/index.html) into page content for hosts that
// supply their own <html>/<head>/<body> skeleton: title + styles first, then markup, then scripts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist-single/index.html", "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const pick = (re) => [...head.matchAll(re)].map((m) => m[0]);
const parts = [
  ...pick(/<title>[\s\S]*?<\/title>/g),
  ...pick(/<meta name="description"[^>]*>/g),
  ...pick(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g),
  ...pick(/<style[^>]*>[\s\S]*?<\/style>/g),
  body.trim(),
  ...pick(/<script[^>]*>[\s\S]*?<\/script>/g),
];
mkdirSync("dist-artifact", { recursive: true });
const out = parts.join("\n");
writeFileSync("dist-artifact/fly-factory.html", out);
console.log(`dist-artifact/fly-factory.html  ${(out.length / 1e6).toFixed(2)} MB`);
