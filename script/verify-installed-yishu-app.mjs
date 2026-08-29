#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_APP_PATH = "/Applications/奕枢.app";
const EXPECTED_BUNDLE_IDENTIFIER = "com.yishu.yishu-buddy";
const REQUIRED_FILES = {
  runtimePackage: {
    relativePath: "Contents/Resources/YishuRuntime/runtime/package.json",
  },
  runtimeEntry: {
    relativePath: "Contents/Resources/YishuRuntime/runtime/dist/stdio-server.js",
  },
  node: {
    relativePath: "Contents/Resources/YishuRuntime/bin/node",
    executable: true,
  },
  voiceProxy: {
    relativePath: "Contents/Resources/YishuVoiceProxy/local-server.mjs",
  },
  voiceProxyHotwords: {
    relativePath: "Contents/Resources/YishuVoiceProxy/stepfun-hotwords.mjs",
  },
};
const GENERATED_RUNTIME_SOURCE_PREFIXES = ["dist/", "node_modules/", ".git/"];
const GENERATED_RUNTIME_SOURCE_SUFFIXES = [".d.ts", ".map"];

function parseArguments(rawArguments) {
  let appPath;
  let repoRoot;
  let requireRunning = false;

  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--require-running") {
      requireRunning = true;
      continue;
    }
    if (argument === "--repo-root") {
      repoRoot = rawArguments[index + 1];
      if (!repoRoot || repoRoot.startsWith("-")) {
        throw new Error("missing_repo_root");
      }
      index += 1;
      continue;
    }
    if (argument === "--app-path") {
      if (appPath !== undefined) {
        throw new Error("duplicate_app_path");
      }
      appPath = rawArguments[index + 1];
      if (!appPath || appPath.startsWith("-")) {
        throw new Error("missing_app_path");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error("unknown_argument");
    }
    if (appPath !== undefined) {
      throw new Error("duplicate_app_path");
    }
    appPath = argument;
  }

  return {
    appPath: path.resolve(appPath ?? DEFAULT_APP_PATH),
    repoRoot: repoRoot === undefined ? undefined : path.resolve(repoRoot),
    requireRunning,
    help: false,
  };
}

function printHelp() {
  process.stdout.write([
    "Usage: node script/verify-installed-yishu-app.mjs [app-path] [options]",
    "",
    `Default app path: ${DEFAULT_APP_PATH}`,
    "  --app-path PATH       App bundle to inspect",
    "  --repo-root PATH      Compare packages/runtime/src with bundled runtime/src",
    "  --require-running     Require exactly one matching app process",
    "  --help                Show this help",
    "",
  ].join("\n"));
}

function commandFor(environmentKey, defaultCommand) {
  const configured = process.env[environmentKey];
  return configured && configured.trim() ? configured : defaultCommand;
}

