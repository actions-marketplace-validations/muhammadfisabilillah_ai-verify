import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleVerify } from "../../src/mcp/server.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-mcp-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

describe("handleVerify", () => {
  it("returns PASS with empty ChangeSet on a clean tree", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const result = await handleVerify({ repositoryPath: repo });

    expect(result.changeSet.files).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result).toHaveProperty("risk");
    expect(result).toHaveProperty("verification");
  });

  it("verifies uncommitted changes by default", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);
    writeFileSync(path.join(repo, "README.md"), "hello\nmore docs\n");

    const result = await handleVerify({ repositoryPath: repo });

    expect(result.changeSet.files).toHaveLength(1);
    expect(result.verdict).toBe("PASS");
  });

  it("verifies a committed range ignoring uncommitted changes", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "first"]);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "second"]);
    writeFileSync(path.join(repo, "a.txt"), "v3-uncommitted\n");

    const result = await handleVerify({
      repositoryPath: repo,
      refRange: "HEAD~1..HEAD",
    });

    expect(result.changeSet.files).toHaveLength(1);
    expect(result.changeSet.files[0]).toMatchObject({ path: "a.txt" });
  });

  it("rejects option-like refRange", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "first"]);

    await expect(
      handleVerify({ repositoryPath: repo, refRange: "--help" }),
    ).rejects.toThrow(/Invalid --ref/);
  });
});
