import { describe, it, expect, vi } from 'vitest';
import type { UnshieldedKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { revocableKeystore } from '../../srv/midnight/worker/revocable-keystore';

function fakeInner() {
    return {
        getSecretKey: vi.fn(() => Buffer.from('secret')),
        getBech32Address: vi.fn(() => 'mn_addr1test'),
        getPublicKey: vi.fn(() => 'vk'),
        getAddress: vi.fn(() => 'addr-hex'),
        signData: vi.fn(() => 'sig'),
        signDataAsync: vi.fn(async () => 'sig')
    } as unknown as UnshieldedKeystore & Record<string, ReturnType<typeof vi.fn>>;
}

describe('revocable keystore', () => {
    it('passes every call to the SDK keystore until revoked', async () => {
        const inner = fakeInner();
        const ks = revocableKeystore(inner);
        expect(ks.getPublicKey()).toBe('vk');
        expect(ks.getAddress()).toBe('addr-hex');
        expect(String(ks.getBech32Address())).toBe('mn_addr1test');
        expect(ks.getSecretKey().toString()).toBe('secret');
        expect(ks.signData(new Uint8Array([1]))).toBe('sig');
        await expect(ks.signDataAsync(new Uint8Array([2]))).resolves.toBe('sig');
        expect(inner.signData).toHaveBeenCalledTimes(2);
    });

    it('refuses every call after revoke and no longer reaches the SDK keystore', async () => {
        const inner = fakeInner();
        const ks = revocableKeystore(inner);
        ks.revoke();
        expect(() => ks.signData(new Uint8Array([1]))).toThrow('signing key dropped');
        await expect(ks.signDataAsync(new Uint8Array([1]))).rejects.toThrow('signing key dropped');
        expect(() => ks.getSecretKey()).toThrow('signing key dropped');
        expect(() => ks.getPublicKey()).toThrow('signing key dropped');
        expect(inner.signData).not.toHaveBeenCalled();
        ks.revoke();
    });
});
