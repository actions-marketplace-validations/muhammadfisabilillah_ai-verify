import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { GoTestVerifier } from "../../src/verifier/go-test.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-go-test-"));
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
      language: f.path.endsWith(".go") ? "go" : undefined,
    })),
    totalAdditions: files.length * 10,
    totalDeletions: 0,
  };
}

describe("GoTestVerifier", () => {
  const verifier = new GoTestVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("go-test");
    expect(verifier.name).toBe("Go tests");
  });

  it("skips if no Go files", async () => {
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
    expect(result.reason).toMatch(/No Go files changed/);
  });

  it("skips if no test files", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "main.go"), "package main\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "main.go", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No Go test files found/);
  });

  it("skips if no go.mod", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "main_test.go"), "package main\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "main_test.go", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No go\.mod found/);
  });

  it("skips if go not available", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "go.mod"), "module test\n\ngo 1.21\n");
    writeFileSync(path.join(repo, "main_test.go"), "package main\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "main_test.go", changeType: "modified" },
    ]);

    const restorePath = hideExternalTools();
    try {
      const result = await verifier.run({
        repositoryPath: repo,
        changeSet,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/Go is not available/);
    } finally {
      restorePath();
    }
  });
});
