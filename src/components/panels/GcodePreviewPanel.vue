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
                    <v-checkbox
                        v-model="showMovePath"
                        :label="$t('Panels.GcodePreviewPanel.ShowMovePath')"
                        hide-details
                        dense />
                    <div class="gcode-preview-layer-label">
                        {{
                            $t('Panels.GcodePreviewPanel.Layer', {
                                current: currentLayerIndex + 1,
                                total: layers.length,
                            })
                        }}
                    </div>
                </div>
                <div class="gcode-preview-chart-wrap">
                    <gcode-preview-chart
                        :runs="currentLayerRuns"
                        :travels="showMovePath ? currentLayerTravels : []"
                        :progress-offset="fileProgressOffset"
                        :tool-position="toolPositionXY"
                        :bed-min="bedMin"
                        :bed-max="bedMax" />
                </div>
            </template>
        </v-card-text>
    </panel>
</template>

<script lang="ts">
import { Component, Mixins, Prop, Watch } from 'vue-property-decorator'
import BaseMixin from '../mixins/base'
import Panel from '@/components/ui/Panel.vue'
import GcodePreviewChart from '@/components/charts/GcodePreviewChart.vue'
import GcodePreviewWorker from './GcodePreview/gcodePreview.worker?worker'
import type { GcodePreviewWorkerOutMessage } from './GcodePreview/gcodePreview.worker'
import { GcodePreviewLayer, GcodePreviewPoint, GcodePreviewRun } from './GcodePreview/parser'
import { generateDemoGcode } from './GcodePreview/demoGcode'
import { escapePath } from '@/plugins/helpers'
import axios, { CancelTokenSource } from 'axios'
import { mdiRefresh, mdiVideo2d } from '@mdi/js'

const MAX_FILE_SIZE_BYTES = 80 * 1024 * 1024

@Component({
    components: { Panel, GcodePreviewChart },
})
export default class GcodePreviewPanel extends Mixins(BaseMixin) {
    @Prop({ default: 'dashboard' }) declare currentPage?: string

    mdiRefresh = mdiRefresh
    mdiVideo2d = mdiVideo2d

    loading = false
    error: string | null = null
    layers: GcodePreviewLayer[] = []
    loadedFilename: string | null = null
    showMovePath = false

    private worker: Worker | null = null
    private cancelTokenSource: CancelTokenSource | null = null

    // ===== DEMO MODE (screenshot only) - remove before commit =====
    private demoTimer: number | null = null
    private demoFlatPoints: GcodePreviewPoint[] = []
    private demoPointIndex = 0
    demoProgressOffset = 0
    demoToolPosition: [number, number] | null = null

    get demoMode(): boolean {
        return 'demo' in this.$route.query
    }

    private loadDemoFile(): void {
        this.loading = true
        this.error = null
        this.layers = []
        this.parseInWorker(generateDemoGcode(), 'demo_preview.gcode')
    }

    @Watch('layers')
    onDemoLayersChanged(newLayers: GcodePreviewLayer[]): void {
        if (this.demoMode && newLayers.length > 0 && this.demoTimer === null) this.startDemoAnimation()
    }

    private startDemoAnimation(): void {
        this.demoFlatPoints = this.layers.flatMap((layer) => layer.runs.flat())
        if (this.demoFlatPoints.length === 0) return

        const maxOffset = this.demoFlatPoints[this.demoFlatPoints.length - 1].offset
        const durationMs = 20000
        const startTime = Date.now()

        this.demoTimer = window.setInterval(() => {
            const elapsed = Date.now() - startTime
            const loopElapsed = elapsed % durationMs
            if (loopElapsed < 100) this.demoPointIndex = 0

            const targetOffset = (loopElapsed / durationMs) * maxOffset
            this.demoProgressOffset = targetOffset

            while (
                this.demoPointIndex < this.demoFlatPoints.length - 1 &&
                this.demoFlatPoints[this.demoPointIndex + 1].offset <= targetOffset
            ) {
                this.demoPointIndex++
            }
            const point = this.demoFlatPoints[this.demoPointIndex]
            this.demoToolPosition = [point.x, point.y]
        }, 100)
    }
    // ===== END DEMO MODE =====

