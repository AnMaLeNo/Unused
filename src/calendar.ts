import { z } from "zod";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

/**
 * Une plage automatique : les jours où elle *commence*, l'heure de début et
 * l'heure de fin en heure locale. `to` ≤ `from` signifie le lendemain
 * (23:00 → 07:00). Une plage ne dépasse pas 24 h.
 */
export const WindowSpecSchema = z
  .object({
    days: z.array(z.enum(DAYS)).nonempty(),
    from: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
    to: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
  })
  .strict();
export type WindowSpec = z.infer<typeof WindowSpecSchema>;

export interface Span {
  start: Date;
  end: Date;
}

function at(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Les occurrences concrètes des plages qui commencent entre J-1 et J+7 autour de `now`. */
export function occurrences(specs: WindowSpec[], now: Date): Span[] {
  const spans: Span[] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const day = addDays(now, offset);
    day.setHours(0, 0, 0, 0);
    const name = DAYS[day.getDay()]!;
    for (const spec of specs) {
      if (!spec.days.includes(name)) continue;
      const start = at(day, spec.from);
      let end = at(day, spec.to);
      if (end.getTime() <= start.getTime()) end = addDays(end, 1);
      spans.push({ start, end });
    }
  }
  return spans.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Si `now` est dans une plage, la fin de la couverture : les plages qui
 * s'enchaînent ou se chevauchent sont fusionnées. Sinon null.
 */
export function coverageEnd(specs: WindowSpec[], now: Date): Date | null {
  let end: Date | null = null;
  for (const s of occurrences(specs, now)) {
    const inside = s.start.getTime() <= now.getTime() && now.getTime() < s.end.getTime();
    const extends_ = end !== null && s.start.getTime() <= end.getTime() && s.end.getTime() > end.getTime();
    if (inside || extends_) end = s.end;
  }
  return end;
}

/** Le prochain début de plage strictement après `now` (hors couverture en cours), ou null. */
export function nextStart(specs: WindowSpec[], now: Date): Date | null {
  const cover = coverageEnd(specs, now);
  const floor = cover ?? now;
  for (const s of occurrences(specs, now)) {
    if (s.start.getTime() > floor.getTime()) return s.start;
  }
  return null;
}
