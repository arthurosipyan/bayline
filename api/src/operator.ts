import type pg from "pg";
import { completeStation, faultStation, startStation } from "./callbacks.js";
import { HttpError } from "./http.js";
import { releaseWorkOrder } from "./release.js";
import type { LotStatus, WorkOrderStatus } from "./replay.js";
import { executeCycle } from "./robot/pickPlace.js";
import type { RobotAdapter } from "./robot/adapter.js";
import {
  PRODUCT_CODE,
  actionLabel,
  nextStation,
  stationHeadline,
  stationLabel,
  type HoldCode,
  type Station,
} from "./stations.js";

export type OperatorView = {
  headline: string;
  lines: string[];
  action: { label: string } | null;
  lotId: string | null;
  serial: string | null;
  lotStatus: LotStatus | null;
  workOrderStatus: WorkOrderStatus | null;
  currentStation: Station | null;
  lastGoodStation: Station | null;
  holdCode: HoldCode | null;
};

type LotRow = {
  id: string;
  serial: string;
  status: LotStatus;
  current_station: Station | null;
  last_good_station: Station | null;
  hold_code: HoldCode | null;
  work_order_status: WorkOrderStatus;
};

type ReservationRow = { part_number: string; status: "held" | "consumed" | "released" };

type ActBody = {
  lotId?: string;
  idempotencyKey?: string;
};

export async function readOperator(pool: pg.Pool): Promise<OperatorView> {
  const selected = await pool.query<{ id: string }>(
    `SELECT l.id
     FROM lots l
     ORDER BY
       CASE l.status
         WHEN 'held' THEN 0
         WHEN 'in_station' THEN 1
         WHEN 'queued' THEN 2
         WHEN 'passed' THEN 3
         ELSE 4
       END,
       l.created_at
     LIMIT 1`,
  );
  if (!selected.rowCount) return idleView();
  return viewForLot(pool, selected.rows[0].id);
}

export async function act(pool: pg.Pool, body: ActBody, robot: RobotAdapter): Promise<OperatorView> {
  const key = body.idempotencyKey?.trim();
  if (!key) throw new HttpError(400, "idempotencyKey is required");

  const current = await readOperator(pool);
  if (!current.lotId || !current.lotStatus) {
    if (body.lotId) throw new HttpError(409, "no lot is waiting");
    await releaseWorkOrder(pool, { productCode: PRODUCT_CODE, quantity: 1 });
    return readOperator(pool);
  }

  if (body.lotId && body.lotId !== current.lotId) throw new HttpError(409, "lot is not the active lot");
  if ((await hasEvent(pool, `${key}:terminal`)) || (await hasEvent(pool, `${key}:complete`))) {
    return readOperator(pool);
  }
  if (current.lotStatus === "held" || current.lotStatus === "passed" || current.lotStatus === "scrapped") {
    throw new HttpError(409, "lot is not waiting for an action");
  }

  if (current.lotStatus === "queued") {
    const station = nextStation(current.lastGoodStation);
    if (!station) throw new HttpError(409, "lot is not waiting for an action");
    if (station === "pick_place") await runPickPlace(pool, current.lotId, key, robot);
    else await finishManual(pool, current.lotId, station, key);
    return readOperator(pool);
  }

  if (current.lotStatus === "in_station" && current.currentStation === "pick_place") {
    await finishPickPlace(pool, current.lotId, `${key}:terminal`, robot);
    return readOperator(pool);
  }

  if (current.lotStatus === "in_station" && current.currentStation) {
    if (!(await hasEvent(pool, `${key}:complete`))) {
      await completeStation(pool, current.lotId, current.currentStation, `${key}:complete`, {});
    }
    return readOperator(pool);
  }

  throw new HttpError(409, "lot is not waiting for an action");
}

async function finishManual(pool: pg.Pool, lotId: string, station: Station, key: string) {
  if (await hasEvent(pool, `${key}:complete`)) return;
  if (!(await hasEvent(pool, `${key}:start`))) await startStation(pool, lotId, station, `${key}:start`, {});
  await completeStation(pool, lotId, station, `${key}:complete`, {});
}

