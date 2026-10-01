import type { CartesianPose } from "../replay.js";
import { RobotError, type RobotAdapter } from "./adapter.js";

export type RobotScenario = "success" | "TIMEOUT" | "FAULT_MID_CYCLE";

export type RobotCall =
  | { op: "move"; frame: string; pose: CartesianPose }
  | { op: "grip" }
  | { op: "release" };

export function scenarioFromEnv(value = process.env.BAYLINE_ROBOT_SCENARIO): RobotScenario {
  if (value === undefined || value === "") return "FAULT_MID_CYCLE";
  if (value === "success" || value === "TIMEOUT" || value === "FAULT_MID_CYCLE") return value;
  throw new Error("BAYLINE_ROBOT_SCENARIO must be success, TIMEOUT, or FAULT_MID_CYCLE");
}

export class FakeRobotAdapter implements RobotAdapter {
  readonly calls: RobotCall[] = [];

  constructor(private readonly scenario: RobotScenario) {}

  async move(frame: string, pose: CartesianPose): Promise<void> {
    this.calls.push({ op: "move", frame, pose });
    const moves = this.calls.filter((call) => call.op === "move").length;
    if (this.scenario === "TIMEOUT" && moves === 1) throw new RobotError("TIMEOUT");
    if (this.scenario === "FAULT_MID_CYCLE" && moves === 2) throw new RobotError("FAULT_MID_CYCLE");
  }

  async grip(): Promise<void> {
    this.calls.push({ op: "grip" });
  }

  async release(): Promise<void> {
    this.calls.push({ op: "release" });
  }
}
