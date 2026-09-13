import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import { isGoFile } from "./go-vet.js";
import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

interface GoTestFailure {
  Test: string;
  Package: string;
  Output: string[];
  Action: string;
}

function parseGoTestOutput(stdout: string): GoTestFailure[] {
  const failures: GoTestFailure[] = [];
  const lines = stdout.split("\n");

  let currentFailure: GoTestFailure | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        Test?: string;
        Package?: string;
        Action?: string;
        Output?: string;
      };

      if (entry.Action === "fail" && entry.Test) {
        if (currentFailure && currentFailure.Test) {
          failures.push(currentFailure);
        }
        currentFailure = {
          Test: entry.Test,
          Package: entry.Package ?? "",
          Output: [],
          Action: "fail",
        };
      } else if (currentFailure && entry.Action === "output" && entry.Output) {
        currentFailure.Output.push(entry.Output);
      }
    } catch {
      // Not JSON, skip
    }
  }

  if (currentFailure && currentFailure.Test) {
    failures.push(currentFailure);
  }

  return failures;
}

function toFinding(
  failure: GoTestFailure,
  repositoryPath: string,
  index: number,
): Finding {
  const output = failure.Output.join("\n").slice(0, 2000);

  return {
    id: `go-test-${index + 1}`,
    title: `${failure.Test} failed`,
    description: `Test ${failure.Test} in ${failure.Package} failed\n${output}`,
    severity: "medium",
    category: "test",
    source: "test",
    file: failure.Package,
    ruleId: "go-test",
  };
}

async function isAccessibleDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hasGoMod(repositoryPath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryPath, "go.mod"));
    return true;
  } catch {
    return false;
  }
}

async function isGoAvailable(repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync("go", ["version"], {
      cwd: repositoryPath,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function hasGoTestFiles(changeSet: VerifierContext["changeSet"]): boolean {
  return changeSet.files.some(
    (file) =>
      isGoFile(file.path, file.language) &&
      (file.path.includes("_test.go") || file.path.endsWith("_test.go")),
  );
}

export class GoTestVerifier implements Verifier {
  readonly id = "go-test";
  readonly name = "Go tests";

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

    const touchesGo = context.changeSet.files.some((file) =>
      isGoFile(file.path, file.language),
    );

    if (!touchesGo) {
      return finish("skipped", [], "No Go files changed.");
    }

    if (!hasGoTestFiles(context.changeSet)) {
      return finish("skipped", [], "No Go test files found in changes.");
    }

    if (!(await isAccessibleDirectory(context.repositoryPath))) {
      return finish(
        "error",
        [],
        `Cannot access repository path: ${context.repositoryPath}`,
      );
    }

    if (!(await hasGoMod(context.repositoryPath))) {
      return finish("skipped", [], "No go.mod found. Run go mod init first.");
    }

    if (!(await isGoAvailable(context.repositoryPath))) {
      return finish("skipped", [], "Go is not available in this environment.");
    }

    try {
      await execFileAsync("go", ["test", "-json", "./..."], {
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
        const failures = parseGoTestOutput(error.stdout);
        findings = failures.map((failure, index) =>
          toFinding(failure, context.repositoryPath, index),
        );
      }

      if (findings.length > 0) {
        return finish("failed", findings);
      }

      return finish("error", [], "Go test execution failed.");
    }
  }
}
