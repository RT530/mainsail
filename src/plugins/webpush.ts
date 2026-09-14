/**
 * Helpers around the Web Push API.
 *
 * Push requires a secure context (https, or localhost during development). On
 * iOS the API additionally only exists once the web app has been added to the
 * home screen, so `PushManager` missing is a normal state to report rather than
 * an error.
 */

export interface WebPushSubscriptionJson {
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
}

export const isServiceWorkerSupported = (): boolean => 'serviceWorker' in navigator

export const isPushSupported = (): boolean => isServiceWorkerSupported() && 'PushManager' in window

export const isNotificationSupported = (): boolean => 'Notification' in window

/**
 * True when the app runs as an installed PWA. iOS exposes push only in this
 * mode, so it is worth telling the user about explicitly.
 */
export const isStandalone = (): boolean => {
    const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone
    if (iosStandalone) return true

    return window.matchMedia?.('(display-mode: standalone)').matches ?? false
}

/**
 * VAPID keys are distributed base64url encoded, but `subscribe()` wants the raw
 * bytes of the public key.
 */
export const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)

    // backed by an explicit ArrayBuffer, as BufferSource does not accept the
    // SharedArrayBuffer that a plain Uint8Array may be typed with
    const output = new Uint8Array(new ArrayBuffer(rawData.length))
    for (let i = 0; i < rawData.length; i++) {
        output[i] = rawData.charCodeAt(i)
    }

    return output
}

export interface VapidKeypair {
    /** base64url raw P-256 point, the form `subscribe()` and senders expect */
    publicKey: string
    /** PKCS#8 PEM, the form Apprise's `keyfile=` expects */
    privateKeyPem: string
}

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
    }

    return btoa(binary)
}

const toBase64Url = (bytes: Uint8Array): string =>
    bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const toPem = (der: ArrayBuffer): string => {
    const body = bytesToBase64(new Uint8Array(der))
        .replace(/(.{64})/g, '$1\n')
        .trimEnd()

    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

/**
 * Generates the VAPID key pair in the browser, so that enabling notifications
 * needs no key generation script on the host. The private key is PKCS#8 PEM,
 * which is what Apprise loads via `keyfile=`; the public key is the raw curve
 * point both `subscribe()` and the sender derive their identity from.
 */
export const generateVapidKeypair = async (): Promise<VapidKeypair> => {
    const keypair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

    const [rawPublicKey, pkcs8PrivateKey] = await Promise.all([
        crypto.subtle.exportKey('raw', keypair.publicKey),
        crypto.subtle.exportKey('pkcs8', keypair.privateKey),
    ])

    return {
        publicKey: toBase64Url(new Uint8Array(rawPublicKey)),
        privateKeyPem: toPem(pkcs8PrivateKey),
    }
}

/**
 * Recovers the public half of a VAPID key pair from its private key.
 *
 * WebCrypto cannot hand back a public key from an imported private one, but a
 * P-256 private key exported as JWK carries the curve point in `x`/`y`, which
 * is the uncompressed point with its leading 0x04 removed. This lets the key
 * pair on the printer stay the single source of truth, with nothing about it
 * duplicated into the settings.
 */
export const derivePublicKeyFromPem = async (pem: string): Promise<string> => {
    const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    const der = urlBase64ToUint8Array(body)

    const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
    ])

    const jwk = await crypto.subtle.exportKey('jwk', privateKey)
    if (!jwk.x || !jwk.y) throw new Error('private key carries no public point')

    const point = new Uint8Array(65)
    point[0] = 4
    point.set(urlBase64ToUint8Array(jwk.x), 1)
    point.set(urlBase64ToUint8Array(jwk.y), 33)

    return toBase64Url(point)
}

export const getRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!isServiceWorkerSupported()) return null

    return (await navigator.serviceWorker.getRegistration()) ?? null
}

export const getSubscription = async (): Promise<PushSubscription | null> => {
    const registration = await getRegistration()
    if (registration === null) return null

    return await registration.pushManager.getSubscription()
}

export const subscribe = async (vapidPublicKey: string): Promise<PushSubscription> => {
    const registration = await navigator.serviceWorker.ready

    const existing = await registration.pushManager.getSubscription()
    // a subscription made with a different key can never be delivered to, so
    // drop it before subscribing again
    if (existing !== null) await existing.unsubscribe()

    return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
}

export const unsubscribe = async (): Promise<boolean> => {
    const subscription = await getSubscription()
    if (subscription === null) return false

    return await subscription.unsubscribe()
}

/**
 * Reduces a PushSubscription to the endpoint/keys pair that push senders need.
 */
export const toSubscriptionJson = (subscription: PushSubscription): WebPushSubscriptionJson => {
    const json = subscription.toJSON()

    return {
        endpoint: json.endpoint ?? '',
        keys: {
            p256dh: json.keys?.p256dh ?? '',
            auth: json.keys?.auth ?? '',
        },
    }
}
