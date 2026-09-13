import type { Finding } from "../core/types/index.js";

export interface FixSuggestion {
  /** One actionable sentence tailored to the finding. */
  summary: string;
  /** True when a command below can apply the fix without human judgment. */
  autoFixable: boolean;
  /** Optional command that applies (or helps apply) the fix. */
  command?: string;
}

function where(finding: Finding): string {
  if (finding.file && finding.line !== undefined) {
    return `${finding.file}:${finding.line}`;
  }
  return finding.file ?? "the reported location";
}

function lintSuggestion(finding: Finding): FixSuggestion {
  const location = where(finding);
  const file = finding.file ?? "";

  if (/\.(ts|tsx|js|jsx)$/i.test(file)) {
    return {
      summary: `Run ESLint auto-fix on ${location}, then address any remaining rule violations manually: ${finding.title}.`,
      autoFixable: true,
      command: `npx eslint --fix ${file}`,
    };
  }

  if (/\.py$/i.test(file)) {
    return {
      summary: `Run Ruff auto-fix on ${location}, then address any remaining rule violations manually: ${finding.title}.`,
      autoFixable: true,
      command: `ruff check --fix ${file}`,
    };
  }

  return {
    summary: `Address the lint issue in ${location}: ${finding.title}.`,
    autoFixable: false,
  };
}

/**
 * Map a finding to a concrete fix suggestion.
 * Pure function: no I/O, no tool execution — applying the fix (including
 * auto-fixable commands) is always the caller's decision.
 */
export function suggestFix(finding: Finding): FixSuggestion {
  switch (finding.source) {
    case "secret":
      return {
        summary:
          `Remove the hardcoded credential in ${where(finding)} and load it ` +
          `from an environment variable instead. Rotate the exposed secret.`,
        autoFixable: false,
      };

    case "typecheck":
      return {
        summary:
          `Fix the type error in ${where(finding)}: ${finding.title}. ` +
          `Add a type annotation or correct the mismatched type.`,
        autoFixable: false,
      };

    case "lint":
      return lintSuggestion(finding);

    case "test":
      return {
        summary:
          `Fix the failing test in ${where(finding)}: ${finding.title}. ` +
          `Reproduce locally, fix the code or the expectation, then re-run.`,
        autoFixable: false,
      };

    case "dependency":
      if (finding.remediation) {
        return {
          summary: `${finding.remediation} to resolve ${finding.title}.`,
          autoFixable: false,
        };
      }
      return {
        summary:
          `Update the vulnerable package to resolve ${finding.title}. ` +
          `Prefer the patched version from the advisory.`,
        autoFixable: false,
      };

    default:
      if (finding.remediation) {
        return { summary: finding.remediation, autoFixable: false };
      }
      return {
        summary: `Review ${where(finding)} and address: ${finding.title}.`,
        autoFixable: false,
      };
  }
}

/** Suggest fixes for every finding, preserving order. */
export function suggestFixes(findings: Finding[]): FixSuggestion[] {
  return findings.map((finding) => suggestFix(finding));
}
