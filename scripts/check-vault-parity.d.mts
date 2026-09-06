export interface VaultParityRun { text: string; count: number; firstLine: number; lastLine: number }
export function normalizeVaultSource(source: string, width: 16 | 32): VaultParityRun[];
export function compareVaultSources(src16: string, src32: string): { ok: boolean; problems: string[]; runs16: number; runs32: number };
