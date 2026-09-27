/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `vite build` -> dist/ (multi-file static site)
// `vite build --mode single` -> dist-single/index.html (everything inlined, for one-file hosting)
export default defineConfig(({ mode }) => {
  const single = mode === "single";
  return {
    base: "./",
    plugins: single ? [viteSingleFile()] : [],
    worker: { format: "es" },
    build: {
      outDir: single ? "dist-single" : "dist",
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 4000,
      target: "es2022",
    },
    test: {
      environment: "node",
      include: ["tests/*.test.ts"],
      testTimeout: 120_000,
    },
  };
});
