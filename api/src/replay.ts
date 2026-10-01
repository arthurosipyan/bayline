import type pg from "pg";
import { HttpError } from "./http.js";
import { HOUSING_PART, type HoldCode, type Station } from "./stations.js";

export type ReservationStatus = "held" | "consumed" | "released";
export type LotStatus = "queued" | "in_station" | "held" | "passed" | "scrapped";
export type WorkOrderStatus = "released" | "running" | "held" | "done";
export type EventType = "started" | "completed" | "faulted";

export type CycleStep =
  | { op: "move"; frame: string; pose: CartesianPose; result: "ok" | HoldCode }
  | { op: "grip"; partNumber: string; result: "ok" | HoldCode }
  | { op: "release"; result: "ok" | HoldCode };

export type CartesianPose = {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
};

export type EventPayload = {
  code?: HoldCode;
  cycle?: CycleStep[];
};

export type LotSnap = {
  id: string;
  status: LotStatus;
  currentStation: Station | null;
  lastGoodStation: Station | null;
  holdCode: HoldCode | null;
};

export type ReservationSnap = {
  lotId: string;
  partNumber: string;
  qty: number;
  status: ReservationStatus;
};

export type Snapshot = {
  workOrderStatus: WorkOrderStatus;
  lots: LotSnap[];
  reservations: ReservationSnap[];
};

export type ReplayEvent = {
  lotId: string;
  station: Station;
  eventType: EventType;
  payload: EventPayload;
};

export type StoredEvent = ReplayEvent & {
  id: string;
  seq: number;
  idempotencyKey: string;
  createdAt: string;
};

type LotRow = { id: string };
type ReservationRow = { lot_id: string; qty: number; part_number: string };
type EventRow = {
  id: string;
  seq: string;
  lot_id: string;
  station: Station;
  event_type: EventType;
  idempotency_key: string;
  payload: EventPayload;
  created_at: Date;
};

export function replay(initial: Snapshot, events: ReplayEvent[]): Snapshot {
  const state: Snapshot = structuredClone(initial);
  const lots = new Map(state.lots.map((lot) => [lot.id, lot]));

  for (const event of events) {
    const lot = lots.get(event.lotId);
    if (!lot) continue;

    if (event.eventType === "started") {
      lot.status = "in_station";
      lot.currentStation = event.station;
    } else if (event.eventType === "completed") {
      lot.lastGoodStation = event.station;
      lot.currentStation = null;
      if (event.station === "pick_place") consume(state, lot.id, (part) => part === HOUSING_PART);
      if (event.station === "pack") {
        lot.status = "passed";
        consume(state, lot.id, () => true);
      } else {
        lot.status = "queued";
      }
    } else {
      lot.status = "held";
      lot.holdCode = event.payload.code ?? null;
      for (const reservation of state.reservations) {
        if (reservation.lotId === lot.id && reservation.status === "held") reservation.status = "released";
      }
    }

    state.workOrderStatus = deriveWorkOrder(state.lots);
  }

  return state;
}

export async function readReplay(pool: pg.Pool, lotId: string) {
  const owner = await pool.query<{ work_order_id: string }>("SELECT work_order_id FROM lots WHERE id = $1", [lotId]);
  if (!owner.rowCount) throw new HttpError(404, "lot not found");
  const workOrderId = owner.rows[0].work_order_id;

  const lots = await pool.query<LotRow>("SELECT id FROM lots WHERE work_order_id = $1 ORDER BY serial", [workOrderId]);
  const reservations = await pool.query<ReservationRow>(
    `SELECT r.lot_id, r.qty, b.part_number
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     JOIN lots l ON l.id = r.lot_id
     WHERE l.work_order_id = $1
     ORDER BY l.serial, b.part_number`,
    [workOrderId],
  );
  const events = await pool.query<EventRow>(
    `SELECT e.id, e.seq, e.lot_id, e.station, e.event_type, e.idempotency_key, e.payload, e.created_at
     FROM station_events e
     JOIN lots l ON l.id = e.lot_id
     WHERE l.work_order_id = $1
     ORDER BY e.seq`,
    [workOrderId],
  );

  const initial: Snapshot = {
    workOrderStatus: "released",
    lots: lots.rows.map((row) => ({
      id: row.id,
      status: "queued",
      currentStation: null,
      lastGoodStation: null,
      holdCode: null,
    })),
    reservations: reservations.rows.map((row) => ({
      lotId: row.lot_id,
      partNumber: row.part_number,
      qty: row.qty,
      status: "held",
    })),
  };
  const stored = events.rows.map(presentEvent);
  return { initial, events: stored, state: replay(initial, stored) };
}

function presentEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
    lotId: row.lot_id,
    station: row.station,
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: row.payload ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

function consume(state: Snapshot, lotId: string, match: (partNumber: string) => boolean) {
  for (const reservation of state.reservations) {
    if (reservation.lotId === lotId && reservation.status === "held" && match(reservation.partNumber)) {
      reservation.status = "consumed";
    }
  }
}

function deriveWorkOrder(lots: LotSnap[]): Snapshot["workOrderStatus"] {
  if (lots.some((lot) => lot.status === "held")) return "held";
  if (lots.length > 0 && lots.every((lot) => lot.status === "passed")) return "done";
  if (lots.some((lot) => lot.status !== "queued" || lot.lastGoodStation)) return "running";
  return "released";
}
