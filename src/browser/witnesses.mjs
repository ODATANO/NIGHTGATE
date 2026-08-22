// Browser-safe witness + attester-secret helpers for the wallet-connector path.
//
// This is the BROWSER mirror of `srv/submission/contract-witnesses.ts` (server
// path). Kept as a small self-contained ESM module so the browser bundle never
// reaches into `srv/` (which carries Node-only assumptions). The two MUST stay
// in lockstep on:
//   - the domain-separation label   'nightgate/attestation-vault/v1'
//   - the witness object shape       { local_secret_key, field_value, merkle_*, set_*, doc_leaves_* }
// Hashing uses @noble/hashes (pure JS); the secret sealing helpers use the
// platform WebCrypto (`globalThis.crypto`, browser and Node 18+).
//
// Design: the vault has no contract private state; attester identity = HMAC
// over secret material. The attester secret is RANDOM per wallet
// (`generateAttestationSecret`), stored client-side under the dApp's origin
// via `sealAttestationSecret` (AES-256-GCM; the unlock material, e.g. a
// wallet signature, only decrypts a ciphertext the dApp holds and is NOT
// itself the secret). The old fixed-message signData derivation was removed
// in 0.16.0: a signature over a fixed public message is shareable
// authentication evidence, and any dApp able to request it could reproduce
// the attester identity and run the owner-gated circuits.

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

const ATTESTATION_VAULT_LABEL = 'nightgate/attestation-vault/v1';

function hexToBytes32(hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('value must be 64 hex chars (32 bytes)');
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

function hexToBytes(hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
        throw new Error('invalid hex string');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Derive the 32-byte AttestationVault secret from arbitrary key material.
 *
 * SAME primitive as the server's `deriveAttestationSecret(seedBytes)` (same
 * HMAC-SHA256 + domain label), so that, IF the same material is supplied to both
 * paths, the on-chain `attester_id = persistentHash(local_secret_key())`
 * matches. The server feeds the wallet seed; browser flows use a RANDOM
 * secret (`generateAttestationSecret`) instead, so cross-path identities
 * coincide only when the material is deliberately shared. NEVER feed
 * shareable authentication evidence (signatures over fixed messages) here.
 */
export function deriveAttestationSecret(material) {
    return hmac(sha256, material, new TextEncoder().encode(ATTESTATION_VAULT_LABEL));
}

// REMOVED in 0.16.0: deriveAttestationSecretFromSignature /
// ATTESTER_SECRET_MESSAGE. A signature over a fixed public message is
// shareable authentication evidence, not key material: any dApp that got the
// user to sign the same message derived the SAME attester identity and could
// run the owner-gated circuits as it. Use the flow below instead.

const SEAL_INFO_LABEL = 'nightgate/attestation-secret-seal/v1';

function bytesToHexStr(bytes) {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
}

/**
 * Generate a fresh RANDOM 32-byte attester secret (CSPRNG). This is the
 * wallet's contract authority: `attester_id = persistentHash(secret)`.
 * Generate ONCE per wallet, seal it with `sealAttestationSecret`, keep the
 * sealed blob in the dApp's own storage, and reopen it per session. Losing
 * the secret loses the attester identity (registrar re-assignment is the
 * recovery path for registered passport ids).
 */
export function generateAttestationSecret() {
    const secret = new Uint8Array(32);
    globalThis.crypto.getRandomValues(secret);
    return secret;
}

async function sealKeyFor(unlockMaterial, salt, usage) {
    if (!(unlockMaterial instanceof Uint8Array) || unlockMaterial.length === 0) {
        throw new Error('unlockMaterial must be a non-empty Uint8Array');
    }
    const subtle = globalThis.crypto.subtle;
    const ikm = await subtle.importKey('raw', unlockMaterial, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(SEAL_INFO_LABEL) },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        [usage]
    );
}

/**
 * Seal the attester secret under arbitrary unlock material (AES-256-GCM with
 * an HKDF-derived key; WebCrypto). The unlock material MAY be a wallet
 * signature: unlike the removed fixed-message derivation, the signature only
 * DECRYPTS a ciphertext this dApp holds in its own origin storage; a foreign
 * dApp obtaining the same signature has no ciphertext to open. Returns a
 * JSON-serializable blob `{ v, salt, iv, cipher }` (hex members).
 */
