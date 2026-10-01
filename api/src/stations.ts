import { HttpError } from "./http.js";

export const STATIONS = ["kit", "pick_place", "torque", "inspect", "pack"] as const;
export type Station = (typeof STATIONS)[number];

export const HOLD_CODES = ["FAULT_MID_CYCLE", "TIMEOUT"] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

export const PRODUCT_CODE = "JA-100";
export const HOUSING_PART = "HSG-100";

export function parseStation(value: string): Station {
  if ((STATIONS as readonly string[]).includes(value)) return value as Station;
  throw new HttpError(404, "station not found");
}

export function nextStation(lastGood: Station | null): Station | null {
  if (!lastGood) return "kit";
  const index = STATIONS.indexOf(lastGood);
  if (index < 0 || index === STATIONS.length - 1) return null;
  return STATIONS[index + 1];
}

export function stationLabel(station: Station): string {
  switch (station) {
    case "kit":
      return "Kit";
    case "pick_place":
      return "Pick & Place";
    case "torque":
      return "Torque";
    case "inspect":
      return "Inspect";
    case "pack":
      return "Pack";
  }
}

export function stationHeadline(station: Station): string {
  switch (station) {
    case "kit":
      return "KIT";
    case "pick_place":
      return "PICK & PLACE";
    case "torque":
      return "TORQUE";
    case "inspect":
      return "INSPECT";
    case "pack":
      return "PACK";
  }
}

export function actionLabel(station: Station): string {
  switch (station) {
    case "kit":
      return "Finish kit";
    case "torque":
      return "Finish torque";
    case "inspect":
      return "Finish inspect";
    case "pack":
      return "Finish pack";
    case "pick_place":
      return "Run pick and place";
  }
}
