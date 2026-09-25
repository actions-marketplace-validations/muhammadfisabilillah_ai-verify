# GitLab CI/CD Setup

AI Verify integrates with GitLab CI/CD to automatically verify code changes in merge requests and pushes.

## Quick Setup

### Option 1: Include the template

Add this to your `.gitlab-ci.yml`:

```yaml
include:
  - project: 'muhammadfisabilillah/ai-verify'
    ref: main
    file: '/examples/gitlab-ci.yml'
```

### Option 2: Copy the job

Copy the `ai-verify` job from [`examples/gitlab-ci.yml`](../examples/gitlab-ci.yml) into your `.gitlab-ci.yml`.

### Option 3: Minimal setup

Add this minimal job to your `.gitlab-ci.yml`:

```yaml
ai-verify:
  stage: test
  image: node:18
  script:
    - npx --yes @fisaabil_/ai-verify@latest . --json
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

## Configuration

### Version pinning

Pin a specific version for reproducibility:

```yaml
ai-verify:
  variables:
    AI_VERIFY_VERSION: "0.2.1"
```

### Custom path

Verify a specific directory:

```yaml
ai-verify:
  script:
    - npx --yes @fisaabil_/ai-verify@latest ./src --json
```

### Extra flags

Pass additional flags:

```yaml
ai-verify:
  script:
    - npx --yes @fisaabil_/ai-verify@latest . --json --no-history
```

## How it works

1. The job runs on merge requests and pushes to the default branch
2. AI Verify analyzes the changes, assesses risk, and runs appropriate checks
3. The verdict (`PASS`, `REVIEW`, or `BLOCK`) is printed in the job output
4. The JSON report is saved as an artifact for 30 days
5. The job fails on `REVIEW` or `BLOCK` (configurable via `allow_failure`)

## Verdict handling

| Verdict | Job status | Meaning |
|---------|-----------|---------|
| `PASS` | ✅ Success | All checks passed |
| `REVIEW` | ❌ Failed | Findings need human review |
| `BLOCK` | ❌ Failed | Critical issues found |
| `UNKNOWN` | ❌ Failed | Report unreadable |

## Using the verdict in downstream jobs

You can use the verdict to conditionally run other jobs:

```yaml
ai-verify:
  stage: verify
  image: node:18
  script:
    - |
      set -uo pipefail
      out="ai-verify.json"
      npx --yes @fisaabil_/ai-verify@latest . --json > "$out" || code=$?
      verdict=$(node -e "const fs=require('fs');try{console.log(JSON.parse(fs.readFileSync('$out','utf8')).verdict)}catch{console.log('UNKNOWN')}")
      echo "verdict=$verdict" >> build.env
      exit ${code:-0}
  artifacts:
    reports:
      dotenv: build.env

deploy:
  stage: deploy
  needs: ["ai-verify"]
  rules:
    - if: '$verdict == "PASS"'
  script:
    - echo "Deploying..."
```

## Artifacts

The job saves:
- `ai-verify.json` - Full verification report (30 days retention)
- `build.env` - Verdict variable (optional, for downstream jobs)

## Requirements

- Node.js >= 18 available in the runner
- Git repository with changes to verify
- The runner must be able to install npm packages

## Troubleshooting

### Job fails with "not a git repository"

Ensure the runner has proper Git checkout. Add `GIT_DEPTH: 0` if needed:

```yaml
ai-verify:
  variables:
    GIT_DEPTH: 0
```

### Job fails with npm install errors

Try using a different Node.js image or pre-install the package:

```yaml
ai-verify:
  image: node:20-alpine
  before_script:
    - npm install -g @fisaabil_/ai-verify@latest
  script:
    - ai-verify . --json
```

### Job takes too long

Increase the timeout or skip history:

```yaml
ai-verify:
  timeout: 10 minutes
  script:
    - npx --yes @fisaabil_/ai-verify@latest . --json --no-history
```
