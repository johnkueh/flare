// The example in a real browser: two people, each in their own browser
// window, sign in by email code, share a list by its invite code, and see
// each other's items arrive live.
//
//   pnpm e2e                                  # starts wrangler dev on a fresh local state
//   CHROMIUM=/path/to/chrome pnpm e2e         # another browser
//   E2E_URL=http://localhost:8787 pnpm e2e    # against a dev server you already run
//
// Screenshots and wrangler's log land in .wrangler/e2e/.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { chromium } from "playwright-core";

const STATE = ".wrangler/e2e";
const PORT = 8799;
let server;

async function main() {
  let base = process.env.E2E_URL;
  if (!base) {
    rmSync(STATE, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    execFileSync("node", ["scripts/db-local.mjs", "--persist-to", STATE], { stdio: "ignore" });
    const log = openSync(`${STATE}/dev.log`, "w");
    server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", `BETTER_AUTH_URL:http://localhost:${PORT}`], {
      // To a file: an unread pipe fills up and stalls wrangler.
      stdio: ["ignore", log, log],
    });
    base = `http://localhost:${PORT}`;
    await waitFor(base);
  }

  const browser = await chromium.launch({ executablePath: findChromium() });
  try {
    const mia = await person(browser, base, "mia@example.com");
    const sam = await person(browser, base, "sam@example.com");

    step("Mia makes a list and adds milk");
    await mia.fill("#space-name", "Weekly shop");
    await mia.click("#create-form button");
    await mia.waitForSelector("#space:not([hidden])");
    await add(mia, "Milk");
    const code = (await mia.textContent("#invite-code")).replace("-", "");

    step(`Sam joins with the code ${code}`);
    await sam.fill("#join-code", code);
    await sam.click("#join-form button");
    await sam.waitForSelector("#space:not([hidden])");
    await sam.waitForSelector("#items li:has-text('Milk')");

    step("Sam adds bread; it appears on Mia's list without a reload");
    await add(sam, "Bread");
    await mia.waitForSelector("#items li:has-text('Bread')", { timeout: 10_000 });

    step("Mia ticks milk off; Sam sees it done");
    await mia.click("#items li:has-text('Milk') input");
    await sam.waitForSelector("#items li.done:has-text('Milk')", { timeout: 10_000 });

    step("Both are listed as members");
    await mia.click("#back");
    await mia.click("#spaces button:has-text('Weekly shop')");
    await mia.waitForSelector("#members li:nth-child(2)");

    step("Sam signs out and back in: the list is still there");
    await sam.click("#sign-out");
    await sam.waitForSelector("#signed-out:not([hidden])");
    await signIn(sam, base, "sam@example.com");
    await sam.waitForSelector("#spaces button:has-text('Weekly shop')");

    await mia.screenshot({ path: `${STATE}/mia.png` });
    await sam.screenshot({ path: `${STATE}/sam.png` });
    console.log("\nPassed. Screenshots in .wrangler/e2e/");
  } finally {
    await browser.close();
  }
}

/** A browser window of its own (its own cookies), signed in. */
async function person(browser, base, email) {
  const context = await browser.newContext({ viewport: { width: 480, height: 820 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`[${email}] page error:`, err.message));
  await page.goto(base);
  step(`${email} signs in with an email code`);
  await signIn(page, base, email);
  await page.waitForSelector("#home:not([hidden])");
  return page;
}

async function signIn(page, base, email) {
  await page.fill("#email", email);
  await page.click("#email-form button");
  await page.waitForSelector("#code-form:not([hidden])");
  await page.fill("#code", await latestCode(base, email));
  await page.click("#code-form button");
}

async function add(page, name) {
  await page.fill("#item-name", name);
  await page.click("#add-form button");
  await page.waitForSelector(`#items li:has-text('${name}')`);
}

async function latestCode(base, email) {
  for (let i = 0; i < 50; i++) {
    const { code } = await (await fetch(`${base}/dev/outbox?email=${encodeURIComponent(email)}`)).json();
    if (code) return code;
    await sleep(100);
  }
  throw new Error(`no code sent to ${email}`);
}

async function waitFor(base) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("wrangler dev didn't start");
}

function findChromium() {
  const candidates = [process.env.CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].filter(Boolean);
  return candidates.find((p) => existsSync(p)); // undefined: playwright's own download
}

function step(text) {
  console.log(`• ${text}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => server?.kill());
