import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve("dist");
const nodeModulesDir = resolve("node_modules");
const mapFiles = walk(distDir).filter((file) => file.endsWith(".map"));
const packages = new Set();

for (const mapFile of mapFiles) {
  const sourceMap = JSON.parse(readFileSync(mapFile, "utf8"));
  for (const source of sourceMap.sources || []) {
    const packageName = packageNameFromSource(source);
    if (packageName) packages.add(packageName);
  }
}

if (!packages.size) throw new Error("No bundled third-party packages found in dist source maps");

const sections = [...packages].sort().map((packageName) => {
  const packageDir = join(nodeModulesDir, packageName);
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const licenseFile = findLicenseFile(packageDir);
  const license = typeof metadata.license === "string" ? metadata.license : "See license text below";
  const licenseText = licenseFile
    ? readFileSync(licenseFile, "utf8").trim()
    : packagedLicenseFallback(metadata);
  if (!licenseText) throw new Error(`Missing license text for ${packageName}`);
  return [
    "=".repeat(78),
    `${packageName}@${metadata.version} (${license})`,
    "=".repeat(78),
    licenseText,
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

function packageNameFromSource(source) {
  const marker = "node_modules/";
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const parts = source.slice(markerIndex + marker.length).split("/");
  if (!parts[0]) return null;
  return parts[0].startsWith("@") && parts[1]
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
}

function findLicenseFile(packageDir) {
  const candidates = readdirSync(packageDir)
    .filter((name) => /^(licen[sc]e|copying)(\..+)?$/i.test(name))
    .map((name) => join(packageDir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => a.length - b.length);
  return candidates[0];
}

function packagedLicenseFallback(metadata) {
  if (metadata.license !== "MIT") return null;
  const author = typeof metadata.author === "string"
    ? metadata.author
    : metadata.author?.name;
  if (!author) return null;
  return [
    "(The MIT License)",
    "",
    `Copyright (c) ${author}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n");
}
