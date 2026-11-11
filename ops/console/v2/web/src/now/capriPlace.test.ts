import { describe, expect, it } from "vitest";
import { CAPRI_MAX, CAPRI_MIN, clampPlace, parsePlace } from "./capriPlace";

describe("capri place", () => {
  it("keeps the size in range", () => {
    expect(clampPlace({ right: 16, bottom: 16, size: 10 }, 1440, 900).size).toBe(CAPRI_MIN);
    expect(clampPlace({ right: 16, bottom: 16, size: 999 }, 1440, 900).size).toBe(CAPRI_MAX);
  });
  it("keeps the box inside the window", () => {
    expect(clampPlace({ right: -50, bottom: -50, size: 100 }, 1440, 900)).toEqual({ right: 4, bottom: 4, size: 100 });
    expect(clampPlace({ right: 5000, bottom: 5000, size: 100 }, 1440, 900)).toEqual({ right: 1336, bottom: 784, size: 100 });
  });
  it("reads only a well formed entry", () => {
    expect(parsePlace('{"right":20,"bottom":30,"size":150}')).toEqual({ right: 20, bottom: 30, size: 150 });
    expect(parsePlace("{bad")).toBeNull();
    expect(parsePlace('{"right":"x","bottom":1,"size":1}')).toBeNull();
    expect(parsePlace(null)).toBeNull();
  });
});
