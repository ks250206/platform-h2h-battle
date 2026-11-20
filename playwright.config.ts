import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Software WebGL on CI is slower than a GPU; exercise the same production build.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5176/platform-h2h-battle/",
    viewport: { width: 1440, height: 900 },
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
    command:
      "pnpm build && pnpm exec vp preview --host 127.0.0.1 --port 5176 --strictPort --base /platform-h2h-battle/",
    url: "http://127.0.0.1:5176/platform-h2h-battle/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
