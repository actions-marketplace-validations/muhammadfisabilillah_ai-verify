#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CoreOrchestrator } from "../core/orchestrator.js";
import { GitAnalyzer } from "../analyzer/git-analyzer.js";
import { RiskEngineV01 } from "../risk/risk-engine.js";
import { deriveVerdict, selectVerifiers } from "../verifier/index.js";
import { appendHistory, buildHistoryEntry } from "../history/store.js";
import {
  hasFailed,
  printBanner,
  printChangeReport,
  printRiskReport,
  printVerificationReport,
} from "./report.js";
import { getVersion } from "./version.js";
import { installHook, uninstallHook } from "./hooks.js";

export interface RunOptions {
  json?: boolean;
  history?: boolean;
  refRange?: string | undefined;
}

export interface CliArgs {
  repositoryPath: string;
  json: boolean;
  help: boolean;
  version: boolean;
  history: boolean;
  ref?: string | undefined;
  installHook: boolean;
  uninstallHook: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let repositoryPath = ".";
  let json = false;
  let help = false;
  let version = false;
  let history = true;
  let ref: string | undefined;
  let installHook = false;
  let uninstallHook = false;

  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;

    if (arg === "--json") {
      json = true;
    } else if (arg === "--no-history") {
      history = false;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-V") {
      version = true;
    } else if (arg === "--install-hook") {
      installHook = true;
    } else if (arg === "--uninstall-hook") {
      uninstallHook = true;
    } else if (arg === "--ref") {
      const value = args[i + 1];
      i++;

      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --ref: expected a git range.");
      }

      ref = value;
    } else if (arg.startsWith("--ref=")) {
      const value = arg.slice("--ref=".length);

      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --ref: expected a git range.");
      }

      ref = value;
    } else if (!arg.startsWith("-") && repositoryPath === ".") {
      repositoryPath = arg;
    } else if (!arg.startsWith("-")) {
      repositoryPath = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    repositoryPath,
    json,
    help,
    version,
    history,
    ref,
    installHook,
    uninstallHook,
  };
}

export function printHelp(): void {
  console.log(`AI Verify — AI can generate code. AI Verify helps verify it.
------------------------------
Usage: ai-verify [path] [options]

Arguments:
  [path]        Target git repository (default: .)

Options:
  --json        Machine-readable JSON output ({ changeSet, risk, verification, verdict })
  --ref <range> Verify a committed git range (e.g. HEAD~1..HEAD) instead of
                uncommitted changes
  --no-history  Skip recording this run to the local history
  --install-hook    Install ai-verify as a git pre-commit hook
  --uninstall-hook  Remove the ai-verify pre-commit hook
  -h, --help    Show this help
  -V, --version Show version

History: every run appends one summary line to
~/.cache/ai-verify/runs.jsonl (override with AI_VERIFY_HISTORY_FILE).
No file contents are recorded. Use --no-history to opt out.

Examples:
  ai-verify .
  ai-verify /path/to/repo --json
  ai-verify . --ref HEAD~1..HEAD
  ai-verify --install-hook
  ai-verify --help`);
}

export async function run(
  repositoryPath: string,
  options?: RunOptions,
): Promise<number> {
  const request: {
    repositoryPath: string;
    includeUncommittedChanges: boolean;
    refRange?: string | undefined;
  } = {
    repositoryPath: path.resolve(repositoryPath),
    includeUncommittedChanges: true,
  };

  if (options?.refRange !== undefined) {
    request.refRange = options.refRange;
  }

  const analyzer = new GitAnalyzer();
  const riskEngine = new RiskEngineV01();
  const core = new CoreOrchestrator(analyzer, riskEngine, selectVerifiers);

  const output = await core.run(request);
  const { changeSet, risk, verification } = output;
  const verdict = deriveVerdict(verification);

  if (options?.history !== false) {
    await appendHistory(
      buildHistoryEntry(output, verdict, getVersion(), request.repositoryPath),
    );
  }

  if (options?.json === true) {
    console.log(
      JSON.stringify({
        changeSet,
        risk,
        verification,
        verdict,
      }),
    );
    return hasFailed(verification) ? 1 : 0;
  }

  printBanner(getVersion());
  printChangeReport(changeSet, request.refRange);
  printRiskReport(risk);
  printVerificationReport(verification);

  return hasFailed(verification) ? 1 : 0;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.version) {
    console.log(getVersion());
    return 0;
  }

  if (args.installHook) {
    const repoPath =
      args.repositoryPath === "." ? process.cwd() : args.repositoryPath;
    try {
      const result = await installHook(repoPath);
      if (result.installed) {
        console.log(
          `Pre-commit hook installed${result.backedUp ? " (existing hook backed up)" : ""}.`,
        );
        return 0;
      } else {
        console.log("Pre-commit hook is already installed.");
        return 0;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to install hook: ${message}`);
      return 1;
    }
  }

  if (args.uninstallHook) {
    const repoPath =
      args.repositoryPath === "." ? process.cwd() : args.repositoryPath;
    try {
      const result = await uninstallHook(repoPath);
      if (result.removed) {
        console.log(
          `Pre-commit hook removed${result.restored ? " (backup restored)" : ""}.`,
        );
        return 0;
      } else {
        console.log("No ai-verify pre-commit hook found.");
        return 0;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to uninstall hook: ${message}`);
      return 1;
    }
  }

  return run(args.repositoryPath, {
    json: args.json,
    history: args.history,
    refRange: args.ref,
  });
}

const entryPath = fileURLToPath(import.meta.url);

// npm .bin links, npx, and global installs invoke the CLI through a symlink,
// so argv[1] never equals the real module path. Compare canonical paths or
// every symlinked install exits silently without running anything.
export function isEntryModule(
  invokedPath: string | undefined,
  metaUrl: string,
): boolean {
  if (invokedPath === undefined) {
    return false;
  }

  try {
    return realpathSync(invokedPath) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error("AI Verify failed.");

      if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error(error);
      }

      process.exitCode = 1;
    },
  );
}
