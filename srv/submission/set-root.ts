/**
 * How an allow-list of values is turned into one set root, public under
 * `@odatano/nightgate/set-root`. The code lives in `@odatano/contract-kit`.
 */
export {
    SET_DEPTH,
    MAX_SET_VALUES,
    canonicalSetDigests,
    buildMembershipSet,
    membershipPathFor,
    type SetPureCircuits,
    type MembershipPath
} from '@odatano/contract-kit';
