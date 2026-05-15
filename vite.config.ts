import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    emptyOutDir: true,
    minify: "terser",
    outDir: "dist",
    terserOptions: {
      format: {
        ascii_only: true,
      },
    },
  },
});
