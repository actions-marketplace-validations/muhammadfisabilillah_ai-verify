import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  installHook,
  uninstallHook,
  hookExists,
  isAiVerifyHook,
  isGitRepository,
} from "../../src/cli/hooks.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-hooks-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

describe("isGitRepository", () => {
  it("returns true for a git repo", async () => {
    const repo = await initRepo();
    expect(await isGitRepository(repo)).toBe(true);
  });

  it("returns false for a non-git directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-hooks-non-git-"));
    tempDirs.push(dir);
    expect(await isGitRepository(dir)).toBe(false);
  });
});

describe("installHook", () => {
  it("installs pre-commit hook in a git repo", async () => {
    const repo = await initRepo();
    const result = await installHook(repo);

    expect(result.installed).toBe(true);
    expect(result.backedUp).toBe(false);
    expect(await hookExists(repo)).toBe(true);

    const content = readFileSync(
      path.join(repo, ".git/hooks/pre-commit"),
      "utf8",
    );
    expect(isAiVerifyHook(content)).toBe(true);
  });

  it("backs up existing hook before installing", async () => {
    const repo = await initRepo();
    const hookPath = path.join(repo, ".git/hooks/pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho old hook\n", "utf8");

    const result = await installHook(repo);

    expect(result.installed).toBe(true);
    expect(result.backedUp).toBe(true);

    const backupContent = readFileSync(hookPath + ".backup", "utf8");
    expect(backupContent).toContain("old hook");
  });

  it("skips if already installed", async () => {
    const repo = await initRepo();
    await installHook(repo);
    const result = await installHook(repo);

    expect(result.installed).toBe(false);
    expect(result.backedUp).toBe(false);
  });

  it("throws if not a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-hooks-no-git-"));
    tempDirs.push(dir);

    await expect(installHook(dir)).rejects.toThrow(/Not a git repository/);
  });

  it("hook is executable", async () => {
    const repo = await initRepo();
    await installHook(repo);

    const hookPath = path.join(repo, ".git/hooks/pre-commit");
    const { statSync } = await import("node:fs");
    const stat = statSync(hookPath);
    expect(stat.mode & 0o755).toBeTruthy();
  });
});

describe("uninstallHook", () => {
  it("removes the ai-verify hook", async () => {
    const repo = await initRepo();
    await installHook(repo);

    const result = await uninstallHook(repo);

    expect(result.removed).toBe(true);
    expect(result.restored).toBe(false);
    expect(await hookExists(repo)).toBe(false);
  });

  it("restores backup if it exists", async () => {
    const repo = await initRepo();
    const hookPath = path.join(repo, ".git/hooks/pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho original\n", "utf8");

    await installHook(repo);
    const result = await uninstallHook(repo);

    expect(result.removed).toBe(true);
    expect(result.restored).toBe(true);

    const restoredContent = readFileSync(hookPath, "utf8");
    expect(restoredContent).toContain("original");
  });

  it("returns removed: false if no hook exists", async () => {
    const repo = await initRepo();
    const result = await uninstallHook(repo);

    expect(result.removed).toBe(false);
    expect(result.restored).toBe(false);
  });

  it("throws if not a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-hooks-no-git-"));
    tempDirs.push(dir);

    await expect(uninstallHook(dir)).rejects.toThrow(/Not a git repository/);
  });
});

describe("hookExists", () => {
  it("returns true when hook exists", async () => {
    const repo = await initRepo();
    await installHook(repo);
    expect(await hookExists(repo)).toBe(true);
  });

  it("returns false when no hook", async () => {
    const repo = await initRepo();
    expect(await hookExists(repo)).toBe(false);
  });
});

describe("isAiVerifyHook", () => {
  it("detects ai-verify hook", () => {
    expect(isAiVerifyHook("# Installed by ai-verify")).toBe(true);
  });

  it("detects non ai-verify hook", () => {
    expect(isAiVerifyHook("#!/bin/sh\necho hello")).toBe(false);
  });
});
