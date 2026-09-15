<template>
    <panel
        :icon="mdiVideo2d"
        :title="$t('Panels.GcodePreviewPanel.Headline')"
        card-class="gcode-preview-panel"
        :loading="loading"
        :margin-bottom="currentPage !== 'page'">
        <template #buttons>
            <v-btn icon tile :disabled="!sdCardFilePath" @click="loadFile(true)">
                <v-icon>{{ mdiRefresh }}</v-icon>
            </v-btn>
        </template>
        <v-card-text
            :class="[
                hasFile && !error ? 'gcode-preview-content' : '',
                hasFile && !error && currentPage === 'page' ? 'gcode-preview-content--page' : '',
            ]">
            <p v-if="error" class="text-center mb-0 text--disabled">{{ error }}</p>
            <p v-else-if="!hasFile" class="text-center mb-0 text--disabled">
                {{ $t('Panels.GcodePreviewPanel.NoFile') }}
            </p>
            <template v-else>
                <div class="gcode-preview-toolbar">
                    <div class="gcode-preview-toggles">
                        <v-checkbox
                            v-model="showPrintPreview"
                            :label="$t('Panels.GcodePreviewPanel.PrintPreview')"
                            hide-details
                            dense />
                        <v-checkbox
                            v-model="showMovePath"
                            :label="$t('Panels.GcodePreviewPanel.ShowMovePath')"
                            hide-details
                            dense />
                    </div>
                    <div class="gcode-preview-layer-label">{{ layerLabel }}</div>
                </div>
                <div class="gcode-preview-chart-wrap gcode-preview-chart-wrap--clickable" @click="showDialog = true">
                    <gcode-preview-chart
                        :runs="currentLayerRuns"
                        :show-remaining="showPrintPreview"
                        :travels="showMovePath ? currentLayerTravels : []"
                        :progress-offset="fileProgressOffset"
                        :tool-position="toolPositionXY"
                        :bed-min="bedMin"
                        :bed-max="bedMax"
                        :tool-on-layer="toolOnLayer" />
                </div>
                <gcode-preview-dialog
                    v-model="showDialog"
                    :runs="currentLayerRuns"
                    :travels="showMovePath ? currentLayerTravels : []"
                    :progress-offset="fileProgressOffset"
                    :tool-position="toolPositionXY"
                    :bed-min="bedMin"
                    :bed-max="bedMax"
                    :tool-on-layer="toolOnLayer"
                    :layer-label="layerLabel"
                    :show-print-preview.sync="showPrintPreview"
                    :show-move-path.sync="showMovePath" />
            </template>
        </v-card-text>
    </panel>
</template>

<script lang="ts">
import { Component, Mixins, Prop, Watch } from 'vue-property-decorator'
import BaseMixin from '../mixins/base'
import Panel from '@/components/ui/Panel.vue'
import GcodePreviewChart from '@/components/charts/GcodePreviewChart.vue'
import GcodePreviewDialog from '@/components/dialogs/GcodePreviewDialog.vue'
import GcodePreviewWorker from './GcodePreview/gcodePreview.worker?worker'
import type { GcodePreviewWorkerOutMessage } from './GcodePreview/gcodePreview.worker'
import { distanceSqToSegment, GcodePreviewLayer, GcodePreviewRun } from './GcodePreview/parser'
import { escapePath } from '@/plugins/helpers'
import axios, { CancelTokenSource } from 'axios'
import { mdiRefresh, mdiVideo2d } from '@mdi/js'

const MAX_FILE_SIZE_BYTES = 80 * 1024 * 1024

// live Z includes bed-mesh compensation (up to a full layer height on this bed), so "at
// the layer's Z" can't be an absolute tolerance. The offset live Z - layer Z is learned
// while the nozzle is on a printed segment, and a z-hop is a rise past this fraction of
// the layer spacing above that learned offset. Mesh drift between samples is far smaller.
const LIFT_FRACTION_OF_LAYER = 0.5
const DEFAULT_LAYER_SPACING_MM = 0.2

// a candidate layer other than the current one also has to have the nozzle on one of its
// already-read printed segments - the same on-path tolerance the chart uses. Z alone isn't
// enough: a 1 mm z-hop on 0.1 mm layers lands exactly on another layer's Z.
const LAYER_XY_TOLERANCE_MM = 2
const LAYER_XY_SCAN_POINTS = 4000

@Component({
    components: { Panel, GcodePreviewChart, GcodePreviewDialog },
})
export default class GcodePreviewPanel extends Mixins(BaseMixin) {
    @Prop({ default: 'dashboard' }) declare currentPage?: string

