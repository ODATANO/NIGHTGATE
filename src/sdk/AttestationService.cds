using {midnight} from '../../db/schema';

/**
 * Base service with three views of `midnight.Attestations`, each showing more data.
 * Extend it and call `registerAttestationServiceHandlers(this, this.db)` in `init()`.
 * That helper checks the caller's disclosure role. All views need a logged-in user even without it.
 *
 *   Public:    any logged-in user. Shows only that an attestation exists.
 *   Disclosed: role `legitimate_interest` or higher. Adds the attester and metadata.
 *   Authority: role `authority` only. Shows the full row, including the encrypted payload.
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
