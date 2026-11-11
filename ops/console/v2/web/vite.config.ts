import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const sharedDir = fileURLToPath(new URL("../shared", import.meta.url));
const repoDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": sharedDir },
  },
  build: { outDir: "dist", sourcemap: false, emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    // shared/api.ts lives one level above the web root; dev needs read access to it.
    fs: { allow: [here, sharedDir, repoDir] },
  },
  test: {
    // No DOM environment is installed on purpose: tests cover pure logic only.
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: ["dot"],
    // Bounded parallelism, because this box is the owner's desktop and not a CI
    // runner. Vitest defaults to a worker per core, so a full run took all
    // twelve and WSL showed up as ninety percent CPU in Windows; he killed it,
    // which is the correct response to a tool making the machine unusable.
    // Four workers finish the suite in about the same wall time (it is 500
    // fast pure-logic tests, so startup dominates) while leaving the machine
    // responsive. An agent runs this far more often than a person does.
    pool: "threads",
    // vitest 4 replaced poolOptions.threads.maxThreads with a top-level maxWorkers.
    maxWorkers: 4,
  },
});