async function runPickPlace(pool: pg.Pool, lotId: string, key: string, robot: RobotAdapter) {
  if (await hasEvent(pool, `${key}:terminal`)) return;
  if (!(await hasEvent(pool, `${key}:start`))) {
    await startStation(pool, lotId, "pick_place", `${key}:start`, {});
  }
  await finishPickPlace(pool, lotId, `${key}:terminal`, robot);
}

async function finishPickPlace(pool: pg.Pool, lotId: string, terminalKey: string, robot: RobotAdapter) {
  if (await hasEvent(pool, terminalKey)) return;
  const outcome = await executeCycle(robot);
  if (outcome.ok) {
    await completeStation(pool, lotId, "pick_place", terminalKey, { cycle: outcome.cycle });
    return;
  }
  await faultStation(pool, lotId, "pick_place", terminalKey, { code: outcome.code, cycle: outcome.cycle });
}

async function hasEvent(pool: pg.Pool, idempotencyKey: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM station_events WHERE idempotency_key = $1", [idempotencyKey]);
  return Boolean(result.rowCount);
}

async function viewForLot(pool: pg.Pool, lotId: string): Promise<OperatorView> {
  const lotResult = await pool.query<LotRow>(
    `SELECT l.id, l.serial, l.status, l.current_station, l.last_good_station, l.hold_code,
            w.status AS work_order_status
     FROM lots l
     JOIN work_orders w ON w.id = l.work_order_id
     WHERE l.id = $1`,
    [lotId],
  );
  const lot = lotResult.rows[0];
  if (!lot) return idleView();

  const reservations = await pool.query<ReservationRow>(
    `SELECT b.part_number, r.status
     FROM reservations r
     JOIN bom_items b ON b.id = r.bom_item_id
     WHERE r.lot_id = $1`,
    [lotId],
  );

  const base = {
    lotId: lot.id,
    serial: lot.serial,
    lotStatus: lot.status,
    workOrderStatus: lot.work_order_status,
    currentStation: lot.current_station,
    lastGoodStation: lot.last_good_station,
    holdCode: lot.hold_code,
  };

  if (lot.status === "held") {
    return {
      ...base,
      headline: "HOLD",
      lines: holdLines(lot, reservations.rows),
      action: null,
    };
  }

  if (lot.status === "passed") {
    return { ...base, headline: "PASSED", lines: [lot.serial], action: null };
  }

  const station = lot.status === "in_station" ? lot.current_station : nextStation(lot.last_good_station);
  if (!station) return { ...base, headline: "IDLE", lines: [lot.serial], action: null };

  const lines = [lot.serial];
  if (lot.last_good_station) lines.push(`Last good station: ${stationLabel(lot.last_good_station)}`);
  return {
    ...base,
    headline: stationHeadline(station),
    lines,
    action: { label: actionLabel(station) },
  };
}

function holdLines(lot: LotRow, reservations: ReservationRow[]): string[] {
  const where = lot.current_station === "pick_place" ? "Pick and place faulted" : `${lot.current_station ?? "Station"} faulted`;
  return [
    lot.serial,
    `Last good station: ${lot.last_good_station ? stationLabel(lot.last_good_station) : "none"}`,
    where,
    lot.hold_code === "FAULT_MID_CYCLE" ? "Gripped housing HSG-100. Did not place." : "Arm timed out before the grip.",
    reservationLine(reservations),
  ];
}

function reservationLine(reservations: ReservationRow[]): string {
  const held = reservations.some((reservation) => reservation.status === "held");
  const consumed = reservations.some((reservation) => reservation.status === "consumed");
  if (!held && consumed) return "Remaining inventory reservation released.";
  return "Inventory reservation released.";
}

function idleView(): OperatorView {
  return {
    headline: "IDLE",
    lines: [],
    action: { label: "Release work order" },
    lotId: null,
    serial: null,
    lotStatus: null,
    workOrderStatus: null,
    currentStation: null,
    lastGoodStation: null,
    holdCode: null,
  };
}
