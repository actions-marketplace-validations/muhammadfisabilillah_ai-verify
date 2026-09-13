import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleVerifyAndFix } from "../../src/mcp/server.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-mcp-hist-"));
  tempDirs.push(dir);
  vi.stubEnv("AI_VERIFY_HISTORY_FILE", path.join(dir, "runs.jsonl"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-mcp-fix-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

describe("handleVerifyAndFix", () => {
  it("returns no suggestions when there are no findings", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const result = await handleVerifyAndFix({ repositoryPath: repo });

    expect(result.verdict).toBe("PASS");
    expect(result.verification.findings).toHaveLength(0);
    expect(result.suggestions).toEqual([]);
  });

  it("returns one actionable suggestion per finding", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);
    writeFileSync(
      path.join(repo, "notes.txt"),
      'key = "AKIAIOSFODNN7EXAMPLE"\n',
    );

    const result = await handleVerifyAndFix({ repositoryPath: repo });

    expect(result.verdict).toBe("BLOCK");
    expect(result.verification.findings.length).toBeGreaterThan(0);
    expect(result.suggestions).toHaveLength(
      result.verification.findings.length,
    );
    expect(result.suggestions[0]?.summary).toMatch(/environment variable/i);
    expect(result.suggestions[0]?.autoFixable).toBe(false);
  });

  it("never echoes secret values into suggestions", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);
    writeFileSync(
      path.join(repo, "notes.txt"),
      'key = "AKIAIOSFODNN7EXAMPLE"\n',
    );

    const result = await handleVerifyAndFix({ repositoryPath: repo });

    expect(JSON.stringify(result.suggestions)).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });
});
