import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Distribute individual tests evenly across CI shards while keeping 1 worker per runner.
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // Software WebGL on CI is slower than a GPU; exercise the same production build.
  timeout: process.env.CI ? 180_000 : 90_000,
  expect: { timeout: process.env.CI ? 30_000 : 15_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5176/platform-h2h-battle/",
    viewport: { width: 1440, height: 900 },
    headless: true,
    screenshot: "only-on-failure",
    // Continuous screencast readbacks stall software WebGL on CI. Keep DOM/action
    // traces and the explicit screenshots below instead of recording every frame.
    trace: { mode: "retain-on-failure", screenshots: false, snapshots: true },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--enable-unsafe-swiftshader",
        "--use-gl=angle",
        "--use-angle=swiftshader",
      ],
    },
  },
  webServer: {
    command: process.env.PLAYWRIGHT_SKIP_BUILD
      ? "pnpm exec vp preview --host 127.0.0.1 --port 5176 --strictPort --base /platform-h2h-battle/"
      : "pnpm build && pnpm exec vp preview --host 127.0.0.1 --port 5176 --strictPort --base /platform-h2h-battle/",
    url: "http://127.0.0.1:5176/platform-h2h-battle/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
