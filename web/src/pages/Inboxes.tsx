import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema, timestampDate } from "@bufbuild/protobuf/wkt";
import { useQueryClient } from "@tanstack/react-query";
import { sortBy } from "lodash-es";
import { BellIcon, CheckCheckIcon, InboxIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import Empty from "@/components/Empty";
import MemoCommentMessage from "@/components/Inbox/MemoCommentMessage";
import MemoMentionMessage from "@/components/Inbox/MemoMentionMessage";
import MobileHeader from "@/components/MobileHeader";
import { userServiceClient } from "@/connect";
import useMediaQuery from "@/hooks/useMediaQuery";
import { useNotifications, userKeys } from "@/hooks/useUserQueries";
import { cn } from "@/lib/utils";
import { UserNotification, UserNotification_Status, UserNotification_Type } from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";

const Inboxes = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "unread">("all");

  // Fetch notifications with React Query
  const { data: fetchedNotifications = [] } = useNotifications();

  const allNotifications = sortBy(fetchedNotifications, (notification: UserNotification) => {
    return -((notification.createTime ? timestampDate(notification.createTime) : undefined)?.getTime() || 0);
  });

  const notifications = allNotifications.filter((notification) => {
    if (filter === "unread") return notification.status === UserNotification_Status.UNREAD;
    return true;
  });

  const unreadCount = allNotifications.filter((n) => n.status === UserNotification_Status.UNREAD).length;

  const handleMarkAllAsRead = async () => {
    const unreadNotifications = allNotifications.filter(
      (n) => n.status === UserNotification_Status.UNREAD,
    );
    if (unreadNotifications.length === 0) return;

    await Promise.all(
      unreadNotifications.map((n) =>
        userServiceClient.updateUserNotification({
          notification: {
            name: n.name,
            status: UserNotification_Status.ARCHIVED,
          },
          updateMask: create(FieldMaskSchema, { paths: ["status"] }),
        }),
      ),
    );

    await queryClient.invalidateQueries({ queryKey: userKeys.notifications() });
    toast.success(`已将 ${unreadNotifications.length} 条通知标记为已读`);
  };

  const handleClearAll = async () => {
    if (allNotifications.length === 0) return;

    await Promise.all(
      allNotifications.map((n) => userServiceClient.deleteUserNotification({ name: n.name })),
    );

    await queryClient.invalidateQueries({ queryKey: userKeys.notifications() });
    toast.success(`已清除 ${allNotifications.length} 条通知`);
  };

  return (
    <section className="@container w-full max-w-5xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="w-full border border-border flex flex-col justify-start items-start rounded-xl bg-background text-foreground overflow-hidden">
          {/* Header */}
          <div className="w-full px-4 py-4 border-b border-border">
            <div className="flex flex-row justify-between items-center">
              <div className="flex flex-row items-center gap-2">
                <BellIcon className="w-5 h-auto text-muted-foreground" />
                <h1 className="text-xl font-semibold">{t("common.inbox")}</h1>
                {unreadCount > 0 && (
                  <span className="ml-1 px-2 py-0.5 text-xs font-medium rounded-full bg-primary text-primary-foreground">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllAsRead}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md transition-colors"
                    title="一键已读"
                  >
                    <CheckCheckIcon className="w-3.5 h-3.5" />
                    一键已读
                  </button>
                )}
                {allNotifications.length > 0 && (
                  <button
                    onClick={handleClearAll}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                    title="一键清除"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                    一键清除
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="w-full px-4 py-2 border-b border-border bg-muted/30">
            <div className="flex flex-row gap-1">
              <button
                onClick={() => setFilter("all")}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                  filter === "all"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                {t("common.all")} ({allNotifications.length})
              </button>
              <button
                onClick={() => setFilter("unread")}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5",
                  filter === "unread"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                <InboxIcon className="w-3.5 h-auto" />
                {t("inbox.unread")} ({unreadCount})
              </button>
            </div>
          </div>

          {/* Notifications List */}
          <div className="w-full">
            {notifications.length === 0 ? (
              <div className="w-full py-16 flex flex-col justify-center items-center">
                <Empty />
                <p className="mt-4 text-sm text-muted-foreground">
                  {filter === "unread" ? t("inbox.no-unread") : t("message.no-data")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col">
                {notifications.map((notification: UserNotification) => {
                  if (notification.type === UserNotification_Type.MEMO_COMMENT) {
                    return <MemoCommentMessage key={notification.name} notification={notification} />;
                  }
                  if (notification.type === UserNotification_Type.MEMO_MENTION) {
                    return <MemoMentionMessage key={notification.name} notification={notification} />;
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Inboxes;
