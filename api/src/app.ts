import Fastify, { type FastifyRequest } from "fastify";
import type pg from "pg";
import { completeStation, faultStation, startStation } from "./callbacks.js";
import { HttpError } from "./http.js";
import { act, readOperator } from "./operator.js";
import { readReplay, type EventPayload } from "./replay.js";
import { releaseWorkOrder } from "./release.js";
import type { RobotAdapter } from "./robot/adapter.js";
import { FakeRobotAdapter, scenarioFromEnv } from "./robot/fake.js";
import { HOLD_CODES, parseStation, type HoldCode } from "./stations.js";

type StationParams = { lotId: string; station: string };
type LotParams = { lotId: string };
type ReleaseBody = { productCode?: string; quantity?: number };
type FaultBody = { code?: string; cycle?: EventPayload["cycle"] };
type ActBody = { lotId?: string; idempotencyKey?: string };

export function buildApp(pool: pg.Pool, robot: RobotAdapter = new FakeRobotAdapter(scenarioFromEnv())) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message });
    }
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/work-orders", async (request, reply) => {
    const body = (request.body ?? {}) as ReleaseBody;
    if (typeof body.productCode !== "string" || body.productCode.trim() === "") {
      throw new HttpError(400, "productCode is required");
    }
    if (typeof body.quantity !== "number") throw new HttpError(400, "quantity must be a positive integer");
    const released = await releaseWorkOrder(pool, { productCode: body.productCode, quantity: body.quantity });
    return reply.code(201).send(released);
  });

  app.post("/lots/:lotId/stations/:station/start", async (request) => {
    const { lotId, station } = stationParams(request);
    return startStation(pool, lotId, station, idempotencyKey(request), {});
  });

  app.post("/lots/:lotId/stations/:station/complete", async (request) => {
    const { lotId, station } = stationParams(request);
    return completeStation(pool, lotId, station, idempotencyKey(request), {});
  });

  app.post("/lots/:lotId/stations/:station/fault", async (request) => {
    const { lotId, station } = stationParams(request);
    const body = (request.body ?? {}) as FaultBody;
    if (!isHoldCode(body.code)) throw new HttpError(400, "fault code is not recognized");
    return faultStation(pool, lotId, station, idempotencyKey(request), {
      code: body.code,
      cycle: body.cycle,
    });
  });

  app.get("/lots/:lotId/replay", async (request) => {
    const { lotId } = request.params as LotParams;
    return readReplay(pool, lotId);
  });

  app.get("/operator", async () => readOperator(pool));

  app.post("/operator/act", async (request) => {
    const body = (request.body ?? {}) as ActBody;
    return act(pool, body, robot);
  });

  return app;
}

function stationParams(request: FastifyRequest): { lotId: string; station: ReturnType<typeof parseStation> } {
  const params = request.params as StationParams;
  return { lotId: params.lotId, station: parseStation(params.station) };
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, "Idempotency-Key is required");
  return value.trim();
}

function isHoldCode(value: string | undefined): value is HoldCode {
  return (HOLD_CODES as readonly string[]).includes(value ?? "");
}
