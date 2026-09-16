import { describe, expect, it } from "vitest";
import { coverageEnd, nextStart, WindowSpecSchema, type WindowSpec } from "./calendar.js";

// Mercredi 2026-09-16, heure locale.
const wed = (h: number, m = 0) => new Date(2026, 8, 16, h, m);
const thu = (h: number, m = 0) => new Date(2026, 8, 17, h, m);
const nights: WindowSpec[] = [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "23:00", to: "07:00" }];

describe("calendar", () => {
  it("valide le format", () => {
    expect(WindowSpecSchema.safeParse({ days: ["mon"], from: "23:00", to: "07:00" }).success).toBe(true);
    expect(WindowSpecSchema.safeParse({ days: [], from: "23:00", to: "07:00" }).success).toBe(false);
    expect(WindowSpecSchema.safeParse({ days: ["mon"], from: "23h", to: "07:00" }).success).toBe(false);
    expect(WindowSpecSchema.safeParse({ days: ["lun"], from: "23:00", to: "07:00" }).success).toBe(false);
  });

  it("hors plage : pas de couverture, prochain début ce soir", () => {
    expect(coverageEnd(nights, wed(15))).toBeNull();
    expect(nextStart(nights, wed(15))).toEqual(wed(23));
  });

  it("dans une plage de nuit, avant et après minuit : fin le lendemain matin", () => {
    expect(coverageEnd(nights, wed(23, 30))).toEqual(thu(7));
    expect(coverageEnd(nights, thu(3))).toEqual(thu(7));
    expect(nextStart(nights, thu(3))).toEqual(thu(23));
  });

  it("la fin exacte est exclue, le début inclus", () => {
    expect(coverageEnd(nights, thu(7))).toBeNull();
    expect(coverageEnd(nights, wed(23))).toEqual(thu(7));
  });

  it("les plages qui s'enchaînent ou se chevauchent fusionnent", () => {
    const specs: WindowSpec[] = [
      { days: ["wed"], from: "22:00", to: "01:00" },
      { days: ["thu"], from: "00:30", to: "04:00" },
      { days: ["thu"], from: "04:00", to: "06:00" },
      { days: ["thu"], from: "09:00", to: "10:00" },
    ];
    expect(coverageEnd(specs, wed(22, 30))).toEqual(thu(6));
    expect(nextStart(specs, wed(22, 30))).toEqual(thu(9));
  });

  it("le samedi n'a pas de nuit de semaine", () => {
    const sat = new Date(2026, 8, 19, 23, 30);
    expect(coverageEnd(nights, sat)).toBeNull();
    expect(nextStart(nights, sat)).toEqual(new Date(2026, 8, 21, 23));
  });

  it("aucune plage : rien", () => {
    expect(coverageEnd([], wed(23))).toBeNull();
    expect(nextStart([], wed(23))).toBeNull();
  });
});
