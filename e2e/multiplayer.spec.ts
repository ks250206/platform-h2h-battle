import { expect, test, type Page } from "@playwright/test";

/**
 * Local multiplayer with fake gamepads: `navigator.getGamepads` is replaced by a function that
 * returns pads the test drives through `window.__pad*` helpers.
 */

declare global {
  interface Window {
    __pads: (FakePad | null)[];
    __rumbles: number;
    __padConnect: (index: number) => void;
    __padDisconnect: (index: number) => void;
    __padButton: (index: number, button: number, down: boolean) => void;
    __padAxes: (index: number, axes: number[]) => void;
  }
}
interface FakePad {
  index: number;
  id: string;
  connected: boolean;
  mapping: string;
  timestamp: number;
  axes: number[];
  buttons: { pressed: boolean; value: number; touched: boolean }[];
  vibrationActuator: { playEffect: () => Promise<string> };
}

const A = 0;
const B = 1;
const Y = 3;
const LB = 4;
const RB = 5;
const START = 9;
const DOWN = 13;
const RIGHT = 15;

async function installPads(page: Page) {
  await page.addInitScript(() => {
    window.__pads = [null, null, null, null];
    window.__rumbles = 0;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => window.__pads.slice(),
    });
    window.__padConnect = (index) => {
      const pad: FakePad = {
        index,
        id: `Fake standard pad ${index}`,
        connected: true,
        mapping: "standard",
        timestamp: performance.now(),
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
        vibrationActuator: {
          playEffect: () => {
            window.__rumbles++;
            return Promise.resolve("complete");
          },
        },
      };
      window.__pads[index] = pad;
      const event = new Event("gamepadconnected");
      Object.defineProperty(event, "gamepad", { value: pad });
      window.dispatchEvent(event);
    };
    window.__padDisconnect = (index) => {
      window.__pads[index] = null;
      window.dispatchEvent(new Event("gamepaddisconnected"));
    };
    window.__padButton = (index, button, down) => {
      const pad = window.__pads[index]!;
      pad.buttons[button] = { pressed: down, value: down ? 1 : 0, touched: down };
      pad.timestamp = performance.now();
    };
    window.__padAxes = (index, axes) => {
      window.__pads[index]!.axes = axes;
      window.__pads[index]!.timestamp = performance.now();
    };
  });
}

const button = (page: Page, index: number, which: number, down: boolean) =>
  page.evaluate(([i, b, d]) => window.__padButton(i, b, d), [index, which, down] as const);
const phase = (page: Page) => page.evaluate(() => window.__BRAMBLE__!.snapshot().phase);
/**
 * Waits for `count` animation frames in the page. A pad is polled once a frame, so a release
 * followed by a press needs frames in between, however long a frame takes on the machine.
 */
const frames = (page: Page, count: number) =>
  page.evaluate(
    (left) =>
      new Promise<void>((resolve) => {
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
      }),
    count,
  );
const device = (page: Page, slot: number) =>
  page.locator(`.player-row[data-slot="${slot}"] .player-device`);

