import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AiVerifyConfig {
  hook?: {
    blockOn?: string[];
    reviewOn?: string[];
    skip?: boolean;
    timeout?: number;
  };
}

const DEFAULT_CONFIG: AiVerifyConfig = {
  hook: {
    blockOn: ["BLOCK"],
    reviewOn: [],
    skip: false,
    timeout: 120,
  },
};

export function getDefaultConfig(): AiVerifyConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export async function loadConfig(
  repositoryPath: string,
): Promise<AiVerifyConfig> {
  const configPath = path.join(repositoryPath, ".ai-verify.yml");

  try {
    const content = await readFile(configPath, "utf8");
    const parsed = parseYaml(content);
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentSection: string | null = null;
  let currentSubsection: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex !== -1) {
        currentSection = trimmed.slice(0, colonIndex).trim();
        currentSubsection = null;
        const value = trimmed.slice(colonIndex + 1).trim();
        if (value !== "") {
          result[currentSection] = parseValue(value);
        } else {
          result[currentSection] = {};
        }
      }
    } else if (indent === 2 && currentSection) {
      const section = result[currentSection];
      if (typeof section === "object" && section !== null) {
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex !== -1) {
          currentSubsection = trimmed.slice(0, colonIndex).trim();
          const value = trimmed.slice(colonIndex + 1).trim();
          if (value !== "") {
            (section as Record<string, unknown>)[currentSubsection] =
              parseValue(value);
          } else {
            (section as Record<string, unknown>)[currentSubsection] = [];
          }
        }
      }
    } else if (indent === 4 && currentSection && currentSubsection) {
      const section = result[currentSection];
      if (typeof section === "object" && section !== null) {
        const subsection = (section as Record<string, unknown>)[
          currentSubsection
        ];
        if (Array.isArray(subsection)) {
          const dashIndex = trimmed.indexOf("-");
          if (dashIndex !== -1) {
            const value = trimmed.slice(dashIndex + 1).trim();
            subsection.push(parseValue(value));
          }
        }
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function mergeConfig(
  base: AiVerifyConfig,
  override: Record<string, unknown>,
): AiVerifyConfig {
  const result = structuredClone(base);

  if (override.hook && typeof override.hook === "object") {
    const hookOverride = override.hook as Record<string, unknown>;
    if (!result.hook) {
      result.hook = {};
    }

    if (Array.isArray(hookOverride.blockOn)) {
      result.hook.blockOn = hookOverride.blockOn as string[];
    }
    if (Array.isArray(hookOverride.reviewOn)) {
      result.hook.reviewOn = hookOverride.reviewOn as string[];
    }
    if (typeof hookOverride.skip === "boolean") {
      result.hook.skip = hookOverride.skip;
    }
    if (typeof hookOverride.timeout === "number") {
      result.hook.timeout = hookOverride.timeout;
    }
  }

  return result;
}
