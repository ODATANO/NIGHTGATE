using { midnight } from '../../db/schema';

/**
 * Tiered-disclosure attestation surface (T11).
 *
 * Abstract CAP service that consumer apps (e.g. @odatano/passport) extend to
 * inherit three role-gated projections over `midnight.Attestations`. The
 * tiers mirror the EU Battery Regulation Annex XIII / Art. 77 access model:
 *
 *   Public      — anyone authenticated. Just proof an attestation exists on
 *                 chain (payload_hash + anchored tx/time). No attester
 *                 identity, no metadata, no payload.
 *   Disclosed   — callers with `legitimate_interest` or higher. Adds
 *                 attester, contractAddress and publicMetadata.
 *   Authority   — callers with `authority` only. Full row including the
 *                 (optionally encrypted) off-chain payload cipher.
 *
 * Field-width gating is declarative below. The per-tier *visibility* check
 * (i.e. "may this caller hit this entity at all?") lives in the matching
 * `registerAttestationServiceHandlers` TS helper — it reads
 * `req.disclosureRole` set by the `attachDisclosureRole` middleware (T14).
 *
 * Consumer pattern:
 *
 *   using AttestationService from '@odatano/nightgate/sdk/AttestationService';
 *   service PassportAttestations extends AttestationService { … }
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
  entity Public as projection on midnight.Attestations {
    ID,
    attestationId,
    anchoredTxHash,
    anchoredAt
  };

  @readonly
  entity Disclosed as projection on midnight.Attestations {
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