test("pads join on the title and a keyboard player and a pad player share a duel", async ({
  page,
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installPads(page);
  const started = Date.now();
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  console.info(`ready in ${Date.now() - started}ms`);
  await expect(page.locator(".join-hint")).toContainText("パッドのボタンを押して参加");
  await page.evaluate(() => {
    window.__padConnect(0);
    window.__padConnect(1);
  });
  // A button that is already down when a screen takes over the pads does nothing until it is
  // released, so let the title see the pads idle before the first press.
  await frames(page, 5);

  // パッド1 presses A: it takes the duel's CPU slot (シロ).
  await expect(device(page, 1)).toHaveValue("cpu");
  await button(page, 0, A, true);
  await expect(device(page, 1)).toHaveValue("pad1");
  await button(page, 0, A, false);
  await expect(page.locator('.player-row[data-slot="1"] .player-badge')).toHaveText("P2");
  await expect(page.locator('.player-row[data-slot="0"] .player-badge')).toHaveText("P1");

  // In a rumble, パッド2's Start joins the next CPU slot instead of starting, and B leaves again.
  await page.locator('button[data-mode="rumble"]').click();
  await button(page, 1, START, true);
  await expect(device(page, 2)).toHaveValue("pad2");
  await button(page, 1, START, false);
  expect(await phase(page)).toBe("menu");
  await expect(device(page, 3)).toHaveValue("cpu");
  await expect(page.locator('.player-row[data-slot="3"] .player-level')).toBeVisible();
  await button(page, 1, B, true);
  await expect(device(page, 2)).toHaveValue("cpu");
  await button(page, 1, B, false);

  // Choosing a device another slot uses swaps the two.
  await device(page, 1).selectOption("keyboard");
  await expect(device(page, 0)).toHaveValue("pad1");
  await expect(device(page, 1)).toHaveValue("keyboard");
  await device(page, 0).selectOption("keyboard");
  await expect(device(page, 1)).toHaveValue("pad1");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("bramble.match.v1")!).controls),
  ).toEqual({ 0: "keyboard", 1: "pad1" });

  // The duel: keyboard = P1 (コハク), パッド1 = P2 (シロ).
  await page.locator('button[data-mode="duel"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  console.info(`duel playing after ${Date.now() - started}ms`);
  const snapshot = await page.evaluate(() => window.__BRAMBLE__!.snapshot());
  expect(snapshot.options.controls).toEqual({ 0: "keyboard", 1: "pad1" });
  expect(snapshot.fighters[0]!.human).toBe(true);
  expect(snapshot.fighters[0]!.player).toBe(1);
  expect(snapshot.fighters[1]!.human).toBe(true);
  expect(snapshot.fighters[1]!.player).toBe(2);
  await expect(page.locator(".fighter-card .fighter-tag")).toHaveText(["P1", "P2"]);
  await expect(page.locator(".fighter-locks").first()).toContainText("P2 LOCK");
  await expect(page.locator(".pad-legend")).toBeVisible();
  await expect(page.locator(".keyboard-legend")).toBeVisible();

  // The pad's left stick moves fighter 1 and not fighter 0.
  const before = snapshot.fighters;
  // The stick is let go from inside the page as soon as the fighter has covered the distance: a
  // slow round trip through the test runner would walk it off the island.
  await page.evaluate(
    ([x, z]) =>
      new Promise<void>((resolve) => {
        window.__padAxes(0, [0.9, 0, 0, 0]);
        const poll = () => {
          const f = window.__BRAMBLE__!.snapshot().fighters[1]!;
          if (Math.hypot(f.x - x, f.z - z) <= 0.6) return requestAnimationFrame(poll);
          window.__padAxes(0, [0, 0, 0, 0]);
          resolve();
        };
        requestAnimationFrame(poll);
      }),
    [before[1]!.x, before[1]!.z] as const,
  );
  const moved = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters);
  expect(Math.hypot(moved[0]!.x - before[0]!.x, moved[0]!.z - before[0]!.z)).toBeLessThan(0.05);
  await page.waitForFunction(() => {
    const f = window.__BRAMBLE__!.snapshot().fighters[1]!;
    return f.mode === "idle" && f.grounded && Math.hypot(f.vx, f.vz) < 0.05;
  });

  // RB commits a sweep. Fighter 1's mode is logged every frame from inside the page, and RB is
  // released from inside the page once the charge shows, so a slow frame cannot hide a state.
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { __log: string[] }).__log = log;
    let released = false;
    const poll = () => {
      const f = window.__BRAMBLE__!.snapshot().fighters[1]!;
      log.push(`${f.mode}:${f.attack}`);
      if (!released && f.mode === "charge") {
        released = true;
        window.__padButton(0, 5, false);
      }
      if (log.length < 600) requestAnimationFrame(poll);
    };
    window.__padButton(0, 5, true);
    requestAnimationFrame(poll);
  });
  await page.waitForFunction(() =>
    (window as unknown as { __log: string[] }).__log.some((entry) =>
      /^(windup|active|recovery):sweep$/.test(entry),
    ),
  );
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log.slice());
  expect(log).toContain("charge:sweep");
  expect(log.some((entry) => entry.startsWith("windup:sweep"))).toBe(true);
  await button(page, 0, RB, false);
  // Fighter 0 (the keyboard player) did not attack.
  expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0]!.attack)).toBeNull();

  // Start pauses; still held, it does not resume at once; pressed again, it resumes.
  await button(page, 0, START, true);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "paused");
  await page.waitForTimeout(400);
  expect(await phase(page)).toBe("paused");
  await button(page, 0, START, false);
  await frames(page, 5);
  await button(page, 0, START, true);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  await button(page, 0, START, false);

  // A pad of the match that goes away pauses the game and says which one.
  await page.evaluate(() => window.__padDisconnect(0));
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "paused");
  await expect(page.locator(".pause-notice")).toHaveText(/パッド1 の接続が切れました/);
  await page.evaluate(() => window.__padConnect(0));
  // Any pad drives the pause panel: B resumes. The panel must have taken over the pads first: on
  // a slow machine the press could land in the very frame the pause appears, and a button that
  // is down at a takeover is ignored until it comes up.
  await frames(page, 5);
  await button(page, 1, B, true);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  await button(page, 1, B, false);
  await page.screenshot({ path: "test-results/multiplayer-duel.png" });
  expect(errors).toEqual([]);
});

