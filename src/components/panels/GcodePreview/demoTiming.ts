/**
 * Demo-mode only: builds a coarse "time -> byte offset" timeline for a G-code file so the
 * demo can advance at the file's actual print speed instead of an arbitrary fixed sweep.
 *
 * Move durations come from each move's distance divided by the active feedrate, which
 * ignores acceleration and so underestimates the real time. When the slicer's own
 * estimate is known (Moonraker's `estimated_time` metadata), the whole timeline is scaled
 * to match it, which lines the demo up with the print time the file itself advertises.
 *
 * Not part of the preview feature - the real panel gets its progress from Moonraker's
 * virtual_sdcard.file_position, not from a simulated clock.
 */

export interface DemoTimelinePoint {
    /** byte offset into the file */
    offset: number
    /** seconds since the start of the print */
    t: number
}

const DEFAULT_FEEDRATE_MM_S = 50
const MOVES_PER_CHECKPOINT = 100

export function buildDemoTimeline(text: string, estimatedTotalSeconds?: number): DemoTimelinePoint[] {
    const timeline: DemoTimelinePoint[] = [{ offset: 0, t: 0 }]

    let x = 0
    let y = 0
    let z = 0
    let relative = false
    let feedrateMmS = DEFAULT_FEEDRATE_MM_S
    let seconds = 0
    let offset = 0
    let movesSinceCheckpoint = 0

    for (const rawLine of text.split('\n')) {
        const startOffset = offset
        offset += rawLine.length + 1

        const semiIndex = rawLine.indexOf(';')
        const line = (semiIndex === -1 ? rawLine : rawLine.slice(0, semiIndex)).trim()
        if (!line) continue

        const tokens = line.split(' ')
        const command = tokens[0].toUpperCase()

        if (command === 'G90') {
            relative = false
            continue
        }
        if (command === 'G91') {
            relative = true
            continue
        }
        if (command !== 'G0' && command !== 'G1') continue

        let newX = x
        let newY = y
        let newZ = z

        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i]
            if (token.length < 2) continue

            const value = parseFloat(token.slice(1))
            if (Number.isNaN(value)) continue

            switch (token[0].toUpperCase()) {
                case 'X':
                    newX = relative ? x + value : value
                    break
                case 'Y':
                    newY = relative ? y + value : value
                    break
                case 'Z':
                    newZ = relative ? z + value : value
                    break
                case 'F':
                    feedrateMmS = Math.max(value / 60, 1)
                    break
            }
        }

        const dx = newX - x
        const dy = newY - y
        const dz = newZ - z
        x = newX
        y = newY
        z = newZ

        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (distance > 0) seconds += distance / feedrateMmS

        movesSinceCheckpoint++
        if (movesSinceCheckpoint >= MOVES_PER_CHECKPOINT) {
            timeline.push({ offset: startOffset, t: seconds })
            movesSinceCheckpoint = 0
        }
    }

    timeline.push({ offset, t: seconds })

    // stretch/squash onto the slicer's own estimate when we have it, so the demo runs at
    // the print time the file advertises rather than our acceleration-free approximation
    if (estimatedTotalSeconds && estimatedTotalSeconds > 0 && seconds > 0) {
        const scale = estimatedTotalSeconds / seconds
        for (const point of timeline) point.t *= scale
    }

    return timeline
}

/** byte offset reached at `seconds` into the print, linearly interpolated between checkpoints */
export function offsetAtTime(timeline: DemoTimelinePoint[], seconds: number): number {
    if (timeline.length === 0) return 0

    const last = timeline[timeline.length - 1]
    if (seconds >= last.t) return last.offset

    let low = 0
    let high = timeline.length - 1
    while (low < high - 1) {
        const mid = (low + high) >> 1
        if (timeline[mid].t <= seconds) low = mid
        else high = mid
    }

    const a = timeline[low]
    const b = timeline[high]
    const span = b.t - a.t
    if (span <= 0) return a.offset

    return a.offset + ((seconds - a.t) / span) * (b.offset - a.offset)
}

/** total seconds the timeline covers */
export function timelineDuration(timeline: DemoTimelinePoint[]): number {
    return timeline.length ? timeline[timeline.length - 1].t : 0
}
