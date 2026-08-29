#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUILD_PROVENANCE_SCHEMA_VERSION = 1;

const SOURCE_INPUT_ROOTS = [
  {
    relativePath: "apps/clicky/leanring-buddy",
    include: (relativePath) => (
      relativePath.endsWith(".swift")
      || relativePath === "Info.plist"
      || relativePath.endsWith(".entitlements")
    ),
  },
  {
    relativePath: "apps/clicky/leanring-buddy.xcodeproj",
    include: () => true,
  },
  {
    relativePath: "packages/runtime/src",
    include: () => true,
  },
  {
    relativePath: "packages/kernel/src",
    include: () => true,
  },
  {
    relativePath: "apps/clicky/worker/local-server.mjs",
    include: () => true,
  },
  {
    relativePath: "apps/clicky/worker/stepfun-hotwords.mjs",
    include: () => true,
  },
];

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isIgnoredSourceEntry(name, relativePath) {
  return name === ".DS_Store"
    || name === "xcuserdata"
    || relativePath === ".DS_Store";
}

function collectTreeFiles(repoRoot, sourceRoot) {
  const files = [];
  const absoluteRoot = path.join(repoRoot, sourceRoot.relativePath);

  function visit(absoluteDirectory, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      throw new Error("source_input_missing");
    }
    entries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (isIgnoredSourceEntry(entry.name, relativePath)) continue;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("source_input_symlink");
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile() && sourceRoot.include(relativePath)) {
        files.push({
          relativePath: path.join(sourceRoot.relativePath, relativePath)
            .split(path.sep)
            .join("/"),
          absolutePath,
        });
      }
    }
  }

  let rootStats;
  try {
    rootStats = lstatSync(absoluteRoot);
  } catch {
    throw new Error("source_input_missing");
  }
  if (rootStats.isSymbolicLink()) throw new Error("source_input_symlink");
  if (rootStats.isDirectory()) {
    visit(absoluteRoot, "");
  } else if (rootStats.isFile() && sourceRoot.include("")) {
    files.push({
      relativePath: sourceRoot.relativePath,
      absolutePath: absoluteRoot,
    });
  } else {
    throw new Error("source_input_missing");
  }
  return files;
}

export function collectSourceInputFiles(repoRoot) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const files = SOURCE_INPUT_ROOTS.flatMap((sourceRoot) => (
    collectTreeFiles(absoluteRepoRoot, sourceRoot)
  ));
  files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  if (files.length === 0) throw new Error("source_input_missing");
  return files;
}

export function sourceInputHash(repoRoot) {
  const entries = collectSourceInputFiles(repoRoot).map(({ relativePath, absolutePath }) => {
    let bytes;
    try {
      bytes = readFileSync(absolutePath);
    } catch {
      throw new Error("source_input_unreadable");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `${relativePath}\0${digest}\n`;
  });
  return createHash("sha256").update(entries.join(""), "utf8").digest("hex");
}

function runGit(repoRoot, gitCommand, argumentsList) {
  let result;
  try {
    result = spawnSync(gitCommand, ["-C", path.resolve(repoRoot), ...argumentsList], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
  } catch {
    throw new Error("git_unavailable");
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("git_query_failed");
  }
  return result.stdout.trim();
}

export function captureBuildProvenance(
  repoRoot,
  gitCommand = process.env.YISHU_PROVENANCE_GIT_BIN || "git",
) {
  const commit = runGit(repoRoot, gitCommand, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("invalid_git_head");
  const status = runGit(repoRoot, gitCommand, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    commit,
    worktreeDirty: status.length > 0,
    sourceInputHash: sourceInputHash(repoRoot),
  };
}

function parseArguments(rawArguments) {
  let repoRoot;
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--repo-root") {
      repoRoot = rawArguments[index + 1];
      if (!repoRoot || repoRoot.startsWith("-")) throw new Error("missing_repo_root");
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    throw new Error("unknown_argument");
  }
  return {
    help: false,
    repoRoot: path.resolve(repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")),
  };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write("Unable to capture Yishu build provenance.\n");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write("Usage: node script/build-provenance.mjs [--repo-root PATH]\n");
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(captureBuildProvenance(options.repoRoot))}\n`);
  } catch {
    process.stderr.write("Unable to capture Yishu build provenance.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
