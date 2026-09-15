<template>
    <div>
        <v-card flat>
            <v-card-text>
                <div class="d-flex align-center">
                    <v-icon style="opacity: 0.7">{{ mdiBellRing }}</v-icon>
                    <v-card-title class="mx-n2">
                        {{ $t('Settings.NotificationsTab.Notifications') }}
                    </v-card-title>
                    <v-divider class="ml-3" />
                </div>
                <template v-if="isPwa">
                    <v-alert v-if="unavailableReason" dense text type="info" class="mb-0 mt-3">
                        {{ unavailableReason }}
                    </v-alert>
                    <template v-else>
                        <settings-row
                            :title="$t('Settings.NotificationsTab.TestNotification')"
                            :sub-title="$t('Settings.NotificationsTab.TestNotificationDescription')">
                            <v-btn small outlined @click="sendTestNotification">
                                {{ $t('Settings.NotificationsTab.SendTest') }}
                            </v-btn>
                        </settings-row>
                        <v-divider class="my-2" />
                        <settings-row
                            :title="$t('Settings.NotificationsTab.Enable')"
                            :sub-title="enableDescription"
                            :loading="loading">
                            <v-switch
                                v-model="enabled"
                                hide-details
                                class="mt-0"
                                :disabled="loading"
                                @change="onEnabledChanged" />
                        </settings-row>
                        <template v-if="hasProgressMacro">
                            <v-divider class="my-2" />
                            <settings-row
                                :title="$t('Settings.NotificationsTab.Progress')"
                                :sub-title="$t('Settings.NotificationsTab.ProgressDescription')"
                                :mobile-second-row="true">
                                <v-select
                                    v-model="progressInterval"
                                    :items="progressOptions"
                                    hide-details
                                    outlined
                                    dense />
                            </settings-row>
                        </template>
                        <template v-if="hasRunoutMacro">
                            <h3 class="text-h5 mb-3 mt-6">{{ $t('Settings.NotificationsTab.Runout') }}</h3>
                            <p class="mb-3 text--secondary runout-hint">
                                {{ $t('Settings.NotificationsTab.RunoutDescription') }}
                            </p>
                            <template v-if="availableRunoutSensors.length">
                                <template v-for="(sensor, index) in availableRunoutSensors">
                                    <v-divider v-if="index" :key="'runout_divider_' + sensor" class="my-2" />
                                    <settings-row :key="sensor" :title="convertName(sensor)" :dynamic-slot-width="true">
                                        <v-switch
                                            :input-value="isRunoutSensorEnabled(sensor)"
                                            hide-details
                                            class="mt-0"
                                            @change="setRunoutSensor(sensor, $event)" />
                                    </settings-row>
                                </template>
                            </template>
                            <p v-else class="mb-0 text-center font-italic">
                                {{ $t('Settings.NotificationsTab.RunoutNoSensors') }}
                            </p>
                        </template>
                    </template>
                </template>
                <v-alert v-else dense text type="info" class="mb-0 mt-3">
                    {{ $t('Settings.NotificationsTab.EnableFromApp') }}
                </v-alert>

                <!-- Connected devices: shown on every device type, so any
                     browser can review the list and drop a stale entry, not
                     only the phone that can subscribe. -->
                <h3 class="text-h5 mb-3 mt-6">{{ $t('Settings.NotificationsTab.ConnectedDevices') }}</h3>
                <p class="mb-3 text--secondary devices-hint">
                    {{ $t('Settings.NotificationsTab.ConnectedDevicesDescription') }}
                </p>
                <p v-if="devicesLoading" class="mb-0 text-center font-italic">
                    {{ $t('Settings.NotificationsTab.DevicesLoading') }}
                </p>
                <template v-else-if="connectedDevices.length">
                    <template v-for="(device, index) in connectedDevices">
                        <v-divider v-if="index" :key="'device_divider_' + device.name" class="my-2" />
                        <settings-row
                            :key="device.name"
                            :title="device.name"
                            :sub-title="device.service"
                            :dynamic-slot-width="true">
                            <div class="d-flex align-center justify-end">
                                <v-chip v-if="device.current" x-small color="primary" outlined class="mr-3">
                                    {{ $t('Settings.NotificationsTab.ThisDevice') }}
                                </v-chip>
                                <v-btn
                                    small
                                    outlined
                                    color="error"
                                    :loading="disconnecting === device.name"
                                    :disabled="disconnecting !== ''"
                                    @click="disconnectDevice(device.name)">
                                    {{ $t('Settings.NotificationsTab.Disconnect') }}
                                </v-btn>
                            </div>
                        </settings-row>
                    </template>
                </template>
                <p v-else class="mb-0 text-center font-italic">
                    {{ $t('Settings.NotificationsTab.NoDevices') }}
                </p>
            </v-card-text>
        </v-card>
    </div>
