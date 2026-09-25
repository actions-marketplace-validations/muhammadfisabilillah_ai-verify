import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

const JAVA_EXTENSION = /\.java$/i;

export function isJavaFile(
  filePath: string,
  language: string | undefined,
): boolean {
  if (language === "java") {
    return true;
  }

  return JAVA_EXTENSION.test(filePath);
}

async function isAccessibleDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isJavaAvailable(repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync("javac", ["-version"], {
      cwd: repositoryPath,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasMavenOrGradle(repositoryPath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryPath, "pom.xml"));
    return true;
  } catch {
    try {
      await stat(path.join(repositoryPath, "build.gradle"));
      return true;
    } catch {
      try {
        await stat(path.join(repositoryPath, "build.gradle.kts"));
        return true;
      } catch {
        return false;
      }
    }
  }
}

interface JavaError {
  file: string;
  line: number;
  column: number;
  message: string;
}

function parseJavacOutput(stderr: string): JavaError[] {
  const errors: JavaError[] = [];
  const lines = stderr.split("\n");

  for (const line of lines) {
    const match = /^(.+?):(\d+):\s*(?:error|warning):\s*(.+)$/.exec(
      line.trim(),
    );
    if (match) {
      const [, file, lineStr, message] = match;
      errors.push({
        file: file ?? "unknown",
        line: Number.parseInt(lineStr ?? "0", 10),
        column: 0,
        message: message ?? "Unknown error",
      });
    }
  }

  return errors;
}

function toFinding(
  error: JavaError,
  repositoryPath: string,
  index: number,
): Finding {
  const relative =
    path.isAbsolute(error.file) &&
    error.file.startsWith(repositoryPath + path.sep)
      ? path.relative(repositoryPath, error.file)
      : error.file;

  return {
    id: `javac-${index + 1}`,
    title: error.message,
    description: `Java compilation error in ${relative}`,
    severity: "high",
    category: "reliability",
    source: "typecheck",
    file: relative,
    ruleId: "javac",
    line: error.line,
  };
}

export class JavacVerifier implements Verifier {
  readonly id = "javac";
  readonly name = "Java compiler";

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

    const touchesJava = context.changeSet.files.some((file) =>
      isJavaFile(file.path, file.language),
    );

    if (!touchesJava) {
      return finish("skipped", [], "No Java files changed.");
    }

    if (!(await isAccessibleDirectory(context.repositoryPath))) {
      return finish(
        "error",
        [],
        `Cannot access repository path: ${context.repositoryPath}`,
      );
    }

    if (!(await hasMavenOrGradle(context.repositoryPath))) {
      return finish("skipped", [], "No pom.xml or build.gradle found.");
    }

    if (!(await isJavaAvailable(context.repositoryPath))) {
      return finish(
        "skipped",
        [],
        "Java compiler (javac) is not available in this environment.",
      );
    }

    try {
      await execFileAsync("javac", ["-version"], {
        cwd: context.repositoryPath,
        timeout: 60_000,
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
        const errors = parseJavacOutput(error.stderr);
        const findings = errors.map((err, index) =>
          toFinding(err, context.repositoryPath, index),
        );

        if (findings.length > 0) {
          return finish("failed", findings);
        }
      }

      return finish("error", [], "Java compilation failed.");
    }
  }
}
