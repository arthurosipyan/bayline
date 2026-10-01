export type OperatorView = {
  headline: string;
  lines: string[];
  action: { label: string } | null;
  lotId: string | null;
  serial: string | null;
  lotStatus: string | null;
  workOrderStatus: string | null;
  currentStation: string | null;
  lastGoodStation: string | null;
  holdCode: string | null;
};

export async function loadOperator(): Promise<OperatorView> {
  const response = await fetch("/api/operator");
  if (!response.ok) throw new Error("Station link is down.");
  return response.json() as Promise<OperatorView>;
}

export async function act(idempotencyKey: string, lotId: string | null): Promise<OperatorView> {
  const response = await fetch("/api/operator/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey, lotId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Action failed.");
  }
  return response.json() as Promise<OperatorView>;
}
