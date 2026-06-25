#!/usr/bin/env python3
"""
Memos Webhook 接收处理脚本（支持 AI 自动回复）
监听 POST 请求，根据事件类型分发处理。
当有新帖子创建时，读取帖子内容（文字+图片+地理位置），
调用 OpenAI 兼容 API 生成回复，并自动创建评论。

用法:
  # 配置文件方式（推荐）
  cp config.example.json config.json   # 编辑 config.json 填入实际值
  python3 receiver.py

  # 环境变量覆盖敏感字段
  AI_API_KEY=sk-xxx MEMOS_PAT=memos_pat_xxx python3 receiver.py

  # 命令行参数（最高优先级）
  python3 receiver.py --ai-base-url https://api.openai.com/v1 --ai-api-key sk-xxx

配置优先级: 配置文件 < 环境变量 < 命令行参数
"""

import argparse
import base64
import hashlib
import hmac
import io
import json
import logging
import os
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


# ──────────────────────────────────────────────
# 配置
# ──────────────────────────────────────────────

DEFAULT_PORT = 5000
# 已回复 memo 持久化文件名（位于脚本所在目录）
REPLIED_MEMOS_FILE = "ai_replied_memos.json"

ACTIVITY_TYPES = {
    "memos.memo.created": "Memo 创建",
    "memos.memo.updated": "Memo 更新",
    "memos.memo.deleted": "Memo 删除",
    "memos.memo.comment.created": "评论创建",
}

# Memos webhook 中 visibility 字段可能是枚举整数值，统一映射为字符串。
VISIBILITY_MAP = {
    0: "VISIBILITY_UNSPECIFIED",
    1: "PRIVATE",
    2: "PROTECTED",
    3: "PUBLIC",
}

DEFAULT_SYSTEM_PROMPT = "你是一个友好的社区助手。用户发布了一条帖子，请根据帖子内容给出简短、温暖、有意义的回复。回复使用中文，不超过3句话。"


def normalize_visibility(visibility: Any) -> str:
    """将 visibility 统一规范化为字符串形式"""
    if isinstance(visibility, int):
        return VISIBILITY_MAP.get(visibility, "")
    if isinstance(visibility, str):
        return visibility
    return ""

# 运行时配置（由 load_config 注入）
MEMOS_URL = ""
PAT = ""
AI_BASE_URL = ""
AI_API_KEY = ""
AI_MODEL = ""
AI_SYSTEM_PROMPT = ""
AI_MAX_TOKENS = 512
AI_IMAGE_MAX_SIZE = 2048
AI_REPLY_DELAY_SECONDS = 120
CURRENT_USER_NAME = ""

# 待回复任务注册表：memo name -> Timer
PENDING_REPLIES: dict[str, threading.Timer] = {}
PENDING_REPLIES_LOCK = threading.Lock()

# memo 最近一次已知状态，用于判断 updated 事件是否需要重置延迟计时
LAST_KNOWN_MEMOS: dict[str, dict[str, Any]] = {}
LAST_KNOWN_MEMOS_LOCK = threading.Lock()

# 已回复过的 memo 集合，防止重复触发 AI 回复
REPLIED_MEMOS: set[str] = set()
REPLIED_MEMOS_LOCK = threading.Lock()


# ──────────────────────────────────────────────
# 配置加载
# ──────────────────────────────────────────────

# 环境变量名映射
ENV_MAP = {
    "port": "WEBHOOK_PORT",
    "secret": "WEBHOOK_SECRET",
    "memos_url": "MEMOS_URL",
    "pat": "MEMOS_PAT",
    "ai_base_url": "AI_BASE_URL",
    "ai_api_key": "AI_API_KEY",
    "ai_model": "AI_MODEL",
    "ai_system_prompt": "AI_SYSTEM_PROMPT",
    "log": "WEBHOOK_LOG",
}

# 需要转 int 的配置键
INT_KEYS = {"port", "ai_max_tokens", "ai_image_max_size"}

# 命令行参数名 → 配置键映射
ARG_MAP = {
    "memos_url": "memos_url",
    "pat": "pat",
    "port": "port",
    "secret": "secret",
    "log": "log",
    "debug": "debug",
    "ai_base_url": "ai_base_url",
    "ai_api_key": "ai_api_key",
    "ai_model": "ai_model",
    "ai_system_prompt": "ai_system_prompt",
    "ai_max_tokens": "ai_max_tokens",
    "ai_image_max_size": "ai_image_max_size",
}


