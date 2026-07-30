import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BRIDGE_VERSION } from "../bridge/version.mjs";

const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve("public/manifest.json"), "utf8"));
if (packageMetadata.version !== manifest.version || packageMetadata.version !== BRIDGE_VERSION) {
  throw new Error(`Version mismatch: package=${packageMetadata.version}, manifest=${manifest.version}, bridge=${BRIDGE_VERSION}`);
}

const artifactsDir = resolve("artifacts");
mkdirSync(artifactsDir, { recursive: true });
const extensionName = `lumen-paper-extension-v${packageMetadata.version}.zip`;
const extensionPath = join(artifactsDir, extensionName);
copyFileSync(resolve("lumen-paper-extension.zip"), extensionPath);

const archivedManifest = JSON.parse(runText("unzip", ["-p", extensionPath, "manifest.json"]));
if (archivedManifest.version !== packageMetadata.version) {
  throw new Error(`Packaged manifest version mismatch: ${archivedManifest.version}`);
}
const extensionEntries = runText("unzip", ["-Z1", extensionPath]).trim().split("\n");
if (extensionEntries.some((entry) => entry.endsWith(".map"))) throw new Error("Extension archive contains source maps");
if (!extensionEntries.includes("manifest.json")) throw new Error("Extension archive must keep manifest.json at its root");

const bridgeName = `lumen-paper-codex-bridge-v${BRIDGE_VERSION}`;
const bridgeZipPath = join(artifactsDir, `${bridgeName}.zip`);
const bridgeEntries = runText("unzip", ["-Z1", bridgeZipPath]).trim().split("\n");
const requiredBridgeEntries = [
  "server.mjs",
  "version.mjs",
  "lumen-paper-bridge",
  "Start Lumen Paper Bridge.command",
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
].map((name) => `${bridgeName}/${name}`);
for (const entry of requiredBridgeEntries) {
  if (!bridgeEntries.includes(entry)) throw new Error(`Bridge archive is missing ${entry}`);
}
if (bridgeEntries.some((entry) => /(^|\/)(\.token|auth\.json|\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i.test(entry))) {
  throw new Error("Bridge archive contains a forbidden secret-like file");
}
const assetNames = [
  extensionName,
  `${bridgeName}.zip`,
  `${bridgeName}.tar.gz`,
  "install-lumen-paper-bridge.sh",
];
for (const name of assetNames) readFileSync(join(artifactsDir, name));

const checksumText = assetNames
  .map((name) => `${sha256(join(artifactsDir, name))}  ${name}`)
  .join("\n");
writeFileSync(join(artifactsDir, "SHA256SUMS.txt"), `${checksumText}\n`);
process.stdout.write(`${checksumText}\n`);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runText(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
