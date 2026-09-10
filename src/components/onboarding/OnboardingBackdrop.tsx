import { useMemo } from 'react'

function wavyRingPath(baseR: number, amplitude: number, waves: number, steps: number): string {
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const θ = (i / steps) * 2 * Math.PI
    const r = baseR + amplitude * Math.sin(waves * θ)
    pts.push(`${(r * Math.cos(θ)).toFixed(1)},${(r * Math.sin(θ)).toFixed(1)}`)
  }
  return `M ${pts[0]} L ${pts.slice(1).join(' ')} Z`
}

/** Two wave-groups with coprime frequencies create the classic guilloche interference. */
const GUILLOCHE_GROUPS = [
  { waves: 5, amplitude: 18, rMin: 40, rMax: 270, spacing: 11, dur: 180, rev: false },
  { waves: 7, amplitude: 14, rMin: 45, rMax: 265, spacing: 11, dur: 240, rev: true },
] as const

export function GuillocheBackground() {
  const groups = useMemo(
    () => GUILLOCHE_GROUPS.map((g) => {
      const paths: string[] = []
      for (let r = g.rMin; r <= g.rMax; r += g.spacing) {
        paths.push(wavyRingPath(r, g.amplitude, g.waves, 120))
      }
      return paths
    }),
    [],
  )

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none animate-guilloche-breathe" aria-hidden="true">
      {/* Each wave group is its own <svg> and the rotation animates the <svg>
          element itself (an HTML box the browser composites), never an inner
          SVG <g> — Firefox re-tessellates and repaints the whole SVG every
          frame when inner elements are transform-animated (#36). The radial
          fade mask is rotationally symmetric, so it can spin with its group;
          `overflow-visible` keeps box-edge clipping from sweeping into view
          as the rectangle rotates (the pattern already fades out radially). */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[140%] h-[140%]">
        {GUILLOCHE_GROUPS.map((group, gi) => (
          <svg
            key={gi}
            className={`absolute inset-0 h-full w-full overflow-visible ${
              group.rev ? 'animate-guilloche-reverse' : 'animate-guilloche'
            }`}
            style={{ animationDuration: `${group.dur}s` }}
            viewBox="-300 -300 600 600"
            preserveAspectRatio="xMidYMid slice"
          >
            <defs>
              <radialGradient id={`g-fade-${gi}`}>
                <stop offset="0%" stopColor="white" stopOpacity="1" />
                <stop offset="50%" stopColor="white" stopOpacity="0.6" />
                <stop offset="100%" stopColor="white" stopOpacity="0" />
              </radialGradient>
              <mask id={`g-mask-${gi}`}>
                <rect x="-300" y="-300" width="600" height="600" fill={`url(#g-fade-${gi})`} />
              </mask>
            </defs>
            <g mask={`url(#g-mask-${gi})`}>
              {groups[gi].map((d, ri) => (
                <path
                  key={ri}
                  d={d}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="0.4"
                  strokeOpacity="0.06"
                />
              ))}
            </g>
          </svg>
        ))}
      </div>
    </div>
  )
}
