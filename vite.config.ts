import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss()],
  server: { host: "0.0.0.0", port: 5176 },
  preview: { host: "0.0.0.0", port: 4176 },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  fmt: { ignorePatterns: ["dist/**", "playwright-report/**", "test-results/**", "pnpm-lock.yaml"] },
  lint: { ignorePatterns: ["dist/**", "playwright-report/**", "test-results/**"] },
});