export async function sealAttestationSecret(secret, unlockMaterial) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) {
        throw new Error('secret must be a 32-byte Uint8Array');
    }
    const salt = new Uint8Array(32);
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(salt);
    globalThis.crypto.getRandomValues(iv);
    const key = await sealKeyFor(unlockMaterial, salt, 'encrypt');
    const cipher = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret));
    return { v: 1, salt: bytesToHexStr(salt), iv: bytesToHexStr(iv), cipher: bytesToHexStr(cipher) };
}

/**
 * Reopen a sealed attester secret. Throws on wrong unlock material or a
 * tampered blob (GCM authentication).
 */
export async function openAttestationSecret(sealed, unlockMaterial) {
    if (!sealed || sealed.v !== 1 || !sealed.salt || !sealed.iv || !sealed.cipher) {
        throw new Error('sealed must be a { v: 1, salt, iv, cipher } blob from sealAttestationSecret');
    }
    const key = await sealKeyFor(unlockMaterial, hexToBytes(sealed.salt), 'decrypt');
    const secret = new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexToBytes(sealed.iv) }, key, hexToBytes(sealed.cipher)));
    if (secret.length !== 32) throw new Error('sealed blob did not contain a 32-byte secret');
    return secret;
}

/**
 * Build the AttestationVault witness object bound to a given attester secret
 * (and an optional Merkle inclusion proof for the field-bound proof circuits).
 *
 * Witness signature matches the generated `Witnesses<PS>`:
 *   local_secret_key(ctx): [PS, Uint8Array]
 *   field_value(ctx):      [PS, bigint]
 *   merkle_siblings(ctx):  [PS, Uint8Array[]]   (log2(slotWidth) × Bytes<32>; 4 on the 16er, 5 on the 32er)
 *   merkle_dirs(ctx):      [PS, boolean[]]      (log2(slotWidth))
 * `ctx.privateState` is passed through unchanged; the vault has no private state.
 *
 * `merkleProof` is a per-call proof BUNDLE for the field-bound proof circuits:
 * { fieldValue?, fieldSalt?, fieldDigest?, siblings?: string[depth] hex,
 *   dirs?: boolean[depth], setProof?: { siblings: string[6] hex, dirs: boolean[6] },
 *   docPair?: { schema: descriptor[width], openingA: { saltSeed, slots[width] },
 *               openingB: { saltSeed, slots[width] } } }
 * where width comes from `slotWidth` (16 default, 32 for attestation-vault-32)
 * and depth = log2(width).
 * `fieldValue` + `fieldSalt` feed proveFieldPredicate, `fieldDigest` +
 * `fieldSalt` + `setProof` feed proveFieldMembership; proveFieldEquality
 * needs `fieldSalt` + siblings/dirs; the mode-switched cross-root circuit
 * (proveDocumentComparison) needs only `docPair` (shared schema + both full
 * openings; the server's prepareDocumentProof returns them as `schema` and
 * `opening`), and `siblings`/`dirs` may then be omitted. Unused witnesses
 * simply are never invoked for other circuits, so a proof-less call
 * (attest/grant/…) is unaffected.
 *
 * `merkleProofHolder` (batch mode, mutually exclusive with `merkleProof`):
 * { current?: <bundle> }. Resolved at witness INVOCATION time; the batch loop
 * swaps `holder.current` immediately before each call, so one witness object
 * serves N proof calls inside one transaction scope. Mirrors the server's
 * `WitnessFactoryInput`.
 */
// Classic 16-slot default; every decode takes the per-artifact slot count
// (`slotWidth` on buildAttestationVaultWitnesses: 16 default, 32 for the
// attestation-vault-32 width variant) and derives depth = log2(width).
const SET_DEPTH = 6;
const SLOT_COUNT = 16;

const ZERO32 = new Uint8Array(32);

