import { CirclePauseIcon, CirclePlayIcon, EyeIcon, EyeOffIcon, LoaderIcon, PauseIcon, PlayIcon, TrashIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { getAccessToken } from "@/auth-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import SettingGroup from "./SettingGroup";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";

// ──────────────────────────────────────────────
// API helpers
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface ReceiverConfig {
  port: number;
  secret: string;
  log: string;
  debug: boolean;
  memos_url: string;
  pat: string;
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_system_prompt: string;
  ai_max_tokens: number;
  ai_image_max_size: number;
}

interface ReceiverStatus {
  running: boolean;
  pid?: number;
}

// Editable form state (sensitive fields are separate)
interface FormState {
  port: number;
  secret: string;
  log: string;
  debug: boolean;
  memos_url: string;
  pat: string; // empty = keep existing
  ai_base_url: string;
  ai_api_key: string; // empty = keep existing
  ai_model: string;
  ai_system_prompt: string;
  ai_max_tokens: number;
  ai_image_max_size: number;
}

const DEFAULT_FORM: FormState = {
  port: 5000,
  secret: "",
  log: "webhook.log",
  debug: false,
  memos_url: "",
  pat: "",
  ai_base_url: "",
  ai_api_key: "",
  ai_model: "gpt-4o",
  ai_system_prompt: "",
  ai_max_tokens: 512,
  ai_image_max_size: 2048,
};

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────

const WebhookReceiverSection = () => {
  const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM });
  const [original, setOriginal] = useState<FormState>({ ...DEFAULT_FORM });
  const [showPat, setShowPat] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [status, setStatus] = useState<ReceiverStatus>({ running: false });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logPaused, setLogPaused] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Fetch config
  const fetchConfig = useCallback(async () => {
    try {
      const cfg = await apiFetch<ReceiverConfig>(`${API_BASE}/config`);
      const formState: FormState = {
        port: cfg.port,
        secret: cfg.secret,
        log: cfg.log,
        debug: cfg.debug,
        memos_url: cfg.memos_url,
        pat: cfg.pat,
        ai_base_url: cfg.ai_base_url,
        ai_api_key: cfg.ai_api_key,
        ai_model: cfg.ai_model,
        ai_system_prompt: cfg.ai_system_prompt,
        ai_max_tokens: cfg.ai_max_tokens,
        ai_image_max_size: cfg.ai_image_max_size,
      };
      setForm(formState);
      setOriginal(formState);
    } catch {
      // silently ignore
    }
  }, []);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiFetch<ReceiverStatus>(`${API_BASE}/status`);
      setStatus(s);
    } catch {
      // ignore
    }
  }, []);

  // Initial load + periodic status refresh
  useEffect(() => {
    fetchConfig();
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchConfig, fetchStatus]);

  // Auto-scroll logs
  useEffect(() => {
    if (!logPaused && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, logPaused]);

  // SSE for logs — use fetch + ReadableStream (like useLiveMemoRefresh)
  // because EventSource doesn't support Authorization headers.
  useEffect(() => {
    if (!logsExpanded) return;

    const token = getAccessToken();
    if (!token) return;

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`${API_BASE}/logs`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
          credentials: "include",
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split("\n\n");
          buffer = messages.pop() || "";

          for (const message of messages) {
            if (!message.trim()) continue;
            for (const line of message.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const data = JSON.parse(line.slice(6));
                if (data.line) {
                  setLogs((prev) => {
                    const next = [...prev, data.line];
                    return next.length > 1000 ? next.slice(-500) : next;
                  });
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      } catch {
        // abort or network error — fine
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [logsExpanded]);

  const hasChanges = JSON.stringify(form) !== JSON.stringify(original);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Save config
  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const key of Object.keys(form) as (keyof FormState)[]) {
        if (form[key] !== original[key]) {
          body[key] = form[key];
        }
      }

      await apiFetch(`${API_BASE}/config`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      toast.success("配置已保存");
      await fetchConfig();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // Start / Stop
  const handleToggle = async () => {
    setToggling(true);
    try {
      if (status.running) {
        await apiFetch(`${API_BASE}/stop`, { method: "POST" });
        toast.success("接收器已停止");
      } else {
        await apiFetch(`${API_BASE}/start`, { method: "POST" });
        toast.success("接收器已启动");
      }
      await fetchStatus();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setToggling(false);
    }
  };

  return (
    <SettingSection
      title="Webhook 接收器"
      description="管理 AI 自动回复脚本的配置、进程和日志。"
      actions={
        <div className="flex items-center gap-2">
          {status.running && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              运行中 (PID: {status.pid})
            </span>
          )}
          {!status.running && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
              已停止
            </span>
          )}
          <Button
            variant={status.running ? "destructive" : "default"}
            size="sm"
            disabled={toggling}
            onClick={handleToggle}
          >
            {toggling ? (
              <LoaderIcon className="w-4 h-4 mr-1 animate-spin" />
            ) : status.running ? (
              <CirclePauseIcon className="w-4 h-4 mr-1" />
            ) : (
              <CirclePlayIcon className="w-4 h-4 mr-1" />
            )}
            {status.running ? "停止" : "启动"}
          </Button>
        </div>
      }
    >
      {/* ── 基础配置 ── */}
      <SettingGroup title="基础配置">
        <SettingRow label="监听端口" description="Webhook 接收器监听的端口号">
          <Input
            type="number"
            className="w-24"
            value={form.port}
            onChange={(e) => updateField("port", parseInt(e.target.value) || 5000)}
          />
        </SettingRow>
        <SettingRow label="Memos 实例地址" description="后端 API 地址，如 http://localhost:8081">
          <Input
            className="w-64"
            placeholder="http://localhost:8081"
            value={form.memos_url}
            onChange={(e) => updateField("memos_url", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="Personal Access Token" description="Memos 的访问令牌">
          <div className="flex items-center gap-1">
            <Input
              type={showPat ? "text" : "password"}
              className="w-64"
              placeholder="memos_pat_..."
              value={form.pat}
              onChange={(e) => updateField("pat", e.target.value)}
            />
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setShowPat(!showPat)}>
              {showPat ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="HMAC 签名密钥" description="可选，留空不校验">
          <Input
            className="w-64"
            placeholder="可选"
            value={form.secret}
            onChange={(e) => updateField("secret", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="日志文件" description="日志保存路径（相对于脚本目录）">
          <Input
            className="w-48"
            placeholder="webhook.log"
            value={form.log}
            onChange={(e) => updateField("log", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="调试模式" description="开启 DEBUG 级别日志">
          <Switch checked={form.debug} onCheckedChange={(v) => updateField("debug", v)} />
        </SettingRow>
      </SettingGroup>

      {/* ── AI 配置 ── */}
      <SettingGroup title="AI 自动回复">
        <SettingRow label="API 地址" description="OpenAI 兼容 API 的基础 URL">
          <Input
            className="w-64"
            placeholder="https://api.openai.com/v1"
            value={form.ai_base_url}
            onChange={(e) => updateField("ai_base_url", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="API Key" description="AI 服务的 API 密钥">
          <div className="flex items-center gap-1">
            <Input
              type={showApiKey ? "text" : "password"}
              className="w-64"
              placeholder="sk-..."
              value={form.ai_api_key}
              onChange={(e) => updateField("ai_api_key", e.target.value)}
            />
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setShowApiKey(!showApiKey)}>
              {showApiKey ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
            </Button>
          </div>
        </SettingRow>
        <SettingRow label="模型名称">
          <Input
            className="w-40"
            placeholder="gpt-4o"
            value={form.ai_model}
            onChange={(e) => updateField("ai_model", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="系统提示词" description="AI 回复的系统角色设定" vertical>
          <Textarea
            className="w-full min-h-[80px]"
            placeholder="你是一个友好的社区助手..."
            value={form.ai_system_prompt}
            onChange={(e) => updateField("ai_system_prompt", e.target.value)}
          />
        </SettingRow>
        <SettingRow label="最大回复 Token 数" description="限制 AI 回复长度">
          <Input
            type="number"
            className="w-24"
            value={form.ai_max_tokens}
            onChange={(e) => updateField("ai_max_tokens", parseInt(e.target.value) || 512)}
          />
        </SettingRow>
        <SettingRow label="图片最大边长" description="超过此尺寸的图片会被缩放（像素）">
          <Input
            type="number"
            className="w-24"
            value={form.ai_image_max_size}
            onChange={(e) => updateField("ai_image_max_size", parseInt(e.target.value) || 2048)}
          />
        </SettingRow>
      </SettingGroup>

      {/* ── 保存按钮 ── */}
      <div className="flex justify-end">
        <Button disabled={!hasChanges || saving} onClick={handleSave}>
          {saving && <LoaderIcon className="w-4 h-4 mr-1 animate-spin" />}
          保存配置
        </Button>
      </div>

      {/* ── 实时日志 ── */}
      <SettingGroup
        title="实时日志"
        actions={
          <div className="flex items-center gap-1">
            {logsExpanded && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setLogPaused(!logPaused)}>
                  {logPaused ? <PlayIcon className="w-4 h-4" /> : <PauseIcon className="w-4 h-4" />}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setLogs([])}>
                  <TrashIcon className="w-4 h-4" />
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setLogsExpanded(!logsExpanded)}>
              {logsExpanded ? <XIcon className="w-4 h-4" /> : "展开"}
            </Button>
          </div>
        }
      >
        {logsExpanded && (
          <div
            ref={logContainerRef}
            className="w-full h-64 overflow-y-auto bg-zinc-900 text-zinc-200 rounded-lg p-3 font-mono text-xs leading-5"
          >
            {logs.length === 0 && <span className="text-zinc-500">暂无日志</span>}
            {logs.map((line, i) => (
              <div key={i} className={line.includes("[WARNING]") || line.includes("[WARN]") ? "text-yellow-400" : line.includes("[ERROR]") ? "text-red-400" : ""}>
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        )}
      </SettingGroup>
    </SettingSection>
  );
};

export default WebhookReceiverSection;
