import assert from "node:assert/strict";
import { test } from "node:test";
import { installTestShutdown, resetDb } from "./helpers.js";

installTestShutdown();

test("the joint actuator bom is seeded", async () => {
  const pool = await resetDb();
  const bom = await pool.query<{ part_number: string; qty_per: number }>(
    "SELECT part_number, qty_per FROM bom_items WHERE product_code = 'JA-100' ORDER BY part_number",
  );
  assert.deepEqual(
    bom.rows.map((row) => [row.part_number, row.qty_per]),
    [
      ["BRG-100", 2],
      ["ENC-100", 1],
      ["FLG-100", 1],
      ["FST-100", 8],
      ["HSG-100", 1],
      ["RTR-100", 1],
      ["STR-100", 1],
    ],
  );
});

test("station events reject update and delete", async () => {
  const pool = await resetDb();
  const order = await pool.query<{ id: string }>(
    "INSERT INTO work_orders (product_code, quantity, status) VALUES ('JA-100', 1, 'released') RETURNING id",
  );
  const lot = await pool.query<{ id: string }>(
    "INSERT INTO lots (work_order_id, serial, status) VALUES ($1, 'JA100-9001', 'queued') RETURNING id",
    [order.rows[0].id],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO station_events (lot_id, station, event_type, idempotency_key, payload)
     VALUES ($1, 'kit', 'started', 'schema-start', '{}'::jsonb)
     RETURNING id`,
    [lot.rows[0].id],
  );

  await assert.rejects(
    pool.query("UPDATE station_events SET payload = '{}'::jsonb WHERE id = $1", [event.rows[0].id]),
    /station_events is append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM station_events WHERE id = $1", [event.rows[0].id]),
    /station_events is append-only/,
  );
});
