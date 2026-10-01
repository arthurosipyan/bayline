import { after } from "node:test";
import type pg from "pg";
import { migrate } from "../src/migrate.js";
import { getDatabase, stopDatabase } from "../src/postgres.js";

export function installTestShutdown(): void {
  after(async () => {
    await stopDatabase();
  });
}

export async function resetDb(): Promise<pg.Pool> {
  const { pool } = await getDatabase();
  await migrate(pool);
  await pool.query(`
    TRUNCATE station_events, reservations, lots, work_orders RESTART IDENTITY CASCADE
  `);
  await pool.query("ALTER SEQUENCE lot_serial_seq RESTART WITH 1");
  return pool;
}
