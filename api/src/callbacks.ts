import type pg from "pg";
import { canonicalJson } from "./json.js";
import { HttpError, isUniqueViolation } from "./http.js";
import type { EventPayload, EventType, LotStatus, WorkOrderStatus } from "./replay.js";
import { HOUSING_PART, nextStation, type HoldCode, type Station } from "./stations.js";

export type CallbackResult = {
  event: {
    id: string;
    lotId: string;
    station: Station;
    eventType: EventType;
    idempotencyKey: string;
    payload: EventPayload;
    createdAt: string;
  };
  lot: {
    id: string;
    serial: string;
    status: LotStatus;
    currentStation: Station | null;
    lastGoodStation: Station | null;
    holdCode: HoldCode | null;
  };
  workOrder: {
    id: string;
    status: WorkOrderStatus;
  };
};

type LockedLot = {
  id: string;
  workOrderId: string;
  status: LotStatus;
  currentStation: Station | null;
  lastGoodStation: Station | null;
  workOrderStatus: WorkOrderStatus;
};

type LockRow = {
  id: string;
  work_order_id: string;
  status: LotStatus;
  current_station: Station | null;
  last_good_station: Station | null;
  work_order_status: WorkOrderStatus;
};

class IdempotentReplay extends Error {
  constructor() {
    super("idempotent replay");
  }
}

export async function startStation(
  pool: pg.Pool,
  lotId: string,
  station: Station,
  idempotencyKey: string,
  payload: EventPayload = {},
): Promise<CallbackResult> {
  return applyCallback(pool, lotId, station, "started", idempotencyKey, payload, async (client, lot) => {
    assertCanMove(lot);
    if (lot.status !== "queued") throw new HttpError(409, "lot is not queued");
    if (nextStation(lot.lastGoodStation) !== station) throw new HttpError(409, "station is out of order");

    await client.query("UPDATE lots SET status = 'in_station', current_station = $2 WHERE id = $1", [lot.id, station]);
    if (lot.workOrderStatus === "released") {
      await client.query("UPDATE work_orders SET status = 'running' WHERE id = $1 AND status = 'released'", [
        lot.workOrderId,
      ]);
    }
  });
}

