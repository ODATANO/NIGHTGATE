/**
 * Input Validation Utilities for Midnight service handlers
 *
 * Centralizes validation logic across all CDS action handlers.
 * Each function returns an error string on failure, undefined on success.
 */

const COMMITMENT_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

const MAX_REFERENCE_ID_LENGTH = 50;
const MAX_REFERENCE_TYPE_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REASON_LENGTH = 500;

const ALLOWED_DISCLOSURE_FIELDS = new Set([
  'complianceType',
  'status',
  'issuedAt',
  'expiresAt',
  'referenceId',
  'referenceType',
  'description'
]);

export function validateCommitmentHash(hash: string): string | undefined {
  if (!COMMITMENT_HASH_REGEX.test(hash)) {
    return `Invalid commitmentHash format. Expected 64 hex characters, got ${hash.length} chars`;
  }
  return undefined;
}

export function validateExpiresAt(value: string): string | undefined {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return 'Invalid expiresAt: not a valid ISO 8601 date';
  }
  if (date <= new Date()) {
    return 'expiresAt must be in the future';
  }
  return undefined;
}

export function validateStringField(
  value: string | undefined | null,
  fieldName: string,
  maxLength: number
): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') {
    return `${fieldName} must be a string`;
  }
  if (value.length > maxLength) {
    return `${fieldName} exceeds maximum length of ${maxLength}`;
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) {
    return `${fieldName} contains invalid control characters`;
  }
  return undefined;
}

export function validateFieldsToDisclose(fields: string[]): string | undefined {
  if (!Array.isArray(fields) || fields.length === 0) {
    return 'fieldsToDisclose must be a non-empty array';
  }
  const invalid = fields.filter(f => !ALLOWED_DISCLOSURE_FIELDS.has(f));
  if (invalid.length > 0) {
    return `Invalid fields for disclosure: ${invalid.join(', ')}. Allowed: ${[...ALLOWED_DISCLOSURE_FIELDS].join(', ')}`;
  }
  return undefined;
}

export function validateCommitmentHashes(hashes: string[]): string | undefined {
  for (let i = 0; i < hashes.length; i++) {
    const err = validateCommitmentHash(hashes[i]);
    if (err) {
      return `commitmentHashes[${i}]: ${err}`;
    }
  }
  return undefined;
}

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

export { MAX_REFERENCE_ID_LENGTH, MAX_REFERENCE_TYPE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_REASON_LENGTH };
