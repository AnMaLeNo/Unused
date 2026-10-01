// Les cas de changement d'heure supposent un fuseau qui en a un.
process.env.TZ = "Europe/Paris";

import { describe, expect, it } from "vitest";
import { coverageEnd, nextStart, occurrences, WindowSpecSchema, type WindowSpec } from "./calendar.js";

describe("plages automatiques : cas limites", () => {
  it("une plage incluse dans une plus longue ne raccourcit pas la couverture", () => {
    const specs: WindowSpec[] = [
      { days: ["wed"], from: "20:00", to: "06:00" },
      { days: ["wed"], from: "21:00", to: "22:00" },
      { days: ["wed"], from: "23:00", to: "23:30" },
    ];
    const wed2130 = new Date(2026, 8, 16, 21, 30);
    expect(coverageEnd(specs, wed2130)).toEqual(new Date(2026, 8, 17, 6, 0));
    // Le prochain début est après toute la couverture, pas à 23:00.
    expect(nextStart(specs, wed2130)).toEqual(new Date(2026, 8, 23, 20, 0));
  });

  it("passage à l'heure d'été : une plage dans l'heure sautée ne s'étire pas sur 24 h", () => {
    const specs: WindowSpec[] = [{ days: ["sun"], from: "02:30", to: "03:00" }];
    const dstDay = occurrences(specs, new Date(2026, 2, 28, 12)).filter((s) => s.start.getMonth() === 2 && s.start.getDate() >= 29 && s.start.getDate() <= 30);
    expect(dstDay).toEqual([]);
    // Une plage qui déborde de l'heure sautée perd seulement cette heure.
    const long = occurrences([{ days: ["sun"], from: "02:00", to: "07:00" }], new Date(2026, 2, 28, 12)).find((s) => s.start.getDate() === 29)!;
    expect(long.end.getTime() - long.start.getTime()).toBe(4 * 3_600_000);
    // Et une plage de nuit reste une plage de nuit.
    const night = occurrences([{ days: ["sat"], from: "23:00", to: "07:00" }], new Date(2026, 2, 28, 12)).find((s) => s.start.getDate() === 28)!;
    expect(night.end).toEqual(new Date(2026, 2, 29, 7, 0));
  });

  it("refuse les heures impossibles, accepte 24:00 comme fin", () => {
    const ok = (from: string, to: string) => WindowSpecSchema.safeParse({ days: ["mon"], from, to }).success;
    expect(ok("08:00", "60:00")).toBe(false);
    expect(ok("99:99", "07:00")).toBe(false);
    expect(ok("24:00", "07:00")).toBe(false);
    expect(ok("20:00", "24:00")).toBe(true);
    expect(coverageEnd([{ days: ["mon"], from: "20:00", to: "24:00" }], new Date(2026, 8, 14, 23, 0))).toEqual(new Date(2026, 8, 15, 0, 0));
  });
});
