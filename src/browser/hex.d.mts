/** Hex codec shared by browser bundle, txbuilder and server. See hex.mjs. */
export function hexToBytes(hex: string, label?: string): Uint8Array;
export function hexToBytes32(hex: string, label?: string): Uint8Array;
export function bytesToHex(bytes: Uint8Array | ArrayLike<number>): string;
export function normalizeHex(hex: string, label?: string): string;
