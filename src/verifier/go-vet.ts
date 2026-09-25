import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

const GO_EXTENSION = /\.go$/i;

export function isGoFile(
  filePath: string,
  language: string | undefined,
): boolean {
  if (language === "go") {
    return true;
  }

  return GO_EXTENSION.test(filePath);
}

async function isAccessibleDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
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

async function hasGoMod(repositoryPath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryPath, "go.mod"));
    return true;
  } catch {
    return false;
  }
}

interface GoVetDiagnostic {
  position?: {
    file: string;
    line: number;
    column: number;
  };
  message: string;
}

function parseGoVetOutput(stderr: string): GoVetDiagnostic[] {
  const diagnostics: GoVetDiagnostic[] = [];
  const lines = stderr.split("\n");

  for (const line of lines) {
    const match = /^(.+?):(\d+):(\d+):\s*(.+)$/.exec(line.trim());
    if (match) {
      const [, file, lineStr, colStr, message] = match;
      diagnostics.push({
        position: {
          file: file ?? "",
          line: Number.parseInt(lineStr ?? "0", 10),
          column: Number.parseInt(colStr ?? "0", 10),
        },
        message: message ?? "",
      });
    }
  }

  return diagnostics;
}

function toFinding(
  diagnostic: GoVetDiagnostic,
  repositoryPath: string,
  index: number,
): Finding {
  const filePath = diagnostic.position?.file ?? "unknown";
  const relative =
    path.isAbsolute(filePath) && filePath.startsWith(repositoryPath + path.sep)
      ? path.relative(repositoryPath, filePath)
      : filePath;

  const finding: Finding = {
    id: `go-vet-${index + 1}`,
    title: diagnostic.message,
    description: `go vet issue in ${relative}`,
    severity: "medium",
    category: "quality",
    source: "lint",
    file: relative,
    ruleId: "go-vet",
  };

  if (diagnostic.position?.line) {
    finding.line = diagnostic.position.line;
  }

  return finding;
}

export class GoVetVerifier implements Verifier {
  readonly id = "go-vet";
  readonly name = "Go vet";

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
      await execFileAsync("go", ["vet", "./..."], {
        cwd: context.repositoryPath,
        timeout: 120_000,
      });

      return finish("passed");
    } catch (error: unknown) {
      if (
        error !== null &&
        typeof error === "object" &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.trim() !== ""
      ) {
        const diagnostics = parseGoVetOutput(error.stderr);

        if (diagnostics.length > 0) {
          const findings = diagnostics.map((diag, index) =>
            toFinding(diag, context.repositoryPath, index),
          );
          return finish("failed", findings);
        }
      }

      return finish("error", [], "Go vet execution failed.");
    }
  }
}