</template>

<script lang="ts">
import Component from 'vue-class-component'
import { Mixins } from 'vue-property-decorator'
import BaseMixin from '@/components/mixins/base'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import Panel from '@/components/ui/Panel.vue'
import { mdiBellRing } from '@mdi/js'
import { sha256 } from 'js-sha256'
import { convertName } from '@/plugins/helpers'
import axios from 'axios'
import {
    getSubscription,
    isNotificationSupported,
    derivePublicKeyFromPem,
    generateVapidKeypair,
    isPushSupported,
    isStandalone,
    subscribe,
    toSubscriptionJson,
    unsubscribe,
    WebPushSubscriptionJson,
} from '@/plugins/webpush'

const deviceNameStorageKey = 'mainsail.push.deviceName'

@Component({
    components: {
        Panel,
        SettingsRow,
    },
})
export default class SettingsNotificationsTab extends Mixins(BaseMixin) {
    mdiBellRing = mdiBellRing

    convertName = convertName

    loading = false
    enabled = false
    subscription: WebPushSubscriptionJson | null = null
    deviceNameValue = ''
    connectedDevices: { name: string; endpoint: string; service: string; current: boolean }[] = []
    devicesLoading = true
    disconnecting = ''

    async mounted() {
        const stored = localStorage.getItem(deviceNameStorageKey)
        // persist the generated name straight away, otherwise a new one is made
        // on every mount and stops matching the entry written to the printer
        if (stored === null) this.deviceName = this.defaultDeviceName
        else this.deviceNameValue = stored

        await this.refreshSubscription()
        await this.refreshDevices()
    }

    /**
     * Never shown in the UI -- it only keys this device's entry in the
     * subscription file, so it just has to be readable there and unique.
     */
    get defaultDeviceName() {
        const agent = navigator.userAgent
        const platform = [
            ['iphone', /iPhone/i],
            ['ipad', /iPad/i],
            ['android', /Android/i],
            ['mac', /Macintosh/i],
            ['windows', /Windows/i],
            ['linux', /Linux/i],
        ].find(([, pattern]) => (pattern as RegExp).test(agent))

        return `${platform?.[0] ?? 'browser'}-${Math.random().toString(36).slice(2, 8)}`
    }

    /**
     * Push is unavailable rather than broken in a few normal situations, each of
     * which needs a different hint to the user.
     */
    /**
     * True only in an installed PWA. The subscribe controls are shown here alone,
     * since a plain browser tab is not what receives the notifications; the
     * connected-device list below stays visible everywhere.
     */
    get isPwa(): boolean {
        return isStandalone()
    }

    get unavailableReason() {
        if (!window.isSecureContext) return this.$t('Settings.NotificationsTab.NeedsSecureContext')

        // iOS exposes PushManager only once the app is on the home screen
        if (!isPushSupported() && !isStandalone()) return this.$t('Settings.NotificationsTab.NeedsInstall')

        if (!isPushSupported() || !isNotificationSupported()) return this.$t('Settings.NotificationsTab.NotSupported')

        return null
    }

    get enableDescription() {
        return this.$t('Settings.NotificationsTab.EnableDescription')
    }

    /**
     * Both of these settings are driven by printer-side macros, which Mainsail
     * does not ship. Hiding the controls when the macros are absent keeps them
     * from writing save variables that nothing would ever read.
     */
    get hasProgressMacro(): boolean {
        return 'gcode_macro _NOTIFY_PROGRESS_VARS' in (this.$store.state.printer ?? {})
    }

    get hasRunoutMacro(): boolean {
        return 'gcode_macro _NOTIFY_RUNOUT_VARS' in (this.$store.state.printer ?? {})
    }

