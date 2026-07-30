import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve("dist");
const nodeModulesDir = resolve("node_modules");
const mapFiles = walk(distDir).filter((file) => file.endsWith(".map"));
const packages = new Set();

for (const mapFile of mapFiles) {
  const sourceMap = JSON.parse(readFileSync(mapFile, "utf8"));
  for (const source of sourceMap.sources || []) {
    const match = source.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
    if (match) packages.add(match[1]);
  }
}

if (!packages.size) throw new Error("No bundled third-party packages found in dist source maps");

const sections = [...packages].sort().map((packageName) => {
  const packageDir = join(nodeModulesDir, packageName);
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const licenseFile = findLicenseFile(packageDir);
  if (!licenseFile) throw new Error(`Missing license file for ${packageName}`);
  const license = typeof metadata.license === "string" ? metadata.license : "See license text below";
  return [
    "=".repeat(78),
    `${packageName}@${metadata.version} (${license})`,
    "=".repeat(78),
    readFileSync(licenseFile, "utf8").trim(),
  ].join("\n");
});

const output = [
  "Third-Party Notices",
  "",
  "Lumen Paper includes third-party open-source software. Each component",
  "remains subject to its respective license. Nothing in this file modifies",
  "those license terms.",
  "",
  `Generated from ${packages.size} packages present in the production bundle.`,
  "",
  ...sections,
  "",
].join("\n");

for (const target of [resolve("public/THIRD_PARTY_NOTICES.txt"), resolve("dist/THIRD_PARTY_NOTICES.txt")]) {
  writeFileSync(target, output);
}

process.stdout.write(`Wrote notices for ${packages.size} bundled packages\n`);

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function findLicenseFile(packageDir) {
  const candidates = readdirSync(packageDir)
    .filter((name) => /^(licen[sc]e|copying)(\..+)?$/i.test(name))
    .map((name) => join(packageDir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => a.length - b.length);
  return candidates[0];
}
