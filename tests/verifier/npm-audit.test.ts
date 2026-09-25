import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { NpmAuditVerifier } from "../../src/verifier/npm-audit.js";
import type { ChangeSet } from "../../src/core/types/index.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-npm-audit-"));
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

describe("NpmAuditVerifier", () => {
  const verifier = new NpmAuditVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("npm-audit");
    expect(verifier.name).toBe("npm audit");
  });

  it("skips if no package.json", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "package.json", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No package\.json found/);
  });

  it("skips if no package-lock.json", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "package.json"), '{"name":"test"}');
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "package.json", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No package-lock\.json found/);
  });

  it("passes when no vulnerabilities", async () => {
    const repo = await initRepo();
    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        dependencies: {},
      }),
    );
    writeFileSync(
      path.join(repo, "package-lock.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "test",
            version: "1.0.0",
            dependencies: {},
          },
        },
      }),
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "package.json", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(0);
  });
});
