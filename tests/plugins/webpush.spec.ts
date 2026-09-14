import { describe, expect, it } from 'vitest'
import {
    derivePublicKeyFromPem,
    generateVapidKeypair,
    toSubscriptionJson,
    urlBase64ToUint8Array,
} from '@/plugins/webpush'

describe('webpush', () => {
    describe('urlBase64ToUint8Array', () => {
        it('decodes a base64url string without padding', () => {
            // "hello" is aGVsbG8 in base64url, which needs one '=' of padding
            expect([...urlBase64ToUint8Array('aGVsbG8')]).toEqual([104, 101, 108, 108, 111])
        })

        it('decodes the base64url alphabet, which differs from base64 in two characters', () => {
            // 0xfb 0xff 0xbf encodes to -_-_ rather than +/+/
            expect([...urlBase64ToUint8Array('-_-_')]).toEqual([251, 255, 191])
        })

        it('decodes a P-256 application server key to 65 bytes', () => {
            const key = 'BD--r2_2FU7ROqS22aheSQtW-oOnoZHHcF2cWgKyBbZbpgAq8wUjJD-VbSCJl-bW5UVOCKMDm0t14D_FdSA7i4U'

            const decoded = urlBase64ToUint8Array(key)

            expect(decoded).toHaveLength(65)
            // an uncompressed EC point always starts with 0x04
            expect(decoded[0]).toBe(4)
        })

        it('returns a view backed by a plain ArrayBuffer, as BufferSource requires', () => {
            expect(urlBase64ToUint8Array('aGVsbG8').buffer).toBeInstanceOf(ArrayBuffer)
        })
    })

    describe('generateVapidKeypair', () => {
        it('produces an application server key and a PKCS#8 private key', async () => {
            const keypair = await generateVapidKeypair()

            // 65 bytes, leading 0x04: the uncompressed point subscribe() expects
            expect(urlBase64ToUint8Array(keypair.publicKey)).toHaveLength(65)
            expect(urlBase64ToUint8Array(keypair.publicKey)[0]).toBe(4)

            expect(keypair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
            expect(keypair.privateKeyPem).toMatch(/-----END PRIVATE KEY-----\n$/)
        })
    })

    describe('derivePublicKeyFromPem', () => {
        it('recovers the public key the pair was generated with', async () => {
            const keypair = await generateVapidKeypair()

            // the printer only keeps the private half, so this round trip is what
            // lets the public key stop being a stored setting
            await expect(derivePublicKeyFromPem(keypair.privateKeyPem)).resolves.toBe(keypair.publicKey)
        })

        it('reads a key pair generated outside the browser', async () => {
            // anyone who set this up with the old python script keeps working
            const pem =
                '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5E+QzvMtGTEMg5Yr\n2O1otpO4SIUiHY1DE17xoRtXF4ehRANCAARIWmwpV0os/O0PG1fQra8yZaHGwdz7\nGfMYEVxrcwSwWV5RT6kLq8vFMTZqorOUcgvqlhNkCvQDKi4xqLj43OzI\n-----END PRIVATE KEY-----\n'

            await expect(derivePublicKeyFromPem(pem)).resolves.toBe(
                'BEhabClXSiz87Q8bV9CtrzJlocbB3PsZ8xgRXGtzBLBZXlFPqQury8UxNmqis5RyC-qWE2QK9AMqLjGouPjc7Mg'
            )
        })

        it('rejects something that is not a private key', async () => {
            await expect(derivePublicKeyFromPem('not a pem')).rejects.toThrow()
        })
    })

    describe('toSubscriptionJson', () => {
        it('keeps only the endpoint and keys a push sender needs', () => {
            const subscription = {
                toJSON: () => ({
                    endpoint: 'https://example.test/push/abc',
                    expirationTime: null,
                    keys: { p256dh: 'public-key', auth: 'auth-secret' },
                }),
            } as unknown as PushSubscription

            expect(toSubscriptionJson(subscription)).toEqual({
                endpoint: 'https://example.test/push/abc',
                keys: { p256dh: 'public-key', auth: 'auth-secret' },
            })
        })

        it('falls back to empty strings when the browser omits the keys', () => {
            const subscription = {
                toJSON: () => ({ endpoint: 'https://example.test/push/abc' }),
            } as unknown as PushSubscription

            expect(toSubscriptionJson(subscription)).toEqual({
                endpoint: 'https://example.test/push/abc',
                keys: { p256dh: '', auth: '' },
            })
        })
    })
})
