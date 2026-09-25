import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { CargoTestVerifier } from "../../src/verifier/cargo-test.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-cargo-test-"));
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
      language: f.path.endsWith(".rs") ? "rust" : undefined,
    })),
    totalAdditions: files.length * 10,
    totalDeletions: 0,
  };
}

describe("CargoTestVerifier", () => {
  const verifier = new CargoTestVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("cargo-test");
    expect(verifier.name).toBe("Cargo tests");
  });

  it("skips if no Rust files", async () => {
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
    expect(result.reason).toMatch(/No Rust files changed/);
  });

  it("skips if no test files", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "main.rs"), "fn main() {}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "main.rs", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No Rust test files found/);
  });

  it("skips if no Cargo.toml", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "lib_test.rs"), "fn test() {}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "lib_test.rs", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No Cargo\.toml found/);
  });

  it("skips if cargo not available", async () => {
    const repo = await initRepo();
    writeFileSync(
      path.join(repo, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\n',
    );
    writeFileSync(path.join(repo, "lib_test.rs"), "fn test() {}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "lib_test.rs", changeType: "modified" },
    ]);

    const restorePath = hideExternalTools();
    try {
      const result = await verifier.run({
        repositoryPath: repo,
        changeSet,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/Cargo is not available/);
    } finally {
      restorePath();
    }
  });
});
