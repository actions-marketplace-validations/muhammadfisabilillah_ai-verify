import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { PipAuditVerifier } from "../../src/verifier/pip-audit.js";
import type { ChangeSet } from "../../src/core/types/index.js";
import { hideExternalTools } from "../helpers/hide-tools.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(() => {
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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-pip-audit-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

function makeChangeSet(
  files: Array<{ path: string; changeType: "added" | "modified" | "deleted" }>,
): ChangeSet {
  return {
    files: files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      additions: 10,
      deletions: 0,
      source: "unknown",
    })),
    totalAdditions: files.length * 10,
    totalDeletions: 0,
  };
}

describe("PipAuditVerifier", () => {
  const verifier = new PipAuditVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("pip-audit");
    expect(verifier.name).toBe("pip-audit");
  });

  it("skips if no Python dependency files", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "README.md", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No Python dependency files found/);
  });

  it("skips if pip-audit not available", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "requirements.txt"), "requests==2.28.0\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "requirements.txt", changeType: "modified" },
    ]);

    const restorePath = hideExternalTools();
    try {
      const result = await verifier.run({
        repositoryPath: repo,
        changeSet,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/pip-audit is not available/);
    } finally {
      restorePath();
    }
  });
});