test("a pad alone picks a look: Y opens, the d-pad and A choose, B cancels, Start confirms", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installPads(page);
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await page.evaluate(() => window.__padConnect(0));
  await frames(page, 5);
  /** One full press: the menu reads the pads once a frame. */
  const press = async (which: number) => {
    await button(page, 0, which, true);
    await frames(page, 4);
    await button(page, 0, which, false);
    await frames(page, 4);
  };
  const saved = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("bramble.match.v1") ?? "{}"));
  const focused = () =>
    page.evaluate(() => ({ ...(document.activeElement as HTMLElement | null)?.dataset }));
  const dialog = page.locator(".character-dialog");
  const original = { species: "rabbit", palette: "sky", accessory: "none" };

  // The pad joins slot 1; Y opens the picker on the fighter it plays.
  await press(A);
  await expect(device(page, 1)).toHaveValue("pad1");
  await expect(page.locator(".join-hint")).toContainText("見た目");
  await press(Y);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-customize-slot="1"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator(".character-pad-hint")).toBeVisible();
  await expect(dialog.locator('[data-species="rabbit"]')).toBeFocused();

  // Right and A: the next animal. Down reaches the colours, then the accessories; A takes the
  // focused one each time, and the fighter in the arena follows.
  await press(RIGHT);
  await press(A);
  await expect(dialog.locator('[data-species="bear"]')).toHaveAttribute("aria-pressed", "true");
  await press(DOWN);
  await press(RIGHT);
  const palette = (await focused()).palette;
  expect(palette).toBeTruthy();
  await press(A);
  let accessory: string | undefined;
  for (let step = 0; step < 5 && !accessory; step++) {
    await press(DOWN);
    accessory = (await focused()).accessory;
  }
  expect(accessory).toBeTruthy();
  await press(RIGHT);
  accessory = (await focused()).accessory;
  await press(A);
  const chosen = { species: "bear", palette, accessory };
  expect((await saved()).loadouts[1]).toEqual(chosen);
  await page.waitForFunction(
    (look) => {
      const f = window.__BRAMBLE__!.snapshot().fighters[1]!;
      return (
        f.species === look.species && f.palette === look.palette && f.accessory === look.accessory
      );
    },
    chosen as { species: string; palette: string; accessory: string },
  );

  // B is "back": the look from before the picker opened returns, and the pad still plays slot 1.
  await press(B);
  await expect(dialog).toBeHidden();
  expect((await saved()).loadouts[1]).toEqual(original);
  expect((await saved()).controls).toEqual({ 0: "keyboard", 1: "pad1" });
  expect(await phase(page)).toBe("menu");

  // Again, and this time Start keeps it. LB moves to the other slot's tab on the way.
  await press(Y);
  await expect(dialog).toBeVisible();
  await press(RIGHT);
  await press(A);
  await press(LB);
  await expect(dialog.locator('[data-customize-slot="0"]')).toHaveAttribute("aria-pressed", "true");
  await press(START);
  await expect(dialog).toBeHidden();
  expect(await phase(page)).toBe("menu");
  expect((await saved()).loadouts[1]).toEqual({ ...original, species: "bear" });
  expect((await saved()).controls).toEqual({ 0: "keyboard", 1: "pad1" });

  // Start on the title starts the duel: the pad plays the bear it chose, as P2.
  await press(START);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase !== "menu");
  const fighters = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters);
  expect(fighters[1]).toMatchObject({ name: "モカ", species: "bear", human: true, player: 2 });
  expect(fighters[0]).toMatchObject({ name: "コハク", species: "fox", human: true, player: 1 });
  await expect(page.locator(".fighter-card .fighter-tag")).toHaveText(["P1", "P2"]);
  expect(errors).toEqual([]);
});
