import { transformAsync } from "@babel/core";
import { fileURLToPath } from "node:url";

/** Compile the browser entry as the gateway starts; no separate build command is needed. */
export const buildWeb = () =>
  Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("./client.tsx"))],
    target: "browser",
    minify: true,
    plugins: [
      {
        name: "solid-dom",
        setup(build) {
          build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            const transformed = await transformAsync(source, {
              filename: path,
              configFile: false,
              babelrc: false,
              presets: [
                [
                  fileURLToPath(import.meta.resolve("babel-preset-solid")),
                  { generate: "dom", hydratable: false },
                ],
              ],
              parserOpts: { plugins: ["typescript", "jsx"] },
            });
            return { contents: transformed?.code ?? source, loader: "tsx" };
          });
        },
      },
    ],
  });
