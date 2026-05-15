import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/content.ts"),
      formats: ["iife"],
      fileName: () => "content.js",
      name: "ConfluenceMermaidRenderer",
    },
    minify: "terser",
    outDir: "dist",
    terserOptions: {
      format: {
        ascii_only: true,
      },
    },
  },
});
