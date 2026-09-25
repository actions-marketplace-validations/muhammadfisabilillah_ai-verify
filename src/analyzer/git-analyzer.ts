import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AnalysisRequest,
  ChangeSet,
  FileChange,
} from "../core/types/index.js";

import type { Analyzer } from "./analyzer.js";
import { detectLanguage } from "./language.js";

const execFileAsync = promisify(execFile);

type GitChangeStatus = "added" | "modified" | "deleted" | "renamed";

interface GitChange {
  path: string;
  changeType: GitChangeStatus;
}

export class GitAnalyzer implements Analyzer {
  async analyze(request: AnalysisRequest): Promise<ChangeSet> {
    const repositoryPath = path.resolve(request.repositoryPath);

    await this.assertGitRepository(repositoryPath);

    const hasHead = await this.hasCommitHistory(repositoryPath);
    const refRange = this.normalizeRefRange(request.refRange);

    const changes = await this.getGitChanges(
      repositoryPath,
      request.includeUncommittedChanges,
      hasHead,
      refRange,
    );

    const stats = await this.getBatchStats(
      repositoryPath,
      request.includeUncommittedChanges,
      hasHead,
      refRange,
    );

    const files: FileChange[] = [];

    for (const change of changes) {
      const fileChange = await this.createFileChange(
        repositoryPath,
        change,
        request.includeUncommittedChanges,
        hasHead,
        stats,
        refRange,
      );

      files.push(fileChange);
    }

    return {
      files,
      totalAdditions: files.reduce((total, file) => total + file.additions, 0),
      totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  }

  private async assertGitRepository(repositoryPath: string): Promise<void> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: repositoryPath,
      });
    } catch {
      throw new Error(
        `The target directory is not a Git repository: ${repositoryPath}`,
      );
    }
  }

  private async hasCommitHistory(repositoryPath: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repositoryPath,
      });

      return true;
    } catch {
      return false;
    }
  }

  private normalizeRefRange(refRange: string | undefined): string | undefined {
    if (refRange === undefined) {
      return undefined;
    }

    const trimmed = refRange.trim();

    if (!trimmed) {
      throw new Error("Invalid --ref: expected a non-empty git range.");
    }

    if (trimmed.startsWith("-") || trimmed.includes("\0")) {
      throw new Error(`Invalid --ref: refusing option-like range: ${trimmed}`);
    }

    return trimmed;
  }

  private async getGitChanges(
    repositoryPath: string,
    includeUncommittedChanges: boolean,
    hasHead: boolean,
    refRange: string | undefined,
  ): Promise<GitChange[]> {
    if (refRange !== undefined) {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", refRange, "--name-status", "-M"],
        {
          cwd: repositoryPath,
        },
      );

      return this.parseNameStatus(stdout);
    }

    if (!includeUncommittedChanges && !hasHead) {
      return [];
    }

    const args = includeUncommittedChanges
      ? hasHead
        ? ["diff", "HEAD", "--name-status", "-M"]
        : ["diff", "--cached", "--name-status", "-M"]
      : ["diff", "HEAD~1", "HEAD", "--name-status", "-M"];

    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryPath,
    });

    const changes = this.parseNameStatus(stdout);

    if (!includeUncommittedChanges) {
      return changes;
    }

    const untrackedFiles = await this.getUntrackedFiles(repositoryPath);

    return [
      ...changes,
      ...untrackedFiles.map((filePath) => ({
        path: filePath,
        changeType: "added" as const,
      })),
    ];
  }

  private parseNameStatus(output: string): GitChange[] {
    if (!output.trim()) {
      return [];
    }

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => this.parseNameStatusLine(line));
  }

  private parseNameStatusLine(line: string): GitChange[] {
    const parts = line.split("\t");

    if (parts.length < 2) {
      return [];
    }

    const status = parts[0];
    const firstPath = parts[1];

    if (!status || !firstPath) {
      return [];
    }

    const statusCode = status[0];

    switch (statusCode) {
      case "A":
        return [
          {
            path: firstPath,
            changeType: "added",
          },
        ];

      case "M":
        return [
          {
            path: firstPath,
            changeType: "modified",
          },
        ];

      case "D":
        return [
          {
            path: firstPath,
            changeType: "deleted",
          },
        ];

      case "R": {
        const newPath = parts[2];

        if (!newPath) {
          return [];
        }

        return [
          {
            path: newPath,
            changeType: "renamed",
          },
        ];
      }

      default:
        return [];
    }
  }

  private async getUntrackedFiles(repositoryPath: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: repositoryPath,
      },
    );

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async createFileChange(
    repositoryPath: string,
    change: GitChange,
    includeUncommittedChanges: boolean,
    hasHead: boolean,
    batch: Map<string, { additions: number; deletions: number }>,
    refRange: string | undefined,
  ): Promise<FileChange> {
    const stats = await this.getFileStats(
      repositoryPath,
      change,
      includeUncommittedChanges,
      hasHead,
      batch,
      refRange,
    );

    const language = detectLanguage(change.path);

    const fileChange: FileChange = {
      path: change.path,
      changeType: change.changeType,
      additions: stats.additions,
      deletions: stats.deletions,
      source: "unknown",
    };

    if (language !== undefined) {
      fileChange.language = language;
    }

    return fileChange;
  }

  private diffBaseArgs(
    includeUncommittedChanges: boolean,
    hasHead: boolean,
    refRange: string | undefined,
  ): string[] {
    if (refRange !== undefined) {
      return ["diff", refRange];
    }

    if (!includeUncommittedChanges) {
      return ["diff", "HEAD~1", "HEAD"];
    }

    return hasHead ? ["diff", "HEAD"] : ["diff", "--cached"];
  }

  private async getBatchStats(
    repositoryPath: string,
    includeUncommittedChanges: boolean,
    hasHead: boolean,
    refRange: string | undefined,
  ): Promise<Map<string, { additions: number; deletions: number }>> {
    const stats = new Map<string, { additions: number; deletions: number }>();

    if (refRange === undefined && !includeUncommittedChanges && !hasHead) {
      return stats;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          ...this.diffBaseArgs(includeUncommittedChanges, hasHead, refRange),
          "--numstat",
          "-M",
        ],
        { cwd: repositoryPath },
      );

      for (const line of stdout.split("\n")) {
        const entry = this.parseNumstatLine(line);

        if (!entry) {
          continue;
        }

        for (const key of entry.keys) {
          if (!stats.has(key)) {
            stats.set(key, {
              additions: entry.additions,
              deletions: entry.deletions,
            });
          }
        }
      }
    } catch {
      // Fall back to per-file queries below.
    }

    return stats;
  }

  private parseNumstatLine(line: string):
    | {
        keys: string[];
        additions: number;
        deletions: number;
      }
    | undefined {
    const parts = line.split("\t");

    if (parts.length < 3) {
      return undefined;
    }

    const pathField = parts.slice(2).join("\t").trim();

    if (!pathField) {
      return undefined;
    }

    return {
      keys: this.expandNumstatKeys(pathField),
      additions: this.parseStat(parts[0]),
      deletions: this.parseStat(parts[1]),
    };
  }

  private expandNumstatKeys(pathField: string): string[] {
    const keys = new Set<string>([pathField]);

    const arrowIndex = pathField.indexOf(" => ");

    if (arrowIndex === -1) {
      return [...keys];
    }

    keys.add(pathField.slice(0, arrowIndex).trim());
    keys.add(pathField.slice(arrowIndex + 4).trim());

    const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(pathField);

    if (braced) {
      const [, prefix = "", oldPart = "", newPart = "", suffix = ""] = braced;
      keys.add(`${prefix}${oldPart.trim()}${suffix}`);
      keys.add(`${prefix}${newPart.trim()}${suffix}`);
    }

    return [...keys].filter(Boolean);
  }

  private async getFileStats(
    repositoryPath: string,
    change: GitChange,
    includeUncommittedChanges: boolean,
    hasHead: boolean,
    batch: Map<string, { additions: number; deletions: number }>,
    refRange: string | undefined,
  ): Promise<{
    additions: number;
    deletions: number;
  }> {
    if (change.changeType === "added") {
      const isTracked = await this.isTrackedFile(repositoryPath, change.path);

      if (!isTracked) {
        return this.countUntrackedFileLines(repositoryPath, change.path);
      }
    }

    const batched = batch.get(change.path);

    if (batched) {
      return batched;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          ...this.diffBaseArgs(includeUncommittedChanges, hasHead, refRange),
          "--numstat",
          "-M",
          "--",
          change.path,
        ],
        {
          cwd: repositoryPath,
        },
      );

      const line = stdout
        .split("\n")
        .map((value) => value.trim())
        .find(Boolean);

      if (!line) {
        return {
          additions: 0,
          deletions: 0,
        };
      }

      const parts = line.split("\t");

      return {
        additions: this.parseStat(parts[0]),
        deletions: this.parseStat(parts[1]),
      };
    } catch {
      return {
        additions: 0,
        deletions: 0,
      };
    }
  }

  private async isTrackedFile(
    repositoryPath: string,
    filePath: string,
  ): Promise<boolean> {
    try {
      await execFileAsync(
        "git",
        ["ls-files", "--error-unmatch", "--", filePath],
        {
          cwd: repositoryPath,
        },
      );

      return true;
    } catch {
      return false;
    }
  }

  private async countUntrackedFileLines(
    repositoryPath: string,
    filePath: string,
  ): Promise<{
    additions: number;
    deletions: number;
  }> {
    try {
      const absolutePath = path.join(repositoryPath, filePath);
      const content = await readFile(absolutePath, "utf8");

      if (content.length === 0) {
        return { additions: 0, deletions: 0 };
      }

      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      return { additions: lines.length, deletions: 0 };
    } catch {
      return {
        additions: 0,
        deletions: 0,
      };
    }
  }

  private parseStat(value: string | undefined): number {
    if (!value || value === "-") {
      return 0;
    }

    const parsed = Number.parseInt(value, 10);

    return Number.isNaN(parsed) ? 0 : parsed;
  }
}
