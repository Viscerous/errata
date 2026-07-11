import { diamondPoints, hexagonPoints, type Bubble } from '@/lib/fragment-visuals'

export function FragmentBubbleShape({ bubble }: { bubble: Bubble }) {
  const b = bubble
  const transform = b.shape !== 'circle' ? `rotate(${b.rotation} ${b.cx} ${b.cy})` : undefined
  switch (b.shape) {
    case 'rounded-rect':
      return <rect x={b.cx - b.r * 0.8} y={b.cy - b.r * 0.6} width={b.r * 1.6} height={b.r * 1.2} rx={b.r * 0.2} fill={b.color} opacity={b.opacity} transform={transform} />
    case 'hexagon':
      return <polygon points={hexagonPoints(b.cx, b.cy, b.r)} fill={b.color} opacity={b.opacity} transform={transform} />
    case 'ellipse':
      return <ellipse cx={b.cx} cy={b.cy} rx={b.r * 1.2} ry={b.r * 0.7} fill={b.color} opacity={b.opacity} transform={transform} />
    case 'diamond':
      return <polygon points={diamondPoints(b.cx, b.cy, b.r)} fill={b.color} opacity={b.opacity} transform={transform} />
    default:
      return <circle cx={b.cx} cy={b.cy} r={b.r} fill={b.color} opacity={b.opacity} />
  }
}
