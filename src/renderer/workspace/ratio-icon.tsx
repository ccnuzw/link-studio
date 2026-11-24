export function RatioIcon({ ratio }: { ratio: string }) {
  const [horizontal = 0, vertical = 0] = ratio.split(":").map(Number);
  if (!(horizontal > 0 && vertical > 0))
    return (
      <svg aria-hidden width="16" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor">
        <path
          d="M3 7V3h4 M13 3h4v4 M17 13v4h-4 M7 17H3v-4"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  const width = Math.min(30, Math.max(12, (12 * horizontal) / vertical));
  const height = Math.min(22, Math.max(12, (12 * vertical) / horizontal));
  const box = Math.ceil(width) + 2;
  return (
    <svg
      aria-hidden
      width={box}
      height="24"
      viewBox={`0 0 ${box} 24`}
      fill="none"
      stroke="currentColor"
    >
      <rect
        x={(box - width + 1.5) / 2}
        y={(24 - height + 1.5) / 2}
        width={width - 1.5}
        height={height - 1.5}
        rx="1.25"
        strokeWidth="1.5"
      />
    </svg>
  );
}
