import type { CartesianPose, CycleStep } from "../replay.js";
import { HOUSING_PART, type HoldCode } from "../stations.js";
import { RobotError, type RobotAdapter } from "./adapter.js";

export const CELL_FRAME = "cell";

export const PICK_POSE: CartesianPose = { x: 420, y: -180, z: 90, roll: 180, pitch: 0, yaw: 90 };
export const PLACE_POSE: CartesianPose = { x: 610, y: 40, z: 120, roll: 180, pitch: 0, yaw: 90 };

export type CycleOutcome =
  | { ok: true; cycle: CycleStep[] }
  | { ok: false; code: HoldCode; cycle: CycleStep[] };

export async function executeCycle(robot: RobotAdapter): Promise<CycleOutcome> {
  const cycle: CycleStep[] = [];

  const movedToPick = await step(robot, cycle, () => robot.move(CELL_FRAME, PICK_POSE), {
    op: "move",
    frame: CELL_FRAME,
    pose: PICK_POSE,
    result: "ok",
  });
  if (!movedToPick.ok) return movedToPick;

  const gripped = await step(robot, cycle, () => robot.grip(), {
    op: "grip",
    partNumber: HOUSING_PART,
    result: "ok",
  });
  if (!gripped.ok) return gripped;

  const movedToPlace = await step(robot, cycle, () => robot.move(CELL_FRAME, PLACE_POSE), {
    op: "move",
    frame: CELL_FRAME,
    pose: PLACE_POSE,
    result: "ok",
  });
  if (!movedToPlace.ok) return movedToPlace;

  return step(robot, cycle, () => robot.release(), { op: "release", result: "ok" });
}

async function step(
  _robot: RobotAdapter,
  cycle: CycleStep[],
  call: () => Promise<void>,
  record: CycleStep,
): Promise<CycleOutcome> {
  try {
    await call();
    cycle.push(record);
    return { ok: true, cycle };
  } catch (error) {
    if (!(error instanceof RobotError)) throw error;
    cycle.push({ ...record, result: error.code });
    return { ok: false, code: error.code, cycle };
  }
}
