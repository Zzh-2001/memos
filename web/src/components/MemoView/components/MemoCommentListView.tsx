import { ArrowUpRightIcon, FileIcon, MessageCircleIcon } from "lucide-react";
import { Link } from "react-router-dom";
import UserAvatar from "@/components/UserAvatar";
import { extractMemoIdFromName } from "@/helpers/resource-names";
import { useMemoComments } from "@/hooks/useMemoQueries";
import { useUsersByNames } from "@/hooks/useUserQueries";
import { countLogicalAttachmentItems } from "@/utils/media-item";
import { useTranslate } from "@/utils/i18n";
import { computeCommentAmount, useMemoViewContext, useMemoViewDerived } from "../MemoViewContext";

const MemoCommentListView: React.FC = () => {
  const t = useTranslate();
  const { memo } = useMemoViewContext();
  const { isInMemoDetailPage, commentAmount } = useMemoViewDerived();

  const { data } = useMemoComments(memo.name, { enabled: !isInMemoDetailPage && commentAmount > 0, pageSize: 4 });
  const comments = data?.memos ?? [];
  const displayedComments = comments.slice(0, 3);
  const hasMoreComments = comments.length > 3;
  const { data: commentCreators } = useUsersByNames(displayedComments.map((comment) => comment.creator));

  if (isInMemoDetailPage || commentAmount === 0) {
    return null;
  }

  return (
    <div className="border border-t-0 border-border rounded-b-lg px-4 pt-2 pb-3 flex flex-col gap-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{t("memo.comment.self")}{commentAmount > 1 ? ` (${commentAmount})` : ""}</span>
        <Link
          to={`/${memo.name}#comments`}
          className="flex items-center gap-0.5 text-xs text-muted-foreground/80 hover:underline underline-offset-2 transition-colors"
        >
          查看全部
          <ArrowUpRightIcon className="w-3 h-3" />
        </Link>
      </div>
      {displayedComments.map((comment) => {
        const uid = extractMemoIdFromName(comment.name);
        const creator = commentCreators?.get(comment.creator);
        const content = comment.snippet || comment.content;
        const hasContent = content.trim().length > 0;
        const hasAttachments = comment.attachments.length > 0;
        const childCommentCount = computeCommentAmount(comment);
        return (
          <Link
            key={comment.name}
            to={`/${memo.name}#${uid}`}
            viewTransition
            className="rounded-md bg-muted/40 px-2 py-1.5 transition-colors hover:bg-muted/60 min-w-0"
          >
            <div className="flex items-start gap-2 min-w-0">
              <UserAvatar avatarUrl={creator?.avatarUrl} className="w-5 h-5 rounded-md shrink-0 mt-0.5" />
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-xs font-medium text-foreground truncate">
                    {creator?.displayName || creator?.username}
                  </span>
                  {hasAttachments && (
                    <div className="shrink-0 text-muted-foreground/70 inline-flex justify-center items-center gap-0.5">
                      <FileIcon className="w-3 h-3 inline-block" />
                      <span className="text-xs">{countLogicalAttachmentItems(comment.attachments)}</span>
                    </div>
                  )}
                </div>
                {hasContent && (
                  <span className="text-xs text-muted-foreground truncate">
                    {content}
                  </span>
                )}
              </div>
              {childCommentCount > 0 && (
                <div className="shrink-0 flex items-center gap-0.5 text-xs text-muted-foreground/70 ml-1 mt-0.5">
                  <MessageCircleIcon className="w-3 h-3" />
                  <span>{childCommentCount}</span>
                </div>
              )}
            </div>
          </Link>
        );
      })}
      {hasMoreComments && (
        <Link
          to={`/${memo.name}#comments`}
          className="mt-1 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors flex items-center gap-1"
        >
          <span className="w-4 border-t border-muted-foreground/30" />
          还有 {commentAmount - 3} 条评论
          <ArrowUpRightIcon className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
};

export default MemoCommentListView;
