import { useEffect, useState } from "react";
import { getAccessToken } from "@/auth-state";

export type AiReplyStatus = "none" | "pending" | "replied";

interface AiReplyStatusResponse {
  code?: number;
  data?: {
    memo_name?: string;
    status?: AiReplyStatus;
  };
}

/**
 * Fetches the AI auto-reply status for a specific memo from the webhook receiver.
 * Returns `none` when the receiver is offline, the memo has no pending reply,
 * or the memo has already been replied to.
 * Polls every 5 seconds so the UI transitions from pending to replied.
 */
export default function useMemoAiReplyStatus(memoName: string | undefined): AiReplyStatus {
  const [status, setStatus] = useState<AiReplyStatus>("none");

  useEffect(() => {
    if (!memoName) {
      setStatus("none");
      return;
    }

    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const token = getAccessToken();
        const resp = await fetch(
          `/api/v1/instance/webhook-receiver/ai-reply-status?memo_name=${encodeURIComponent(memoName)}`,
          {
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            credentials: "include",
          },
        );
        if (!resp.ok) {
          if (!cancelled) setStatus("none");
          return;
        }
        const data = (await resp.json()) as AiReplyStatusResponse;
        const newStatus = data?.data?.status ?? "none";
        if (!cancelled) setStatus(newStatus);
      } catch {
        if (!cancelled) setStatus("none");
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [memoName]);

  return status;
}
