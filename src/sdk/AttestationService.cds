using {midnight} from '../../db/schema';

/**
 * Tiered-disclosure attestation surface
 *
 * Abstract CAP service that a consumer app extends to inherit three
 * role-gated projections over `midnight.Attestations`. An attestation anchors
 * a document (canonical JSON hashed off-chain) and may carry an external
 * identifier; the on-chain disclosure levels 0, 1 and 2 map onto the tiers:
 *
 *   Public:       anyone authenticated (level 0). Just proof an attestation
 *                 exists on chain (payload hash plus anchored tx and time).
 *                 No attester identity, no metadata, no payload.
 *   Disclosed:    callers with `legitimate_interest` or higher (level 1).
 *                 Adds attester, contractAddress and publicMetadata.
 *   Authority:    callers with `authority` only (level 2). Full row including
 *                 the (optionally encrypted) off-chain payload cipher.
 *
 * Field-width gating is declarative below. The per-tier visibility check
 * ("may this caller hit this entity at all?") lives in the matching
 * `registerAttestationServiceHandlers` TS helper, which resolves the caller's
 * disclosure role through the `attachDisclosureRole` middleware.
 *
 * Consumer pattern:
 *
 *   using AttestationService from '@odatano/nightgate/sdk/AttestationService';
 *   service DocumentAttestations extends AttestationService { ... }
 *
 * Then in the consumer's service-implementation `init()`:
 *
 *   import { registerAttestationServiceHandlers }
 *     from '@odatano/nightgate/sdk/AttestationService';
 *   registerAttestationServiceHandlers(this, this.db);
 */
@abstract
service AttestationService {

  @readonly
  entity Public    as
    projection on midnight.Attestations {
      ID,
      attestationId,
      anchoredTxHash,
      anchoredAt
    };

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

  @readonly
  entity Authority as projection on midnight.Attestations;
}
