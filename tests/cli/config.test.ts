import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, getDefaultConfig } from "../../src/cli/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("getDefaultConfig", () => {
  it("returns default config with hook settings", () => {
    const config = getDefaultConfig();
    expect(config.hook).toBeDefined();
    expect(config.hook?.blockOn).toEqual(["BLOCK"]);
    expect(config.hook?.reviewOn).toEqual([]);
    expect(config.hook?.skip).toBe(false);
    expect(config.hook?.timeout).toBe(120);
  });
});

describe("loadConfig", () => {
  it("returns default config when no file exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-config-"));
    tempDirs.push(dir);

    const config = await loadConfig(dir);
    expect(config).toEqual(getDefaultConfig());
  });

  it("loads config from .ai-verify.yml", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-config-"));
    tempDirs.push(dir);

    writeFileSync(
      path.join(dir, ".ai-verify.yml"),
      `hook:
  skip: true
  timeout: 60
  blockOn:
    - BLOCK
    - REVIEW
`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.hook?.skip).toBe(true);
    expect(config.hook?.timeout).toBe(60);
    expect(config.hook?.blockOn).toEqual(["BLOCK", "REVIEW"]);
  });

  it("ignores comments in yaml", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-config-"));
    tempDirs.push(dir);

    writeFileSync(
      path.join(dir, ".ai-verify.yml"),
      `# This is a comment
hook:
  # Another comment
  skip: true
`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.hook?.skip).toBe(true);
  });

  it("handles malformed yaml gracefully", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-verify-config-"));
    tempDirs.push(dir);

    writeFileSync(
      path.join(dir, ".ai-verify.yml"),
      `hook:
  skip: not-a-boolean
  timeout: 999
`,
      "utf8",
    );

    const config = await loadConfig(dir);
    expect(config.hook?.skip).toBe(false);
    expect(config.hook?.timeout).toBe(999);
  });
});