function runCommand(command, argumentsList) {
  try {
    const result = spawnSync(command, argumentsList, {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
    return {
      exitCode: typeof result.status === "number" ? result.status : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  } catch {
    return { exitCode: null, stdout: "" };
  }
}

function readPlistValue(plistPath, key) {
  const result = runCommand(
    commandFor("YISHU_VERIFY_PLUTIL_BIN", "plutil"),
    ["-extract", key, "raw", "-o", "-", plistPath],
  );
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  if (!value || value.includes("\n") || value.length > 512) return null;
  return value;
}

function fileState(filePath, executable = false) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return { exists: false, executable: false };
    if (!executable) return { exists: true, executable: null };
    try {
      accessSync(filePath, fsConstants.X_OK);
      return { exists: true, executable: true };
    } catch {
      return { exists: true, executable: false };
    }
  } catch {
    return { exists: false, executable: false };
  }
}

function directoryExists(directoryPath) {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function pathWithinApp(appPath, relativePath) {
  return path.join(appPath, ...relativePath.split("/"));
}

function checkRequiredFiles(appPath) {
  const files = {};
  const hashes = {};
  let passed = true;

  for (const [name, descriptor] of Object.entries(REQUIRED_FILES)) {
    const absolutePath = pathWithinApp(appPath, descriptor.relativePath);
    const state = fileState(absolutePath, descriptor.executable === true);
    const filePassed = state.exists && (descriptor.executable !== true || state.executable === true);
    if (!filePassed) passed = false;
    files[name] = {
      path: descriptor.relativePath,
      status: filePassed ? "passed" : "failed",
      ...(descriptor.executable === true ? { executable: state.executable } : {}),
    };
    if (filePassed) {
      const digest = sha256File(absolutePath);
      if (!digest) {
        passed = false;
        files[name].status = "failed";
      } else {
        hashes[name] = digest;
      }
    }
  }

  return {
    check: { status: passed ? "passed" : "failed", files },
    hashes,
  };
}

function checkCodeSignature(appPath) {
  const result = runCommand(
    commandFor("YISHU_VERIFY_CODESIGN_BIN", "codesign"),
    ["--verify", "--deep", "--strict", appPath],
  );
  return {
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
  };
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkRunningProcess(executablePath) {
  if (!executablePath) {
    return {
      status: "failed",
      runningPidCount: null,
      reason: "main_executable_unresolved",
    };
  }

  const pattern = `^${escapeRegularExpression(executablePath)}([[:space:]]|$)`;
  const result = runCommand(
    commandFor("YISHU_VERIFY_PGREP_BIN", "pgrep"),
    ["-f", pattern],
  );
  if (result.exitCode === 1) {
    return { status: "passed", runningPidCount: 0 };
  }
  if (result.exitCode !== 0) {
    return { status: "failed", runningPidCount: null, reason: "process_scan_failed" };
  }

  const lines = result.stdout.trim() ? result.stdout.trim().split(/\s+/u) : [];
  if (lines.length === 0 || lines.some((line) => !/^\d+$/u.test(line))) {
    return { status: "failed", runningPidCount: null, reason: "process_scan_invalid" };
  }
  return { status: "passed", runningPidCount: lines.length };
}

function shouldIgnoreRuntimeSource(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === ".DS_Store") return true;
  if (GENERATED_RUNTIME_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return GENERATED_RUNTIME_SOURCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function collectRuntimeSourceFiles(rootPath) {
  const files = [];
  const unsafeEntries = [];

  function visit(currentPath, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) => (
        left.name.localeCompare(right.name)
      ));
    } catch {
      unsafeEntries.push(relativeDirectory || ".");
      return;
    }

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (shouldIgnoreRuntimeSource(relativePath)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        unsafeEntries.push(relativePath);
      } else if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ relativePath, absolutePath });
      }
    }
  }

  visit(rootPath, "");
  return { files, unsafeEntries };
}

function compareRuntimeSource(appPath, repoRoot) {
  const repoPath = path.join(repoRoot, "packages/runtime/src");
  const bundlePath = pathWithinApp(appPath, "Contents/Resources/YishuRuntime/runtime/src");
  const repoExists = directoryExists(repoPath);
  const bundleExists = directoryExists(bundlePath);
  if (!repoExists || !bundleExists) {
    return {
      status: "failed",
      repoPath,
      bundlePath,
      reason: "runtime_source_missing",
      missingFromRepo: [],
      missingFromBundle: [],
      changed: [],
    };
  }

  const repoFiles = collectRuntimeSourceFiles(repoPath);
  const bundleFiles = collectRuntimeSourceFiles(bundlePath);
  const repoByPath = new Map(repoFiles.files.map((file) => [file.relativePath, file]));
  const bundleByPath = new Map(bundleFiles.files.map((file) => [file.relativePath, file]));
  const missingFromBundle = [...repoByPath.keys()].filter((key) => !bundleByPath.has(key)).sort();
  const missingFromRepo = [...bundleByPath.keys()].filter((key) => !repoByPath.has(key)).sort();
  const changed = [];

  for (const relativePath of [...repoByPath.keys()].filter((key) => bundleByPath.has(key)).sort()) {
    const repoSha256 = sha256File(repoByPath.get(relativePath).absolutePath);
    const bundleSha256 = sha256File(bundleByPath.get(relativePath).absolutePath);
    if (!repoSha256 || !bundleSha256 || repoSha256 !== bundleSha256) {
      changed.push({
        path: relativePath,
        repoSha256,
        bundleSha256,
      });
    }
  }

  const passed = repoFiles.unsafeEntries.length === 0
    && bundleFiles.unsafeEntries.length === 0
    && missingFromBundle.length === 0
    && missingFromRepo.length === 0
    && changed.length === 0
    && repoFiles.files.length > 0;
  return {
    status: passed ? "passed" : "failed",
    repoPath,
    bundlePath,
    repoFileCount: repoFiles.files.length,
    bundleFileCount: bundleFiles.files.length,
    ignoredGeneratedFiles: true,
    missingFromRepo,
    missingFromBundle,
    changed,
    unsafeEntries: [...new Set([...repoFiles.unsafeEntries, ...bundleFiles.unsafeEntries])].sort(),
  };
}

