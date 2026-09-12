const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** "8h", "90m", "1d12h", "1h30m" → millisecondes. */
export function parseDuration(text: string): number {
  const s = text.trim();
  const re = /\s*(\d+)\s*([dhms])/gy;
  let total = 0;
  let last = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    last = re.lastIndex;
  }
  if (last !== s.length || total <= 0) {
    throw new Error(`durée invalide "${text}" (attendu par ex. 8h, 90m, 1d12h)`);
  }
  return total;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}`;
  if (m > 0) return `${m}m${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}
