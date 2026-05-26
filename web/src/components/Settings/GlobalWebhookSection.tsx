import { PlusIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { getAccessToken } from "@/auth-state";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslate } from "@/utils/i18n";
import SettingSection from "./SettingSection";
import SettingTable from "./SettingTable";

interface GlobalWebhook extends Record<string, unknown> {
  id: string;
  title: string;
  url: string;
}

const API_BASE = "/api/v1/instance/global-webhooks";

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

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (hook: GlobalWebhook) => void;
}

function CreateGlobalWebhookDialog({ open, onOpenChange, onSuccess }: CreateDialogProps) {
  const t = useTranslate();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!url) {
      toast.error(t("message.fill-all-required-fields"));
      return;
    }
    setLoading(true);
    try {
      const hook = await apiFetch<GlobalWebhook>(API_BASE, {
        method: "POST",
        body: JSON.stringify({ title, url }),
      });
      onSuccess(hook);
      onOpenChange(false);
      setTitle("");
      setUrl("");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create webhook");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>创建全局 Webhook</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="gw-title">{t("setting.webhook.create-dialog.title")}</Label>
            <Input
              id="gw-title"
              type="text"
              placeholder={t("setting.webhook.create-dialog.an-easy-to-remember-name")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="gw-url">
              {t("setting.webhook.create-dialog.payload-url")} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="gw-url"
              type="text"
              placeholder={t("setting.webhook.create-dialog.url-example-post-receive")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={loading} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={loading} onClick={handleSave}>
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const GlobalWebhookSection = () => {
  const t = useTranslate();
  const [webhooks, setWebhooks] = useState<GlobalWebhook[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GlobalWebhook | undefined>(undefined);

  const fetchWebhooks = async () => {
    try {
      const hooks = await apiFetch<GlobalWebhook[]>(API_BASE);
      setWebhooks(hooks);
    } catch {
      // silently ignore fetch errors (e.g. not admin)
    }
  };

  useEffect(() => {
    fetchWebhooks();
  }, []);

  const handleCreated = (hook: GlobalWebhook) => {
    setWebhooks((prev) => [...prev, hook]);
    toast.success(`全局 Webhook "${hook.title || hook.url}" 创建成功`);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiFetch(`${API_BASE}/${deleteTarget.id}`, { method: "DELETE" });
      setWebhooks((prev) => prev.filter((h) => h.id !== deleteTarget.id));
      toast.success(`已删除全局 Webhook "${deleteTarget.title || deleteTarget.url}"`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete webhook");
    } finally {
      setDeleteTarget(undefined);
    }
  };

  return (
    <SettingSection
      title="全局 Webhook"
      description="管理员配置的全局 Webhook 可接收所有用户的 Memo 事件（创建、更新、删除、评论）。"
      actions={
        <Button onClick={() => setIsCreateOpen(true)}>
          <PlusIcon className="w-4 h-4 mr-2" />
          {t("common.create")}
        </Button>
      }
    >
      <SettingTable
        columns={[
          {
            key: "title",
            header: t("common.name"),
            render: (_, hook: GlobalWebhook) => <span className="text-foreground">{hook.title || <span className="text-muted-foreground italic">无名称</span>}</span>,
          },
          {
            key: "url",
            header: t("setting.webhook.url"),
            render: (_, hook: GlobalWebhook) => (
              <span className="max-w-[300px] inline-block truncate text-foreground" title={hook.url}>
                {hook.url}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (_, hook: GlobalWebhook) => (
              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(hook)}>
                <TrashIcon className="text-destructive w-4 h-auto" />
              </Button>
            ),
          },
        ]}
        data={webhooks}
        emptyMessage="暂无全局 Webhook"
        getRowKey={(hook) => hook.id}
      />

      <CreateGlobalWebhookDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} onSuccess={handleCreated} />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
        title={`删除全局 Webhook "${deleteTarget?.title || deleteTarget?.url || ""}"`}
        description="删除后，该端点将不再接收任何 Memo 事件，此操作不可撤销。"
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={confirmDelete}
        confirmVariant="destructive"
      />
    </SettingSection>
  );
};

export default GlobalWebhookSection;
