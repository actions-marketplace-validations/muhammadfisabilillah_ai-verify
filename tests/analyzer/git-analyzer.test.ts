import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { GitAnalyzer } from "../../src/analyzer/git-analyzer.js";

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-test-"));
  tempDirs.push(dir);
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  writeFileSync(path.join(repo, rel), content);
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
}

describe("GitAnalyzer", () => {
  it("throws for non-git directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-nogit-"));
    tempDirs.push(dir);

    const analyzer = new GitAnalyzer();

    await expect(
      analyzer.analyze({
        repositoryPath: dir,
        includeUncommittedChanges: true,
      }),
    ).rejects.toThrow(/not a Git repository/);
  });

  it("returns empty ChangeSet when nothing changed", async () => {
    const repo = await initRepo();
    write(repo, "README.md", "hello\n");
    await commitAll(repo, "init");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toEqual([]);
    expect(changeSet.totalAdditions).toBe(0);
    expect(changeSet.totalDeletions).toBe(0);
  });

  it("detects modified unstaged file with additions/deletions", async () => {
    const repo = await initRepo();
    write(repo, "src.ts", "line1\nline2\nline3\n");
    await commitAll(repo, "init");
    write(repo, "src.ts", "line1\nline2 changed\nline3\nline4\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: "src.ts",
      changeType: "modified",
    });
    expect(changeSet.files[0]?.additions).toBeGreaterThan(0);
    expect(changeSet.files[0]?.deletions).toBeGreaterThan(0);
    expect(changeSet.totalAdditions).toBe(changeSet.files[0]?.additions);
    expect(changeSet.totalDeletions).toBe(changeSet.files[0]?.deletions);
  });

  it("detects staged new file as added with language", async () => {
    const repo = await initRepo();
    write(repo, "README.md", "base\n");
    await commitAll(repo, "init");
    write(repo, "app.ts", "const a = 1;\nconst b = 2;\n");
    await git(repo, ["add", "app.ts"]);

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    const file = changeSet.files.find((f) => f.path === "app.ts");
    expect(file).toMatchObject({
      changeType: "added",
      language: "typescript",
      additions: 2,
      deletions: 0,
      source: "unknown",
    });
  });

  it("detects untracked file as added via line count", async () => {
    const repo = await initRepo();
    write(repo, "README.md", "base\n");
    await commitAll(repo, "init");
    write(repo, "notes.py", "a = 1\nb = 2\nc = 3\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    const file = changeSet.files.find((f) => f.path === "notes.py");
    expect(file).toMatchObject({
      changeType: "added",
      language: "python",
      additions: 3,
      deletions: 0,
    });
  });

  it("counts untracked lines without shell dependency (no trailing newline, empty)", async () => {
    const repo = await initRepo();
    write(repo, "README.md", "base\n");
    await commitAll(repo, "init");
    write(repo, "no-newline.txt", "a\nb");
    write(repo, "empty.txt", "");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(
      changeSet.files.find((f) => f.path === "no-newline.txt"),
    ).toMatchObject({
      changeType: "added",
      additions: 2,
      deletions: 0,
    });
    expect(changeSet.files.find((f) => f.path === "empty.txt")).toMatchObject({
      changeType: "added",
      additions: 0,
      deletions: 0,
    });
  });

  it("detects deleted file", async () => {
    const repo = await initRepo();
    write(repo, "old.js", "const x = 1;\n");
    await commitAll(repo, "init");
    await git(repo, ["rm", "old.js"]);

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: "old.js",
      changeType: "deleted",
      language: "javascript",
    });
  });

  it("detects renamed file", async () => {
    const repo = await initRepo();
    write(repo, "before.ts", "line1\nline2\nline3\nline4\nline5\n");
    await commitAll(repo, "init");
    await git(repo, ["mv", "before.ts", "after.ts"]);

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: "after.ts",
      changeType: "renamed",
      language: "typescript",
    });
  });

  it("returns only last-commit diff when includeUncommittedChanges is false", async () => {
    const repo = await initRepo();
    write(repo, "a.txt", "v1\n");
    await commitAll(repo, "first");
    write(repo, "a.txt", "v2\n");
    await commitAll(repo, "second");
    // Uncommitted change must be ignored in this mode.
    write(repo, "a.txt", "v3-uncommitted\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: false,
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: "a.txt",
      changeType: "modified",
    });
  });

  it("measures stats from the commit range in committed-only mode", async () => {
    const repo = await initRepo();
    write(repo, "a.txt", "v1\n");
    await commitAll(repo, "first");
    write(repo, "a.txt", "v2a\nv2b\n");
    await commitAll(repo, "second");
    // Working tree moves further: committed-only stats must ignore this.
    write(repo, "a.txt", "v2a\nv2b\nv3-uncommitted\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: false,
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      additions: 2,
      deletions: 1,
    });
  });

  it("aggregates totals across multiple files", async () => {
    const repo = await initRepo();
    write(repo, "base.txt", "base\n");
    await commitAll(repo, "init");
    write(repo, "one.ts", "a\nb\n");
    write(repo, "two.py", "x\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toHaveLength(2);
    const sumAdd = changeSet.files.reduce((t, f) => t + f.additions, 0);
    const sumDel = changeSet.files.reduce((t, f) => t + f.deletions, 0);
    expect(changeSet.totalAdditions).toBe(sumAdd);
    expect(changeSet.totalDeletions).toBe(sumDel);
    expect(sumAdd).toBe(3);
  });

  it("detects staged and untracked files when there are no commits yet", async () => {
    const repo = await initRepo();
    write(repo, "staged.ts", "a\nb\n");
    write(repo, "untracked.py", "x\ny\nz\n");
    await git(repo, ["add", "staged.ts"]);

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
    });

    expect(changeSet.files).toHaveLength(2);
    expect(changeSet.files).toContainEqual(
      expect.objectContaining({
        path: "staged.ts",
        changeType: "added",
        additions: 2,
      }),
    );
    expect(changeSet.files).toContainEqual(
      expect.objectContaining({
        path: "untracked.py",
        changeType: "added",
        additions: 3,
      }),
    );
  });

  it("returns empty ChangeSet for committed-only mode with no commits yet", async () => {
    const repo = await initRepo();
    write(repo, "draft.md", "wip\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: false,
    });

    expect(changeSet.files).toEqual([]);
  });

  it("returns committed range diff ignoring uncommitted changes", async () => {
    const repo = await initRepo();
    write(repo, "a.txt", "v1\n");
    await commitAll(repo, "first");
    write(repo, "a.txt", "v2\n");
    await commitAll(repo, "second");
    write(repo, "a.txt", "v3-uncommitted\n");

    const analyzer = new GitAnalyzer();
    const changeSet = await analyzer.analyze({
      repositoryPath: repo,
      includeUncommittedChanges: true,
      refRange: "HEAD~1..HEAD",
    });

    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: "a.txt",
      changeType: "modified",
      additions: 1,
      deletions: 1,
    });
  });

  it("rejects option-like refRange", async () => {
    const repo = await initRepo();
    write(repo, "a.txt", "v1\n");
    await commitAll(repo, "first");

    const analyzer = new GitAnalyzer();

    await expect(
      analyzer.analyze({
        repositoryPath: repo,
        includeUncommittedChanges: true,
        refRange: "--help",
      }),
    ).rejects.toThrow(/Invalid --ref/);
  });
});
