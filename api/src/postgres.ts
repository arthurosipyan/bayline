import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

export type RunningDatabase = {
  pool: pg.Pool;
  stop: () => Promise<void>;
};

let running: RunningDatabase | null = null;

export async function openDatabase(): Promise<RunningDatabase> {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    return {
      pool,
      stop: async () => {
        await pool.end();
      },
    };
  }

  const databaseDir = await mkdtemp(path.join(tmpdir(), "bayline-pg-"));
  const port = 54329;
  const server = new EmbeddedPostgres({
    databaseDir,
    user: "bayline",
    password: "bayline",
    port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  await server.initialise();
  await server.start();
  await server.createDatabase("bayline");

  const pool = new pg.Pool({
    connectionString: `postgres://bayline:bayline@127.0.0.1:${port}/bayline`,
  });

  return {
    pool,
    stop: async () => {
      await pool.end();
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

export async function getDatabase(): Promise<RunningDatabase> {
  if (!running) {
    running = await openDatabase();
  }
  return running;
}

export async function stopDatabase(): Promise<void> {
  if (!running) return;
  const current = running;
  running = null;
  await current.stop();
}
