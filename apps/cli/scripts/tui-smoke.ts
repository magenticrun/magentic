/**
 * Drives the real TUI through a pseudo-terminal and reads the frames that
 * come back: `bun run smoke` from apps/cli.
 *
 * OpenTUI renders nothing without a terminal on the other end — it asks the
 * terminal what it can do and waits for the answer — so this needs a PTY
 * rather than a pipe. `Bun.Terminal` is one, and a real one: the CLI cannot
 * tell it from a person's terminal, so what this checks is what a person
 * would see, chrome and keys and all, rather than a render of the component
 * tree in isolation.
 *
 * It runs against a config and data directory of its own, so it neither
 * reads the credentials of whoever runs it nor leaves conversations behind.
 *
 * What it checks is what a keystroke newly drew, taken out of the escape
 * sequences around it. OpenTUI redraws by cell diffs, so the stripped text of
 * a whole screen interleaves pieces of the frame before it: look for a run of
 * characters a keystroke put there, never for a whole line, and never for the
 * absence of something. Assertions past that want a terminal emulator to
 * render the cells first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;
const ENTRY = new URL("../src/main.ts", import.meta.url).pathname;

/** How long the first frame may take: a cold start transpiles the CLI and opens a gateway. */
const BOOT_TIMEOUT = 30_000;
/** How long anything after boot may take; a keystroke is a frame away. */
const STEP_TIMEOUT = 5_000;

const ESC = String.fromCharCode(27);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OSC = new RegExp(`${ESC}\\][^${ESC}\\x07]*(?:\\x07|${ESC}\\\\)`, "g");
const OTHER = new RegExp(`${ESC}.`, "g");

/** What was drawn, with the escape sequences that placed it taken out. */
const readable = (raw: string): string =>
  raw.replaceAll(CSI, "").replaceAll(OSC, "").replaceAll(OTHER, "").replaceAll(/ {2,}/g, " ");

const home = mkdtempSync(join(tmpdir(), "magentic-smoke-"));
let raw = "";

const term = new Bun.Terminal({
  cols: 100,
  rows: 30,
  name: "xterm-256color",
  data: (_terminal, chunk) => {
    raw += new TextDecoder().decode(chunk);
  },
});

const child = Bun.spawn(["bun", ENTRY], {
  cwd: ROOT,
  terminal: term,
  env: {
    ...process.env,
    MAGENTIC_HOME: join(home, "config"),
    MAGENTIC_DATA_DIR: join(home, "data"),
  },
});

const failures: Array<string> = [];

const done = () => {
  child.kill();
  term.close();
  rmSync(home, { recursive: true, force: true });
};

/** The last thing drawn, for a failure to be read against. */
const frame = (): string => readable(raw).slice(-1_500);

/**
 * How much has been drawn so far. Taken before a keystroke and handed to the
 * wait after it, so a check reads the frames that keystroke caused and not
 * the ones already on screen.
 */
const drawn = (): number => readable(raw).length;

/**
 * Wait for something to appear on screen. Every check is a wait rather than a
 * sleep and an assertion: a slow machine takes longer to draw, it does not
 * draw something else.
 */
const waitFor = async (
  what: string,
  wanted: string,
  timeout: number,
  from: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (readable(raw).slice(from).includes(wanted)) {
      console.log(`  ok   ${what}`);
      return true;
    }
    await Bun.sleep(100);
  }
  failures.push(what);
  console.log(`  FAIL ${what} — never saw ${JSON.stringify(wanted)}`);
  return false;
};

/** Type at the composer, as a person's keyboard would deliver it, and let it settle. */
const type = async (keys: string) => {
  term.write(keys);
  await Bun.sleep(250);
};

console.log(`tui smoke: ${ENTRY}`);

const typed = "hello from a pty";

if (await waitFor("boots to the composer", "Message the agent", BOOT_TIMEOUT, 0)) {
  const composed = drawn();
  await type(typed);
  await waitFor("takes what is typed", typed, STEP_TIMEOUT, composed);

  await type("\x7f".repeat(typed.length));
  const cleared = drawn();
  await type("/");
  await waitFor("opens the command menu", "/compact", STEP_TIMEOUT, cleared);

  await type("\x7f");
  const composing = drawn();
  await type("\x03");
  await waitFor("arms quitting on ctrl+c", "ctrl+c again to quit", STEP_TIMEOUT, composing);

  term.write("\x03");
  const code = await Promise.race([child.exited, Bun.sleep(STEP_TIMEOUT).then(() => "no exit")]);
  if (code === 0) {
    console.log("  ok   quits on the second ctrl+c");
  } else {
    failures.push("quits on the second ctrl+c");
    console.log(`  FAIL quits on the second ctrl+c — ${code}`);
  }
}

if (failures.length > 0) {
  console.log(`\nlast frame:\n${frame()}\n`);
  console.log(`${failures.length} failed: ${failures.join(", ")}`);
  done();
  process.exit(1);
}

console.log("\nall good");
done();
