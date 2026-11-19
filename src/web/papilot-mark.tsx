import './papilot-mark.css';

type Part = 'top' | 'line' | 'bottom';
type Capsule = readonly [x: number, y: number, width: number, height: number, part: Part];

// The app icon's mark (desktop/assets/icon.svg), flat: navy capsules, the coral
// line and blue capsules, laid along the line before rotating it 45 degrees.
const five: readonly Capsule[] = [
  [-174, -229, 236, 68, 'top'], [-124, -127, 336, 68, 'top'], [-323, -24, 634, 48, 'line'],
  [-124, 59, 336, 68, 'bottom'], [-174, 161, 236, 68, 'bottom'],
];

// Decorative: every use sits beside the product name or in a labelled control.
export function PapilotMark({ size, className }: { size: number; className?: string }) {
  return <svg className={className ? `papilot-mark ${className}` : 'papilot-mark'} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <g transform="translate(34.4715 29.5285) scale(0.1125) rotate(-45)">
      {five.map(([x, y, width, height, part]) => <rect key={`${x},${y}`} className={`mark-${part}`} x={x} y={y} width={width} height={height} rx={height / 2}/>)}
    </g>
  </svg>;
}
