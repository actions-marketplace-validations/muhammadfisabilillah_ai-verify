import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { GoVetVerifier, isGoFile } from "../../src/verifier/go-vet.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-go-vet-"));
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

describe("isGoFile", () => {
  it("detects Go files by extension", () => {
    expect(isGoFile("main.go", undefined)).toBe(true);
    expect(isGoFile("cmd/server.go", undefined)).toBe(true);
  });

  it("detects Go files by language", () => {
    expect(isGoFile("any-file", "go")).toBe(true);
  });

  it("rejects non-Go files", () => {
    expect(isGoFile("main.ts", undefined)).toBe(false);
    expect(isGoFile("app.py", undefined)).toBe(false);
  });
});

describe("GoVetVerifier", () => {
  const verifier = new GoVetVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("go-vet");
    expect(verifier.name).toBe("Go vet");
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

  it("skips if no go.mod", async () => {
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
    expect(result.reason).toMatch(/No go\.mod found/);
  });

  it("skips if go not available", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "go.mod"), "module test\n\ngo 1.21\n");
    writeFileSync(path.join(repo, "main.go"), "package main\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "main.go", changeType: "modified" },
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