def _script_dir() -> str:
    """返回脚本所在目录的绝对路径"""
    return os.path.dirname(os.path.abspath(__file__))


def load_config(args: argparse.Namespace) -> dict[str, Any]:
    """按三级优先级合并配置：配置文件 → 环境变量 → 命令行参数"""
    # 1. 读取配置文件
    config_path = os.path.join(_script_dir(), "config.json")
    cfg: dict[str, Any] = {}
    if os.path.isfile(config_path):
        try:
            with open(config_path, encoding="utf-8") as f:
                cfg = json.load(f)
            logging.info("已加载配置文件: %s", config_path)
        except (json.JSONDecodeError, OSError) as e:
            logging.warning("读取配置文件失败: %s", e)
    else:
        logging.info("未找到配置文件 %s，使用默认值", config_path)

    # 2. 环境变量覆盖
    for cfg_key, env_name in ENV_MAP.items():
        env_val = os.environ.get(env_name, "")
        if env_val:
            if cfg_key in INT_KEYS:
                try:
                    cfg[cfg_key] = int(env_val)
                except ValueError:
                    pass
            elif cfg_key == "debug":
                cfg[cfg_key] = env_val.lower() in ("1", "true", "yes")
            else:
                cfg[cfg_key] = env_val

    # 3. 命令行参数覆盖（仅当显式传入非默认值时）
    for arg_name, cfg_key in ARG_MAP.items():
        val = getattr(args, arg_name, None)
        if val is None:
            continue
        # 对于字符串参数，空字符串表示未传入，不覆盖
        if isinstance(val, str) and val == "":
            continue
        # 对于 port，默认值 DEFAULT_PORT 表示未传入
        if arg_name == "port" and val == DEFAULT_PORT and cfg.get("port") is not None:
            continue
        # 对于 debug，False 表示未传入（因为 action="store_true" 默认就是 False）
        if arg_name == "debug" and not val:
            continue
        # 对于 int 参数，0 表示未传入
        if arg_name in ("ai_max_tokens", "ai_image_max_size") and val == 0:
            continue
        cfg[cfg_key] = val

    # 填充默认值
    cfg.setdefault("ai_system_prompt", DEFAULT_SYSTEM_PROMPT)
    cfg.setdefault("ai_max_tokens", 512)
    cfg.setdefault("ai_image_max_size", 2048)
    cfg.setdefault("ai_model", "gpt-4o")

    return cfg


# ──────────────────────────────────────────────
# AI 回复
# ──────────────────────────────────────────────

def _request_error_str(e: Exception) -> str:
    """将 urllib 请求异常格式化为简短的错误描述字符串"""
    if isinstance(e, urllib.error.HTTPError):
        body = e.read().decode("utf-8", errors="replace")[:200]
        return f"status={e.code}, body={body}"
    return str(e)


def _download_attachment_image(attachment: dict[str, Any]) -> bytes | None:
    """从 memos 下载图片附件的二进制数据，非图片类型返回 None"""
    att_type = attachment.get("type", "")
    if not att_type.startswith("image/"):
        return None

    # attachment.name 格式: "attachments/{uid}"
    att_name = attachment.get("name", "")
    uid = att_name.split("/")[-1] if "/" in att_name else att_name
    filename = attachment.get("filename", "")
    if not uid or not filename:
        logging.warning("附件缺少 uid 或 filename: %s", att_name)
        return None

    url = f"{MEMOS_URL}/file/attachments/{urllib.parse.quote(uid, safe='')}/{urllib.parse.quote(filename, safe='')}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {PAT}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status == 200:
                return resp.read()
            logging.warning("下载附件失败: %s, status=%d", url, resp.status)
    except Exception as e:
        logging.warning("下载附件失败: %s, %s", url, _request_error_str(e))
    return None


