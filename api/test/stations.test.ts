import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { installTestShutdown, resetDb } from "./helpers.js";

installTestShutdown();

test("stations move in order and callbacks are idempotent", async () => {
  const pool = await resetDb();
  const app = buildApp(pool);
  const lotId = await releaseLot(app);

  const torque = await post(app, `/lots/${lotId}/stations/torque/start`, "torque-1");
  assert.equal(torque.statusCode, 409);

  const started = await post(app, `/lots/${lotId}/stations/kit/start`, "kit-start");
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().lot.status, "in_station");
  assert.equal(started.json().lot.currentStation, "kit");
  assert.equal(started.json().workOrder.status, "running");

  const startedAgain = await post(app, `/lots/${lotId}/stations/kit/start`, "kit-start");
  assert.equal(startedAgain.statusCode, 200);
  assert.equal(startedAgain.json().event.id, started.json().event.id);
  const startCount = await pool.query("SELECT count(*)::int AS count FROM station_events");
  assert.equal(startCount.rows[0].count, 1);

  const completed = await post(app, `/lots/${lotId}/stations/kit/complete`, "kit-done");
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().lot.status, "queued");
  assert.equal(completed.json().lot.lastGoodStation, "kit");
  assert.equal(completed.json().lot.currentStation, null);

  const held = await pool.query<{ status: string }>("SELECT status FROM reservations WHERE lot_id = $1", [lotId]);
  assert.ok(held.rows.every((row) => row.status === "held"));

  const pick = await post(app, `/lots/${lotId}/stations/pick_place/start`, "pick-start");
  assert.equal(pick.statusCode, 200);

  const fault = await post(app, `/lots/${lotId}/stations/pick_place/fault`, "pick-fault", {
    code: "FAULT_MID_CYCLE",
  });
  assert.equal(fault.statusCode, 200);
  assert.equal(fault.json().lot.status, "held");
  assert.equal(fault.json().lot.holdCode, "FAULT_MID_CYCLE");
  assert.equal(fault.json().lot.lastGoodStation, "kit");
  assert.equal(fault.json().lot.currentStation, "pick_place");
  assert.equal(fault.json().workOrder.status, "held");

  const replayed = await post(app, `/lots/${lotId}/stations/pick_place/fault`, "pick-fault", {
    code: "FAULT_MID_CYCLE",
  });
  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.json().event.id, fault.json().event.id);

  const conflict = await post(app, `/lots/${lotId}/stations/pick_place/fault`, "pick-fault", {
    code: "TIMEOUT",
  });
  assert.equal(conflict.statusCode, 409);

  const events = await pool.query("SELECT count(*)::int AS count FROM station_events");
  assert.equal(events.rows[0].count, 4);

  const reservations = await pool.query<{ status: string }>("SELECT status FROM reservations WHERE lot_id = $1", [lotId]);
  assert.ok(reservations.rows.every((row) => row.status === "released"));
});

async function releaseLot(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/work-orders",
    payload: { productCode: "JA-100", quantity: 1 },
  });
  assert.equal(response.statusCode, 201);
  return response.json().lots[0].id as string;
}

function post(app: ReturnType<typeof buildApp>, url: string, key: string, payload?: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { "idempotency-key": key },
    payload: payload ?? {},
  });
}
