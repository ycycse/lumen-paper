import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = resolve("lumen-paper-extension.zip");
rmSync(output, { force: true });
const result = spawnSync("zip", ["-qr", output, ".", "-x", "*.map"], { cwd: resolve("dist"), stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
process.stdout.write(`${output}\n`);
