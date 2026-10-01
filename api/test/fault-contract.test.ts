import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import type { Snapshot } from "../src/replay.js";
import { FakeRobotAdapter } from "../src/robot/fake.js";
import { installTestShutdown, resetDb } from "./helpers.js";

installTestShutdown();

test("a mid-cycle fault holds the lot, releases inventory, and replays", async () => {
  const robot = new FakeRobotAdapter("FAULT_MID_CYCLE");
  const pool = await resetDb();
  const app = buildApp(pool, robot);

  await act(app, "release");
  const kitted = await act(app, "kit");
  assert.equal(kitted.json().headline, "PICK & PLACE");
  assert.equal(kitted.json().lastGoodStation, "kit");

  const held = await act(app, "pick");
  assert.equal(held.statusCode, 200);
  const screen = held.json();
  assert.equal(screen.headline, "HOLD");
  assert.equal(screen.action, null);
  assert.equal(screen.holdCode, "FAULT_MID_CYCLE");
  assert.equal(screen.lastGoodStation, "kit");
  assert.equal(screen.currentStation, "pick_place");
  assert.deepEqual(screen.lines, [
    screen.serial,
    "Last good station: Kit",
    "Pick and place faulted",
    "Gripped housing HSG-100. Did not place.",
    "Inventory reservation released.",
  ]);
  assert.deepEqual(
    robot.calls.map((call) => call.op),
    ["move", "grip", "move"],
  );

  const again = await act(app, "pick");
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().headline, "HOLD");
  const events = await pool.query("SELECT count(*)::int AS count FROM station_events");
  assert.equal(events.rows[0].count, 4);

  const replay = await app.inject({ method: "GET", url: `/lots/${screen.lotId}/replay` });
  assert.equal(replay.statusCode, 200);
  const body = replay.json();
  const fault = body.events.find((event: { eventType: string }) => event.eventType === "faulted");
  assert.equal(fault.payload.code, "FAULT_MID_CYCLE");
  assert.equal(fault.payload.cycle[1].op, "grip");
  assert.equal(fault.payload.cycle[1].partNumber, "HSG-100");
  assert.equal(fault.payload.cycle[1].result, "ok");
  assert.equal(fault.payload.cycle[2].result, "FAULT_MID_CYCLE");
  assert.equal(body.state.workOrderStatus, "held");
  assert.deepEqual(project(body.state, screen.lotId), await live(pool, screen.lotId));
});

test("a timeout before the grip also holds the lot and releases inventory", async () => {
  const robot = new FakeRobotAdapter("TIMEOUT");
  const pool = await resetDb();
  const app = buildApp(pool, robot);

  await act(app, "release");
  await act(app, "kit");
  const held = await act(app, "pick");
  assert.equal(held.statusCode, 200);
  assert.equal(held.json().headline, "HOLD");
  assert.equal(held.json().holdCode, "TIMEOUT");
  assert.equal(held.json().lastGoodStation, "kit");
  assert.deepEqual(
    robot.calls.map((call) => call.op),
    ["move"],
  );
  assert.equal(held.json().lines[3], "Arm timed out before the grip.");

  const reservations = await pool.query<{ status: string }>(
    "SELECT status FROM reservations WHERE lot_id = $1",
    [held.json().lotId],
  );
  assert.ok(reservations.rows.every((row) => row.status === "released"));
});

test("a clean cycle consumes the housing at pick and the rest at pack", async () => {
  const robot = new FakeRobotAdapter("success");
  const pool = await resetDb();
  const app = buildApp(pool, robot);

  await act(app, "release");
  await act(app, "kit");
  const placed = await act(app, "pick");
  assert.equal(placed.json().headline, "TORQUE");
  assert.deepEqual(
    robot.calls.map((call) => call.op),
    ["move", "grip", "move", "release"],
  );

  const housing = await pool.query<{ status: string }>(
    `SELECT r.status
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     WHERE r.lot_id = $1 AND b.part_number = 'HSG-100'`,
    [placed.json().lotId],
  );
  assert.equal(housing.rows[0].status, "consumed");
  const others = await pool.query<{ status: string }>(
    `SELECT r.status
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     WHERE r.lot_id = $1 AND b.part_number <> 'HSG-100'`,
    [placed.json().lotId],
  );
  assert.ok(others.rows.every((row) => row.status === "held"));

  await act(app, "torque");
  await act(app, "inspect");
  const packed = await act(app, "pack");
  assert.equal(packed.json().headline, "PASSED");
  assert.equal(packed.json().action, null);
  assert.equal(packed.json().lotStatus, "passed");
  assert.equal(packed.json().workOrderStatus, "done");

  const reservations = await pool.query<{ status: string }>("SELECT status FROM reservations WHERE lot_id = $1", [
    packed.json().lotId,
  ]);
  assert.ok(reservations.rows.every((row) => row.status === "consumed"));

  const replay = await app.inject({ method: "GET", url: `/lots/${packed.json().lotId}/replay` });
  assert.deepEqual(project(replay.json().state, packed.json().lotId), await live(pool, packed.json().lotId));
});

async function act(app: ReturnType<typeof buildApp>, key: string) {
  return app.inject({
    method: "POST",
    url: "/operator/act",
    payload: { idempotencyKey: key },
  });
}

function project(state: Snapshot, lotId: string) {
  const lot = state.lots.find((item) => item.id === lotId);
  return {
    workOrderStatus: state.workOrderStatus,
    status: lot?.status,
    currentStation: lot?.currentStation ?? null,
    lastGoodStation: lot?.lastGoodStation ?? null,
    holdCode: lot?.holdCode ?? null,
    reservations: state.reservations
      .filter((reservation) => reservation.lotId === lotId)
      .map((reservation) => ({ partNumber: reservation.partNumber, status: reservation.status }))
      .sort((left, right) => left.partNumber.localeCompare(right.partNumber)),
  };
}

async function live(pool: Awaited<ReturnType<typeof resetDb>>, lotId: string) {
  const lot = await pool.query<{
    status: string;
    current_station: string | null;
    last_good_station: string | null;
    hold_code: string | null;
    work_order_status: string;
  }>(
    `SELECT l.status, l.current_station, l.last_good_station, l.hold_code, w.status AS work_order_status
     FROM lots l
     JOIN work_orders w ON w.id = l.work_order_id
     WHERE l.id = $1`,
    [lotId],
  );
  const reservations = await pool.query<{ part_number: string; status: string }>(
    `SELECT b.part_number, r.status
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     WHERE r.lot_id = $1
     ORDER BY b.part_number`,
    [lotId],
  );
  const row = lot.rows[0];
  return {
    workOrderStatus: row.work_order_status,
    status: row.status,
    currentStation: row.current_station,
    lastGoodStation: row.last_good_station,
    holdCode: row.hold_code,
    reservations: reservations.rows.map((reservation) => ({
      partNumber: reservation.part_number,
      status: reservation.status,
    })),
  };
}
