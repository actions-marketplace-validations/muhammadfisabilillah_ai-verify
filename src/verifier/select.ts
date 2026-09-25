import type { ChangeSet, RiskAssessment } from "../core/types/index.js";

import { CargoCheckVerifier, isRustFile } from "./cargo-check.js";
import { CargoTestVerifier } from "./cargo-test.js";
import { ClippyVerifier } from "./clippy.js";
import { EslintVerifier, isLintableFile } from "./eslint.js";
import { GoVetVerifier, isGoFile } from "./go-vet.js";
import { GoTestVerifier } from "./go-test.js";
import { JavacVerifier, isJavaFile } from "./javac.js";
import { NpmAuditVerifier } from "./npm-audit.js";
import { PipAuditVerifier } from "./pip-audit.js";
import { PytestVerifier, isPythonFile } from "./pytest.js";
import { RuffVerifier } from "./ruff.js";
import { SecretsVerifier } from "./secrets.js";
import { TypeCheckVerifier, isTypeScriptFile } from "./typecheck.js";
import { VitestVerifier } from "./vitest.js";
import type { Verifier } from "./verifier.js";

export type VerifierSelector = (
  changeSet: ChangeSet,
  risk: RiskAssessment,
) => Verifier[];

// Risk-adaptive selection: risk only ever ADDS depth, never removes it.
// A check that applies to a change at LOW risk still applies at HIGH risk.
// Secret Scan is the risk-independent baseline (always on when files remain);
// risk-adaptive outcomes for it derive from per-rule severity in the verdict,
// not from selection. Future checks branch on `risk` here.
const PYTHON_DEP_FILES = [
  "requirements.txt",
  "setup.py",
  "pyproject.toml",
  "Pipfile",
  "setup.cfg",
];

function hasPythonDeps(changeSet: ChangeSet): boolean {
  return changeSet.files.some(
    (file) =>
      PYTHON_DEP_FILES.includes(file.path) ||
      file.path.endsWith("requirements.txt") ||
      file.path.endsWith("setup.py") ||
      file.path.endsWith("pyproject.toml"),
  );
}

export function selectVerifiers(
  changeSet: ChangeSet,
  _risk: RiskAssessment,
): Verifier[] {
  const verifiers: Verifier[] = [];

  const touchesTypeScript = changeSet.files.some((file) =>
    isTypeScriptFile(file.path, file.language),
  );

  if (touchesTypeScript) {
    verifiers.push(new TypeCheckVerifier());
  }

  const touchesLintable = changeSet.files.some((file) =>
    isLintableFile(file.path, file.language),
  );

  if (touchesLintable) {
    verifiers.push(new EslintVerifier());
    verifiers.push(new VitestVerifier());
  }

  const touchesPython = changeSet.files.some((file) =>
    isPythonFile(file.path, file.language),
  );

  if (touchesPython) {
    verifiers.push(new RuffVerifier());
    verifiers.push(new PytestVerifier());
  }

  const touchesGo = changeSet.files.some((file) =>
    isGoFile(file.path, file.language),
  );

  if (touchesGo) {
    verifiers.push(new GoVetVerifier());
    verifiers.push(new GoTestVerifier());
  }

  const touchesRust = changeSet.files.some((file) =>
    isRustFile(file.path, file.language),
  );

  if (touchesRust) {
    verifiers.push(new CargoCheckVerifier());
    verifiers.push(new ClippyVerifier());
    verifiers.push(new CargoTestVerifier());
  }

  const touchesJava = changeSet.files.some((file) =>
    isJavaFile(file.path, file.language),
  );

  if (touchesJava) {
    verifiers.push(new JavacVerifier());
  }

  const touchesScannableFile = changeSet.files.some(
    (file) => file.changeType !== "deleted",
  );

  if (touchesScannableFile) {
    verifiers.push(new SecretsVerifier());
  }

  const touchesNodeDeps = changeSet.files.some(
    (file) =>
      file.path === "package.json" ||
      file.path === "package-lock.json" ||
      file.path === "yarn.lock" ||
      file.path === "pnpm-lock.yaml",
  );

  if (touchesNodeDeps) {
    verifiers.push(new NpmAuditVerifier());
  }

  if (hasPythonDeps(changeSet)) {
    verifiers.push(new PipAuditVerifier());
  }

  return verifiers;
}
