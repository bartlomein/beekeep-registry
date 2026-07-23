import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageDirectory, "../..");
const outputDirectory = path.join(packageDirectory, "dist");
const outputFile = path.join(outputDirectory, "beekeep.mjs");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(packageDirectory, "src", "beekeep.mjs")],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  packages: "external",
  platform: "node",
  target: "node22",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
await chmod(outputFile, 0o755);
await cp(
  path.join(repositoryRoot, "LICENSE"),
  path.join(packageDirectory, "LICENSE"),
);
