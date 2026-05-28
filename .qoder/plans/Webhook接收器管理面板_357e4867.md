# Webhook 接收器管理面板

## 概述

在 memos 管理界面的"系统设置 > 全局 Webhook"区域下方新增 **Webhook 接收器** 管理面板，包含三个功能：
1. 配置编辑（表单式，非原始 JSON）
2. 进程启停（一键启动/停止 Python 接收器）
3. 实时日志查看（SSE 推送）

## 架构

```
管理员浏览器
  ├── 配置表单 ←→ PUT /api/v1/instance/webhook-receiver/config
  ├── 启停按钮 ←→ POST /api/v1/instance/webhook-receiver/start|stop
  ├── 状态指示 ←→ GET  /api/v1/instance/webhook-receiver/status
  └── 日志面板 ←→ SSE  /api/v1/instance/webhook-receiver/logs
                      ↓
              memos Go 后端
              ├── 读写 config.json 文件
              ├── os/exec 管理 python3 进程
              └── tail webhook.log → SSE 推送
                      ↓
              python3 receiver.py（子进程）
```

## Task 1: 后端 API — 配置读写

新建 `server/router/api/v1/webhook_receiver.go`

- `GET /api/v1/instance/webhook-receiver/config`：读取 `scripts/webhook/config.json`，敏感字段（pat, ai_api_key）返回掩码提示
- `PUT /api/v1/instance/webhook-receiver/config`：写入 config.json，空字符串字段保留原值（与现有 AI Provider API 保持一致的 key-preservation 策略）
- config.json 路径基于 `--data` 目录（`{data}/../scripts/webhook/config.json`），若不存在返回默认配置
- 所有接口需 admin 权限（复用 `makeGlobalWebhookHandler` 模式）

请求/响应结构：
```go
type WebhookReceiverConfig struct {
    Port           int    `json:"port"`
    Secret         string `json:"secret"`
    Log            string `json:"log"`
    Debug          bool   `json:"debug"`
    MemosURL       string `json:"memos_url"`
    PatSet         bool   `json:"pat_set"`          // 掩码标记
    PatHint        string `json:"pat_hint"`         // "memo...ozt"
    AiBaseURL      string `json:"ai_base_url"`
    AiApiKeySet    bool   `json:"ai_api_key_set"`
    AiApiKeyHint   string `json:"ai_api_key_hint"`
    AiModel        string `json:"ai_model"`
    AiSystemPrompt string `json:"ai_system_prompt"`
    AiMaxTokens    int    `json:"ai_max_tokens"`
    AiImageMaxSize int    `json:"ai_image_max_size"`
}
```

## Task 2: 后端 API — 进程管理

同文件 `webhook_receiver.go`，在 `APIV1Service` 上新增状态字段：

```go
type webhookReceiverManager struct {
    mu       sync.Mutex
    cmd      *exec.Cmd
    running  bool
    configPath string  // config.json 绝对路径
    scriptPath string  // receiver.py 绝对路径
    logPath    string  // webhook.log 绝对路径
}
```

- `POST /api/v1/instance/webhook-receiver/start`：
  - 检查 python3 可用性（`exec.LookPath("python3")`）
  - 启动 `python3 {scriptPath}`，工作目录设为脚本目录
  - 记录 cmd 引用，设置 `cmd.Process` 退出回调清理状态
  - 若已在运行，返回 409 Conflict
- `POST /api/v1/instance/webhook-receiver/stop`：
  - 发送 `cmd.Process.Signal(syscall.SIGTERM)`
  - 等待最多 5s，超时则 `Kill()`
  - 若未运行，返回 409 Conflict
- `GET /api/v1/instance/webhook-receiver/status`：
  - 返回 `{"running": true/false, "pid": 12345}` 或 `{"running": false}`
- memos 优雅关闭时自动停止子进程（在 `server.Shutdown` 中调用 stop）

## Task 3: 后端 API — 实时日志 SSE

- `GET /api/v1/instance/webhook-receiver/logs`：SSE 端点
  - 使用独立的 `LogHub`（简化版 SSEHub，只做 fan-out）
  - receiver 进程的 stdout/stderr 通过 `cmd.Stdout` pipe 实时读取 → 写入 logPath → 广播到 LogHub
  - 新连接建立时，先推送最近 N 行日志（`tail -n 200`），然后持续接收新行
  - 事件格式：`data: {"line": "2026-05-26 10:00:00 [INFO] ..."}\n\n`
  - 客户端断开时自动 Unsubscribe

## Task 4: 路由注册

修改 `server/router/api/v1/v1.go`：

```go
// Register webhook receiver management endpoints (admin-only).
s.RegisterWebhookReceiverRoutes(gwGroup)
```

在 `webhook_receiver.go` 中实现 `RegisterWebhookReceiverRoutes`，复用 admin 认证中间件。

## Task 5: 前端 — 配置表单 + 启停 + 日志面板

扩展 `web/src/components/Settings/GlobalWebhookSection.tsx` 或在其下方新建 `WebhookReceiverSection.tsx`：

### 5.1 配置表单
- 使用 Input/Select 组件渲染各配置项（非原始 JSON 编辑器）
- 敏感字段（PAT、AI API Key）用 password input，已设置时显示 hint
- 底部"保存配置"按钮，调用 `PUT /api/v1/instance/webhook-receiver/config`

### 5.2 进程控制
- 顶部状态栏：运行状态指示灯（绿/灰）+ PID + 运行时长
- "启动"/"停止"按钮（互斥，根据状态禁用其中一个）
- 启动前自动保存配置

### 5.3 日志面板
- 底部可折叠的日志面板，展开后通过 SSE 订阅 `/api/v1/instance/webhook-receiver/logs`
- 深色背景 monospace 字体，自动滚动到底部
- "暂停滚动"按钮 + "清除"按钮
- 面板折叠时断开 SSE 连接

## Task 6: 前端路由与集成

- 在 `web/src/components/Settings/` 中将新 Section 添加到管理员设置页面
- 添加 i18n 翻译 key（中文）

## 涉及文件清单

| 操作 | 文件路径 |
|------|----------|
| 新建 | `server/router/api/v1/webhook_receiver.go` |
| 修改 | `server/router/api/v1/v1.go` — 注册路由 |
| 修改 | `server/server.go` — shutdown 时停止子进程 |
| 新建 | `web/src/components/Settings/WebhookReceiverSection.tsx` |
| 修改 | `web/src/components/Settings/` 管理员页面 — 引入新 Section |
| 不变 | `scripts/webhook/receiver.py` — 无需修改 |
| 不变 | `scripts/webhook/config.example.json` — 无需修改 |

## 注意事项

- config.json 路径：基于 memos 工作目录 `scripts/webhook/config.json`，若从 Docker 运行则需考虑路径映射
- Python3 依赖：启动前检查 `python3` 可用性，不可用时在 UI 给出提示
- 进程孤儿问题：memos 异常退出时子进程可能残留，启动前检查端口占用并提示
- 安全：所有接口 admin-only；敏感字段写入时允许空值保留原值