export async function completeStation(
  pool: pg.Pool,
  lotId: string,
  station: Station,
  idempotencyKey: string,
  payload: EventPayload = {},
): Promise<CallbackResult> {
  return applyCallback(pool, lotId, station, "completed", idempotencyKey, payload, async (client, lot) => {
    assertAtStation(lot, station);
    const nextStatus = station === "pack" ? "passed" : "queued";
    await client.query(
      `UPDATE lots
       SET status = $3, current_station = NULL, last_good_station = $2
       WHERE id = $1`,
      [lot.id, station, nextStatus],
    );

    if (station === "pick_place") {
      await client.query(
        `UPDATE reservations r
         SET status = 'consumed'
         FROM bom_items b
         WHERE r.bom_item_id = b.id
           AND r.lot_id = $1
           AND r.status = 'held'
           AND b.part_number = $2`,
        [lot.id, HOUSING_PART],
      );
    }

    if (station === "pack") {
      await client.query("UPDATE reservations SET status = 'consumed' WHERE lot_id = $1 AND status = 'held'", [lot.id]);
      const counts = await client.query<{ total: number; passed: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'passed')::int AS passed
         FROM lots
         WHERE work_order_id = $1`,
        [lot.workOrderId],
      );
      if (counts.rows[0].total === counts.rows[0].passed) {
        await client.query("UPDATE work_orders SET status = 'done' WHERE id = $1", [lot.workOrderId]);
      }
    }
  });
}

export async function faultStation(
  pool: pg.Pool,
  lotId: string,
  station: Station,
  idempotencyKey: string,
  payload: EventPayload & { code: HoldCode },
): Promise<CallbackResult> {
  return applyCallback(pool, lotId, station, "faulted", idempotencyKey, payload, async (client, lot) => {
    assertAtStation(lot, station);
    await client.query("UPDATE lots SET status = 'held', hold_code = $2 WHERE id = $1", [lot.id, payload.code]);
    await client.query("UPDATE reservations SET status = 'released' WHERE lot_id = $1 AND status = 'held'", [lot.id]);
    await client.query("UPDATE work_orders SET status = 'held' WHERE id = $1", [lot.workOrderId]);
  });
}

async function applyCallback(
  pool: pg.Pool,
  lotId: string,
  station: Station,
  eventType: EventType,
  idempotencyKey: string,
  payload: EventPayload,
  mutate: (client: pg.PoolClient, lot: LockedLot) => Promise<void>,
): Promise<CallbackResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lot = await lockLot(client, lotId);
    try {
      await client.query(
        `INSERT INTO station_events (lot_id, station, event_type, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [lotId, station, eventType, idempotencyKey, JSON.stringify(payload)],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new IdempotentReplay();
    }
    await mutate(client, lot);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof IdempotentReplay) {
      return resolveReplay(pool, lotId, station, eventType, idempotencyKey, payload);
    }
    throw error;
  } finally {
    client.release();
  }

  return loadCallbackResult(pool, idempotencyKey);
}

async function resolveReplay(
  pool: pg.Pool,
  lotId: string,
  station: Station,
  eventType: EventType,
  idempotencyKey: string,
  payload: EventPayload,
): Promise<CallbackResult> {
  const existing = await pool.query<{
    lot_id: string;
    station: Station;
    event_type: EventType;
    payload: EventPayload;
  }>("SELECT lot_id, station, event_type, payload FROM station_events WHERE idempotency_key = $1", [idempotencyKey]);
  const row = existing.rows[0];
  if (
    !row ||
    row.lot_id !== lotId ||
    row.station !== station ||
    row.event_type !== eventType ||
    canonicalJson(row.payload) !== canonicalJson(payload)
  ) {
    throw new HttpError(409, "idempotency key was used for a different request");
  }
  return loadCallbackResult(pool, idempotencyKey);
}

async function lockLot(client: pg.PoolClient, lotId: string): Promise<LockedLot> {
  const result = await client.query<LockRow>(
    `SELECT l.id, l.work_order_id, l.status, l.current_station, l.last_good_station, w.status AS work_order_status
     FROM lots l
     JOIN work_orders w ON w.id = l.work_order_id
     WHERE l.id = $1
     FOR UPDATE OF l, w`,
    [lotId],
  );
  if (!result.rowCount) throw new HttpError(404, "lot not found");
  const row = result.rows[0];
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    status: row.status,
    currentStation: row.current_station,
    lastGoodStation: row.last_good_station,
    workOrderStatus: row.work_order_status,
  };
}

function assertCanMove(lot: LockedLot) {
  if (lot.status === "held" || lot.status === "passed" || lot.status === "scrapped") {
    throw new HttpError(409, "lot cannot move");
  }
  if (lot.workOrderStatus === "held" || lot.workOrderStatus === "done") {
    throw new HttpError(409, "work order cannot move");
  }
}

function assertAtStation(lot: LockedLot, station: Station) {
  assertCanMove(lot);
  if (lot.status !== "in_station" || lot.currentStation !== station) {
    throw new HttpError(409, "lot is not in this station");
  }
}

async function loadCallbackResult(pool: pg.Pool, idempotencyKey: string): Promise<CallbackResult> {
  const result = await pool.query<{
    id: string;
    lot_id: string;
    station: Station;
    event_type: EventType;
    idempotency_key: string;
    payload: EventPayload;
    created_at: Date;
    serial: string;
    status: LotStatus;
    current_station: Station | null;
    last_good_station: Station | null;
    hold_code: HoldCode | null;
    work_order_id: string;
    work_order_status: WorkOrderStatus;
  }>(
    `SELECT e.id, e.lot_id, e.station, e.event_type, e.idempotency_key, e.payload, e.created_at,
            l.serial, l.status, l.current_station, l.last_good_station, l.hold_code,
            w.id AS work_order_id, w.status AS work_order_status
     FROM station_events e
     JOIN lots l ON l.id = e.lot_id
     JOIN work_orders w ON w.id = l.work_order_id
     WHERE e.idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500, "internal error");
  return {
    event: {
      id: row.id,
      lotId: row.lot_id,
      station: row.station,
      eventType: row.event_type,
      idempotencyKey: row.idempotency_key,
      payload: row.payload ?? {},
      createdAt: row.created_at.toISOString(),
    },
    lot: {
      id: row.lot_id,
      serial: row.serial,
      status: row.status,
      currentStation: row.current_station,
      lastGoodStation: row.last_good_station,
      holdCode: row.hold_code,
    },
    workOrder: {
      id: row.work_order_id,
      status: row.work_order_status,
    },
  };
}
