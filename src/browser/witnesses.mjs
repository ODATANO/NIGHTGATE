// Vault witnesses and attester-secret helpers of the browser surface; the
// implementation lives in @odatano/contract-kit (server, browser bundle and
// txbuilder decode proof bundles with the same code).
export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses
} from '@odatano/contract-kit';
