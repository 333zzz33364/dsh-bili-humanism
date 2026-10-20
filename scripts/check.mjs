import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = [];
for (const dir of ["lib", "bin", "scripts", "test"])
  for (const f of readdirSync(dir))
    if (/\.(mjs|js)$/.test(f)) files.push(dir + "/" + f);
files.push("index.js");
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status) {
    console.error(r.stderr);
    process.exit(1);
  }
}
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const file of [
  ...files,
  "README.md",
  "NOTICE.md",
  ...readdirSync("docs")
    .filter((f) => f.endsWith(".md"))
    .map((f) => "docs/" + f),
]) {
  const ids = readFileSync(file, "utf8").match(/BV[0-9A-Za-z]{10}/g) || [];
  if (ids.some((id) => !["BV0000000001", "BVxxxxxxxxxx"].includes(id)))
    throw new Error("Public source must use synthetic BV fixtures: " + file);
}
if (!manifest.dsh?.bundle?.patch) throw new Error("Missing DSH bundle");
console.log(
  `Syntax checked ${files.length} source/test files; DSH manifest present.`,
);
