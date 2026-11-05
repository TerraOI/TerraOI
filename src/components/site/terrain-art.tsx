// Contour lines with the Observe / Plan / Act nodes, from the approved mockup.
const CONTOURS = [30, 55, 80, 105, 130, 155, 180];

export function TerrainArt() {
  return (
    <svg viewBox="0 0 300 210" width="100%" role="img" aria-label="Terrain contours with three linked nodes for observe, plan and act">
      <rect width="300" height="210" rx="12" fill="#EEF3F1" />
      <g fill="none" stroke="#CCD8D3" strokeWidth="1">
        {CONTOURS.map((y) => (
          <path key={y} d={`M-10 ${y} C60 ${y + 30} 90 ${y - 30} 160 ${y} S240 ${y + 40} 310 ${y - 10}`} />
        ))}
      </g>
      <path d="M60 70 L150 115 L240 60" fill="none" stroke="#007F78" strokeWidth="1.6" strokeDasharray="5 4" />
      <circle cx="60" cy="70" r="8" fill="#007F78" stroke="#FFFFFF" strokeWidth="3" />
      <circle cx="150" cy="115" r="8" fill="#A48748" stroke="#FFFFFF" strokeWidth="3" />
      <circle cx="240" cy="60" r="8" fill="#007F78" stroke="#FFFFFF" strokeWidth="3" />
      <g fontSize="11" fill="#17252B" textAnchor="middle" fontFamily="var(--font-sans), Inter, Arial, sans-serif">
        <text x="60" y="96">Observe</text>
        <text x="150" y="141">Plan</text>
        <text x="240" y="86">Act</text>
      </g>
    </svg>
  );
}
