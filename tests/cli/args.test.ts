import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArgs, printHelp, run } from "../../src/cli/index.js";
import { getVersion } from "../../src/cli/version.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function isolateHistory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-hist-"));
  tempDirs.push(dir);
  const file = path.join(dir, "runs.jsonl");
  vi.stubEnv("AI_VERIFY_HISTORY_FILE", file);
  return file;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-args-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@ai-verify.dev"]);
  await git(dir, ["config", "user.name", "AI Verify Test"]);
  return dir;
}

function captureLog(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  return (async () => {
    await fn();
    return lines;
  })();
}

describe("parseArgs", () => {
  it("defaults to current dir with no flags", () => {
    expect(parseArgs(["node", "ai-verify"])).toEqual({
      repositoryPath: ".",
      json: false,
      help: false,
      version: false,
      history: true,
      installHook: false,
      uninstallHook: false,
    });
  });

  it("takes path positionally and flags anywhere", () => {
    expect(
      parseArgs(["node", "ai-verify", "/tmp/repo", "--json"]),
    ).toMatchObject({
      repositoryPath: "/tmp/repo",
      json: true,
    });
    expect(
      parseArgs(["node", "ai-verify", "--json", "/tmp/repo"]),
    ).toMatchObject({
      repositoryPath: "/tmp/repo",
      json: true,
    });
  });

  it("supports -h and -V shorthands", () => {
    expect(parseArgs(["node", "ai-verify", "-h"]).help).toBe(true);
    expect(parseArgs(["node", "ai-verify", "-V"]).version).toBe(true);
  });

  it("opts out of history with --no-history", () => {
    expect(parseArgs(["node", "ai-verify", "--no-history"]).history).toBe(
      false,
    );
  });

  it("throws on unknown option", () => {
    expect(() => parseArgs(["node", "ai-verify", "--yaml"])).toThrow(
      /Unknown option/,
    );
  });

  it("parses --ref with separate and equals values", () => {
    expect(parseArgs(["node", "ai-verify", "--ref", "HEAD~1..HEAD"]).ref).toBe(
      "HEAD~1..HEAD",
    );
    expect(parseArgs(["node", "ai-verify", "--ref=HEAD~1..HEAD"]).ref).toBe(
      "HEAD~1..HEAD",
    );
  });

  it("throws on missing --ref value", () => {
    expect(() => parseArgs(["node", "ai-verify", "--ref"])).toThrow(
      /Missing value for --ref/,
    );
    expect(() => parseArgs(["node", "ai-verify", "--ref", "--json"])).toThrow(
      /Missing value for --ref/,
    );
  });

  it("parses --install-hook flag", () => {
    expect(parseArgs(["node", "ai-verify", "--install-hook"]).installHook).toBe(
      true,
    );
  });

  it("parses --uninstall-hook flag", () => {
    expect(
      parseArgs(["node", "ai-verify", "--uninstall-hook"]).uninstallHook,
    ).toBe(true);
  });
});

describe("help and version", () => {
  it("prints usage with examples", async () => {
    const lines = await captureLog(() => printHelp());

    expect(lines.join("\n")).toMatch(/Usage: ai-verify/);
    expect(lines.join("\n")).toMatch(/--json/);
  });

  it("main --help returns 0 without analyzing", async () => {
    const lines = await captureLog(async () => {
      await expect(main(["node", "ai-verify", "--help"])).resolves.toBe(0);
    });

    expect(lines.join("\n")).toMatch(/Usage: ai-verify/);
  });

  it("main --version prints package version", async () => {
    const lines = await captureLog(async () => {
      await expect(main(["node", "ai-verify", "--version"])).resolves.toBe(0);
    });

    expect(lines.join("")).toContain(getVersion());
  });
});

describe("run --json", () => {
  it("emits parseable JSON with changeSet, risk, verification", async () => {
    const historyFile = isolateHistory();
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);
    writeFileSync(path.join(repo, "README.md"), "hello\nmore docs\n");

    let code = -1;
    const lines = await captureLog(async () => {
      code = await run(repo, { json: true });
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as {
      changeSet: unknown;
      risk: unknown;
      verification: unknown;
      verdict: unknown;
    };
    expect(parsed).toHaveProperty("changeSet");
    expect(parsed).toHaveProperty("risk");
    expect(parsed).toHaveProperty("verification");
    expect(parsed.verdict).toBe("PASS");
  });

  it("records the run to history by default", async () => {
    const historyFile = isolateHistory();
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);
    writeFileSync(path.join(repo, "README.md"), "hello\nmore docs\n");

    await captureLog(async () => {
      await run(repo);
    });

    const entry = JSON.parse(
      readFileSync(historyFile, "utf8").trim().split("\n")[0] as string,
    ) as { verdict: unknown; repo: unknown };
    expect(entry.verdict).toBe("PASS");
    expect(entry.repo).toBe(repo);
  });

  it("skips history with history: false", async () => {
    const historyFile = isolateHistory();
    const repo = await initRepo();
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "init"]);

    await captureLog(async () => {
      await run(repo, { history: false });
    });

    expect(() => readFileSync(historyFile, "utf8")).toThrow();
  });

  it("verifies a committed range ignoring uncommitted changes", async () => {
    isolateHistory();
    const repo = await initRepo();
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "first"]);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "second"]);
    writeFileSync(path.join(repo, "a.txt"), "v3-uncommitted\n");

    let code = -1;
    const lines = await captureLog(async () => {
      code = await run(repo, { refRange: "HEAD~1..HEAD" });
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Range\s+:\s+HEAD~1\.\.HEAD/);
    expect(lines.join("\n")).toMatch(/a\.txt/);
  });
});
