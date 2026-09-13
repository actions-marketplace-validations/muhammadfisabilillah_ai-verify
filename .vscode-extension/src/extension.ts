import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

type Verdict = "PASS" | "REVIEW" | "BLOCK" | "UNKNOWN";

interface VerifyFinding {
  severity: string;
  title: string;
  file?: string;
  line?: number;
}

interface VerifyReport {
  verdict?: Verdict;
  changeSet?: { files?: unknown[] };
  risk?: { level?: string; score?: number };
  verification?: { findings?: VerifyFinding[] };
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("aiVerify").get<T>(key, fallback);
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function resolveRunner(): Promise<{ command: string; args: string[] }> {
  const binaryPath = config("binaryPath", "").trim();
  if (binaryPath) {
    return { command: binaryPath, args: [] };
  }

  try {
    const { stdout } = await execFileAsync("ai-verify", ["--version"], {
      timeout: 10_000,
    });
    if (stdout.trim()) {
      return { command: "ai-verify", args: [] };
    }
  } catch {
    // Fall through to npx.
  }

  const spec = config("packageSpec", "@fisaabil_/ai-verify@latest").trim();
  return { command: "npx", args: ["--yes", spec] };
}

function toDiagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (severity) {
    case "critical":
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function updateDiagnostics(
  collection: vscode.DiagnosticCollection,
  repositoryPath: string,
  findings: VerifyFinding[],
): void {
  collection.clear();

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const finding of findings) {
    if (!finding.file) {
      continue;
    }
    const uri = vscode.Uri.file(path.join(repositoryPath, finding.file));
    const line = Math.max((finding.line ?? 1) - 1, 0);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
      `${finding.title} [ai-verify: ${finding.severity}]`,
      toDiagnosticSeverity(finding.severity),
    );
    diagnostic.source = "ai-verify";
    const key = uri.toString();
    const list = byFile.get(key) ?? [];
    list.push(diagnostic);
    byFile.set(key, list);
  }

  for (const [key, diagnostics] of byFile) {
    collection.set(vscode.Uri.parse(key), diagnostics);
  }
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  verdict: Verdict,
  findingCount: number,
): void {
  const icon =
    verdict === "PASS" ? "$(check)" : verdict === "UNKNOWN" ? "$(question)" : "$(alert)";
  item.text = `${icon} AI Verify: ${verdict}`;
  item.tooltip =
    verdict === "UNKNOWN"
      ? "AI Verify produced no readable report"
      : `${findingCount} finding(s)`;
  item.backgroundColor =
    verdict === "BLOCK"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : verdict === "REVIEW"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  item.show();
}

async function runVerification(
  repositoryPath: string,
  statusBar: vscode.StatusBarItem,
  diagnostics: vscode.DiagnosticCollection,
): Promise<VerifyReport | undefined> {
  statusBar.text = "$(sync~spin) AI Verify: running…";
  statusBar.tooltip = repositoryPath;
  statusBar.show();

  const { command, args } = await resolveRunner();
  const extraArgs = config("extraArgs", [] as string[]);

  try {
    const { stdout } = await execFileAsync(
      command,
      [...args, repositoryPath, "--no-history", "--json", ...extraArgs],
      { cwd: repositoryPath, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout || "{}") as VerifyReport;
    const verdict: Verdict = report.verdict ?? "UNKNOWN";
    const findings = report.verification?.findings ?? [];

    updateDiagnostics(diagnostics, repositoryPath, findings);
    updateStatusBar(statusBar, verdict, findings.length);
    return report;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatusBar(statusBar, "UNKNOWN", 0);
    void vscode.window.showErrorMessage(`AI Verify failed: ${message}`);
    return undefined;
  }
}

async function pickRepositoryPath(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const startDir = editor
    ? path.dirname(editor.document.uri.fsPath)
    : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());

  const root = await gitTopLevel(startDir);
  if (!root) {
    void vscode.window.showInformationMessage(
      "AI Verify: not a git repository — skipping.",
    );
    return undefined;
  }
  return root;
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "aiVerify.verifyProject";
  statusBar.text = "AI Verify";
  statusBar.tooltip = "Run AI Verify on this repository";
  statusBar.show();

  const diagnostics = vscode.languages.createDiagnosticCollection("ai-verify");

  const verifyProject = vscode.commands.registerCommand(
    "aiVerify.verifyProject",
    async () => {
      const repositoryPath = await pickRepositoryPath();
      if (!repositoryPath) {
        return;
      }
      const report = await runVerification(repositoryPath, statusBar, diagnostics);
      if (!report) {
        return;
      }
      const verdict = report.verdict ?? "UNKNOWN";
      const findings = report.verification?.findings ?? [];
      const risk = report.risk;
      void vscode.window.showInformationMessage(
        `AI Verify: ${verdict} — ${findings.length} finding(s)` +
          (risk ? `, risk ${risk.level} (${risk.score})` : ""),
      );
    },
  );

  const verifyFile = vscode.commands.registerCommand(
    "aiVerify.verifyFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage(
          "AI Verify: open a file first to verify it.",
        );
        return;
      }
      const repositoryPath = await pickRepositoryPath();
      if (!repositoryPath) {
        return;
      }
      const report = await runVerification(repositoryPath, statusBar, diagnostics);
      if (!report) {
        return;
      }
      const relative = path.relative(
        repositoryPath,
        editor.document.uri.fsPath,
      );
      const fileFindings = (report.verification?.findings ?? []).filter(
        (finding) => finding.file === relative,
      );
      void vscode.window.showInformationMessage(
        `AI Verify: ${report.verdict ?? "UNKNOWN"} — ${fileFindings.length} finding(s) in ${relative}.`,
      );
    },
  );

  context.subscriptions.push(statusBar, diagnostics, verifyProject, verifyFile);
}

export function deactivate(): void {
  // VS Code disposes subscriptions automatically.
}
