import { describe, expect, it } from "vitest";

import { detectLanguage } from "../../src/analyzer/language.js";

describe("detectLanguage", () => {
  it("detects TypeScript", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
  });

  it("detects TypeScript JSX", () => {
    expect(detectLanguage("src/App.tsx")).toBe("typescript");
  });

  it("detects JavaScript", () => {
    expect(detectLanguage("src/utils.js")).toBe("javascript");
  });

  it("detects JavaScript JSX", () => {
    expect(detectLanguage("src/App.jsx")).toBe("javascript");
  });

  it("detects Python", () => {
    expect(detectLanguage("app/main.py")).toBe("python");
  });

  it("detects Go", () => {
    expect(detectLanguage("cmd/server.go")).toBe("go");
  });

  it("detects Rust", () => {
    expect(detectLanguage("src/main.rs")).toBe("rust");
  });

  it("detects Java", () => {
    expect(detectLanguage("src/Main.java")).toBe("java");
  });

  it("detects PHP", () => {
    expect(detectLanguage("public/index.php")).toBe("php");
  });

  it("detects Ruby", () => {
    expect(detectLanguage("app/controllers/application.rb")).toBe("ruby");
  });

  it("detects C#", () => {
    expect(detectLanguage("src/Program.cs")).toBe("csharp");
  });

  it("detects C++", () => {
    expect(detectLanguage("src/main.cpp")).toBe("cpp");
  });

  it("detects C", () => {
    expect(detectLanguage("src/main.c")).toBe("c");
  });

  it("detects Swift", () => {
    expect(detectLanguage("Sources/App.swift")).toBe("swift");
  });

  it("detects Kotlin", () => {
    expect(detectLanguage("src/Main.kt")).toBe("kotlin");
  });

  it("returns undefined for unknown extensions", () => {
    expect(detectLanguage("README.md")).toBeUndefined();
  });

  it("returns undefined for non-existent extensions", () => {
    expect(detectLanguage("Makefile")).toBeUndefined();
  });
});
