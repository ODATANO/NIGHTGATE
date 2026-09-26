using {midnight} from '../../db/schema';

/**
 * Abstract service with three disclosure-tier projections over
 * `midnight.Attestations`. Extend it and call
 * `registerAttestationServiceHandlers(this, this.db)` in `init()`; that
 * helper enforces per-tier access from the caller's disclosure role. Every
 * tier requires an authenticated user, also in a projection that forgot the helper.
 *
 *   Public:    any authenticated caller (level 0), existence only.
 *   Disclosed: `legitimate_interest` or higher (level 1), adds attester and metadata.
 *   Authority: `authority` only (level 2), full row incl. payload cipher.
 */
@abstract
service AttestationService {

  @requires: 'authenticated-user'
  @readonly
  entity Public    as
    projection on midnight.Attestations {
      ID,
      attestationId,
      anchoredTxHash,
      anchoredAt
    };

  @requires: 'authenticated-user'
  @readonly
  entity Disclosed as
    projection on midnight.Attestations {
      ID,
      attestationId,
      contractAddress,
      attester,
      publicMetadata,
      anchoredTxHash,
      anchoredAt
    };

  @requires: 'authenticated-user'
  @readonly
  entity Authority as projection on midnight.Attestations;
}
