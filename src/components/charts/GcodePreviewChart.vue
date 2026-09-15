<template>
    <svg
        version="1.1"
        xmlns="http://www.w3.org/2000/svg"
        :viewBox="viewBox"
        preserveAspectRatio="xMidYMid meet"
        class="gcode-preview-svg"
        :style="{ aspectRatio: `${bedWidth} / ${bedHeight}` }">
        <rect
            :x="bedMin[0]"
            :y="convertY(bedMax[1])"
            :width="bedWidth"
            :height="bedHeight"
            fill="none"
            :stroke="fgColorLow"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <line
            v-for="x in xGridLines"
            :key="'x' + x"
            :x1="x"
            :x2="x"
            :y1="convertY(bedMin[1])"
            :y2="convertY(bedMax[1])"
            :stroke="fgColorFaint"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <line
            v-for="y in yGridLines"
            :key="'y' + y"
            :x1="bedMin[0]"
            :x2="bedMax[0]"
            :y1="convertY(y)"
            :y2="convertY(y)"
            :stroke="fgColorFaint"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <line
            v-if="hasXAxis"
            :x1="0"
            :x2="0"
            :y1="convertY(bedMin[1])"
            :y2="convertY(bedMax[1])"
            stroke="#e53935"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <line
            v-if="hasYAxis"
            :x1="bedMin[0]"
            :x2="bedMax[0]"
            :y1="convertY(0)"
            :y2="convertY(0)"
            stroke="#43a047"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <path
            :d="travelPath"
            fill="none"
            stroke="#ffd600"
            stroke-width="1"
            stroke-dasharray="2,2"
            vector-effect="non-scaling-stroke" />
        <path
            v-if="showRemaining"
            :d="remainingPath"
            fill="none"
            stroke="#9e9e9e"
            stroke-width="1"
            vector-effect="non-scaling-stroke" />
        <path :d="donePath" fill="none" :stroke="primaryColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        <circle
            v-if="toolPosition"
            class="gcode-preview-tool"
            :cx="toolPosition[0]"
            :cy="convertY(toolPosition[1])"
            r="1.8"
            fill="#ff9100"
            vector-effect="non-scaling-stroke" />
    </svg>
</template>

<script lang="ts">
import { Component, Mixins, Prop, Watch } from 'vue-property-decorator'
import BaseMixin from '@/components/mixins/base'
import ThemeMixin from '@/components/mixins/theme'
import throttle from 'lodash.throttle'
import { defaultPrimaryColor } from '@/store/variables'
import { GcodePreviewPoint, GcodePreviewRun } from '@/components/panels/GcodePreview/parser'

const PROGRESS_THROTTLE_MS = 500
const GRID_SPACING_MM = 25

// how far back from the file position to look for the segment the toolhead is on - big
// enough to cover Klipper's lookahead queue, small enough that a path crossing its own
// earlier track can't match something from the far side of the layer
const TOOLHEAD_LOOKBACK_POINTS = 4000

// how far the nozzle may sit from the nearest extrusion segment and still count as being
// on it. Anything further means it's off the path - mid-travel, or parked for a pause -
// where drawing the line out to it would cut a false stroke across the part.
const ON_PATH_TOLERANCE_MM = 2

@Component
export default class GcodePreviewChart extends Mixins(BaseMixin, ThemeMixin) {
    @Prop({ type: Array, required: true }) declare readonly runs: GcodePreviewRun[]
    @Prop({ type: Array, required: false, default: () => [] }) declare readonly travels: GcodePreviewRun[]
    @Prop({ type: Boolean, required: false, default: true }) declare readonly showRemaining: boolean
    @Prop({ type: Number, required: true }) declare readonly progressOffset: number
    @Prop({ type: Array, required: false, default: null }) declare readonly toolPosition: [number, number] | null
    @Prop({ type: Array, required: true }) declare readonly bedMin: number[]
    @Prop({ type: Array, required: true }) declare readonly bedMax: number[]

    throttledProgressOffset = 0

    // built in created(), not as a class-field initializer - a class field's arrow function
    // captures `this` before vue-class-component finishes wiring up the reactive instance, so
    // assignments from inside it silently miss reactivity.
    private setThrottledProgressOffset: ((value: number) => void) & { cancel(): void } = throttle(() => {}, 0)

    get primaryColor() {
        return this.$store.state.gui.theme?.primary ?? defaultPrimaryColor
    }

    get bedWidth() {
        return this.bedMax[0] - this.bedMin[0]
    }

    get bedHeight() {
        return this.bedMax[1] - this.bedMin[1]
    }

    get viewBox() {
        return `${this.bedMin[0]} ${this.convertY(this.bedMax[1])} ${this.bedWidth} ${this.bedHeight}`
    }

    get xGridLines(): number[] {
        return this.gridLines(this.bedMin[0], this.bedMax[0]).filter((value) => value !== 0)
    }

    get yGridLines(): number[] {
        return this.gridLines(this.bedMin[1], this.bedMax[1]).filter((value) => value !== 0)
    }

    get hasXAxis(): boolean {
        return this.bedMin[0] <= 0 && this.bedMax[0] >= 0
    }

    get hasYAxis(): boolean {
        return this.bedMin[1] <= 0 && this.bedMax[1] >= 0
    }

    get donePath(): string {
        return this.splitRuns.done.map((run) => this.runToSubpath(run)).join(' ')
    }

