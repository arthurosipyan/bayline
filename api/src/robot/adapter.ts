import type { CartesianPose } from "../replay.js";
import type { HoldCode } from "../stations.js";

export type { CartesianPose };

export class RobotError extends Error {
  constructor(readonly code: HoldCode) {
    super(code);
  }
}

export interface RobotAdapter {
  move(frame: string, pose: CartesianPose): Promise<void>;
  grip(): Promise<void>;
  release(): Promise<void>;
}
