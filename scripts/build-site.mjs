import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(projectRoot, "dist");

await mkdir(join(outputDirectory, "assets"), { recursive: true });
await Promise.all([
  cp(join(projectRoot, "index.html"), join(outputDirectory, "index.html")),
  cp(
    join(projectRoot, "ShamsAcademy.html"),
    join(outputDirectory, "ShamsAcademy.html"),
  ),
  cp(join(projectRoot, "assets"), join(outputDirectory, "assets"), {
    recursive: true,
  }),
]);

console.log("Built static site in dist/.");
