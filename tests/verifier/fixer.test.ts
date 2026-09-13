import { describe, expect, it } from "vitest";

import type { Finding } from "../../src/core/types/index.js";
import { suggestFix, suggestFixes } from "../../src/verifier/fixer.js";

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "test-1",
    title: "Something is wrong",
    description: "desc",
    severity: "medium",
    category: "quality",
    source: "unknown",
    ...overrides,
  };
}

describe("suggestFix", () => {
  it("suggests env-var removal for secrets", () => {
    const suggestion = suggestFix(
      makeFinding({
        source: "secret",
        category: "security",
        file: "src/auth.ts",
        line: 12,
      }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.command).toBeUndefined();
    expect(suggestion.summary).toMatch(/src\/auth\.ts:12/);
    expect(suggestion.summary).toMatch(/environment variable/i);
  });

  it("suggests type annotation fixes for type errors", () => {
    const suggestion = suggestFix(
      makeFinding({
        source: "typecheck",
        file: "src/app.ts",
        line: 3,
        title: "TS2322: Type 'string' is not assignable",
      }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.summary).toMatch(/src\/app\.ts:3/);
    expect(suggestion.summary).toMatch(/TS2322/);
  });

  it("offers eslint auto-fix for JS/TS lint findings", () => {
    const suggestion = suggestFix(
      makeFinding({ source: "lint", file: "src/app.ts", line: 7 }),
    );

    expect(suggestion.autoFixable).toBe(true);
    expect(suggestion.command).toBe("npx eslint --fix src/app.ts");
  });

  it("offers ruff auto-fix for Python lint findings", () => {
    const suggestion = suggestFix(
      makeFinding({ source: "lint", file: "src/app.py", line: 7 }),
    );

    expect(suggestion.autoFixable).toBe(true);
    expect(suggestion.command).toBe("ruff check --fix src/app.py");
  });

  it("keeps non-autofixable lint findings manual", () => {
    const suggestion = suggestFix(
      makeFinding({ source: "lint", file: "main.go", line: 7 }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.command).toBeUndefined();
  });

  it("guides test failures back to reproduce-and-fix", () => {
    const suggestion = suggestFix(
      makeFinding({
        source: "test",
        file: "main_test.go",
        title: "TestLogin failed",
      }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.summary).toMatch(/TestLogin failed/);
  });

  it("reuses the remediation for dependency findings", () => {
    const suggestion = suggestFix(
      makeFinding({
        source: "dependency",
        title: "lodash: Prototype Pollution",
        remediation: "Update to >=4.17.21",
      }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.summary).toMatch(/Update to >=4\.17\.21/);
  });

  it("falls back to a generic review suggestion", () => {
    const suggestion = suggestFix(
      makeFinding({ file: "README.md", title: "Stale docs" }),
    );

    expect(suggestion.autoFixable).toBe(false);
    expect(suggestion.summary).toMatch(/README\.md/);
  });
});

describe("suggestFixes", () => {
  it("preserves order and length", () => {
    const suggestions = suggestFixes([
      makeFinding({ source: "secret", file: "a.ts" }),
      makeFinding({ source: "test", file: "b_test.go" }),
    ]);

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.summary).toMatch(/environment variable/i);
    expect(suggestions[1]?.summary).toMatch(/failing test/i);
  });
});
