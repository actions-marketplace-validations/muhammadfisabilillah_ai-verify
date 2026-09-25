import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

const RUST_EXTENSION = /\.rs$/i;

export function isRustFile(
  filePath: string,
  language: string | undefined,
): boolean {
  if (language === "rust") {
    return true;
  }

  return RUST_EXTENSION.test(filePath);
}

async function isAccessibleDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isCargoAvailable(repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync("cargo", ["--version"], {
      cwd: repositoryPath,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasCargoToml(repositoryPath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryPath, "Cargo.toml"));
    return true;
  } catch {
    return false;
  }
}

interface CargoMessage {
  message?: {
    code?: { code: string };
    message: string;
    level: string;
    spans?: Array<{
      file_name: string;
      line_start: number;
      column_start: number;
    }>;
  };
}

function parseCargoOutput(stdout: string): CargoMessage[] {
  const messages: CargoMessage[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as CargoMessage;
      if (parsed.message) {
        messages.push(parsed);
      }
    } catch {
      // Not JSON, skip
    }
  }

  return messages;
}

function toFinding(
  msg: CargoMessage,
  repositoryPath: string,
  index: number,
): Finding {
  const message = msg.message;
  const span = message?.spans?.[0];
  const filePath = span?.file_name ?? "unknown";
  const relative =
    path.isAbsolute(filePath) && filePath.startsWith(repositoryPath + path.sep)
      ? path.relative(repositoryPath, filePath)
      : filePath;

  const finding: Finding = {
    id: `cargo-check-${index + 1}`,
    title: message?.code?.code
      ? `${message.code.code}: ${message.message}`
      : (message?.message ?? "Unknown error"),
    description: `Cargo check issue in ${relative}`,
    severity: message?.level === "error" ? "high" : "medium",
    category: "reliability",
    source: "typecheck",
    file: relative,
    ruleId: message?.code?.code ?? "cargo-check",
  };

  if (span?.line_start) {
    finding.line = span.line_start;
  }

  return finding;
}

export class CargoCheckVerifier implements Verifier {
  readonly id = "cargo-check";
  readonly name = "Cargo check";

  async run(context: VerifierContext): Promise<VerificationCheck> {
    const start = Date.now();
    const finish = (
      status: VerificationCheck["status"],
      findings: Finding[] = [],
      reason?: string,
    ): VerificationCheck => {
      if (reason === undefined) {
        return {
          id: this.id,
          name: this.name,
          status,
          durationMs: Date.now() - start,
          findings,
        };
      }

      return {
        id: this.id,
        name: this.name,
        status,
        durationMs: Date.now() - start,
        findings,
        reason,
      };
    };

    const touchesRust = context.changeSet.files.some((file) =>
      isRustFile(file.path, file.language),
    );

    if (!touchesRust) {
      return finish("skipped", [], "No Rust files changed.");
    }

    if (!(await isAccessibleDirectory(context.repositoryPath))) {
      return finish(
        "error",
        [],
        `Cannot access repository path: ${context.repositoryPath}`,
      );
    }

    if (!(await hasCargoToml(context.repositoryPath))) {
      return finish(
        "skipped",
        [],
        "No Cargo.toml found. Run cargo init first.",
      );
    }

    if (!(await isCargoAvailable(context.repositoryPath))) {
      return finish(
        "skipped",
        [],
        "Cargo is not available in this environment.",
      );
    }

    try {
      await execFileAsync("cargo", ["check", "--message-format=json"], {
        cwd: context.repositoryPath,
        timeout: 180_000,
      });

      return finish("passed");
    } catch (error: unknown) {
      if (
        error !== null &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        error.stdout.trim() !== ""
      ) {
        const messages = parseCargoOutput(error.stdout);
        const findings = messages
          .filter((msg) => msg.message?.level === "error")
          .map((msg, index) => toFinding(msg, context.repositoryPath, index));

        if (findings.length > 0) {
          return finish("failed", findings);
        }
      }

      return finish("error", [], "Cargo check execution failed.");
    }
  }
}