    mdiRefresh = mdiRefresh
    mdiVideo2d = mdiVideo2d

    loading = false
    error: string | null = null
    layers: GcodePreviewLayer[] = []
    loadedFilename: string | null = null
    showDialog = false
    // the layer the nozzle was last seen printing (by live Z); null until it matches one
    liveLayerIndex: number | null = null
    // learned live Z - layer Z while on a printed segment: bed mesh plus whatever else
    // Klipper adds that the gcode doesn't know about. null until the first on-path sample
    zOffsetEstimate: number | null = null

    private worker: Worker | null = null
    private cancelTokenSource: CancelTokenSource | null = null
    private loadCounter = 0

    // both toggles persist through gui settings, so they survive a reload like the
    // rest of the dashboard's per-panel preferences
    get showPrintPreview(): boolean {
        return this.$store.state.gui.gcodePreview?.showPrintPreview ?? true
    }

    set showPrintPreview(value: boolean) {
        this.$store.dispatch('gui/saveSetting', { name: 'gcodePreview.showPrintPreview', value })
    }

    get showMovePath(): boolean {
        return this.$store.state.gui.gcodePreview?.showMovePath ?? false
    }

    set showMovePath(value: boolean) {
        this.$store.dispatch('gui/saveSetting', { name: 'gcodePreview.showMovePath', value })
    }

    get sdCardFilePath(): string {
        return this.$store.state.printer.print_stats?.filename ?? ''
    }

    get hasFile(): boolean {
        return this.layers.length > 0
    }

    // once a print isn't actively running/paused, treat the whole path as completed
    get fileProgressOffset(): number {
        if (!this.printerIsPrinting) return Number.MAX_SAFE_INTEGER

        return this.$store.state.printer.virtual_sdcard?.file_position ?? 0
    }

    // a layer's own runs are always in increasing offset order (the file is scanned
    // top to bottom), so its first/last point give the layer's offset range for free
    get layerStartOffsets(): number[] {
        return this.layers.map((layer) => layer.runs[0]?.[0]?.offset ?? 0)
    }

    // the layer the nozzle is actually on wins. The file position runs a whole lookahead
    // queue ahead of the head, so it flips to the next layer while the last perimeters of
    // this one are still being laid down - and the head then wanders over paths that
    // aren't its own. Fall back to the file position only until live Z has matched a layer.
    get currentLayerIndex(): number {
        if (this.liveLayerIndex !== null && this.liveLayerIndex < this.layers.length) return this.liveLayerIndex

        const progress = this.fileProgressOffset
        for (let i = this.layerStartOffsets.length - 1; i >= 0; i--) {
            if (progress >= this.layerStartOffsets[i]) return i
        }
        return 0
    }

    get liveZ(): number | null {
        if (!this.printerIsPrinting) return null

        return this.livePosition[2] - (this.gcodeOffset[2] ?? 0)
    }

    // smallest step between consecutive layer Zs, so the lift threshold scales with the file
    get layerSpacing(): number {
        let spacing = Number.POSITIVE_INFINITY
        for (let i = 1; i < this.layers.length; i++) {
            const step = this.layers[i].z - this.layers[i - 1].z
            if (step > 0 && step < spacing) spacing = step
        }
        return Number.isFinite(spacing) ? spacing : DEFAULT_LAYER_SPACING_MM
    }

    get liftThreshold(): number {
        return this.layerSpacing * LIFT_FRACTION_OF_LAYER
    }

    // the already-read layer whose Z the nozzle is sitting on (mesh offset removed); -1 while
    // lifted, or before the offset is known. Switching to a *different* layer also needs the
    // nozzle on one of that layer's printed segments, so a lift that happens to land on
    // another layer's Z doesn't flip the view
    findLayerAtZ(z: number): number {
        if (this.zOffsetEstimate === null) return -1

        const readLimit = this.fileProgressOffset
        const corrected = z - this.zOffsetEstimate
        let nearest = -1
        let nearestDistance = Number.POSITIVE_INFINITY
        for (let i = 0; i < this.layers.length; i++) {
            if (this.layerStartOffsets[i] > readLimit) break
            const distance = Math.abs(this.layers[i].z - corrected)
            if (distance < nearestDistance) {
                nearestDistance = distance
                nearest = i
            }
        }
        if (nearest === -1 || nearestDistance > this.liftThreshold) return -1
        if (nearest === this.liveLayerIndex) return nearest

        return this.isOnLayerPath(this.layers[nearest], this.toolPositionXY, readLimit) ? nearest : -1
    }

