import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // OpenTUI's Solid components: Vite honours `jsx: preserve`, so Solid's own transform
  // has to run, and the `node` export condition must not pick Solid's server build.
  plugins: [solid({ solid: { moduleName: "@opentui/solid", generate: "universal" }, ssr: false })],
  resolve: {
    alias: {
      "solid-js/store": "solid-js/store/dist/store.js",
      "solid-js": "solid-js/dist/solid.js",
    },
  },
  test: {
    environment: "node",
    include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}"],
  },
});