function decodeSchema(schema, label, slotCount = SLOT_COUNT) {
    if (schema === undefined) return undefined;
    if (!Array.isArray(schema) || schema.length !== slotCount) {
        throw new Error(`${label} must have exactly ${slotCount} entries`);
    }
    return schema.map((d, i) => {
        const kind = BigInt(d.kind);
        if (kind < 0n || kind > 2n) throw new Error(`${label}[${i}].kind must be 0, 1 or 2`);
        return { field_key: hexToBytes32(d.fieldKey), kind, scale: BigInt(d.scale ?? '0') };
    });
}

function decodeOpening(opening, label, slotCount = SLOT_COUNT) {
    if (opening === undefined) return undefined;
    if (!Array.isArray(opening.slots) || opening.slots.length !== slotCount) {
        throw new Error(`${label}.slots must have exactly ${slotCount} entries`);
    }
    return {
        seed: hexToBytes32(opening.saltSeed),
        slots: opening.slots.map((s) => ({
            present: Boolean(s.present),
            uint_value: s.value !== undefined ? BigInt(s.value) : 0n,
            value_digest: s.valueDigest !== undefined ? hexToBytes32(s.valueDigest) : ZERO32
        }))
    };
}

function decodeMerkleProof(proof, slotCount = SLOT_COUNT) {
    const depth = Math.log2(slotCount);
    const fieldValue = proof.fieldValue !== undefined ? BigInt(proof.fieldValue) : undefined;
    const fieldSalt = proof.fieldSalt !== undefined ? hexToBytes32(proof.fieldSalt) : undefined;
    const fieldDigest = proof.fieldDigest !== undefined ? hexToBytes32(proof.fieldDigest) : undefined;
    // The inclusion path is required for the single-field circuits; a bundle
    // carrying ONLY cross-root material may omit it.
    let siblings;
    let dirs;
    if (proof.siblings !== undefined || proof.dirs !== undefined || !proof.docPair) {
        siblings = (proof.siblings || []).map(hexToBytes32);
        dirs = (proof.dirs || []).map(Boolean);
        if (siblings.length !== depth || dirs.length !== depth) {
            throw new Error(`merkleProof.siblings and .dirs must each have ${depth} entries`);
        }
    }
    let setSiblings;
    let setDirs;
    if (proof.setProof) {
        setSiblings = (proof.setProof.siblings || []).map(hexToBytes32);
        setDirs = (proof.setProof.dirs || []).map(Boolean);
        if (setSiblings.length !== SET_DEPTH || setDirs.length !== SET_DEPTH) {
            throw new Error(`merkleProof.setProof.siblings and .dirs must each have ${SET_DEPTH} entries`);
        }
    }
    const docSchema = decodeSchema(proof.docPair?.schema, 'merkleProof.docPair.schema', slotCount);
    const openingA = decodeOpening(proof.docPair?.openingA, 'merkleProof.docPair.openingA', slotCount);
    const openingB = decodeOpening(proof.docPair?.openingB, 'merkleProof.docPair.openingB', slotCount);
    if (proof.docPair && (docSchema === undefined || openingA === undefined || openingB === undefined)) {
        throw new Error('merkleProof.docPair requires schema, openingA and openingB');
    }
    return {
        fieldValue, fieldSalt, fieldDigest, siblings, dirs, setSiblings, setDirs,
        docSchema, docSaltA: openingA?.seed, docSaltB: openingB?.seed,
        docSlotsA: openingA?.slots, docSlotsB: openingB?.slots
    };
}

