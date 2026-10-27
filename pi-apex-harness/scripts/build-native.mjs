#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const C_SRC_PATH = path.join(REPO_ROOT, "src/native/linux_fs_bridge.c");
const ADDON_PATH = path.join(REPO_ROOT, "src/native/linux_fs_bridge.node");

const includeCandidates = [
  "/opt/homebrew/include/node",
  "/usr/include/node",
  "/tmp/node22/include/node",
  "/usr/local/include/node",
  path.resolve(process.execPath, "../../include/node"),
  path.resolve(process.execPath, "../../../include/node")
];
const nodeInclude = includeCandidates.find((p) => fs.existsSync(path.join(p, "node_api.h")));
if (!nodeInclude) {
  console.error(`Missing node_api.h in candidates [${includeCandidates.join(", ")}]`);
  process.exit(1);
}

const isDarwin = process.platform === "darwin";
const compiler = isDarwin ? "clang" : (process.env.CC || "gcc");
const flags = isDarwin
  ? [
      "-dynamiclib",
      "-undefined",
      "dynamic_lookup",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      "-DNODE_GYP_MODULE_NAME=linux_fs_bridge",
      `-I${nodeInclude}`,
      C_SRC_PATH,
      "-o",
      ADDON_PATH
    ]
  : [
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      "-DNODE_GYP_MODULE_NAME=linux_fs_bridge",
      `-I${nodeInclude}`,
      C_SRC_PATH,
      "-o",
      ADDON_PATH
    ];

execFileSync(compiler, flags, { stdio: "inherit" });
console.log(`[build:native] Built ${ADDON_PATH} successfully using ${compiler}`);
