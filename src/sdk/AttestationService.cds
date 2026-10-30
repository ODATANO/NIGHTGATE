using {midnight} from '../../db/schema';

/** Base service with three views of `midnight.Attestations`. Public needs a logged-in user and shows only that an attestation exists.
 *  Disclosed needs role `legitimate_interest` and adds attester and metadata. Authority needs role `authority` and shows the full row.
 *  Extend it and call `registerAttestationServiceHandlers(this, this.db)` in `init()`. */
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
