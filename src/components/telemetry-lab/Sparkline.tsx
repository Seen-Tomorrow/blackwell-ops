interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
  fill?: boolean;
}

export default function Sparkline({
  values,
  color,
  width = 140,
  height = 32,
  fill = false,
}: SparklineProps) {
  if (values.length < 2) {
    return <div className="rounded-sm bg-stealth-black" style={{ width, height }} />;
  }

  const max = Math.max(...values, 0.001);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pad = 2;

  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (height - pad * 2) - ((v - min) / range) * (height - pad * 2);
    return { x, y };
  });

  const line = points.map((p) => `${p.x},${p.y}`).join(" ");
  const area = `${points[0].x},${height - pad} ${line} ${points[points.length - 1].x},${height - pad}`;

  return (
    <svg width={width} height={height} className="block rounded-sm bg-stealth-black/80">
      {fill && <polygon points={area} fill={color} fillOpacity={0.12} />}
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        points={line}
      />
    </svg>
  );
}