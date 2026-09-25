import type { ChangeSet } from "./change.js";

export interface AnalysisRequest {
  repositoryPath: string;
  changeSet?: ChangeSet;
  includeUncommittedChanges: boolean;
  refRange?: string | undefined;
}
