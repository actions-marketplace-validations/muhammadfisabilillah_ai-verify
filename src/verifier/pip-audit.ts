import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

interface PipAuditVulnerability {
  name: string;
  version: string;
  id: string;
  fix_versions: string[];
  description: string;
}

interface PipAuditPackage {
  name: string;
  version: string;
  vulns: PipAuditVulnerability[];
}

interface PipAuditReport {
  dependencies: PipAuditPackage[];
  skipped: Array<{ name: string; version: string; skip_reason: string }>;
}

const PYTHON_DEP_FILES = [
  "requirements.txt",
  "setup.py",
  "pyproject.toml",
  "Pipfile",
  "setup.cfg",
];

function hasPythonDeps(repositoryPath: string): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    for (const file of PYTHON_DEP_FILES) {
      try {
        statSync(path.join(repositoryPath, file));
        return true;
      } catch {
        // Continue
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function isPipAuditAvailable(repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync("pip-audit", ["--version"], {
      cwd: repositoryPath,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function mapSeverity(vulns: PipAuditVulnerability[]): Finding["severity"] {
  if (vulns.length === 0) return "info";

  const hasHigh = vulns.some(
    (v) =>
      v.id.startsWith("GHSA-") && v.description?.toLowerCase().includes("high"),
  );
  if (hasHigh) return "high";

  const hasMedium = vulns.some(
    (v) =>
      v.id.startsWith("GHSA-") &&
      v.description?.toLowerCase().includes("moderate"),
  );
  if (hasMedium) return "medium";

  return "low";
}

function toFinding(pkg: PipAuditPackage, index: number): Finding {
  const vulnIds = pkg.vulns.map((v) => v.id).join(", ");
  const fixVersions = pkg.vulns
    .flatMap((v) => v.fix_versions)
    .filter(Boolean)
    .join(", ");

  const finding: Finding = {
    id: `pip-audit-${index + 1}`,
    title: `${pkg.name}@${pkg.version}: ${pkg.vulns.length} vulnerability(ies)`,
    description: [
      `Package: ${pkg.name}`,
      `Version: ${pkg.version}`,
      `Vulnerabilities: ${vulnIds}`,
      fixVersions ? `Fix versions: ${fixVersions}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    severity: mapSeverity(pkg.vulns),
    category: "dependency",
    source: "dependency",
    file: "requirements.txt",
    ruleId: `pip-${pkg.name}`,
  };

  if (fixVersions) {
    finding.remediation = `Update to ${fixVersions}`;
  }

  return finding;
}

function parseAuditOutput(stdout: string): PipAuditReport | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("dependencies" in parsed)
    ) {
      return undefined;
    }
    return parsed as PipAuditReport;
  } catch {
    return undefined;
  }
}

export class PipAuditVerifier implements Verifier {
  readonly id = "pip-audit";
  readonly name = "pip-audit";

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

    if (!hasPythonDeps(context.repositoryPath)) {
      return finish("skipped", [], "No Python dependency files found.");
    }

    if (!(await isPipAuditAvailable(context.repositoryPath))) {
      return finish(
        "skipped",
        [],
        "pip-audit is not available in this environment.",
      );
    }

    try {
      const { stdout } = await execFileAsync(
        "pip-audit",
        ["--format=json", "--desc"],
        {
          cwd: context.repositoryPath,
          timeout: 120_000,
        },
      );

      const report = parseAuditOutput(stdout);

      if (report === undefined) {
        return finish("error", [], "Failed to parse pip-audit output.");
      }

      const findings: Finding[] = [];
      let index = 0;

      for (const pkg of report.dependencies) {
        if (pkg.vulns.length > 0) {
          findings.push(toFinding(pkg, index));
          index++;
        }
      }

      if (findings.length > 0) {
        return finish("failed", findings);
      }

      return finish("passed");
    } catch (error: unknown) {
      if (
        error !== null &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        error.stdout.trim() !== ""
      ) {
        const report = parseAuditOutput(error.stdout);

        if (report !== undefined) {
          const findings: Finding[] = [];
          let index = 0;

          for (const pkg of report.dependencies) {
            if (pkg.vulns.length > 0) {
              findings.push(toFinding(pkg, index));
              index++;
            }
          }

          if (findings.length > 0) {
            return finish("failed", findings);
          }
        }
      }

      return finish("error", [], "pip-audit execution failed.");
    }
  }
}
