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
ACTIVITY_TYPES = {
    "memos.memo.created": "Memo 创建",
    "memos.memo.updated": "Memo 更新",
    "memos.memo.deleted": "Memo 删除",
    "memos.memo.comment.created": "评论创建",
}

DEFAULT_SYSTEM_PROMPT = "你是一个友好的社区助手。用户发布了一条帖子，请根据帖子内容给出简短、温暖、有意义的回复。回复使用中文，不超过3句话。"

# 运行时配置（由 load_config 注入）
MEMOS_URL = ""
PAT = ""
AI_BASE_URL = ""
AI_API_KEY = ""
AI_MODEL = ""
AI_SYSTEM_PROMPT = ""
AI_MAX_TOKENS = 512
AI_IMAGE_MAX_SIZE = 2048
CURRENT_USER_NAME = ""


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
# 事件处理器
# ──────────────────────────────────────────────

def on_memo_created(payload: dict[str, Any]) -> None:
    """Memo 新建时触发"""
    memo = payload.get("memo", {})
    enable_ai = memo.get("enable_ai_reply", False)
    logging.info(
        "[创建] creator=%s  uid=%s  visibility=%s  enableAiReply=%s  content=%.80s",
        payload.get("creator"),
        memo.get("uid"),
        memo.get("visibility"),
        enable_ai,
        memo.get("content", ""),
    )
    # 示例：把公开 Memo 写入文件归档
    if memo.get("visibility") == "PUBLIC":
        _append_to_archive(memo)

    # AI 自动回复（仅在用户开启时触发，跳过由脚本自己创建的 memo，防止无限递归）
    if (
        enable_ai
        and AI_BASE_URL
        and memo.get("name")
        and not memo.get("parent")
        and payload.get("creator") != CURRENT_USER_NAME
    ):
        messages = build_memo_messages(memo)
        reply = call_ai_model(messages)
        if reply:
            post_comment(memo.get("name"), memo.get("visibility", "PUBLIC"), reply)


def on_memo_updated(payload: dict[str, Any]) -> None:
    """Memo 更新时触发"""
    memo = payload.get("memo", {})
    logging.info(
        "[更新] creator=%s  uid=%s  content=%.80s",
        payload.get("creator"),
        memo.get("uid"),
        memo.get("content", ""),
    )


def on_memo_deleted(payload: dict[str, Any]) -> None:
    """Memo 删除时触发"""
    memo = payload.get("memo", {})
    logging.info(
        "[删除] creator=%s  uid=%s",
        payload.get("creator"),
        memo.get("uid"),
    )


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

def _append_to_archive(memo: dict[str, Any]) -> None:
    """将公开 Memo 追加到 archive.jsonl 文件"""
    archive_path = os.path.join(_script_dir(), "memo_archive.jsonl")
    with open(archive_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(memo, ensure_ascii=False) + "\n")
    logging.debug("已归档 memo uid=%s 到 %s", memo.get("uid"), archive_path)


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

    def do_GET(self) -> None:  # 健康检查
        self.send_response(200)
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
    global AI_MAX_TOKENS, AI_IMAGE_MAX_SIZE, CURRENT_USER_NAME
    WebhookHandler.secret = cfg.get("secret", "")
    MEMOS_URL = str(cfg.get("memos_url", "")).rstrip("/")
    PAT = cfg.get("pat", "")
    AI_BASE_URL = str(cfg.get("ai_base_url", "")).rstrip("/")
    AI_API_KEY = cfg.get("ai_api_key", "")
    AI_MODEL = cfg.get("ai_model", "gpt-4o")
    AI_SYSTEM_PROMPT = cfg.get("ai_system_prompt", DEFAULT_SYSTEM_PROMPT)
    AI_MAX_TOKENS = int(cfg.get("ai_max_tokens", 512))
    AI_IMAGE_MAX_SIZE = int(cfg.get("ai_image_max_size", 1024))
    CURRENT_USER_NAME = fetch_current_user()

    port = cfg.get("port", DEFAULT_PORT)
    server = HTTPServer(("0.0.0.0", port), WebhookHandler)
    logging.info("Webhook 接收服务已启动，监听 0.0.0.0:%d", port)
    if cfg.get("secret"):
        logging.info("HMAC 签名校验已启用")
    if AI_BASE_URL:
        logging.info("AI 自动回复已启用: model=%s, max_tokens=%d", AI_MODEL, AI_MAX_TOKENS)
    logging.info("支持的事件类型: %s", ", ".join(ACTIVITY_TYPES.keys()))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("服务已停止")


if __name__ == "__main__":
    main()
