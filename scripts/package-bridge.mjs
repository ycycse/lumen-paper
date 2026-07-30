import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { BRIDGE_VERSION } from "../bridge/version.mjs";

const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
if (packageMetadata.version !== BRIDGE_VERSION) {
  throw new Error(`Version mismatch: package.json=${packageMetadata.version}, Bridge=${BRIDGE_VERSION}`);
}

run("node", ["--check", resolve("bridge/server.mjs")]);
run("bash", ["-n", resolve("bridge/lumen-paper-bridge")]);
run("bash", ["-n", resolve("bridge/Start Lumen Paper Bridge.command")]);
run("bash", ["-n", resolve("scripts/install-bridge.template.sh")]);

const artifactsDir = resolve("artifacts");
const stagingRoot = resolve("work/bridge-release");
const bundleName = `lumen-paper-codex-bridge-v${BRIDGE_VERSION}`;
const bundleDir = join(stagingRoot, bundleName);
mkdirSync(artifactsDir, { recursive: true });
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

const files = [
  ["bridge/server.mjs", "server.mjs", 0o600],
  ["bridge/version.mjs", "version.mjs", 0o600],
  ["bridge/lumen-paper-bridge", "lumen-paper-bridge", 0o700],
  ["bridge/Start Lumen Paper Bridge.command", "Start Lumen Paper Bridge.command", 0o700],
  ["bridge/README.md", "README.md", 0o600],
  ["LICENSE", "LICENSE", 0o600],
  ["PRIVACY.md", "PRIVACY.md", 0o600],
  ["SECURITY.md", "SECURITY.md", 0o600],
];
for (const [source, destination, mode] of files) {
  const target = join(bundleDir, destination);
  copyFileSync(resolve(source), target);
  chmodSync(target, mode);
}

const zipPath = join(artifactsDir, `${bundleName}.zip`);
const tarPath = join(artifactsDir, `${bundleName}.tar.gz`);
rmSync(zipPath, { force: true });
rmSync(tarPath, { force: true });
run("zip", ["-qry", zipPath, bundleName], { cwd: stagingRoot });
run("tar", ["-czf", tarPath, bundleName], { cwd: stagingRoot });

const archiveHash = sha256(tarPath);
const template = readFileSync(resolve("scripts/install-bridge.template.sh"), "utf8");
const installer = template
  .replaceAll("__VERSION__", BRIDGE_VERSION)
  .replaceAll("__BRIDGE_TARBALL_SHA256__", archiveHash);
if (installer.includes("__VERSION__") || installer.includes("__BRIDGE_TARBALL_SHA256__")) {
  throw new Error("Installer template placeholders were not fully replaced");
}
const installerPath = join(artifactsDir, "install-lumen-paper-bridge.sh");
writeFileSync(installerPath, installer, { mode: 0o700 });
chmodSync(installerPath, 0o700);
run("bash", ["-n", installerPath]);

for (const artifact of [zipPath, tarPath, installerPath]) {
  process.stdout.write(`${sha256(artifact)}  ${basename(artifact)}\n`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status || 1);
}
