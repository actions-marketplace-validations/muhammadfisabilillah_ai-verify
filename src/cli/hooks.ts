import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadConfig, type AiVerifyConfig } from "./config.js";

const execFileAsync = promisify(execFile);

function generateHookContent(config: AiVerifyConfig): string {
  const hookConfig = config.hook ?? {};
  const timeout = hookConfig.timeout ?? 120;

  return `#!/usr/bin/env sh
# Installed by ai-verify — https://github.com/muhammadfisabilillah/ai-verify
# Runs ai-verify before each commit. Blocks on BLOCK verdict.
# Remove with: ai-verify --uninstall-hook

set -e

# Find ai-verify binary: prefer npx, fall back to global
if command -v ai-verify >/dev/null 2>&1; then
  AI_VERIFY="ai-verify"
elif command -v npx >/dev/null 2>&1; then
  AI_VERIFY="npx --yes @fisaabil_/ai-verify@latest"
else
  echo "ai-verify: not found — skipping verification."
  exit 0
fi

# Run verification (skip history, use JSON for exit code)
out=$(timeout ${timeout} $AI_VERIFY . --no-history --json 2>/dev/null) || {
  # ai-verify failed to run — let the commit proceed but warn
  echo "ai-verify: verification failed to run — allowing commit."
  exit 0
}

verdict=$(echo "$out" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(data.verdict || 'UNKNOWN');
" 2>/dev/null)

if [ "$verdict" = "BLOCK" ]; then
  echo ""
  echo "ai-verify: BLOCK — commit rejected."
  echo "Fix the issues above or use --no-verify to bypass."
  echo ""
  # Print the human-readable report
  $AI_VERIFY . --no-history 2>/dev/null || true
  exit 1
fi

if [ "$verdict" = "REVIEW" ]; then
  echo ""
  echo "ai-verify: REVIEW — please review the findings above."
  echo ""
fi

exit 0
`;
}

const HOOK_PATH = path.join(".git", "hooks", "pre-commit");

export async function isGitRepository(
  repositoryPath: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repositoryPath,
    });
    return true;
  } catch {
    return false;
  }
}

export async function hookExists(repositoryPath: string): Promise<boolean> {
  try {
    await access(path.join(repositoryPath, HOOK_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function readExistingHook(
  repositoryPath: string,
): Promise<string | null> {
  try {
    const content = await readFile(
      path.join(repositoryPath, HOOK_PATH),
      "utf8",
    );
    return content;
  } catch {
    return null;
  }
}

export function isAiVerifyHook(content: string): boolean {
  return content.includes("Installed by ai-verify");
}

export async function installHook(
  repositoryPath: string,
): Promise<{ installed: boolean; backedUp: boolean }> {
  if (!(await isGitRepository(repositoryPath))) {
    throw new Error(
      `Not a git repository: ${repositoryPath}. Initialize a git repo first.`,
    );
  }

  const config = await loadConfig(repositoryPath);
  if (config.hook?.skip) {
    return { installed: false, backedUp: false };
  }

  const hookPath = path.join(repositoryPath, HOOK_PATH);
  let backedUp = false;

  if (await hookExists(repositoryPath)) {
    const existing = await readExistingHook(repositoryPath);

    if (existing !== null && isAiVerifyHook(existing)) {
      const hookContent = generateHookContent(config);
      await writeFile(hookPath, hookContent, "utf8");
      await chmod(hookPath, 0o755);
      return { installed: false, backedUp: false };
    }

    const backupPath = hookPath + ".backup";
    if (existing !== null) {
      await writeFile(backupPath, existing, "utf8");
      backedUp = true;
    }
  }

  const hookContent = generateHookContent(config);
  await writeFile(hookPath, hookContent, "utf8");
  await chmod(hookPath, 0o755);

  return { installed: true, backedUp };
}

export async function uninstallHook(
  repositoryPath: string,
): Promise<{ removed: boolean; restored: boolean }> {
  if (!(await isGitRepository(repositoryPath))) {
    throw new Error(
      `Not a git repository: ${repositoryPath}. Initialize a git repo first.`,
    );
  }

  const hookPath = path.join(repositoryPath, HOOK_PATH);
  const backupPath = hookPath + ".backup";

  if (!(await hookExists(repositoryPath))) {
    return { removed: false, restored: false };
  }

  const existing = await readExistingHook(repositoryPath);
  const wasAiVerify = existing !== null && isAiVerifyHook(existing);

  const { unlinkSync } = await import("node:fs");
  unlinkSync(hookPath);

  let restored = false;
  try {
    await access(backupPath);
    const backupContent = await readFile(backupPath, "utf8");
    await writeFile(hookPath, backupContent, "utf8");
    await chmod(hookPath, 0o755);
    unlinkSync(backupPath);
    restored = true;
  } catch {
    // No backup to restore
  }

  return { removed: wasAiVerify || restored, restored };
}