    get progressOptions() {
        return [
            { text: this.$t('Settings.NotificationsTab.ProgressEvery', { percent: 10 }), value: 10 },
            { text: this.$t('Settings.NotificationsTab.ProgressEvery', { percent: 25 }), value: 25 },
            { text: this.$t('Settings.NotificationsTab.ProgressEvery', { percent: 50 }), value: 50 },
            { text: this.$t('Settings.NotificationsTab.ProgressComplete'), value: 100 },
        ]
    }

    get progressInterval(): number {
        return this.$store.state.gui.push?.progressInterval ?? 25
    }

    set progressInterval(newVal: number) {
        this.$store.dispatch('gui/push/saveSetting', { name: 'progressInterval', value: newVal })
        // the printer-side macro reads this from save_variables, so that
        // progress notifications keep working with no browser open
        this.$store.dispatch('printer/sendGcode', `SAVE_VARIABLE VARIABLE=notify_progress_interval VALUE=${newVal}`)
    }

    get availableRunoutSensors(): string[] {
        const printer = this.$store.state.printer ?? {}

        return (
            Object.keys(printer)
                .filter((key) => key.startsWith('filament_switch_sensor ') || key.startsWith('filament_motion_sensor '))
                .map((key) => key.split(' ').slice(1).join(' '))
                // numeric-aware, or mmu_entry_10 sorts between _1 and _2
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        )
    }

    get runoutSensors(): string[] {
        return this.$store.state.gui.push?.runoutSensors ?? []
    }

    isRunoutSensorEnabled(name: string): boolean {
        return this.runoutSensors.includes(name)
    }

    /**
     * Watched sensors go to the printer as a comma-separated string, so a
     * printer-side macro can poll them with no browser open. Each is latched
     * separately there, which matters on an MMU where unused gates read empty.
     */
    setRunoutSensor(name: string, value: boolean | null) {
        const current = this.runoutSensors.filter((sensor) => sensor !== name)
        const next = value === true ? [...current, name].sort() : current

        this.$store.dispatch('gui/push/saveSetting', { name: 'runoutSensors', value: next })
        // klipper strips one level of quotes before ast.literal_eval, so the
        // value has to arrive with its quotes escaped
        this.$store.dispatch(
            'printer/sendGcode',
            `SAVE_VARIABLE VARIABLE=notify_runout_sensors VALUE=\\"${next.join(',')}\\"`
        )
    }

    get subscriptionPath(): string {
        return this.$store.state.gui.push?.subscriptionPath ?? 'webpush/subscriptions.json'
    }

    get deviceName(): string {
        return this.deviceNameValue
    }

    set deviceName(newVal: string) {
        this.deviceNameValue = newVal
        localStorage.setItem(deviceNameStorageKey, newVal)
    }

    async refreshSubscription() {
        const subscription = await getSubscription()
        this.subscription = subscription === null ? null : toSubscriptionJson(subscription)
        this.enabled = this.subscription !== null
    }

    /**
     * The v-switch writes `enabled` directly, so react to the change instead of
     * using a setter -- Safari only shows the permission prompt when
     * requestPermission() is reached from the click without an await in front.
     */
    async onEnabledChanged(newVal: boolean) {
        if (!newVal) {
            try {
                await unsubscribe()
                this.subscription = null
            } catch (error: unknown) {
                // the browser kept the subscription, but dropping this device
                // from the printer is what actually stops the notifications
                window.console.error('unsubscribing failed:', error)
                this.$toast.error(this.$t('Settings.NotificationsTab.UnsubscribeFailed').toString())
            }

            await this.removeFromPrinter()

            return
        }

        let vapidPublicKey: string
        try {
            vapidPublicKey = await this.ensureVapidPublicKey()
        } catch (error: unknown) {
            window.console.error('preparing the VAPID key pair failed:', error)
            this.enabled = false
            this.$toast.error(this.$t('Settings.NotificationsTab.KeygenFailed').toString())

            return
        }

        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
            this.enabled = false
            this.$toast.error(this.$t('Settings.NotificationsTab.PermissionDenied').toString())
            return
        }

        this.loading = true
        try {
            const subscription = await subscribe(vapidPublicKey)
            this.subscription = toSubscriptionJson(subscription)
        } catch (error: unknown) {
            window.console.error('push subscribe failed:', error)
            await this.rollbackSubscription('SubscribeFailed')

            return
        } finally {
            this.loading = false
        }