function failedArgumentReport(reason) {
  return {
    schemaVersion: 1,
    ok: false,
    appPath: DEFAULT_APP_PATH,
    version: null,
    bundleIdentifier: null,
    executablePath: null,
    hashes: {},
    runningPidCount: null,
    checks: {
      arguments: { status: "failed", reason },
    },
  };
}

function verify(options) {
  const appPath = options.appPath;
  const appExists = directoryExists(appPath);
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const plistState = fileState(infoPlistPath);
  const bundleIdentifier = plistState.exists
    ? readPlistValue(infoPlistPath, "CFBundleIdentifier")
    : null;
  const version = plistState.exists
    ? readPlistValue(infoPlistPath, "CFBundleShortVersionString")
    : null;
  const executableName = plistState.exists
    ? readPlistValue(infoPlistPath, "CFBundleExecutable")
    : null;
  const executableNameIsSafe = Boolean(
    executableName
      && path.basename(executableName) === executableName
      && !executableName.includes("\\"),
  );
  const executablePath = executableNameIsSafe
    ? path.join(appPath, "Contents", "MacOS", executableName)
    : null;
  const executableState = fileState(executablePath ?? "", true);
  const required = checkRequiredFiles(appPath);
  const codeSignature = appExists ? checkCodeSignature(appPath) : {
    status: "failed",
    exitCode: null,
  };
  const mainExecutableHash = executableState.exists ? sha256File(executablePath) : null;
  const processCheck = checkRunningProcess(executablePath);
  const singleInstancePassed = processCheck.status === "passed"
    && processCheck.runningPidCount !== null
    && processCheck.runningPidCount <= 1;
  const runningPassed = singleInstancePassed
    && (!options.requireRunning || processCheck.runningPidCount === 1);

  const checks = {
    app: {
      status: appExists ? "passed" : "failed",
      path: appPath,
    },
    bundleIdentifier: {
      status: bundleIdentifier === EXPECTED_BUNDLE_IDENTIFIER ? "passed" : "failed",
      expected: EXPECTED_BUNDLE_IDENTIFIER,
      actual: bundleIdentifier,
    },
    version: {
      status: version ? "passed" : "failed",
      value: version,
    },
    mainExecutable: {
      status: executableState.exists && executableState.executable && mainExecutableHash
        ? "passed"
        : "failed",
      path: executablePath,
      executable: executableState.executable,
    },
    codeSignature,
    runtime: required.check,
    node: required.check.files.node,
    voiceProxy: required.check.files.voiceProxy,
    singleInstance: {
      status: singleInstancePassed ? "passed" : "failed",
      max: 1,
    },
    running: {
      status: runningPassed ? "passed" : "failed",
      required: options.requireRunning,
    },
  };
  if (options.repoRoot !== undefined) {
    checks.runtimeSource = compareRuntimeSource(appPath, options.repoRoot);
  }

  const ok = Object.values(checks).every((check) => check.status === "passed");
  return {
    schemaVersion: 1,
    ok,
    appPath,
    version,
    bundleIdentifier,
    executablePath,
    hashes: {
      mainExecutable: mainExecutableHash,
      ...required.hashes,
    },
    runningPidCount: processCheck.runningPidCount,
    checks,
  };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failedArgumentReport(error instanceof Error ? error.message : "invalid_arguments"))}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const report = verify(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
