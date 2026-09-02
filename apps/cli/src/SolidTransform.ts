import { plugin } from "bun";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Solid components are compiled by Babel as their modules load, and Babel is
 * the slowest thing the CLI would import: loading it and compiling the chat
 * view take longer than everything else before the first paint. The compiled
 * output is kept under the cache directory, stamped with the source's hash
 * and OpenTUI's version, so a warm start reads a file instead. Babel is
 * imported only when a component changed, or the compiler did.
 *
 * This runs before Effect and its Config exist, which is why the home
 * directory is read here directly.
 */

const PLUGIN_URL = import.meta.resolve("@opentui/solid/bun-plugin");

/** OpenTUI pins the Solid preset, so its version stands for the compiler's. */
const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", PLUGIN_URL), "utf8"),
).version;

const CACHE_DIR = join(homedir(), ".cache", "magentic", "solid");

/** JSX files outside node_modules, the way OpenTUI's own plugin selects them. */
const SOURCE = /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/;
const SOLID_SERVER = /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/;
const STORE_SERVER = /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/;

const strip = (path: string): string => path.replace(/[?#].*$/, "");

interface Compiler {
  readonly transformSolidSource: (
    code: string,
    options: { readonly filename: string },
  ) => Promise<string>;
}

let compiler: Promise<Compiler> | undefined;

/** The compiler beside OpenTUI's plugin, which the package does not export on its own. */
const loadCompiler = (): Promise<Compiler> =>
  (compiler ??= import(new URL("./solid-transform.js", PLUGIN_URL).href));

/** Written beside the cache file first, so a start that reads meanwhile sees whole files only. */
const store = (file: string, text: string): void => {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const partial = `${file}.${process.pid}`;
    writeFileSync(partial, text);
    renameSync(partial, file);
  } catch {
    // A cache that cannot be written only costs the next start what this one paid.
  }
};

/** Register the transform. Must run before any module with a Solid component is imported. */
export const registerSolidTransform = (): void => {
  plugin({
    name: "magentic-solid",
    setup: (build) => {
      // Bun resolves solid-js to its server build, which has no reactivity; point it at the real one.
      build.onLoad({ filter: SOLID_SERVER }, async (args) => ({
        contents: await Bun.file(strip(args.path).replace("server.js", "solid.js")).text(),
        loader: "js",
      }));
      build.onLoad({ filter: STORE_SERVER }, async (args) => ({
        contents: await Bun.file(strip(args.path).replace("server.js", "store.js")).text(),
        loader: "js",
      }));
      build.onLoad({ filter: SOURCE }, async (args) => {
        const path = strip(args.path);
        const code = await Bun.file(path).text();
        const stamp = `// magentic solid ${VERSION} ${Bun.hash(code).toString(16)}\n`;
        const file = join(CACHE_DIR, `${Bun.hash(path).toString(16)}.js`);
        const known = await Bun.file(file)
          .text()
          .catch(() => undefined);
        if (known !== undefined && known.startsWith(stamp)) {
          return { contents: known.slice(stamp.length), loader: "js" };
        }
        const { transformSolidSource } = await loadCompiler();
        const contents = await transformSolidSource(code, { filename: path });
        store(file, stamp + contents);
        return { contents, loader: "js" };
      });
    },
  });
};
