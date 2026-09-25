import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Point PATH at an empty directory so external tool binaries (go, cargo,
 * javac, pip-audit, ...) resolve as "not available".
 *
 * Tool-availability tests must be hermetic: CI runners ship different
 * toolchains than dev machines, so a test that relies on a tool being
 * absent passes vacuously locally and then runs the real (slow) tool in CI.
 * Returns a restore function for use in try/finally.
 */
export function hideExternalTools(): () => void {
  const originalPath = process.env.PATH;
  const emptyDir = mkdtempSync(path.join(tmpdir(), "ai-verify-no-tools-"));
  process.env.PATH = emptyDir;

  return () => {
    process.env.PATH = originalPath;
    rmSync(emptyDir, { recursive: true, force: true });
  };
}
