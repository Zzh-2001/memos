import { useEffect, useState } from "react";
import { getAccessToken } from "@/auth-state";

interface ReceiverStatus {
  running: boolean;
  pid?: number;
}

const defaultStatus: ReceiverStatus = { running: false };

/**
 * Fetches the webhook receiver process status from the backend.
 * Available to any signed-in user so that non-admin users can know whether
 * AI auto-reply can be enabled for a memo.
 * Returns `running: false` if the API is unreachable.
 */
export default function useWebhookReceiverStatus(): ReceiverStatus {
  const [status, setStatus] = useState<ReceiverStatus>(defaultStatus);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const token = getAccessToken();
        const resp = await fetch("/api/v1/instance/webhook-receiver/status", {
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
        });
        if (!resp.ok) {
          // Non-admin users may get 403 — treat as not running.
          if (!cancelled) setStatus(defaultStatus);
          return;
        }
        const data = (await resp.json()) as ReceiverStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(defaultStatus);
      }
    };

    fetchStatus();
    // Re-check every 30 seconds so the UI stays responsive to start/stop changes.
    const interval = setInterval(fetchStatus, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}