    isOnLayerPath(layer: GcodePreviewLayer, tool: [number, number] | null, readLimit: number): boolean {
        if (!tool) return false

        const toleranceSq = LAYER_XY_TOLERANCE_MM * LAYER_XY_TOLERANCE_MM
        let scanned = 0
        for (const run of layer.runs) {
            for (let i = 0; i + 1 < run.length && scanned < LAYER_XY_SCAN_POINTS; i++, scanned++) {
                // runs are in file order, so past the read limit nothing later is printed yet
                if (run[i].offset > readLimit) return false
                if (distanceSqToSegment(tool, run[i], run[i + 1]) <= toleranceSq) return true
            }
        }
        return false
    }

    get layerLabel(): string {
        return this.$t('Panels.GcodePreviewPanel.Layer', {
            current: this.currentLayerIndex + 1,
            total: this.layers.length,
        }).toString()
    }

    get currentLayerRuns(): GcodePreviewRun[] {
        return this.layers[this.currentLayerIndex]?.runs ?? []
    }

    get currentLayerTravels(): GcodePreviewRun[] {
        return this.layers[this.currentLayerIndex]?.travels ?? []
    }

    get bedMin(): number[] {
        return this.$store.state.printer.toolhead?.axis_minimum ?? [0, 0]
    }

    get bedMax(): number[] {
        return this.$store.state.printer.toolhead?.axis_maximum ?? [200, 200]
    }

    get gcodeOffset(): number[] {
        return this.$store.state.printer.gcode_move?.homing_origin ?? [0, 0]
    }

    get livePosition(): number[] {
        return this.$store.state.printer.motion_report?.live_position ?? [0, 0, 0, 0]
    }

    get toolPositionXY(): [number, number] | null {
        if (!this.printerIsPrinting) return null

        return [this.livePosition[0] - this.gcodeOffset[0], this.livePosition[1] - this.gcodeOffset[1]]
    }

    // the nozzle is at the drawn layer's Z, i.e. not lifted for a travel - without this the
    // chart would treat XY nearness to a printed segment as being on it
    get toolOnLayer(): boolean {
        const z = this.liveZ
        const layer = this.layers[this.currentLayerIndex]
        if (z === null || !layer || this.zOffsetEstimate === null) return false

        return Math.abs(z - layer.z - this.zOffsetEstimate) <= this.liftThreshold
    }

    @Watch('sdCardFilePath')
    sdCardFilePathChanged(newVal: string): void {
        if (newVal === '' || !this.printerIsPrinting) return

        this.loadFile()
    }

    // print_stats.filename survives the end of a job, so without this the panel keeps
    // showing the finished file's toolpath - and reloads it on mount - until the next
    // print starts. A job that stops for any reason clears the preview instead.
    @Watch('liveZ')
    liveZChanged(z: number | null): void {
        if (z === null) {
            this.liveLayerIndex = null
            this.zOffsetEstimate = null
            return
        }

        this.learnZOffset(z)
        const index = this.findLayerAtZ(z)
        if (index !== -1) this.liveLayerIndex = index
    }

    // while the nozzle is on a printed segment of the drawn layer, live Z - layer Z is the
    // mesh plus whatever else Klipper adds. Track it, but never learn from a rise bigger
    // than the lift threshold - that's a z-hop, not the bed. A wrong first sample (taken
    // mid-hop) corrects itself on the next on-path one, since a drop is always accepted.
    learnZOffset(z: number): void {
        const layer = this.layers[this.currentLayerIndex]
        if (!layer || !this.isOnLayerPath(layer, this.toolPositionXY, this.fileProgressOffset)) return

        const observed = z - layer.z
        if (this.zOffsetEstimate !== null && observed - this.zOffsetEstimate > this.liftThreshold) return

        this.zOffsetEstimate = observed
    }

    @Watch('printerIsPrinting')
    printerIsPrintingChanged(isPrinting: boolean): void {
        if (isPrinting) {
            if (this.sdCardFilePath) this.loadFile()
            return
        }

        this.clearPreview()
    }

    mounted(): void {
        if (this.printerIsPrinting && this.sdCardFilePath) this.loadFile()
    }

    beforeDestroy(): void {
        this.cancelTokenSource?.cancel('component destroyed')
        this.worker?.terminate()
    }

    private clearPreview(): void {
        // bump the load id so an in-flight download or worker result can't repopulate it
        this.loadCounter++
        this.cancelTokenSource?.cancel('print ended')
        this.worker?.terminate()
        this.worker = null

        this.layers = []
        this.liveLayerIndex = null
        this.zOffsetEstimate = null
        this.loadedFilename = null
        this.error = null
        this.loading = false
        this.showDialog = false
    }

