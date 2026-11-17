import { defineConfig } from "tsup";

export default defineConfig([
  { entry: ["src/index.ts"], format: ["esm", "cjs"], target: "es2022", sourcemap: true, clean: true },
  // The worker is loaded as a module worker: ESM only, self-contained (no shared chunk to resolve).
  { entry: ["src/worker.ts"], format: ["esm"], target: "es2022", sourcemap: true, splitting: false },
]);
