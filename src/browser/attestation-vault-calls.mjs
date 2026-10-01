// Typed call-input helpers for the AttestationVault (browser path); the
// implementation lives in @odatano/contract-kit.
export {
    DEFAULT_CLAIM_LIFETIME_S,
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest,
    prepareRegisterDocument,
    prepareRegisterPassport,
    prepareBindDocument,
    prepareBindPassport,
    prepareRetract,
    prepareRetractAttestation,
    preparePurgeExpired,
    recordKeyOf,
    prepareAnchorContentRoot,
    prepareProveFieldPredicate,
    prepareProveFieldEquality,
    prepareProveFieldMembership,
    prepareProveFieldsUnchangedExcept,
    prepareProveFieldsDiffer
} from '@odatano/contract-kit';