    async loadFile(force = false): Promise<void> {
        const filename = this.sdCardFilePath
        if (!filename) return
        if (!force && filename === this.loadedFilename) return

        this.cancelTokenSource?.cancel('superseded by newer load')
        this.worker?.terminate()
        this.worker = null

        this.loading = true
        this.error = null
        this.layers = []
        this.liveLayerIndex = null
        this.zOffsetEstimate = null

        // cancelling can't call back an already-fulfilled request, so every load carries
        // an id and anything that isn't the newest one is dropped on arrival
        const loadId = ++this.loadCounter
        const cancelTokenSource = axios.CancelToken.source()
        this.cancelTokenSource = cancelTokenSource
        const url = this.apiUrl + '/server/files/' + escapePath('gcodes/' + filename)

        try {
            // check the size before pulling the body down, so an oversized file isn't
            // buffered into memory just to be rejected afterwards
            const head = await axios.head(url, { cancelToken: cancelTokenSource.token })
            if (loadId !== this.loadCounter) return

            const contentLength = Number(head.headers['content-length'] ?? 0)
            if (contentLength > MAX_FILE_SIZE_BYTES) {
                this.error = this.$t('Panels.GcodePreviewPanel.FileTooLarge').toString()
                this.loading = false
                return
            }

            const response = await axios.get<string>(url, {
                cancelToken: cancelTokenSource.token,
                responseType: 'text',
            })
            if (loadId !== this.loadCounter) return

            if (response.data.length > MAX_FILE_SIZE_BYTES) {
                this.error = this.$t('Panels.GcodePreviewPanel.FileTooLarge').toString()
                this.loading = false
                return
            }

            this.parseInWorker(response.data, filename, loadId)
        } catch (e) {
            if (axios.isCancel(e) || loadId !== this.loadCounter) return

            this.error = this.$t('Panels.GcodePreviewPanel.LoadError').toString()
            this.loading = false
        }
    }

    private parseInWorker(text: string, filename: string, loadId = this.loadCounter): void {
        const bedSizeMm = Math.max(this.bedMax[0] - this.bedMin[0], this.bedMax[1] - this.bedMin[1])

        const worker = new GcodePreviewWorker()
        this.worker = worker

        worker.onmessage = (event: MessageEvent<GcodePreviewWorkerOutMessage>) => {
            // a worker from a superseded load must not overwrite the current preview
            if (loadId !== this.loadCounter) {
                worker.terminate()
                return
            }

            if (event.data.type === 'result') {
                // frozen: a sliced file is easily 100k+ points, and Vue would otherwise
                // deep-walk every one of them installing reactivity we never need - the
                // parsed result is replaced wholesale, never mutated in place
                this.layers = Object.freeze(event.data.layers) as GcodePreviewLayer[]
                this.loadedFilename = filename
            } else {
                this.error = event.data.message
            }

            this.loading = false
            worker.terminate()
            if (this.worker === worker) this.worker = null
        }

        worker.postMessage({ type: 'parse', text, bedSizeMm })
    }
}
</script>

<style scoped>
.gcode-preview-content {
    padding: 10px;
}

/* on the dedicated page, fit the panel to the viewport instead of letting the bed's
   aspect ratio push the page taller than the screen - the toolbar row above the chart
   is a fixed-size flex item, so the chart wrap gets whatever height remains regardless
   of the toolbar's own size */
.gcode-preview-content--page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 148px);
    box-sizing: border-box;
}

.gcode-preview-chart-wrap {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.gcode-preview-chart-wrap--clickable {
    cursor: pointer;
}

/* the whole row stays on one line at dashboard column width: nothing wraps, and the
   labels shrink rather than pushing the layer badge onto a second line */
.gcode-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    flex: 0 0 auto;
    flex-wrap: nowrap;
    gap: 8px;
}

.gcode-preview-toggles {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.gcode-preview-toolbar ::v-deep .v-input--checkbox {
    margin-top: 0;
    padding-top: 0;
}

.gcode-preview-toolbar ::v-deep .v-label {
    font-size: 0.75rem;
    white-space: nowrap;
}

.gcode-preview-toolbar ::v-deep .v-input--selection-controls__input {
    margin-right: 4px;
}

.gcode-preview-toolbar ::v-deep .v-input--selection-controls__input .v-icon {
    font-size: 18px;
}

.gcode-preview-layer-label {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: nowrap;
    flex: 0 0 auto;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
}
</style>
