/**
 * Input Validation Utilities for Midnight service handlers
 */

const HEX_REGEX = /^[0-9a-fA-F]+$/;

export function validateViewingKey(viewingKey: string | undefined | null): string | undefined {
  if (!viewingKey || typeof viewingKey !== 'string') {
    return 'viewingKey is required';
  }
  if (!HEX_REGEX.test(viewingKey)) {
    return 'viewingKey must be hex-encoded';
  }
  if (viewingKey.length !== 64) {
    return `viewingKey must be 64 hex characters (32 bytes), got ${viewingKey.length}`;
  }
  return undefined;
}
