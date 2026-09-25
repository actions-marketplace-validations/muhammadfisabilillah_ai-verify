import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import { isRustFile } from "./cargo-check.js";
import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

interface CargoTestFailure {
  name: string;
  stdout: string;
  stderr: string;
}

function parseCargoTestOutput(stdout: string): CargoTestFailure[] {
  const failures: CargoTestFailure[] = [];
  const lines = stdout.split("\n");

  let currentTest: string | null = null;
  let currentOutput: string[] = [];

  for (const line of lines) {
    if (line.startsWith("test ") && line.includes("FAILED")) {
      const match = /^test\s+(.+)\s+FAILED/.exec(line);
      if (match && match[1]) {
        currentTest = match[1];
        currentOutput = [];
      }
    } else if (line.startsWith("failures:") && currentTest) {
      failures.push({
        name: currentTest,
        stdout: currentOutput.join("\n"),
        stderr: "",
      });
      currentTest = null;
      currentOutput = [];
    } else if (currentTest) {
      currentOutput.push(line);
    }
  }

  return failures;
}

function toFinding(
  failure: CargoTestFailure,
  repositoryPath: string,
  index: number,
): Finding {
  return {
    id: `cargo-test-${index + 1}`,
    title: `${failure.name} failed`,
    description: `Test ${failure.name} failed\n${failure.stdout}`,
    severity: "medium",
    category: "test",
    source: "test",
    file: repositoryPath,
    ruleId: "cargo-test",
  };
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

function hasRustTestFiles(changeSet: VerifierContext["changeSet"]): boolean {
  return changeSet.files.some(
    (file) =>
      isRustFile(file.path, file.language) &&
      (file.path.includes("test") || file.path.includes("spec")),
  );
}

export class CargoTestVerifier implements Verifier {
  readonly id = "cargo-test";
  readonly name = "Cargo tests";

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

    if (!hasRustTestFiles(context.changeSet)) {
      return finish("skipped", [], "No Rust test files found in changes.");
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

    const tempDir = mkdtempSync(path.join(tmpdir(), "ai-verify-cargo-test-"));

    try {
      await execFileAsync("cargo", ["test"], {
        cwd: context.repositoryPath,
        timeout: 180_000,
      });

      return finish("passed");
    } catch (error: unknown) {
      let findings: Finding[] = [];

      if (
        error !== null &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        error.stdout.trim() !== ""
      ) {
        const failures = parseCargoTestOutput(error.stdout);
        findings = failures.map((failure, index) =>
          toFinding(failure, context.repositoryPath, index),
        );
      }

      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      if (findings.length > 0) {
        return finish("failed", findings);
      }

      return finish("error", [], "Cargo test execution failed.");
    }
  }
}