export function buildAttestationVaultWitnesses({ attestationSecret, merkleProof, merkleProofHolder, slotWidth } = {}) {
    // OPTIONAL (holder/attester separation): the proof circuits
    // (proveFieldPredicate/Equality/Membership, proveDocumentComparison) never
    // invoke local_secret_key, so a holder proving against an anchored root
    // must not be handed the owner secret at all. Only the owner-gated
    // circuits (attest, grant/revokeDisclosure, registerPassport,
    // bindPassport, anchorContentRoot) resolve this witness.
    if (attestationSecret !== undefined
        && (!(attestationSecret instanceof Uint8Array) || attestationSecret.length !== 32)) {
        throw new Error('attestationSecret must be a 32-byte Uint8Array');
    }
    if (merkleProof && merkleProofHolder) {
        throw new Error('merkleProof and merkleProofHolder are mutually exclusive');
    }
    const slotCount = slotWidth ?? SLOT_COUNT;
    const staticProof = merkleProof ? decodeMerkleProof(merkleProof, slotCount) : undefined;
    const holder = merkleProofHolder;
    const currentProof = (witnessName) => {
        if (holder) {
            if (!holder.current) {
                throw new Error(`${witnessName} witness invoked with an empty batch proof holder; set holder.current before the call`);
            }
            return decodeMerkleProof(holder.current, slotCount);
        }
        if (staticProof === undefined) {
            throw new Error(`${witnessName} witness invoked without a merkleProof; the field-bound proof circuits require a proof bundle`);
        }
        return staticProof;
    };

    return {
        local_secret_key(ctx) {
            if (attestationSecret === undefined) {
                throw new Error('local_secret_key witness invoked without an attestationSecret; the owner-gated circuits require it (proof circuits do not)');
            }
            return [ctx.privateState, attestationSecret];
        },
        field_value(ctx) {
            const p = currentProof('field_value');
            if (p.fieldValue === undefined) {
                throw new Error('field_value witness invoked without a fieldValue; proveFieldPredicate requires a numeric proof bundle');
            }
            return [ctx.privateState, p.fieldValue];
        },
        merkle_siblings(ctx) {
            const p = currentProof('merkle_siblings');
            if (p.siblings === undefined) {
                throw new Error('merkle_siblings witness invoked without an inclusion path; the single-field proof circuits require siblings/dirs');
            }
            return [ctx.privateState, p.siblings];
        },
        merkle_dirs(ctx) {
            const p = currentProof('merkle_dirs');
            if (p.dirs === undefined) {
                throw new Error('merkle_dirs witness invoked without an inclusion path; the single-field proof circuits require siblings/dirs');
            }
            return [ctx.privateState, p.dirs];
        },
        field_digest(ctx) {
            const p = currentProof('field_digest');
            if (p.fieldDigest === undefined) {
                throw new Error('field_digest witness invoked without a fieldDigest; proveFieldMembership requires a bytes proof bundle');
            }
            return [ctx.privateState, p.fieldDigest];
        },
        set_siblings(ctx) {
            const p = currentProof('set_siblings');
            if (p.setSiblings === undefined) {
                throw new Error('set_siblings witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setSiblings];
        },
        set_dirs(ctx) {
            const p = currentProof('set_dirs');
            if (p.setDirs === undefined) {
                throw new Error('set_dirs witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setDirs];
        },
        field_salt(ctx) {
            const p = currentProof('field_salt');
            if (p.fieldSalt === undefined) {
                throw new Error('field_salt witness invoked without a fieldSalt; the single-field proof circuits require the slot salt (v4)');
            }
            return [ctx.privateState, p.fieldSalt];
        },
        doc_schema(ctx) {
            const p = currentProof('doc_schema');
            if (p.docSchema === undefined) {
                throw new Error('doc_schema witness invoked without docPair.schema; proveDocumentComparison requires the shared descriptor list');
            }
            return [ctx.privateState, p.docSchema];
        },
        doc_salt_a(ctx) {
            const p = currentProof('doc_salt_a');
            if (p.docSaltA === undefined) {
                throw new Error('doc_salt_a witness invoked without docPair.openingA; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSaltA];
        },
        doc_salt_b(ctx) {
            const p = currentProof('doc_salt_b');
            if (p.docSaltB === undefined) {
                throw new Error('doc_salt_b witness invoked without docPair.openingB; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSaltB];
        },
        doc_slots_a(ctx) {
            const p = currentProof('doc_slots_a');
            if (p.docSlotsA === undefined) {
                throw new Error('doc_slots_a witness invoked without docPair.openingA; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSlotsA];
        },
        doc_slots_b(ctx) {
            const p = currentProof('doc_slots_b');
            if (p.docSlotsB === undefined) {
                throw new Error('doc_slots_b witness invoked without docPair.openingB; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSlotsB];
        }
    };
}
