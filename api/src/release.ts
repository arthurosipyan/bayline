import type pg from "pg";
import { HttpError } from "./http.js";

export type ReleasedLot = {
  id: string;
  serial: string;
  status: "queued";
};

export type ReleasedOrder = {
  workOrder: {
    id: string;
    productCode: string;
    quantity: number;
    status: "released";
  };
  lots: ReleasedLot[];
};

type OrderRow = { id: string; product_code: string; quantity: number; status: "released" };
type LotRow = { id: string; serial: string; status: "queued" };

export async function releaseWorkOrder(
  pool: pg.Pool,
  input: { productCode: string; quantity: number },
): Promise<ReleasedOrder> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new HttpError(400, "quantity must be a positive integer");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bom = await client.query("SELECT 1 FROM bom_items WHERE product_code = $1 LIMIT 1", [input.productCode]);
    if (!bom.rowCount) throw new HttpError(404, "product not found");

    const order = await client.query<OrderRow>(
      `INSERT INTO work_orders (product_code, quantity, status)
       VALUES ($1, $2, 'released')
       RETURNING id, product_code, quantity, status`,
      [input.productCode, input.quantity],
    );
    const lots = await client.query<LotRow>(
      `INSERT INTO lots (work_order_id, serial, status)
       SELECT $1, 'JA100-' || lpad(nextval('lot_serial_seq')::text, 4, '0'), 'queued'
       FROM generate_series(1, $2)
       RETURNING id, serial, status`,
      [order.rows[0].id, input.quantity],
    );
    await client.query(
      `INSERT INTO reservations (lot_id, bom_item_id, qty, status)
       SELECT l.id, b.id, b.qty_per, 'held'
       FROM lots l
       JOIN bom_items b ON b.product_code = $2
       WHERE l.work_order_id = $1`,
      [order.rows[0].id, input.productCode],
    );
    await client.query("COMMIT");

    return {
      workOrder: {
        id: order.rows[0].id,
        productCode: order.rows[0].product_code,
        quantity: order.rows[0].quantity,
        status: order.rows[0].status,
      },
      lots: lots.rows.map((lot) => ({ id: lot.id, serial: lot.serial, status: lot.status })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
