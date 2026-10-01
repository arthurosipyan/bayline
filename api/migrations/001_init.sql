CREATE TABLE bom_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code text NOT NULL,
  part_number text NOT NULL,
  description text NOT NULL,
  qty_per integer NOT NULL CHECK (qty_per > 0),
  UNIQUE (product_code, part_number)
);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('released', 'running', 'held', 'done')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders (id),
  serial text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'in_station', 'held', 'passed', 'scrapped')),
  current_station text CHECK (
    current_station IS NULL
    OR current_station IN ('kit', 'pick_place', 'torque', 'inspect', 'pack')
  ),
  last_good_station text CHECK (
    last_good_station IS NULL
    OR last_good_station IN ('kit', 'pick_place', 'torque', 'inspect', 'pack')
  ),
  hold_code text CHECK (hold_code IS NULL OR hold_code IN ('FAULT_MID_CYCLE', 'TIMEOUT')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE lot_serial_seq;

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES lots (id),
  bom_item_id uuid NOT NULL REFERENCES bom_items (id),
  qty integer NOT NULL CHECK (qty > 0),
  status text NOT NULL CHECK (status IN ('held', 'consumed', 'released')),
  UNIQUE (lot_id, bom_item_id)
);

CREATE TABLE station_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id uuid NOT NULL REFERENCES lots (id),
  station text NOT NULL CHECK (station IN ('kit', 'pick_place', 'torque', 'inspect', 'pack')),
  event_type text NOT NULL CHECK (event_type IN ('started', 'completed', 'faulted')),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX station_events_lot_created_idx ON station_events (lot_id, created_at);

CREATE FUNCTION reject_station_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'station_events is append-only';
END;
$$;

CREATE TRIGGER station_events_append_only
  BEFORE UPDATE OR DELETE ON station_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_station_event_mutation();

INSERT INTO bom_items (product_code, part_number, description, qty_per) VALUES
  ('JA-100', 'HSG-100', 'Housing', 1),
  ('JA-100', 'STR-100', 'Stator', 1),
  ('JA-100', 'RTR-100', 'Rotor', 1),
  ('JA-100', 'BRG-100', 'Bearing', 2),
  ('JA-100', 'ENC-100', 'Encoder', 1),
  ('JA-100', 'FST-100', 'Fastener', 8),
  ('JA-100', 'FLG-100', 'Output flange', 1);