    get sdCardFilePath(): string {
        return this.$store.state.printer.print_stats?.filename ?? ''
    }

    get hasFile(): boolean {
        return this.layers.length > 0
    }

    // once a print isn't actively running/paused, treat the whole path as completed
    get fileProgressOffset(): number {
        if (this.demoMode) return this.demoProgressOffset
        if (!this.printerIsPrinting) return Number.MAX_SAFE_INTEGER

        return this.$store.state.printer.virtual_sdcard?.file_position ?? 0
    }

    // a layer's own runs are always in increasing offset order (the file is scanned
    // top to bottom), so its first/last point give the layer's offset range for free
    get layerStartOffsets(): number[] {
        return this.layers.map((layer) => layer.runs[0]?.[0]?.offset ?? 0)
    }

    // which layer is "current" is derived from the same progress value used for the
    // done/remaining split - the layer whose extrusion starts at or before the current
    // file position is the one actively being (or last) printed
    get currentLayerIndex(): number {
        const progress = this.fileProgressOffset
        for (let i = this.layerStartOffsets.length - 1; i >= 0; i--) {
            if (progress >= this.layerStartOffsets[i]) return i
        }
        return 0
    }

    get currentLayerRuns(): GcodePreviewRun[] {
        return this.layers[this.currentLayerIndex]?.runs ?? []
    }

    get currentLayerTravels(): GcodePreviewRun[] {
        return this.layers[this.currentLayerIndex]?.travels ?? []
    }

    get bedMin(): number[] {
        if (this.demoMode) return [0, 0]
        return this.$store.state.printer.toolhead?.axis_minimum ?? [0, 0]
    }

    get bedMax(): number[] {
        if (this.demoMode) return [250, 250]
        return this.$store.state.printer.toolhead?.axis_maximum ?? [200, 200]
    }

    get gcodeOffset(): number[] {
        return this.$store.state.printer.gcode_move?.homing_origin ?? [0, 0]
    }

    get livePosition(): number[] {
        return this.$store.state.printer.motion_report?.live_position ?? [0, 0, 0, 0]
    }

    get toolPositionXY(): [number, number] | null {
        if (this.demoMode) return this.demoToolPosition
        if (!this.printerIsPrinting) return null

        return [this.livePosition[0] - this.gcodeOffset[0], this.livePosition[1] - this.gcodeOffset[1]]
    }

    @Watch('sdCardFilePath')
    sdCardFilePathChanged(newVal: string): void {
        if (newVal === '') return

        this.loadFile()
    }

    mounted(): void {
        if (this.demoMode) {
            this.loadDemoFile()
            return
        }
        if (this.sdCardFilePath) this.loadFile()
    }

    beforeDestroy(): void {
        this.cancelTokenSource?.cancel('component destroyed')
        this.worker?.terminate()
        if (this.demoTimer !== null) window.clearInterval(this.demoTimer)
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

        const cancelTokenSource = axios.CancelToken.source()
        this.cancelTokenSource = cancelTokenSource

        try {
            const response = await axios.get<string>(
                this.apiUrl + '/server/files/' + escapePath('gcodes/' + filename),
                { cancelToken: cancelTokenSource.token, responseType: 'text' }
            )

            if (response.data.length > MAX_FILE_SIZE_BYTES) {
                this.error = this.$t('Panels.GcodePreviewPanel.FileTooLarge').toString()
                this.loading = false
                return
            }

            this.parseInWorker(response.data, filename)
        } catch (e) {
            if (axios.isCancel(e)) return

            this.error = this.$t('Panels.GcodePreviewPanel.LoadError').toString()
            this.loading = false
        }
    }

    private parseInWorker(text: string, filename: string): void {
        const bedSizeMm = Math.max(this.bedMax[0] - this.bedMin[0], this.bedMax[1] - this.bedMin[1])

        const worker = new GcodePreviewWorker()
        this.worker = worker

        worker.onmessage = (event: MessageEvent<GcodePreviewWorkerOutMessage>) => {
            if (event.data.type === 'result') {
                this.layers = event.data.layers
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

.gcode-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    flex: 0 0 auto;
}

.gcode-preview-toolbar ::v-deep .v-input--checkbox {
    margin-top: 0;
    padding-top: 0;
}

.gcode-preview-layer-label {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
}
</style>