def _compress_image(data: bytes, max_size: int) -> bytes:
    """压缩图片：如果最长边超过 max_size 则等比缩放，输出 JPEG"""
    try:
        from PIL import Image
    except ImportError:
        logging.debug("Pillow 未安装，跳过图片压缩")
        return data

    try:
        img = Image.open(io.BytesIO(data))
        # 转换 RGBA/P 为 RGB
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_size:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
            logging.debug("图片已缩放: %dx%d -> %dx%d", w, h, img.size[0], img.size[1])
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        logging.warning("图片压缩失败，使用原图: %s", e)
        return data


def build_memo_messages(memo: dict[str, Any]) -> list[dict[str, Any]]:
    """将 memo 内容组装为 OpenAI 格式的 messages 列表"""
    # user message content 数组
    parts: list[dict[str, Any]] = []

    # 1. 文字内容
    content = memo.get("content", "")
    if content:
        parts.append({"type": "text", "text": content})

    # 2. 图片附件
    for attachment in memo.get("attachments", []):
        raw = _download_attachment_image(attachment)
        if raw is None:
            continue
        compressed = _compress_image(raw, AI_IMAGE_MAX_SIZE)
        b64 = base64.b64encode(compressed).decode("ascii")
        parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    # 3. 地理位置
    location = memo.get("location")
    if location and isinstance(location, dict):
        placeholder = location.get("placeholder", "")
        lat = location.get("latitude")
        lon = location.get("longitude")
        if placeholder or (lat is not None and lon is not None):
            loc_text = f"位置: {placeholder}"
            if lat is not None and lon is not None:
                loc_text += f" ({lat}, {lon})"
            parts.append({"type": "text", "text": loc_text})

    if not parts:
        parts.append({"type": "text", "text": "(空帖子)"})

    messages = [
        {"role": "system", "content": AI_SYSTEM_PROMPT},
        {"role": "user", "content": parts},
    ]
    return messages


