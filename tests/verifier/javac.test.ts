import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { JavacVerifier, isJavaFile } from "../../src/verifier/javac.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-javac-"));
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
      language: f.path.endsWith(".java") ? "java" : undefined,
    })),
    totalAdditions: files.length * 10,
    totalDeletions: 0,
  };
}

describe("isJavaFile", () => {
  it("detects Java files by extension", () => {
    expect(isJavaFile("Main.java", undefined)).toBe(true);
    expect(isJavaFile("src/com/example/App.java", undefined)).toBe(true);
  });

  it("detects Java files by language", () => {
    expect(isJavaFile("any-file", "java")).toBe(true);
  });

  it("rejects non-Java files", () => {
    expect(isJavaFile("main.ts", undefined)).toBe(false);
    expect(isJavaFile("app.py", undefined)).toBe(false);
  });
});

describe("JavacVerifier", () => {
  const verifier = new JavacVerifier();

  it("has correct id and name", () => {
    expect(verifier.id).toBe("javac");
    expect(verifier.name).toBe("Java compiler");
  });

  it("skips if no Java files", async () => {
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
    expect(result.reason).toMatch(/No Java files changed/);
  });

  it("skips if no pom.xml or build.gradle", async () => {
    const repo = await initRepo();
    writeFileSync(path.join(repo, "Main.java"), "public class Main {}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "Main.java", changeType: "modified" },
    ]);

    const result = await verifier.run({
      repositoryPath: repo,
      changeSet,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/No pom\.xml or build\.gradle found/);
  });

  it("skips if javac not available", async () => {
    const repo = await initRepo();
    writeFileSync(
      path.join(repo, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion></project>",
    );
    writeFileSync(path.join(repo, "Main.java"), "public class Main {}\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    const changeSet = makeChangeSet([
      { path: "Main.java", changeType: "modified" },
    ]);

    const restorePath = hideExternalTools();
    try {
      const result = await verifier.run({
        repositoryPath: repo,
        changeSet,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/Java compiler.*not available/);
    } finally {
      restorePath();
    }
  });
});
