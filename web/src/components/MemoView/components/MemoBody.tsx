import { AttachmentListView, LocationDisplayView, RelationListView } from "@/components/MemoMetadata";
import { cn } from "@/lib/utils";
import useNavigateTo from "@/hooks/useNavigateTo";
import { MemoRelation_Type } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { useCallback } from "react";
import MemoContent from "../../MemoContent";
import { MemoReactionListView } from "../../MemoReactionListView";
import { useMemoHandlers } from "../hooks";
import { useMemoViewContext, useMemoViewDerived } from "../MemoViewContext";
import type { MemoBodyProps } from "../types";

const isInteractiveElement = (el: HTMLElement): boolean => {
  const interactiveTags = ["A", "BUTTON", "IMG", "INPUT", "TEXTAREA", "SELECT", "AUDIO", "VIDEO"];
  if (interactiveTags.includes(el.tagName)) return true;
  if (el.closest("a") || el.closest("button") || el.closest("input")) return true;
  if (el.closest("[data-blur-overlay]")) return true;
  if (el.closest("[data-state]")) return true;
  if (el.getAttribute("role") === "button") return true;
  return false;
};

const BlurOverlay: React.FC<{ onClick?: () => void }> = ({ onClick }) => {
  const t = useTranslate();
  return (
    <div className="absolute inset-0 z-10 pt-4 flex items-center justify-center" onClick={onClick} data-blur-overlay>
      <button
        type="button"
        className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-accent hover:bg-accent hover:text-foreground"
      >
        {t("memo.click-to-show-sensitive-content")}
      </button>
    </div>
  );
};

const MemoBody: React.FC<MemoBodyProps> = ({ compact }) => {
  const { memo, parentPage, showBlurredContent, blurred, readonly, openEditor, openPreview, toggleBlurVisibility } = useMemoViewContext();
  const { isInMemoDetailPage } = useMemoViewDerived();
  const navigateTo = useNavigateTo();

  const { handleMemoContentClick, handleMemoContentDoubleClick } = useMemoHandlers({ readonly, openEditor, openPreview });

  const handleGotoMemoDetailPage = useCallback(
    (e: React.MouseEvent) => {
      if (isInMemoDetailPage) return;
      const target = e.target as HTMLElement;
      if (isInteractiveElement(target)) return;
      const selection = window.getSelection()?.toString();
      if (selection && selection.length > 0) return;
      navigateTo(`/${memo.name}`, { state: { from: parentPage } });
    },
    [isInMemoDetailPage, memo.name, parentPage, navigateTo],
  );

  const referencedMemos = memo.relations.filter((relation) => relation.type === MemoRelation_Type.REFERENCE);

  return (
    <>
      <div
        className={cn(
          "w-full flex flex-col justify-start items-start gap-2",
          blurred && !showBlurredContent && "blur-lg transition-all duration-200",
          !isInMemoDetailPage && "cursor-pointer",
        )}
        onClick={handleGotoMemoDetailPage}
      >
        <MemoContent
          key={`${memo.name}-${memo.updateTime}`}
          content={memo.content}
          onClick={handleMemoContentClick}
          onDoubleClick={handleMemoContentDoubleClick}
          compact={memo.pinned ? false : compact} // Always show full content when pinned
        />
        <AttachmentListView attachments={memo.attachments} onImagePreview={openPreview} />
        <RelationListView relations={referencedMemos} currentMemoName={memo.name} parentPage={parentPage} />
        {memo.location && <LocationDisplayView location={memo.location} />}
        <MemoReactionListView memo={memo} reactions={memo.reactions} />
      </div>

      {blurred && !showBlurredContent && <BlurOverlay onClick={toggleBlurVisibility} />}
    </>
  );
};

export default MemoBody;