    get remainingPath(): string {
        return this.splitRuns.remaining.map((run) => this.runToSubpath(run)).join(' ')
    }

    // only the portion already traveled is shown - the dashed line should trail the
    // toolhead marker, not reveal moves that haven't happened yet
    get travelPath(): string {
        return this.splitByProgress(this.travels)
            .done.map((run) => this.runToSubpath(run))
            .join(' ')
    }

    get splitRuns(): { done: GcodePreviewRun[]; remaining: GcodePreviewRun[] } {
        return this.splitByProgress(this.runs, this.toolheadCut.anchor)
    }

    // virtual_sdcard.file_position is where Klipper has *read* to, and it runs ahead of the
    // nozzle by the whole lookahead queue - drawing to it puts the printed line visibly in
    // front of the toolhead marker. Anchor the cut to the live position instead: walk back
    // from the file position to the already-read *segment* the head is on, cut at that
    // segment's start, and carry the line through to the head itself. It has to be the
    // nearest segment, not the nearest vertex: on a long straight move the nearest vertex
    // can be the far end of the segment, tens of millimetres ahead of the nozzle.
    get toolheadCut(): { offset: number; anchor: [number, number] | null } {
        const fileOffset = this.throttledProgressOffset
        const tool = this.toolPosition
        if (!tool) return { offset: fileOffset, anchor: null }

        let bestOffset = -1
        let bestDistance = Number.POSITIVE_INFINITY
        let scanned = 0

        for (let r = this.runs.length - 1; r >= 0 && scanned < TOOLHEAD_LOOKBACK_POINTS; r--) {
            const run = this.runs[r]
            for (let i = run.length - 2; i >= 0 && scanned < TOOLHEAD_LOOKBACK_POINTS; i--) {
                const start = run[i]
                if (start.offset > fileOffset) continue

                scanned++
                const distance = this.distanceSqToSegment(tool, start, run[i + 1])
                if (distance < bestDistance) {
                    bestDistance = distance
                    bestOffset = start.offset
                }
            }
        }

        if (bestOffset === -1) return { offset: fileOffset, anchor: null }

        const onPath = bestDistance <= ON_PATH_TOLERANCE_MM * ON_PATH_TOLERANCE_MM
        return { offset: bestOffset, anchor: onPath ? tool : null }
    }

    splitByProgress(
        runs: GcodePreviewRun[],
        anchor: [number, number] | null = null
    ): { done: GcodePreviewRun[]; remaining: GcodePreviewRun[] } {
        const done: GcodePreviewRun[] = []
        const remaining: GcodePreviewRun[] = []
        const progress = this.toolheadCut.offset
        let anchored = false

        for (const run of runs) {
            const splitIndex = run.findIndex((point) => point.offset > progress)

            if (splitIndex === -1) {
                done.push(run)
                continue
            }

            if (splitIndex === 0) {
                remaining.push(run)
                continue
            }

            // the done half ends at the last read vertex, never one past it - "one past" on
            // a long straight move is the far end of the segment, well ahead of the head
            const doneRun = run.slice(0, splitIndex)
            if (anchor && !anchored) {
                doneRun.push({ x: anchor[0], y: anchor[1], offset: progress })
                anchored = true
            }
            done.push(doneRun)
            remaining.push(run.slice(splitIndex - 1))
        }

        return { done, remaining }
    }

    distanceSqToSegment(point: [number, number], a: GcodePreviewPoint, b: GcodePreviewPoint): number {
        const abx = b.x - a.x
        const aby = b.y - a.y
        const apx = point[0] - a.x
        const apy = point[1] - a.y
        const lengthSq = abx * abx + aby * aby
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSq))
        const dx = apx - t * abx
        const dy = apy - t * aby

        return dx * dx + dy * dy
    }

    @Watch('progressOffset', { immediate: true })
    progressOffsetChanged(newVal: number): void {
        this.setThrottledProgressOffset(newVal)
    }

    created(): void {
        this.setThrottledProgressOffset = throttle((value: number) => {
            this.throttledProgressOffset = value
        }, PROGRESS_THROTTLE_MS)
        // the immediate watcher above already fired, into the placeholder - take the
        // current value now, or a progress that never changes again (an idle or finished
        // print) would leave the whole path drawn as not-yet-printed
        this.throttledProgressOffset = this.progressOffset
    }

    beforeDestroy(): void {
        this.setThrottledProgressOffset.cancel()
    }

    convertY(y: number): number {
        return y * -1
    }

    gridLines(min: number, max: number): number[] {
        const lines: number[] = []
        const start = Math.ceil(min / GRID_SPACING_MM) * GRID_SPACING_MM

        for (let value = start; value < max; value += GRID_SPACING_MM) {
            lines.push(value)
        }

        return lines
    }

    runToSubpath(run: GcodePreviewRun): string {
        if (run.length === 0) return ''

        return 'M ' + run.map((point) => `${point.x} ${this.convertY(point.y)}`).join(' L ')
    }
}
</script>

<style scoped>
.gcode-preview-svg {
    display: block;
    width: 100%;
    height: auto;
    /* a percentage max-height only resolves against a definite parent height - on the
       dedicated page (GcodePreviewPanel.vue's flex chart-wrap) that caps it to the
       viewport; on the dashboard, where the wrap's height is just auto, it's a no-op */
    max-width: 100%;
    max-height: 100%;
    margin: 0 auto;
}
</style>