        // save straight away -- a subscription the printer does not know about
        // receives nothing, and a separate step is easy to miss
        try {
            await this.saveToPrinter()
        } catch (error: unknown) {
            window.console.error('saving the subscription failed:', error)
            await this.rollbackSubscription('SaveFailed')
        }
    }

    /**
     * Leaves nothing half-enabled: a browser subscription the printer does not
     * know about receives nothing, and would silently look like it works.
     */
    async rollbackSubscription(message: string) {
        try {
            await unsubscribe()
        } catch (error: unknown) {
            window.console.error('rolling back the subscription failed:', error)
        }

        this.subscription = null
        this.enabled = false
        this.$toast.error(this.$t(`Settings.NotificationsTab.${message}`).toString())
    }

    async sendTestNotification() {
        const registration = await navigator.serviceWorker.ready
        await registration.showNotification(this.$t('Settings.NotificationsTab.TestTitle').toString(), {
            body: this.$t('Settings.NotificationsTab.TestBody').toString(),
            icon: '/img/icons/icon-192.png',
            badge: '/img/icons/icon-192-maskable.png',
            tag: 'mainsail-test',
        })
    }

    get configPath(): string {
        return this.subscriptionPath.replace(/^\/+/, '')
    }

    /**
     * Reads the subscription file from the config root. A missing file is the
     * normal first-run case, so it resolves to an empty set rather than failing.
     */
    async readSubscriptions(): Promise<Record<string, WebPushSubscriptionJson>> {
        try {
            const response = await axios.get(`${this.apiUrl}/server/files/config/${this.configPath}`, {
                params: { date: Date.now() },
            })
            if (response.data && typeof response.data === 'object') return response.data

            return {}
        } catch (error: unknown) {
            // only a missing file means "no subscriptions yet". Treating any
            // other failure as empty would write this device over the top of
            // every other one already in the file
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                window.console.debug('no existing subscription file, starting a new one')

                return {}
            }

            throw error
        }
    }

    get privateKeyPath(): string {
        const directory = this.configPath.split('/').slice(0, -1).join('/')

        return directory === '' ? 'vapid_private.pem' : `${directory}/vapid_private.pem`
    }

    /**
     * Returns the public half of the printer's VAPID key pair, creating the pair
     * on first use. The private key on the printer is the only copy that matters,
     * so the public half is always derived from it rather than stored alongside --
     * nothing can drift out of sync, and there is no setting to fill in.
     */
    async ensureVapidPublicKey(): Promise<string> {
        const existing = await this.readPrivateKey()
        if (existing !== null) return await derivePublicKeyFromPem(existing)

        const keypair = await generateVapidKeypair()
        await this.writePrivateKey(keypair.privateKeyPem)

        return keypair.publicKey
    }

    /**
     * Reads the private key from the config root. Missing is the normal first-run
     * case and resolves to null; anything else is a real failure and is raised,
     * so a transient error cannot silently overwrite a working key pair.
     */
    async readPrivateKey(): Promise<string | null> {
        try {
            const response = await axios.get(`${this.apiUrl}/server/files/config/${this.privateKeyPath}`, {
                params: { date: Date.now() },
                responseType: 'text',
                transformResponse: [(data) => data],
            })

            return typeof response.data === 'string' && response.data.includes('PRIVATE KEY') ? response.data : null
        } catch (error: unknown) {
            if (axios.isAxiosError(error) && error.response?.status === 404) return null

            throw error
        }
    }

    /**
     * Writes the VAPID private key beside the subscription file, where
     * Moonraker's [notifier] can point Apprise at it with `keyfile=`.
     */
    async writePrivateKey(pem: string) {
        const filename = this.privateKeyPath.split('/').pop() ?? 'vapid_private.pem'
        const directory = this.privateKeyPath.split('/').slice(0, -1).join('/')

        const formData = new FormData()
        formData.append('file', new Blob([pem], { type: 'application/x-pem-file' }), filename)
        formData.append('root', 'config')
        formData.append('path', directory)
        formData.append('checksum', sha256(pem))

        await axios.post(`${this.apiUrl}/server/files/upload`, formData)
    }

    async writeSubscriptions(subscriptions: Record<string, WebPushSubscriptionJson>) {
        const content = JSON.stringify(subscriptions, null, 4)
        const filename = this.configPath.split('/').pop() ?? 'subscriptions.json'
        const directory = this.configPath.split('/').slice(0, -1).join('/')

        const formData = new FormData()
        formData.append('file', new Blob([content], { type: 'application/json' }), filename)
        formData.append('root', 'config')
        formData.append('path', directory)
        formData.append('checksum', sha256(content))

        await axios.post(`${this.apiUrl}/server/files/upload`, formData)
    }

    /**
     * Merges this device into the subscription file, so that other devices
     * already listed there keep receiving notifications.
     */
    async saveToPrinter() {
        if (this.subscription === null) {
            this.$toast.error(this.$t('Settings.NotificationsTab.NoSubscription').toString())
            return
        }

        const subscriptions = await this.readSubscriptions()
        subscriptions[this.deviceName] = this.subscription
        await this.writeSubscriptions(subscriptions)
        this.$toast.success(this.$t('Settings.NotificationsTab.Saved', { path: this.configPath }).toString())
        await this.refreshDevices()
    }

    /**
     * Reads every subscribed device from the printer for display. Runs on any
     * device type -- it only reads the config file and needs no Push API -- so
     * the list can be reviewed and tidied from a desktop too.
     */
    async refreshDevices() {
        this.devicesLoading = true
        try {
            const subscriptions = await this.readSubscriptions()
            this.connectedDevices = Object.entries(subscriptions)
                .map(([name, sub]) => ({
                    name,
                    endpoint: sub.endpoint,
                    service: this.serviceLabel(sub.endpoint),
                    current: this.subscription?.endpoint === sub.endpoint,
                }))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        } catch (error: unknown) {
            window.console.error('reading the device list failed:', error)
            this.$toast.error(this.$t('Settings.NotificationsTab.DevicesReadFailed').toString())
        } finally {
            this.devicesLoading = false
        }
    }

    /**
     * Names the push service behind an endpoint, so a row reads 'Apple (Safari)'
     * rather than an opaque URL. Falls back to the host, then to a generic label.
     */
    serviceLabel(endpoint: string): string {
        let host: string
        try {
            host = new URL(endpoint).host
        } catch {
            return this.$t('Settings.NotificationsTab.ServiceGeneric').toString()
        }

        if (host.includes('apple')) return 'Apple (Safari)'
        if (host.includes('mozilla')) return 'Mozilla (Firefox)'
        if (host.includes('windows') || host.includes('microsoft')) return 'Microsoft (Edge)'
        if (host.includes('googleapis') || host.includes('fcm')) return 'Google (Chrome)'

        return host
    }

    /**
     * Removes one device from the subscription file. If it is the browser you are
     * using, the local push subscription is torn down too so the two stay in step.
     */
    async disconnectDevice(name: string) {
        this.disconnecting = name
        try {
            const subscriptions = await this.readSubscriptions()
            const wasCurrent = subscriptions[name]?.endpoint === this.subscription?.endpoint
            if (name in subscriptions) {
                delete subscriptions[name]
                await this.writeSubscriptions(subscriptions)
            }

            if (wasCurrent && this.subscription !== null) {
                try {
                    await unsubscribe()
                } catch (error: unknown) {
                    window.console.error('unsubscribing this device failed:', error)
                }
                this.subscription = null
                this.enabled = false
            }

            this.$toast.success(this.$t('Settings.NotificationsTab.Disconnected', { name }).toString())
        } catch (error: unknown) {
            window.console.error('disconnecting the device failed:', error)
            this.$toast.error(this.$t('Settings.NotificationsTab.DisconnectFailed').toString())
        } finally {
            this.disconnecting = ''
            await this.refreshDevices()
        }
    }

    /**
     * Drops this device from the subscription file so the printer stops sending
     * to an endpoint that no longer accepts anything.
     */
    async removeFromPrinter() {
        try {
            const subscriptions = await this.readSubscriptions()
            if (!(this.deviceName in subscriptions)) return

            delete subscriptions[this.deviceName]
            await this.writeSubscriptions(subscriptions)
        } catch (error: unknown) {
            window.console.error('removing the subscription failed:', error)
        } finally {
            await this.refreshDevices()
        }
    }
}
</script>

<style scoped>
.runout-hint,
.devices-hint {
    font-size: 0.8em;
    line-height: 1.3;
}
</style>
