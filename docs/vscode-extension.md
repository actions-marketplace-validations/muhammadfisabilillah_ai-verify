# VS Code Extension

Run AI Verify without leaving the editor. The extension runs `ai-verify`
on the repository containing your file, shows the verdict in the status
bar, and lists findings in the **Problems** panel.

## Installation

1. Install AI Verify once (used by the extension under the hood):

   ```bash
   npm install -g @fisaabil_/ai-verify
   ```

   Without a global install the extension falls back to
   `npx --yes @fisaabil_/ai-verify@latest` (needs network on first run).

2. Install the extension from source (until it is published):

   ```bash
   cd .vscode-extension
   npm install
   npm run compile
   ```

   Then in VS Code: **Run → Install from VSIX**, or press `F5` in the
   `.vscode-extension` folder to launch an Extension Development Host.

3. Open any file inside a Git repository. The status bar shows `AI Verify`.

## Commands

| Command                          | Where                    | What it does                                     |
| -------------------------------- | ------------------------ | ------------------------------------------------ |
| `AI Verify: Verify Project`      | Command palette, explorer context menu, status bar click | Verifies uncommitted changes in the repo, updates status bar + Problems |
| `AI Verify: Verify Current File` | Command palette, editor context menu | Same run, then reports findings for the open file only |

## Configuration (`aiVerify.*`)

| Setting                | Default                          | Meaning                                                        |
| ---------------------- | -------------------------------- | -------------------------------------------------------------- |
| `aiVerify.binaryPath`  | `""`                             | Path to the `ai-verify` binary. Empty = `ai-verify` on `PATH`, else `npx` with `packageSpec`. |
| `aiVerify.packageSpec` | `@fisaabil_/ai-verify@latest`    | npm spec used for the `npx` fallback (pin a version for teams). |
| `aiVerify.extraArgs`   | `[]`                             | Extra CLI flags appended to every run (e.g. `["--ref", "HEAD~1..HEAD"]`). |

Example (`settings.json`):

```json
{
  "aiVerify.packageSpec": "@fisaabil_/ai-verify@0.2.1"
}
```

## How results appear

- **Status bar** — `AI Verify: PASS` / `REVIEW` / `BLOCK` (red for `BLOCK`,
  yellow for `REVIEW`). Click it to re-verify the project.
- **Problems panel** — one diagnostic per finding with a file and line
  (`critical`/`high` → Error, `medium` → Warning, else Information).
- Findings without a file are counted in the summary message only.

The extension never writes history (`--no-history`) and never modifies
your code — it only reports.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `ai-verify not found`-style error | `npm install -g @fisaabil_/ai-verify`, or set `aiVerify.binaryPath` to the binary |
| `Not a git repository — skipping` | Open a file inside a Git working tree |
| `AI Verify: UNKNOWN` | The CLI produced no JSON (see Output panel) — check `aiVerify.extraArgs` |
| Stale diagnostics | Re-run a command; each run clears the previous `ai-verify` diagnostics |

## Publishing

Maintainers only — requires a Marketplace publisher token:

```bash
cd .vscode-extension
npx @vscode/vsce package   # produces ai-verify-*.vsix
npx @vscode/vsce publish
```
