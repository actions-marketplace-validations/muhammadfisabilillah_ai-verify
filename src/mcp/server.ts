#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type {
  AnalysisRequest,
  ChangeSet,
  RiskAssessment,
  VerificationResult,
  Verdict,
} from "../core/types/index.js";
import { CoreOrchestrator } from "../core/orchestrator.js";
import { GitAnalyzer } from "../analyzer/git-analyzer.js";
import { RiskEngineV01 } from "../risk/risk-engine.js";
import {
  deriveVerdict,
  selectVerifiers,
  suggestFixes,
} from "../verifier/index.js";
import type { FixSuggestion } from "../verifier/index.js";
import { appendHistory, buildHistoryEntry } from "../history/store.js";
import { getVersion } from "../cli/version.js";

export interface VerifyInput {
  repositoryPath?: string | undefined;
  refRange?: string | undefined;
  noHistory?: boolean | undefined;
}

export interface VerifyOutput {
  changeSet: ChangeSet;
  risk: RiskAssessment;
  verification: VerificationResult;
  verdict: Verdict;
}

export interface VerifyAndFixOutput extends VerifyOutput {
  /**
   * One suggestion per entry in `verification.findings`, same order —
   * `suggestions[i]` fixes `verification.findings[i]`. Empty when there
   * are no findings. The server never applies fixes itself; the agent
   * decides, edits, and re-verifies (generate → verify → fix → verify).
   */
  suggestions: FixSuggestion[];
}

// Single ownership: the same CoreOrchestrator the CLI uses.
// Validation of repositoryPath/refRange lives in GitAnalyzer;
// history failures are swallowed by appendHistory and never fail the run.
export async function handleVerify(input: VerifyInput): Promise<VerifyOutput> {
  const repositoryPath = path.resolve(input.repositoryPath ?? ".");

  const request: AnalysisRequest = {
    repositoryPath,
    includeUncommittedChanges: true,
  };

  if (input.refRange !== undefined) {
    request.refRange = input.refRange;
  }

  const analyzer = new GitAnalyzer();
  const riskEngine = new RiskEngineV01();
  const core = new CoreOrchestrator(analyzer, riskEngine, selectVerifiers);

  const output = await core.run(request);
  const verdict = deriveVerdict(output.verification);

  if (input.noHistory !== true) {
    await appendHistory(
      buildHistoryEntry(output, verdict, getVersion(), repositoryPath),
    );
  }

  return { ...output, verdict };
}

/** Same as `handleVerify`, plus a fix suggestion aligned per finding. */
export async function handleVerifyAndFix(
  input: VerifyInput,
): Promise<VerifyAndFixOutput> {
  const output = await handleVerify(input);
  return { ...output, suggestions: suggestFixes(output.verification.findings) };
}

const verifyInputShape = {
  repositoryPath: z
    .string()
    .optional()
    .describe(
      "Target git repository path (default: the server's working directory).",
    ),
  refRange: z
    .string()
    .optional()
    .describe(
      "Committed git range to verify (e.g. HEAD~1..HEAD). " +
        "When omitted, uncommitted changes vs HEAD are verified.",
    ),
  noHistory: z
    .boolean()
    .optional()
    .describe("Skip recording this run to the local history."),
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ai-verify",
    version: getVersion(),
  });

  server.registerTool(
    "verify",
    {
      description:
        "Verify code changes in a git repository: analyze the diff, " +
        "assess risk, run fitting checks, and report PASS / REVIEW / BLOCK. " +
        "Without refRange it verifies uncommitted changes; with refRange " +
        "it verifies a committed range such as HEAD~1..HEAD.",
      inputSchema: verifyInputShape,
    },
    async (args) => {
      try {
        const result = await handleVerify({
          repositoryPath: args.repositoryPath,
          refRange: args.refRange,
          noHistory: args.noHistory,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: "text" as const,
              text: `AI Verify failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "verify-and-fix",
    {
      description:
        "Verify code changes and get a fix suggestion for every finding: " +
        "same report as `verify`, plus `suggestions[i]` for " +
        "`verification.findings[i]`. Suggestions with autoFixable=true " +
        "carry a command the agent may run itself. The server never edits " +
        "code — fix, then call verify again (generate → verify → fix → verify).",
      inputSchema: verifyInputShape,
    },
    async (args) => {
      try {
        const result = await handleVerifyAndFix({
          repositoryPath: args.repositoryPath,
          refRange: args.refRange,
          noHistory: args.noHistory,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: "text" as const,
              text: `AI Verify failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

export function isEntryModule(
  invokedPath: string | undefined,
  metaUrl: string,
): boolean {
  if (invokedPath === undefined) {
    return false;
  }

  try {
    return realpathSync(invokedPath) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}
