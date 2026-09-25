import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Finding, VerificationCheck } from "../core/types/index.js";

import type { Verifier, VerifierContext } from "./verifier.js";

const execFileAsync = promisify(execFile);

interface NpmAuditAdvisory {
  id: number;
  title: string;
  module_name: string;
  severity: string;
  vulnerable_versions: string;
  patched_versions: string;
  recommendation: string;
}

interface NpmAuditVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: Array<string | NpmAuditAdvisory>;
  effects: string[];
  range: string;
  nodes: string[];
}

interface NpmAuditReport {
  auditReportVersion: number;
  vulnerabilities: Record<string, NpmAuditVulnerability>;
  metadata: {
    vulnerabilities: {
      info: number;
      low: number;
      moderate: number;
      high: number;
      critical: number;
    };
  };
}

function hasPackageLock(repositoryPath: string): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    statSync(path.join(repositoryPath, "package-lock.json"));
    return true;
  } catch {
    return false;
  }
}

function hasPackageJson(repositoryPath: string): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    statSync(path.join(repositoryPath, "package.json"));
    return true;
  } catch {
    return false;
  }
}

async function isNpmAvailable(repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync("npm", ["--version"], {
      cwd: repositoryPath,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function toFinding(
  packageName: string,
  vuln: NpmAuditVulnerability,
  advisory: NpmAuditAdvisory | undefined,
  index: number,
): Finding {
  const severity = mapSeverity(vuln.severity);

  const finding: Finding = {
    id: `npm-audit-${index + 1}`,
    title: `${packageName}: ${advisory?.title ?? "Vulnerability"}`,
    description: [
      `Package: ${packageName}`,
      `Severity: ${vuln.severity}`,
      `Vulnerable: ${vuln.range}`,
      advisory?.recommendation
        ? `Recommendation: ${advisory.recommendation}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    severity,
    category: "dependency",
    source: "dependency",
    file: "package-lock.json",
    ruleId: advisory ? `npm-${advisory.id}` : `npm-${packageName}`,
  };

  if (advisory?.patched_versions) {
    finding.remediation = `Update to ${advisory.patched_versions}`;
  }

  return finding;
}

function mapSeverity(severity: string): Finding["severity"] {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
      return "medium";
    case "low":
      return "low";
    default:
      return "info";
  }
}

function parseAuditOutput(stdout: string): NpmAuditReport | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("vulnerabilities" in parsed)
    ) {
      return undefined;
    }
    return parsed as NpmAuditReport;
  } catch {
    return undefined;
  }
}

export class NpmAuditVerifier implements Verifier {
  readonly id = "npm-audit";
  readonly name = "npm audit";

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

    if (!hasPackageJson(context.repositoryPath)) {
      return finish("skipped", [], "No package.json found.");
    }

    if (!hasPackageLock(context.repositoryPath)) {
      return finish(
        "skipped",
        [],
        "No package-lock.json found. Run npm install first.",
      );
    }

    if (!(await isNpmAvailable(context.repositoryPath))) {
      return finish("skipped", [], "npm is not available in this environment.");
    }

    try {
      const { stdout } = await execFileAsync("npm", ["audit", "--json"], {
        cwd: context.repositoryPath,
        timeout: 120_000,
      });

      const report = parseAuditOutput(stdout);

      if (report === undefined) {
        return finish("error", [], "Failed to parse npm audit output.");
      }

      const findings: Finding[] = [];
      let index = 0;

      for (const [packageName, vuln] of Object.entries(
        report.vulnerabilities,
      )) {
        const advisories = vuln.via.filter(
          (v): v is NpmAuditAdvisory => typeof v === "object",
        );
        const advisory = advisories[0];

        findings.push(toFinding(packageName, vuln, advisory, index));
        index++;
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

          for (const [packageName, vuln] of Object.entries(
            report.vulnerabilities,
          )) {
            const advisories = vuln.via.filter(
              (v): v is NpmAuditAdvisory => typeof v === "object",
            );
            const advisory = advisories[0];

            findings.push(toFinding(packageName, vuln, advisory, index));
            index++;
          }

          if (findings.length > 0) {
            return finish("failed", findings);
          }
        }
      }

      return finish("error", [], "npm audit execution failed.");
    }
  }
}
