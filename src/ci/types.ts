export type CIFindingSeverity = 'info' | 'warn' | 'high';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';
  previousPath?: string;
}

export interface DiffInfo {
  cwd: string;
  mode: 'range' | 'working-tree';
  baseRef?: string;
  range?: string;
  changedFiles: ChangedFile[];
}

export interface CIFinding {
  id: string;
  severity: CIFindingSeverity;
  title: string;
  file?: string;
  evidence: string[];
  why: string;
  recommendation: string;
}

export interface CIVerifyOptions {
  cwd?: string;
  base?: string;
  strict?: boolean;
}

export interface CIVerifyReport {
  tool: 'mythos-verify-ci';
  version: 1;
  mode: 'generic' | 'mythos-receipts';
  cwd: string;
  diff: {
    mode: DiffInfo['mode'];
    baseRef?: string;
    range?: string;
    changedFileCount: number;
  };
  changedFiles: ChangedFile[];
  receipt: {
    checked: boolean;
    changedReceiptCount: number;
    validReceiptCount: number;
    coveredChangedFileCount: number;
    uncoveredChangedFiles: string[];
    chainChecked: boolean;
    chainOk: boolean;
    chainLength: number;
  };
  findings: CIFinding[];
  summary: {
    high: number;
    warn: number;
    info: number;
    risk: 'low' | 'medium' | 'high';
    exitCode: number;
    strict: boolean;
  };
}
