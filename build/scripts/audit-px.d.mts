export interface PxViolation {
  path: string;
  line: number;
  reason: string;
}

export declare const auditPx: (options?: {roots?: string[]}) => {violations: PxViolation[]};
export declare const stripComments: (source: string) => string;
export declare const occurrences: (source: string) => Array<{index: number; text: string}>;
export declare const classify: (file: string, source: string, index: number, occurrence: string) => string | null;
