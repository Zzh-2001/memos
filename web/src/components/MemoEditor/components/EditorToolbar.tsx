import { BotIcon, BotOffIcon, CheckCircle2, Loader2 } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import useMemoAiReplyStatus from "@/hooks/useMemoAiReplyStatus";
import useWebhookReceiverStatus from "@/hooks/useWebhookReceiverStatus";
import { Visibility, type Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { validationService } from "../services";
import { useEditorContext } from "../state";
import InsertMenu from "../Toolbar/InsertMenu";
import VisibilitySelector from "../Toolbar/VisibilitySelector";
import type { EditorToolbarProps } from "../types";

export const EditorToolbar: FC<EditorToolbarProps> = ({ onSave, onCancel, memo, memoName, parentMemoName, onAudioRecorderClick }) => {
  const t = useTranslate();
  const { state, actions, dispatch } = useEditorContext();
  const { valid } = validationService.canSave(state);
  const receiverStatus = useWebhookReceiverStatus();

  const isSaving = state.ui.isLoading.saving;
  const enableAiReply = state.metadata.enableAiReply;
  const receiverRunning = receiverStatus.running;
  const visibility = state.metadata.visibility;
  const isPrivate = visibility === Visibility.PRIVATE;
  // 编辑已有 memo 时，若原 memo 已开启 AI 回复，则锁定开关不可再更改。
  const isAiReplyLocked = !!memoName && memo?.enableAiReply === true;
  const aiReplyStatus = useMemoAiReplyStatus(memoName);
  const isAiReplyPending = isAiReplyLocked && aiReplyStatus === "pending";
  const isAiReplyReplied = isAiReplyLocked && aiReplyStatus === "replied";
  const aiReplyDisabled = !receiverRunning || isPrivate || isAiReplyLocked;

  const handleLocationChange = (location: typeof state.metadata.location) => {
    dispatch(actions.setMetadata({ location }));
  };

  const handleToggleFocusMode = () => {
    dispatch(actions.toggleFocusMode());
  };

  const handleVisibilityChange = (visibility: typeof state.metadata.visibility) => {
    dispatch(actions.setMetadata({ visibility }));
    // 切换到私有时自动关闭 AI 回复，避免用户误开启无效功能。
    if (visibility === Visibility.PRIVATE && enableAiReply) {
      dispatch(actions.setMetadata({ enableAiReply: false }));
    }
  };

  const handleToggleAiReply = () => {
    if (aiReplyDisabled) return;
    dispatch(actions.setMetadata({ enableAiReply: !enableAiReply }));
  };

  // Tooltip text based on state
  const aiTooltip = !receiverRunning
    ? t("editor.ai-reply-receiver-offline")
    : isPrivate
      ? t("editor.ai-reply-private-memo")
      : isAiReplyReplied
        ? t("editor.ai-reply-replied")
        : isAiReplyPending
          ? t("editor.ai-reply-pending")
          : isAiReplyLocked
            ? t("editor.ai-reply-enabled-locked")
            : enableAiReply
              ? t("editor.ai-reply-enabled")
              : t("editor.ai-reply-disabled");

  return (
    <div className="w-full flex flex-row justify-between items-center mb-2">
      <div className="flex flex-row justify-start items-center">
        <InsertMenu
          isUploading={state.ui.isLoading.uploading}
          location={state.metadata.location}
          onLocationChange={handleLocationChange}
          onToggleFocusMode={handleToggleFocusMode}
          memoName={memoName}
          onAudioRecorderClick={onAudioRecorderClick}
        />
      </div>

      <div className="flex flex-row justify-end items-center gap-2">
        {!parentMemoName && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={`inline-flex items-center px-2 py-1 text-sm rounded transition-colors ${
                    aiReplyDisabled
                      ? "text-muted-foreground/50 cursor-not-allowed"
                      : enableAiReply
                        ? "text-primary bg-primary/10 hover:bg-primary/20"
                        : "text-muted-foreground opacity-80 hover:opacity-100 hover:bg-accent"
                  }`}
                  onClick={handleToggleAiReply}
                >
                  {aiReplyDisabled ? (
                    isAiReplyReplied ? (
                      <CheckCircle2 className="w-4 h-4 mr-1" />
                    ) : isAiReplyPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <BotOffIcon className="w-4 h-4 mr-1" />
                    )
                  ) : enableAiReply ? (
                    <BotIcon className="w-4 h-4 mr-1" />
                  ) : (
                    <BotOffIcon className="w-4 h-4 mr-1" />
                  )}
                  <span>AI</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">{aiTooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <VisibilitySelector value={state.metadata.visibility} onChange={handleVisibilityChange} />

        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
        )}

        <Button onClick={onSave} disabled={!valid || isSaving}>
          {isSaving ? t("editor.saving") : memoName ? t("editor.save") : t("editor.publish")}
        </Button>
      </div>
    </div>
  );
};
