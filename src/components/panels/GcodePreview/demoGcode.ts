/**
 * Generates a small synthetic multi-layer G-code file for the "?demo=1" preview mode -
 * five layers, each three separate island shapes (so there are real travel moves between
 * them), cycling through a hexagon/square/octagon so a layer change is visually obvious.
 * Lives in code rather than as an uploaded file so the demo doesn't depend on any
 * particular printer having a specific file on its SD storage.
 */

const CENTER_X = 125
const CENTER_Y = 125
const LAYER_COUNT = 5
const LAYER_HEIGHT_MM = 0.2
const ISLAND_OFFSETS: [number, number][] = [
    [0, -55],
    [-55, 35],
    [55, 35],
]

type Point = [number, number]

export function generateDemoGcode(): string {
    const lines: string[] = [
        '; synthetic 5-layer demo gcode for the G-Code Preview panel (multi-island layers, centered)',
        'G90',
        'M82',
        'G92 E0',
    ]

    let e = 0
    const fmt = (n: number): string => n.toFixed(2)

    const travelTo = (x: number, y: number, z: number | null): void => {
        lines.push(z === null ? `G0 X${fmt(x)} Y${fmt(y)} F6000` : `G0 X${fmt(x)} Y${fmt(y)} Z${fmt(z)} F6000`)
    }

    const extrudeTo = (x: number, y: number): void => {
        e += 1
        lines.push(`G1 X${fmt(x)} Y${fmt(y)} E${e.toFixed(4)} F1200`)
    }

    const emitIsland = (points: Point[], z: number | null): void => {
        travelTo(points[0][0], points[0][1], z)
        for (let i = 1; i < points.length; i++) extrudeTo(points[i][0], points[i][1])
    }

    const polygonIsland = (cx: number, cy: number, r: number, sides: number, z: number | null, loops: number): void => {
        for (let loop = 0; loop < loops; loop++) {
            const rr = r - loop * 3
            const points: Point[] = []
            for (let i = 0; i <= sides; i++) {
                const angle = (2 * Math.PI * i) / sides
                points.push([cx + rr * Math.cos(angle), cy + rr * Math.sin(angle)])
            }
            emitIsland(points, loop === 0 ? z : null)
        }
    }

    const squareIsland = (cx: number, cy: number, half: number, z: number | null, loops: number): void => {
        for (let loop = 0; loop < loops; loop++) {
            const h = half - loop * 3
            const points: Point[] = [
                [cx - h, cy - h],
                [cx + h, cy - h],
                [cx + h, cy + h],
                [cx - h, cy + h],
                [cx - h, cy - h],
            ]
            emitIsland(points, loop === 0 ? z : null)
        }
    }

    // sparse back-and-forth infill within a safe inset of the perimeter - the z is
    // already whatever the perimeter loops just set, so it never needs one of its own
    const infillLines = (cx: number, cy: number, halfExtent: number, spacing: number): void => {
        let leftToRight = true
        for (let y = cy - halfExtent; y <= cy + halfExtent; y += spacing) {
            const xStart = leftToRight ? cx - halfExtent : cx + halfExtent
            const xEnd = leftToRight ? cx + halfExtent : cx - halfExtent
            travelTo(xStart, y, null)
            extrudeTo(xEnd, y)
            leftToRight = !leftToRight
        }
    }

    const INFILL_SPACING_MM = 5

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
        const z = LAYER_HEIGHT_MM * (layer + 1)
        const shape = layer % 3

        ISLAND_OFFSETS.forEach(([dx, dy], islandIndex) => {
            const cx = CENTER_X + dx
            const cy = CENTER_Y + dy
            const layerZ = islandIndex === 0 ? z : null

            if (shape === 0) {
                polygonIsland(cx, cy, 22, 6, layerZ, 2)
                infillLines(cx, cy, 22 * Math.cos(Math.PI / 6) * 0.8, INFILL_SPACING_MM)
            } else if (shape === 1) {
                squareIsland(cx, cy, 20, layerZ, 2)
                infillLines(cx, cy, 20 * 0.8, INFILL_SPACING_MM)
            } else {
                polygonIsland(cx, cy, 22, 8, layerZ, 2)
                infillLines(cx, cy, 22 * Math.cos(Math.PI / 8) * 0.8, INFILL_SPACING_MM)
            }
        })
    }

    lines.push(`G0 X${CENTER_X} Y${CENTER_Y} F6000`)
    lines.push('M400')

    return lines.join('\n') + '\n'
}