def call_ai_model(messages: list[dict[str, Any]]) -> str:
    """调用 OpenAI 兼容 API 获取回复，返回回复文本；失败返回空字符串"""
    if not AI_BASE_URL or not AI_API_KEY:
        logging.warning("未配置 ai_base_url 或 ai_api_key，跳过 AI 回复")
        return ""

    url = f"{AI_BASE_URL.rstrip('/')}/chat/completions"
    body = json.dumps({
        "model": AI_MODEL,
        "messages": messages,
        "max_tokens": AI_MAX_TOKENS,
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {AI_API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            reply = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if reply:
                logging.info("AI 回复成功: %.80s%s", reply, "..." if len(reply) > 80 else "")
            else:
                logging.warning("AI 返回空回复")
            return reply
    except Exception as e:
        logging.warning("AI API 调用失败: %s", _request_error_str(e))
    return ""


# ──────────────────────────────────────────────
# Memos API 调用
# ──────────────────────────────────────────────

def fetch_current_user() -> str:
    """使用 PAT 获取当前用户 resource name（如 users/admin）"""
    if not MEMOS_URL or not PAT:
        return ""

    req = urllib.request.Request(
        f"{MEMOS_URL}/api/v1/auth/me",
        headers={"Authorization": f"Bearer {PAT}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            user_name = data.get("user", {}).get("name", "")
            if user_name:
                logging.info("当前 PAT 用户: %s", user_name)
            return user_name
    except Exception as e:
        logging.warning("获取当前用户信息失败: %s", e)
        return ""


def post_comment(memo_name: str, visibility: str, content: str) -> None:
    """调用 memos API 为指定 memo 创建评论"""
    if not MEMOS_URL or not PAT:
        logging.warning("未配置 memos-url 或 pat，跳过自动评论")
        return

    url = f"{MEMOS_URL}/api/v1/{memo_name}/comments"
    body = json.dumps({
        "content": content,
        "visibility": visibility,
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {PAT}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_body = resp.read()
            if resp.status == 200:
                logging.info("已为 %s 自动添加评论", memo_name)
                return
            logging.warning(
                "评论创建失败: %s, status=%d, body=%s",
                memo_name, resp.status, resp_body.decode("utf-8", errors="replace"),
            )
    except Exception as e:
        logging.warning("评论创建失败: %s, %s", memo_name, _request_error_str(e))


# ──────────────────────────────────────────────
# AI 回复调度
# ──────────────────────────────────────────────

def fetch_memo(memo_name: str) -> dict[str, Any] | None:
    """使用 PAT 获取 memo 最新状态"""
    if not MEMOS_URL or not PAT:
        return None

    req = urllib.request.Request(
        f"{MEMOS_URL}/api/v1/{memo_name}",
        headers={"Authorization": f"Bearer {PAT}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logging.warning("获取 memo %s 失败: %s", memo_name, _request_error_str(e))
        return None


def _should_reply_to_memo(memo: dict[str, Any]) -> bool:
    """判断当前 memo 状态是否满足 AI 自动回复条件"""
    visibility = normalize_visibility(memo.get("visibility"))
    # webhook payload 使用 snake_case，但 fetch_memo 拉取的 API 响应使用 camelCase。
    enable_ai_reply = memo.get("enable_ai_reply")
    if enable_ai_reply is None:
        enable_ai_reply = memo.get("enableAiReply")
    return (
        enable_ai_reply is True
        and visibility != "PRIVATE"
        and AI_BASE_URL
        and memo.get("name")
        and not memo.get("parent")
    )


def _execute_ai_reply(memo_name: str) -> None:
    """执行 AI 回复：获取最新状态并生成评论"""
    with REPLIED_MEMOS_LOCK:
        if memo_name in REPLIED_MEMOS:
            logging.info("[AI回复] %s 已经回复过，跳过", memo_name)
            return

    memo = fetch_memo(memo_name)
    if not memo:
        logging.warning("[AI回复] 无法获取 %s 最新状态，跳过", memo_name)
        return
    if not _should_reply_to_memo(memo):
        logging.info("[AI回复] %s 当前状态不满足回复条件，跳过", memo_name)
        return

    messages = build_memo_messages(memo)
    reply = call_ai_model(messages)
    if reply:
        post_comment(memo.get("name"), normalize_visibility(memo.get("visibility", "PUBLIC")), reply)
        with REPLIED_MEMOS_LOCK:
            REPLIED_MEMOS.add(memo_name)
        save_replied_memos()
        logging.info("[AI回复] %s 已回复并持久化记录", memo_name)


def _record_last_known_memo(memo: dict[str, Any]) -> None:
    """记录 memo 最近一次已知状态"""
    memo_name = memo.get("name")
    if not memo_name:
        return
    snapshot = {
        "content": memo.get("content", ""),
        "visibility": memo.get("visibility", ""),
        "enable_ai_reply": memo.get("enable_ai_reply", False),
        "attachments": memo.get("attachments", []),
        "location": memo.get("location"),
    }
    with LAST_KNOWN_MEMOS_LOCK:
        LAST_KNOWN_MEMOS[memo_name] = snapshot


def _has_content_related_change(memo: dict[str, Any]) -> bool:
    """与上一次已知状态比较，内容、可见性、AI开关、附件、位置是否有变化"""
    memo_name = memo.get("name")
    if not memo_name:
        return True

    with LAST_KNOWN_MEMOS_LOCK:
        last = LAST_KNOWN_MEMOS.get(memo_name)
        if last is None:
            return True

        return (
            memo.get("content", "") != last.get("content", "")
            or memo.get("visibility", "") != last.get("visibility", "")
            or memo.get("enable_ai_reply", False) != last.get("enable_ai_reply", False)
            or memo.get("attachments", []) != last.get("attachments", [])
            or memo.get("location") != last.get("location")
        )


def schedule_ai_reply(memo_name: str, delay_seconds: int | None = None) -> None:
    """为 memo 调度延迟 AI 回复；若已存在待回复任务则取消并重新计时"""
    if not memo_name:
        return

    with REPLIED_MEMOS_LOCK:
        if memo_name in REPLIED_MEMOS:
            logging.info("[AI回复] %s 已经回复过，不再调度", memo_name)
            return

    delay = AI_REPLY_DELAY_SECONDS if delay_seconds is None else delay_seconds
    if delay <= 0:
        _execute_ai_reply(memo_name)
        return

    with PENDING_REPLIES_LOCK:
        old_timer = PENDING_REPLIES.pop(memo_name, None)
        if old_timer:
            old_timer.cancel()
        timer = threading.Timer(delay, _ai_reply_timer_callback, args=[memo_name])
        timer.daemon = True
        PENDING_REPLIES[memo_name] = timer
        timer.start()
    logging.info("[AI回复] 已为 %s 调度回复，%d 秒后执行", memo_name, delay)


def _ai_reply_timer_callback(memo_name: str) -> None:
    """Timer 回调入口，执行完成后清理注册表"""
    try:
        _execute_ai_reply(memo_name)
    finally:
        with PENDING_REPLIES_LOCK:
            PENDING_REPLIES.pop(memo_name, None)
        with LAST_KNOWN_MEMOS_LOCK:
            LAST_KNOWN_MEMOS.pop(memo_name, None)


def cancel_ai_reply(memo_name: str) -> None:
    """取消 memo 的待回复任务"""
    if not memo_name:
        return

    with PENDING_REPLIES_LOCK:
        timer = PENDING_REPLIES.pop(memo_name, None)
        if timer:
            timer.cancel()
    logging.info("[AI回复] 已取消 %s 的待回复任务", memo_name)


def get_ai_reply_status(memo_name: str) -> dict[str, Any]:
    """查询 memo 的 AI 回复状态"""
    if not memo_name:
        return {"memo_name": memo_name, "status": "none"}

    with REPLIED_MEMOS_LOCK:
        if memo_name in REPLIED_MEMOS:
            return {"memo_name": memo_name, "status": "replied"}

    with PENDING_REPLIES_LOCK:
        if memo_name in PENDING_REPLIES:
            return {"memo_name": memo_name, "status": "pending"}

    return {"memo_name": memo_name, "status": "none"}


def _replied_memos_path() -> str:
    """返回已回复 memo 持久化文件的绝对路径"""
    return os.path.join(_script_dir(), REPLIED_MEMOS_FILE)


def load_replied_memos() -> set[str]:
    """从磁盘加载已回复 memo 集合"""
    path = _replied_memos_path()
    if not os.path.isfile(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return set(data)
        if isinstance(data, dict) and "memos" in data:
            return set(data["memos"])
    except (json.JSONDecodeError, OSError) as e:
        logging.warning("加载已回复 memo 记录失败: %s", e)
    return set()


def save_replied_memos() -> None:
    """将已回复 memo 集合持久化到磁盘"""
    path = _replied_memos_path()
    try:
        with REPLIED_MEMOS_LOCK:
            data = sorted(REPLIED_MEMOS)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError as e:
        logging.warning("保存已回复 memo 记录失败: %s", e)


# ──────────────────────────────────────────────
# 事件处理器
# ──────────────────────────────────────────────

def on_memo_created(payload: dict[str, Any]) -> None:
    """Memo 新建时触发"""
    memo = payload.get("memo", {})
    memo["visibility"] = normalize_visibility(memo.get("visibility"))
    memo_name = memo.get("name")
    enable_ai = memo.get("enable_ai_reply", False)
    logging.info(
        "[创建] creator=%s  uid=%s  visibility=%s  enable_ai_reply=%s  content=%.80s",
        payload.get("creator"),
        memo.get("uid"),
        memo.get("visibility"),
        enable_ai,
        memo.get("content", ""),
    )

    # 记录已知状态
    _record_last_known_memo(memo)

    # 跳过脚本自己创建的 memo，防止递归
    if payload.get("creator") == CURRENT_USER_NAME:
        return

    # 私有 memo 不触发 AI 回复
    if memo.get("visibility") == "PRIVATE":
        logging.info("[创建] 私有 Memo 跳过 AI 自动回复")
        return

    # 用户未开启 AI 回复则不调度
    if not enable_ai:
        return

    if memo_name and not memo.get("parent"):
        schedule_ai_reply(memo_name)


def on_memo_updated(payload: dict[str, Any]) -> None:
    """Memo 更新时触发"""
    memo = payload.get("memo", {})
    memo["visibility"] = normalize_visibility(memo.get("visibility"))
    memo_name = memo.get("name")
    logging.info(
        "[更新] creator=%s  uid=%s  visibility=%s  enable_ai_reply=%s  content=%.80s",
        payload.get("creator"),
        memo.get("uid"),
        memo.get("visibility"),
        memo.get("enable_ai_reply", False),
        memo.get("content", ""),
    )

    if not memo_name:
        return

    # 记录最新状态前获取上一次的 enable_ai_reply
    last_enable_ai = False
    with LAST_KNOWN_MEMOS_LOCK:
        last = LAST_KNOWN_MEMOS.get(memo_name)
        if last is not None:
            last_enable_ai = last.get("enable_ai_reply", False)

    # 检查是否有内容相关变化，或刚刚开启 AI 回复
    should_reschedule = _has_content_related_change(memo)
    ai_just_enabled = memo.get("enable_ai_reply", False) and not last_enable_ai

    # 更新已知状态
    _record_last_known_memo(memo)

    # 脚本自己的更新不处理
    if payload.get("creator") == CURRENT_USER_NAME:
        return

    enable_ai = memo.get("enable_ai_reply", False)
    visibility = memo.get("visibility", "")

    # 关闭 AI 回复或变为私有时，取消待回复任务
    if not enable_ai or visibility == "PRIVATE":
        cancel_ai_reply(memo_name)
        return

    # 内容相关字段变化，或首次开启 AI 回复时，调度/重置延迟回复
    if should_reschedule or ai_just_enabled:
        schedule_ai_reply(memo_name)


def on_memo_deleted(payload: dict[str, Any]) -> None:
    """Memo 删除时触发"""
    memo = payload.get("memo", {})
    memo_name = memo.get("name")
    logging.info(
        "[删除] creator=%s  uid=%s",
        payload.get("creator"),
        memo.get("uid"),
    )

    if memo_name:
        cancel_ai_reply(memo_name)
        with LAST_KNOWN_MEMOS_LOCK:
            LAST_KNOWN_MEMOS.pop(memo_name, None)
        with REPLIED_MEMOS_LOCK:
            if memo_name in REPLIED_MEMOS:
                REPLIED_MEMOS.discard(memo_name)
                save_replied_memos()


def on_comment_created(payload: dict[str, Any]) -> None:
    """评论创建时触发"""
    memo = payload.get("memo", {})
    logging.info(
        "[评论] creator=%s  on_memo=%s  content=%.80s",
        payload.get("creator"),
        memo.get("name"),
        memo.get("content", ""),
    )


# 事件类型 → 处理函数映射
HANDLERS = {
    "memos.memo.created": on_memo_created,
    "memos.memo.updated": on_memo_updated,
    "memos.memo.deleted": on_memo_deleted,
    "memos.memo.comment.created": on_comment_created,
}


# ──────────────────────────────────────────────
# 辅助函数
# ──────────────────────────────────────────────


def verify_signature(secret: str, body: bytes, sig_header: str) -> bool:
    """验证可选的 HMAC-SHA256 签名（X-Memos-Signature: sha256=<hex>）"""
    if not secret:
        return True
    if not sig_header or not sig_header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    provided = sig_header[len("sha256="):]
    return hmac.compare_digest(expected, provided)


# ──────────────────────────────────────────────
# HTTP 处理器
# ──────────────────────────────────────────────

class WebhookHandler(BaseHTTPRequestHandler):
    secret: str = ""

    def log_message(self, fmt: str, *args: Any) -> None:  # 屏蔽默认 access log，改用 logging 模块
        logging.debug("HTTP %s", fmt % args)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/ai-reply-status":
            query = urllib.parse.parse_qs(parsed.query)
            memo_name = query.get("memo_name", [""])[0]
            status = get_ai_reply_status(memo_name)
            body = json.dumps({"code": 0, "data": status}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # 默认健康检查
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "26")
        self.end_headers()
        self.wfile.write(b'{"code":0,"message":"ok"}')

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        # 可选签名校验
        sig = self.headers.get("X-Memos-Signature", "")
        if not verify_signature(self.secret, body, sig):
            logging.warning("签名校验失败，拒绝请求 from %s", self.client_address)
            self._respond(401, "signature verification failed")
            return

        try:
            payload: dict[str, Any] = json.loads(body)
        except json.JSONDecodeError as e:
            logging.error("JSON 解析失败: %s", e)
            self._respond(400, f"invalid json: {e}")
            return

        activity_type = payload.get("activityType", "")
        type_label = ACTIVITY_TYPES.get(activity_type, activity_type)
        logging.info("收到事件: %s (%s)", type_label, activity_type)

        handler = HANDLERS.get(activity_type)
        if handler:
            try:
                handler(payload)
            except Exception as e:  # noqa: BLE001
                logging.exception("处理事件 %s 时出错: %s", activity_type, e)
                self._respond(500, f"handler error: {e}")
                return
        else:
            logging.warning("未知事件类型: %s，已忽略", activity_type)

        # Memos 要求响应体包含 {"code": 0}
        self._respond(200, "ok")

    def _respond(self, status: int, message: str) -> None:
        body = json.dumps({"code": 0 if status == 200 else 1, "message": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ──────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Memos Webhook 接收处理脚本（支持 AI 自动回复）")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口（默认 {DEFAULT_PORT}）")
    p.add_argument("--secret", default="", help="HMAC 签名密钥（可选，留空不校验）")
    p.add_argument("--log", default="", help="日志文件路径（默认输出到 stdout）")
    p.add_argument("--debug", action="store_true", help="开启 DEBUG 级别日志")
    p.add_argument("--memos-url", "-m", default="", help="Memos 实例基础 URL（如 http://localhost:8081）")
    p.add_argument("--pat", "-p", default="", help="管理员 Personal Access Token（memos_pat_...）")
    p.add_argument("--ai-base-url", default="", help="OpenAI 兼容 API 地址（如 https://api.openai.com/v1）")
    p.add_argument("--ai-api-key", default="", help="AI API Key")
    p.add_argument("--ai-model", default="", help="AI 模型名称（如 gpt-4o）")
    p.add_argument("--ai-system-prompt", default="", help="AI 系统提示词")
    p.add_argument("--ai-max-tokens", type=int, default=0, help="AI 最大回复 token 数")
    p.add_argument("--ai-image-max-size", type=int, default=0, help="图片最大边长（超过则缩放）")
    return p


def setup_logging(log_file: str, debug: bool) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        # 将相对路径转为基于脚本目录的绝对路径
        if not os.path.isabs(log_file):
            log_file = os.path.join(_script_dir(), log_file)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )


def main() -> None:
    args = build_arg_parser().parse_args()

    # 合并配置：配置文件 → 环境变量 → 命令行参数
    cfg = load_config(args)

    setup_logging(cfg.get("log", ""), cfg.get("debug", False))

    # 将配置注入模块全局变量
    global MEMOS_URL, PAT, AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_SYSTEM_PROMPT
    global AI_MAX_TOKENS, AI_IMAGE_MAX_SIZE, AI_REPLY_DELAY_SECONDS, CURRENT_USER_NAME
    WebhookHandler.secret = cfg.get("secret", "")
    MEMOS_URL = str(cfg.get("memos_url", "")).rstrip("/")
    PAT = cfg.get("pat", "")
    AI_BASE_URL = str(cfg.get("ai_base_url", "")).rstrip("/")
    AI_API_KEY = cfg.get("ai_api_key", "")
    AI_MODEL = cfg.get("ai_model", "gpt-4o")
    AI_SYSTEM_PROMPT = cfg.get("ai_system_prompt", DEFAULT_SYSTEM_PROMPT)
    AI_MAX_TOKENS = int(cfg.get("ai_max_tokens", 512))
    AI_IMAGE_MAX_SIZE = int(cfg.get("ai_image_max_size", 1024))
    AI_REPLY_DELAY_SECONDS = int(cfg.get("ai_reply_delay_seconds", 120))
    CURRENT_USER_NAME = fetch_current_user()

    # 加载历史已回复 memo 记录，避免重启后状态丢失
    global REPLIED_MEMOS
    loaded = load_replied_memos()
    with REPLIED_MEMOS_LOCK:
        REPLIED_MEMOS.update(loaded)
    logging.info("已加载 %d 条已回复 memo 记录", len(loaded))

    port = cfg.get("port", DEFAULT_PORT)
    server = HTTPServer(("0.0.0.0", port), WebhookHandler)
    logging.info("Webhook 接收服务已启动，监听 0.0.0.0:%d", port)
    if cfg.get("secret"):
        logging.info("HMAC 签名校验已启用")
    if AI_BASE_URL:
        logging.info("AI 自动回复已启用: model=%s, max_tokens=%d, delay=%ds", AI_MODEL, AI_MAX_TOKENS, AI_REPLY_DELAY_SECONDS)
    logging.info("支持的事件类型: %s", ", ".join(ACTIVITY_TYPES.keys()))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("服务已停止")


if __name__ == "__main__":
    main()
