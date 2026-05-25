import fs from "node:fs";
import path from "node:path";
import type { ExecCommandSegment } from "../infra/exec-approvals-analysis.js";
import type { SystemRunApprovalFileOperand } from "../infra/exec-approvals.js";
import { extractShellWrapperInlineCommand } from "../infra/exec-wrapper-resolution.js";
import { resolveMutableFileOperandSnapshotSync } from "../node-host/invoke-system-run-plan.js";

export type MutableScriptApprovalBinding = {
  argv: string[];
  snapshot: SystemRunApprovalFileOperand;
};

function normalizeCommandName(value: string | undefined): string {
  return path.basename(value ?? "").toLowerCase();
}

function directSegmentReferencesExistingFile(
  argv: readonly string[],
  cwd: string | undefined,
): boolean {
  for (const token of argv.slice(1)) {
    const trimmed = token.trim();
    if (!trimmed || trimmed === "-" || trimmed === "--") {
      continue;
    }
    const candidates = trimmed.includes("=")
      ? [trimmed, trimmed.slice(trimmed.indexOf("=") + 1)]
      : [trimmed];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("-")) {
        continue;
      }
      try {
        if (fs.statSync(path.resolve(cwd ?? process.cwd(), candidate)).isFile()) {
          return true;
        }
      } catch {
        // Non-file arguments do not require script binding.
      }
    }
  }
  return false;
}

function tokenLooksLikeMutableScriptOperand(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    token.includes("/") ||
    token.includes("\\") ||
    /\.(?:[cm]?js|jsx|tsx?|py|rb|pl|php|lua|sh|bash|zsh|fish|mjs|cjs)$/i.test(lower)
  );
}

const MUTABLE_SCRIPT_RUNNER_COMMANDS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "lua",
  "esno",
  "jiti",
  "ts-node",
  "ts-node-esm",
  "tsx",
  "vite-node",
]);

function directSegmentUsesMutableScriptRunner(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  return MUTABLE_SCRIPT_RUNNER_COMMANDS.has(command) || /^python\d*(?:\.\d+)?$/.test(command);
}

function directSegmentLooksLikeScriptInvocation(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  if (!command) {
    return false;
  }
  if (command === "python" || /^python\d+(?:\.\d+)?$/.test(command)) {
    return argv.slice(1).some((token) => {
      const trimmed = token.trim();
      return trimmed && !trimmed.startsWith("-") && tokenLooksLikeMutableScriptOperand(trimmed);
    });
  }
  if (["node", "nodejs", "bun", "deno", "ruby", "perl", "php", "lua"].includes(command)) {
    return argv.slice(1).some((token) => {
      const trimmed = token.trim();
      return trimmed && !trimmed.startsWith("-") && tokenLooksLikeMutableScriptOperand(trimmed);
    });
  }
  return false;
}

function segmentChangesShellCwd(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  return command === "cd" || command === "pushd" || command === "popd";
}

function directSegmentMayRunLocalPythonModule(
  argv: readonly string[],
  cwd: string | undefined,
): boolean {
  const command = normalizeCommandName(argv[0]);
  if (!/^python(?:\d+(?:\.\d+)?)?$/.test(command)) {
    return false;
  }
  const moduleFlagIndex = argv.findIndex((token) => token.trim() === "-m");
  if (moduleFlagIndex < 0) {
    return false;
  }
  const moduleName = argv[moduleFlagIndex + 1]?.trim();
  if (!moduleName || moduleName.startsWith("-")) {
    return false;
  }
  const modulePath = moduleName.replaceAll(".", path.sep);
  const baseDir = cwd ?? process.cwd();
  return [
    path.resolve(baseDir, `${modulePath}.py`),
    path.resolve(baseDir, modulePath, "__main__.py"),
  ].some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function resolveMutableScriptApprovalBindings(params: {
  cwd: string | undefined;
  segments: Array<Pick<ExecCommandSegment, "argv" | "raw">>;
}): { ok: true; bindings: MutableScriptApprovalBinding[] } | { ok: false; message: string } {
  const bindings: MutableScriptApprovalBinding[] = [];
  let shellCwdMayHaveChanged = false;
  for (const segment of params.segments) {
    if (segmentChangesShellCwd(segment.argv)) {
      shellCwdMayHaveChanged = true;
      continue;
    }
    const shellCommand = extractShellWrapperInlineCommand(segment.argv);
    const snapshot = resolveMutableFileOperandSnapshotSync({
      argv: segment.argv,
      cwd: params.cwd,
      shellCommand,
    });
    if (!snapshot.ok) {
      if (
        (shellCwdMayHaveChanged && directSegmentUsesMutableScriptRunner(segment.argv)) ||
        shellCommand !== null ||
        directSegmentReferencesExistingFile(segment.argv, params.cwd) ||
        directSegmentLooksLikeScriptInvocation(segment.argv) ||
        directSegmentMayRunLocalPythonModule(segment.argv, params.cwd)
      ) {
        return snapshot;
      }
      continue;
    }
    if (snapshot.snapshot) {
      if (shellCwdMayHaveChanged) {
        return {
          ok: false,
          message:
            "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        };
      }
      bindings.push({ argv: segment.argv, snapshot: snapshot.snapshot });
    }
  }
  return { ok: true, bindings };
}

export function commandRequiresMutableScriptApproval(params: {
  cwd: string | undefined;
  segments: Array<Pick<ExecCommandSegment, "argv" | "raw">>;
}): boolean {
  const bindings = resolveMutableScriptApprovalBindings(params);
  return !bindings.ok || bindings.bindings.length > 0;
}
