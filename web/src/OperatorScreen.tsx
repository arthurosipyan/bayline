import { useEffect, useRef, useState } from "react";
import { act, loadOperator, type OperatorView } from "./api";

export function OperatorScreen() {
  const [view, setView] = useState<OperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const next = await loadOperator();
        if (cancel || pendingRef.current) return;
        setView(next);
        setError(null);
      } catch (caught) {
        if (cancel || pendingRef.current) return;
        setError(caught instanceof Error ? caught.message : "Station link is down.");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, []);

  async function onAct() {
    if (!view?.action || pendingRef.current) return;
    const key = keyRef.current ?? crypto.randomUUID();
    keyRef.current = key;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await act(key, view.lotId);
      keyRef.current = null;
      setView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const mode = view?.headline === "HOLD" ? "hold" : view?.headline === "PASSED" ? "passed" : "ready";

  return (
    <main className={`screen ${mode}`}>
      <p className="mark">Bayline</p>
      <h1 className="headline">{view?.headline ?? "…"}</h1>
      <ul className="lines">
        {(view?.lines ?? []).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="error" role="status">
        {error ?? ""}
      </p>
      {view?.action ? (
        <button className="action" type="button" disabled={pending} onClick={() => void onAct()}>
          {pending ? "Working" : view.action.label}
        </button>
      ) : null}
    </main>
  );
}
