import assert from "node:assert/strict";
import { test } from "node:test";
import { installTestShutdown, resetDb } from "./helpers.js";
import { buildApp } from "../src/app.js";

installTestShutdown();

test("release holds one reservation per bom line for each lot", async () => {
  const pool = await resetDb();
  const app = buildApp(pool);

  const response = await app.inject({
    method: "POST",
    url: "/work-orders",
    payload: { productCode: "JA-100", quantity: 2 },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.workOrder.status, "released");
  assert.equal(body.workOrder.quantity, 2);
  assert.equal(body.lots.length, 2);
  assert.deepEqual(
    body.lots.map((lot: { status: string }) => lot.status),
    ["queued", "queued"],
  );

  const reservations = await pool.query<{ status: string; part_number: string }>(
    `SELECT r.status, b.part_number
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     WHERE r.lot_id = $1
     ORDER BY b.part_number`,
    [body.lots[0].id],
  );
  assert.equal(reservations.rowCount, 7);
  assert.ok(reservations.rows.every((row) => row.status === "held"));
  assert.equal(reservations.rows.find((row) => row.part_number === "HSG-100")?.status, "held");

  const missing = await app.inject({
    method: "POST",
    url: "/work-orders",
    payload: { productCode: "NO-SUCH", quantity: 1 },
  });
  assert.equal(missing.statusCode, 404);

  const badQty = await app.inject({
    method: "POST",
    url: "/work-orders",
    payload: { productCode: "JA-100", quantity: 0 },
  });
  assert.equal(badQty.statusCode, 400);
});
