# Bayline

Station-level MES for a joint-actuator cell.

Arthur Osipyan — https://github.com/arthurosipyan

The cell builds one joint actuator, `JA-100`, through five stations: kit, pick and place, torque, inspect, pack. The arm is only at pick and place. It sits behind `RobotAdapter`: `move(frame, pose)`, `grip()`, and `release()`. That shape comes from a public robot REST API and nothing else. This repo ships a fake. It returns success, `TIMEOUT`, or `FAULT_MID_CYCLE`, and it does not talk to a live robot.

## The fault

Release a work order and the lot is queued. Every BOM line for that lot is reserved. Kit finishes, and kit is the last good station. Pick and place starts. The arm moves to the housing, grips `HSG-100`, and faults with `FAULT_MID_CYCLE` before the place. `release()` is not called. The grip is not consumption.

The lot goes to held. The work order goes to held. Every reservation that was still held is released. The operator screen shows HOLD and the last good station. The station callbacks that recorded the cycle are idempotent: the same key returns the original event and does not release inventory twice. The append-only event log can replay the cycle.

```mermaid
sequenceDiagram
  participant Op as Operator
  participant MES as Bayline
  participant Arm as RobotAdapter
  Op->>MES: Release work order
  MES->>MES: Lot queued, reservations held
  Op->>MES: Finish kit
  MES->>MES: Last good station is kit
  Op->>MES: Run pick and place
  MES->>Arm: move(cell, pick pose)
  Arm-->>MES: ok
  MES->>Arm: grip()
  Arm-->>MES: ok, housing HSG-100
  MES->>Arm: move(cell, place pose)
  Arm-->>MES: FAULT_MID_CYCLE
  MES->>MES: Append fault, hold lot, release reservations
  MES-->>Op: HOLD, last good station kit
```

The screen is one page: a large status and one action. A hold has no action. It stays until someone deals with the lot outside this slice.

## Run

Node 22 or newer.

```
npm test
npm run dev
```

With `DATABASE_URL` unset, tests and the dev server boot an ephemeral Postgres. To use Docker instead:

```
docker compose up -d
```

Then set `DATABASE_URL=postgres://bayline:bayline@localhost:5432/bayline`.

Open http://localhost:5173. Release the order, finish kit, run pick and place. The default arm scenario is `FAULT_MID_CYCLE`. Set `BAYLINE_ROBOT_SCENARIO=success` to walk the cell through pack, or `TIMEOUT` to fault on the first move, before the grip.

## Scope

No auth, no Kubernetes, no live robot, no MRP, no scrap, no dashboards.
