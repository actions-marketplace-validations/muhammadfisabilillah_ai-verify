import type {
  ChangeSet,
  RiskAssessment,
  VerificationResult,
} from "../core/types/index.js";
import { deriveVerdict } from "../verifier/verdict.js";

const AI_VERIFY_ART = [
  "    _    ___  __     _______ ____  ___ _______   __",
  "   / \\  |_ _| \\ \\   / / ____|  _ \\|_ _|  ___\\ \\ / /",
  "  / _ \\  | |   \\ \\ / /|  _| | |_) || || |_   \\ V /",
  " / ___ \\ | |    \\ V / | |___|  _ < | ||  _|   | |",
  "/_/   \\_\\___|    \\_/  |_____|_| \\_\\___|_|     |_|",
];

export function printBanner(
  version: string,
  fancy: boolean = process.stdout.isTTY ?? false,
): void {
  console.log("");

  if (fancy) {
    for (const line of AI_VERIFY_ART) {
      console.log(line);
    }
  }

  console.log(
    `AI Verify v${version} — AI can generate code. AI Verify helps verify it.`,
  );
  console.log("------------------------------");
}

export function hasFailed(result: VerificationResult): boolean {
  return deriveVerdict(result) !== "PASS";
}

export function printChangeReport(
  changeSet: ChangeSet,
  refRange?: string,
): void {
  console.log(`Files changed : ${changeSet.files.length}`);
  console.log(`Additions     : +${changeSet.totalAdditions}`);
  console.log(`Deletions     : -${changeSet.totalDeletions}`);

  if (refRange !== undefined) {
    console.log(`Range         : ${refRange}`);
  }

  console.log("");

  if (changeSet.files.length === 0) {
    console.log("No changes detected.");
    return;
  }

  console.log("Changes:");

  for (const file of changeSet.files) {
    const language = file.language ?? "unknown";

    console.log(
      `  ${file.changeType.padEnd(8)} ${file.path} (${language}) +${file.additions}/-${file.deletions}`,
    );
  }
}

export function printRiskReport(risk: RiskAssessment): void {
  console.log("");
  console.log(`Risk: ${risk.level.toUpperCase()} (${risk.score})`);

  if (risk.factors.length === 0) {
    console.log("No risk factors.");
    return;
  }

  console.log("Factors:");

  for (const factor of risk.factors) {
    console.log(`  +${factor.score} ${factor.name} — ${factor.reason}`);
  }
}

const CHECK_ICONS: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  skipped: "-",
  error: "!",
};

export function printVerificationReport(result: VerificationResult): void {
  console.log("");
  console.log(`Verification (${result.durationMs}ms)`);

  if (result.checks.length === 0) {
    console.log("No applicable verifiers for these changes.");
  }

  for (const check of result.checks) {
    const icon = CHECK_ICONS[check.status] ?? "?";
    const detail =
      check.findings.length > 0 ? `, ${check.findings.length} finding(s)` : "";
    const reason =
      check.reason !== undefined && check.findings.length === 0
        ? ` (${check.reason})`
        : "";

    console.log(`  ${icon} ${check.name} — ${check.status}${detail}${reason}`);
  }

  console.log(`Findings: ${result.findings.length}`);

  for (const finding of result.findings.slice(0, 20)) {
    const location =
      finding.file !== undefined
        ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})`
        : "";

    console.log(
      `  [${finding.severity.toUpperCase()}] ${finding.title}${location}`,
    );
  }

  console.log(`Result: ${deriveVerdict(result)}`);
}
