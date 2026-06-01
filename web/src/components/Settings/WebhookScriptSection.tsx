import { LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { getAccessToken } from "@/auth-state";
import { Button } from "@/components/ui/button";
import SettingSection from "./SettingSection";

const API_BASE = "/api/v1/instance/webhook-receiver";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const resp = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers || {}),
    },
    credentials: "include",
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(body || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

const WebhookScriptSection = () => {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ content: string }>(`${API_BASE}/script`);
        setContent(data.content);
        setOriginal(data.content);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "读取脚本失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`${API_BASE}/script`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      setOriginal(content);
      toast.success("脚本已保存，重启接收器后生效");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = content !== original;

  return (
    <SettingSection
      title="编辑脚本"
      description="直接编辑 receiver.py，保存后重启接收器生效。"
      actions={
        <Button size="sm" disabled={!hasChanges || saving} onClick={handleSave}>
          {saving && <LoaderIcon className="w-4 h-4 mr-1 animate-spin" />}
          保存
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
          <LoaderIcon className="w-4 h-4 mr-2 animate-spin" />
          加载中...
        </div>
      ) : (
        <textarea
          className="w-full h-[60vh] p-4 font-mono text-xs bg-zinc-950 text-zinc-100 rounded-lg resize-none outline-none"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
        />
      )}
    </SettingSection>
  );
};

export default WebhookScriptSection;
