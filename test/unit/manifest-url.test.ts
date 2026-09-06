// The server emits relative /zk-config URLs unless a public base is
// configured; the browser bundle resolves them against the manifest's URL.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM without a declaration next to it
import { resolveManifestUrl } from '../../src/browser/providers.mjs';

describe('resolveManifestUrl', () => {
    it('keeps absolute URLs as they are', () => {
        expect(resolveManifestUrl('https://api.example/zk-config/vault', 'https://other/contract-manifest')).toBe('https://api.example/zk-config/vault');
    });
    it('resolves a relative URL against the manifest URL', () => {
        expect(resolveManifestUrl('/zk-config/attestation-vault', 'https://api.nightgate.dev/contract-manifest')).toBe('https://api.nightgate.dev/zk-config/attestation-vault');
    });
    it('throws with guidance when relative and nothing to resolve against', () => {
        expect(() => resolveManifestUrl('/zk-config/x', undefined)).toThrow(/pass opts.manifestUrl/);
    });
});
