import { BotIcon, BotOffIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import useWebhookReceiverStatus from "@/hooks/useWebhookReceiverStatus";
import { useTranslate } from "@/utils/i18n";
import { validationService } from "../services";
import { useEditorContext } from "../state";
import InsertMenu from "../Toolbar/InsertMenu";
import VisibilitySelector from "../Toolbar/VisibilitySelector";
import type { EditorToolbarProps } from "../types";

export const EditorToolbar: FC<EditorToolbarProps> = ({ onSave, onCancel, memoName, onAudioRecorderClick }) => {
  const t = useTranslate();
  const { state, actions, dispatch } = useEditorContext();
  const { valid } = validationService.canSave(state);
  const receiverStatus = useWebhookReceiverStatus();

  const isSaving = state.ui.isLoading.saving;
  const enableAiReply = state.metadata.enableAiReply;
  const receiverRunning = receiverStatus.running;

  const handleLocationChange = (location: typeof state.metadata.location) => {
    dispatch(actions.setMetadata({ location }));
  };

  const handleToggleFocusMode = () => {
    dispatch(actions.toggleFocusMode());
  };

  const handleVisibilityChange = (visibility: typeof state.metadata.visibility) => {
    dispatch(actions.setMetadata({ visibility }));
  };

  const handleToggleAiReply = () => {
    if (!receiverRunning) return;
    dispatch(actions.setMetadata({ enableAiReply: !enableAiReply }));
  };

  // Tooltip text based on state
  const aiTooltip = !receiverRunning
    ? t("editor.ai-reply-receiver-offline")
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
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`inline-flex items-center px-2 py-1 text-sm rounded transition-colors ${
                  !receiverRunning
                    ? "text-muted-foreground/50 cursor-not-allowed"
                    : enableAiReply
                      ? "text-primary bg-primary/10 hover:bg-primary/20"
                      : "text-muted-foreground opacity-80 hover:opacity-100 hover:bg-accent"
                }`}
                onClick={handleToggleAiReply}
              >
                {!receiverRunning ? (
                  <BotOffIcon className="w-4 h-4 mr-1" />
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
