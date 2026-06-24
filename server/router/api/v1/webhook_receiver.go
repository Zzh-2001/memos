package v1

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/pkg/errors"

	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

// webhookReceiverConfig represents the configuration stored in config.json.
type webhookReceiverConfig struct {
	Port               int    `json:"port"`
	Secret             string `json:"secret"`
	Log                string `json:"log"`
	Debug              bool   `json:"debug"`
	MemosURL           string `json:"memos_url"`
	PAT                string `json:"pat"`
	AiBaseURL          string `json:"ai_base_url"`
	AiAPIKey           string `json:"ai_api_key"`
	AiModel            string `json:"ai_model"`
	AiSystemPrompt     string `json:"ai_system_prompt"`
	AiMaxTokens        int    `json:"ai_max_tokens"`
	AiImageMaxSize     int    `json:"ai_image_max_size"`
	AiReplyDelaySeconds int   `json:"ai_reply_delay_seconds"`
}

// webhookReceiverConfigResponse is the API response with sensitive fields included.
type webhookReceiverConfigResponse struct {
	Port                int    `json:"port"`
	Secret              string `json:"secret"`
	Log                 string `json:"log"`
	Debug               bool   `json:"debug"`
	MemosURL            string `json:"memos_url"`
	PAT                 string `json:"pat"`
	AiBaseURL           string `json:"ai_base_url"`
	AiAPIKey            string `json:"ai_api_key"`
	AiModel             string `json:"ai_model"`
	AiSystemPrompt      string `json:"ai_system_prompt"`
	AiMaxTokens         int    `json:"ai_max_tokens"`
	AiImageMaxSize      int    `json:"ai_image_max_size"`
	AiReplyDelaySeconds int    `json:"ai_reply_delay_seconds"`
}

// webhookReceiverConfigUpdateRequest is the API request for updating config.
type webhookReceiverConfigUpdateRequest struct {
	Port                *int    `json:"port,omitempty"`
	Secret              *string `json:"secret,omitempty"`
	Log                 *string `json:"log,omitempty"`
	Debug               *bool   `json:"debug,omitempty"`
	MemosURL            *string `json:"memos_url,omitempty"`
	PAT                 *string `json:"pat,omitempty"`
	AiBaseURL           *string `json:"ai_base_url,omitempty"`
	AiAPIKey            *string `json:"ai_api_key,omitempty"`
	AiModel             *string `json:"ai_model,omitempty"`
	AiSystemPrompt      *string `json:"ai_system_prompt,omitempty"`
	AiMaxTokens         *int    `json:"ai_max_tokens,omitempty"`
	AiImageMaxSize      *int    `json:"ai_image_max_size,omitempty"`
	AiReplyDelaySeconds *int    `json:"ai_reply_delay_seconds,omitempty"`
}

// webhookReceiverStatusResponse is the API response for status queries.
type webhookReceiverStatusResponse struct {
	Running bool `json:"running"`
	PID     int  `json:"pid,omitempty"`
}

// ──────────────────────────────────────────────
// Process manager
// ──────────────────────────────────────────────

// webhookReceiverManager manages the lifecycle of the Python webhook receiver process.
type webhookReceiverManager struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	running    bool
	cancelFunc context.CancelFunc

	configPath string
	scriptPath string
	logPath    string
	logHub     *logHub
}

func newWebhookReceiverManager(scriptDir string) *webhookReceiverManager {
	return &webhookReceiverManager{
		configPath: filepath.Join(scriptDir, "config.json"),
		scriptPath: filepath.Join(scriptDir, "receiver.py"),
		logPath:    filepath.Join(scriptDir, "webhook.log"),
		logHub:     newLogHub(),
	}
}

// Start launches the Python receiver process.
func (m *webhookReceiverManager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return errors.New("receiver is already running")
	}

	pythonPath, err := exec.LookPath("python3")
	if err != nil {
		return errors.New("python3 is not available on this system")
	}

	scriptDir := filepath.Dir(m.scriptPath)
	ctx, cancel := context.WithCancel(context.Background())

	// Use just "receiver.py" as the argument since cmd.Dir is set to the script directory.
	cmd := exec.CommandContext(ctx, pythonPath, "receiver.py")
	cmd.Dir = scriptDir
	cmd.Env = append(os.Environ(), fmt.Sprintf("PYTHONUNBUFFERED=1"))

	// Capture stdout and stderr as log lines.
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return errors.Wrap(err, "failed to create stdout pipe")
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return errors.Wrap(err, "failed to create stderr pipe")
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return errors.Wrap(err, "failed to start receiver process")
	}

	m.cmd = cmd
	m.running = true
	m.cancelFunc = cancel

	// Stream stdout and stderr to log hub and log file.
	go m.streamOutput(stdout, "stdout")
	go m.streamOutput(stderr, "stderr")

	// Monitor process exit.
	go func() {
		err := cmd.Wait()
		m.mu.Lock()
		m.running = false
		m.cmd = nil
		m.cancelFunc = nil
		m.mu.Unlock()

		if err != nil && ctx.Err() == nil {
			slog.Warn("Webhook receiver process exited with error", "err", err)
			m.logHub.Broadcast("receiver process exited with error: " + err.Error())
		} else {
			slog.Info("Webhook receiver process stopped")
			m.logHub.Broadcast("receiver process stopped")
		}
	}()

	slog.Info("Webhook receiver process started", "pid", cmd.Process.Pid)
	return nil
}

// Stop terminates the Python receiver process.
func (m *webhookReceiverManager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.running || m.cmd == nil || m.cmd.Process == nil {
		return errors.New("receiver is not running")
	}

	if err := m.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		return errors.Wrap(err, "failed to send SIGTERM")
	}

	// Wait in a goroutine with a timeout; kill if needed.
	done := make(chan struct{})
	go func() {
		// Wait releases resources. We only care that it eventually terminates.
		_ = m.cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Process exited gracefully.
	case <-time.After(5 * time.Second):
		_ = m.cmd.Process.Kill()
		slog.Warn("Webhook receiver process killed after timeout")
		m.logHub.Broadcast("receiver process killed after timeout")
	}

	m.running = false
	m.cmd = nil
	m.cancelFunc = nil
	return nil
}

// Status returns the current process status.
func (m *webhookReceiverManager) Status() webhookReceiverStatusResponse {
	m.mu.Lock()
	defer m.mu.Unlock()

	resp := webhookReceiverStatusResponse{Running: m.running}
	if m.running && m.cmd != nil && m.cmd.Process != nil {
		resp.PID = m.cmd.Process.Pid
	}
	return resp
}

// Shutdown stops the receiver process (called during server shutdown).
func (m *webhookReceiverManager) Shutdown() {
	_ = m.Stop()
	m.logHub.Close()
}

// ReadConfig reads and returns the config.json file.
func (m *webhookReceiverManager) ReadConfig() (*webhookReceiverConfig, error) {
	data, err := os.ReadFile(m.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultWebhookReceiverConfig(), nil
		}
		return nil, errors.Wrap(err, "failed to read config file")
	}

	cfg := &webhookReceiverConfig{}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, errors.Wrap(err, "failed to parse config file")
	}
	return cfg, nil
}

// WriteConfig writes the config.json file.
func (m *webhookReceiverManager) WriteConfig(cfg *webhookReceiverConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return errors.Wrap(err, "failed to marshal config")
	}
	if err := os.WriteFile(m.configPath, data, 0o600); err != nil {
		return errors.Wrap(err, "failed to write config file")
	}
	return nil
}

// ReadScript reads and returns the receiver.py script content.
func (m *webhookReceiverManager) ReadScript() (string, error) {
	data, err := os.ReadFile(m.scriptPath)
	if err != nil {
		return "", errors.Wrap(err, "failed to read script file")
	}
	return string(data), nil
}

// WriteScript writes the receiver.py script content.
func (m *webhookReceiverManager) WriteScript(content string) error {
	if err := os.WriteFile(m.scriptPath, []byte(content), 0o644); err != nil {
		return errors.Wrap(err, "failed to write script file")
	}
	return nil
}

// ReadRecentLogs returns the last N lines from the log file.
func (m *webhookReceiverManager) ReadRecentLogs(n int) []string {
	data, err := os.ReadFile(m.logPath)
	if err != nil {
		return nil
	}

	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func (m *webhookReceiverManager) streamOutput(r io.Reader, _ string) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		m.logHub.Broadcast(line)
		// Also append to log file.
		f, err := os.OpenFile(m.logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = fmt.Fprintln(f, line)
			_ = f.Close()
		}
	}
}

func defaultWebhookReceiverConfig() *webhookReceiverConfig {
	return &webhookReceiverConfig{
		Port:                5000,
		AiModel:             "gpt-4o",
		AiSystemPrompt:      "你是一个友好的社区助手。用户发布了一条帖子，请根据帖子内容给出简短、温暖、有意义的回复。回复使用中文，不超过3句话。",
		AiMaxTokens:         512,
		AiImageMaxSize:      2048,
		AiReplyDelaySeconds: 120,
	}
}

// ──────────────────────────────────────────────
// Log hub (SSE fan-out)
// ──────────────────────────────────────────────

type logHubClient struct {
	ch chan string
}

type logHub struct {
	mu      sync.RWMutex
	clients map[*logHubClient]struct{}
	closed  bool
}

func newLogHub() *logHub {
	return &logHub{
		clients: make(map[*logHubClient]struct{}),
	}
}

func (h *logHub) Subscribe() *logHubClient {
	c := &logHubClient{ch: make(chan string, 64)}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		close(c.ch)
	} else {
		h.clients[c] = struct{}{}
	}
	return c
}

func (h *logHub) Unsubscribe(c *logHubClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.ch)
	}
}

func (h *logHub) Broadcast(line string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.ch <- line:
		default:
			// Drop for slow clients.
		}
	}
}

func (h *logHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for c := range h.clients {
		delete(h.clients, c)
		close(c.ch)
	}
}

// ──────────────────────────────────────────────
// HTTP handlers
// ──────────────────────────────────────────────

// RegisterWebhookReceiverRoutes registers webhook receiver management endpoints.
//
//	GET    /api/v1/instance/webhook-receiver/config   read config   (admin only)
//	PUT    /api/v1/instance/webhook-receiver/config   update config (admin only)
//	GET    /api/v1/instance/webhook-receiver/status   get process status (authenticated)
//	POST   /api/v1/instance/webhook-receiver/start    start the process (admin only)
//	POST   /api/v1/instance/webhook-receiver/stop     stop the process (admin only)
//	GET    /api/v1/instance/webhook-receiver/logs      SSE log stream (admin only)
//	GET    /api/v1/instance/webhook-receiver/script    read receiver.py script (admin only)
//	PUT    /api/v1/instance/webhook-receiver/script    write receiver.py script (admin only)
func (s *APIV1Service) RegisterWebhookReceiverRoutes(g *echo.Group) {
	authenticator := auth.NewAuthenticator(s.Store, s.Secret)

	// authenticate extracts the current user from the request.
	authenticate := func(c *echo.Context) (*store.User, error) {
		authHeader := c.Request().Header.Get("Authorization")
		result := authenticator.Authenticate(c.Request().Context(), authHeader)
		if result == nil {
			return nil, echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
		}
		var userID int32
		if result.Claims != nil {
			userID = result.Claims.UserID
		} else if result.User != nil {
			userID = result.User.ID
		}
		if userID == 0 {
			return nil, echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
		}
		user, err := s.Store.GetUser(c.Request().Context(), &store.FindUser{ID: &userID})
		if err != nil || user == nil {
			return nil, echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
		}
		return user, nil
	}

	// wrap provides admin authentication for management routes.
	wrap := func(h func(*echo.Context, *store.User) error) echo.HandlerFunc {
		return func(c *echo.Context) error {
			user, err := authenticate(c)
			if err != nil {
				return err
			}
			if user.Role != store.RoleAdmin {
				return echo.NewHTTPError(http.StatusForbidden, "admin permission required")
			}
			return h(c, user)
		}
	}

	// wrapAuth provides authentication for routes that any signed-in user may access.
	wrapAuth := func(h func(*echo.Context, *store.User) error) echo.HandlerFunc {
		return func(c *echo.Context) error {
			user, err := authenticate(c)
			if err != nil {
				return err
			}
			return h(c, user)
		}
	}

	g.GET("/api/v1/instance/webhook-receiver/config", wrap(s.handleGetWebhookReceiverConfig))
	g.PUT("/api/v1/instance/webhook-receiver/config", wrap(s.handleUpdateWebhookReceiverConfig))
	g.GET("/api/v1/instance/webhook-receiver/status", wrapAuth(s.handleWebhookReceiverStatus))
	g.GET("/api/v1/instance/webhook-receiver/ai-reply-status", wrapAuth(s.handleWebhookReceiverAIReplyStatus))
	g.POST("/api/v1/instance/webhook-receiver/start", wrap(s.handleStartWebhookReceiver))
	g.POST("/api/v1/instance/webhook-receiver/stop", wrap(s.handleStopWebhookReceiver))
	g.GET("/api/v1/instance/webhook-receiver/logs", wrap(s.handleWebhookReceiverLogs))
	g.GET("/api/v1/instance/webhook-receiver/script", wrap(s.handleGetWebhookReceiverScript))
	g.PUT("/api/v1/instance/webhook-receiver/script", wrap(s.handleUpdateWebhookReceiverScript))
}

func (s *APIV1Service) webhookReceiverMgr() *webhookReceiverManager {
	if s.receiverMgr == nil {
		// Resolve the script directory to an absolute path to avoid path doubling
		// when the child process changes its working directory.
		scriptDir := ""
		candidates := []string{
			filepath.Join(".", "scripts", "webhook"),
		}
		// Also try relative to the executable.
		if exePath, err := os.Executable(); err == nil && exePath != "" {
			candidates = append(candidates, filepath.Join(filepath.Dir(exePath), "scripts", "webhook"))
		}
		for _, candidate := range candidates {
			if _, err := os.Stat(filepath.Join(candidate, "receiver.py")); err == nil {
				scriptDir = candidate
				break
			}
		}
		if scriptDir == "" {
			scriptDir = candidates[0]
		}
		// Convert to absolute path.
		if absDir, err := filepath.Abs(scriptDir); err == nil {
			scriptDir = absDir
		}
		s.receiverMgr = newWebhookReceiverManager(scriptDir)
	}
	return s.receiverMgr
}

// ShutdownWebhookReceiver stops the webhook receiver subprocess during server shutdown.
func (s *APIV1Service) ShutdownWebhookReceiver() {
	if s.receiverMgr != nil {
		s.receiverMgr.Shutdown()
	}
}

func (s *APIV1Service) handleGetWebhookReceiverConfig(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	cfg, err := mgr.ReadConfig()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	resp := webhookReceiverConfigResponse{
		Port:                cfg.Port,
		Secret:              cfg.Secret,
		Log:                 cfg.Log,
		Debug:               cfg.Debug,
		MemosURL:            cfg.MemosURL,
		PAT:                 cfg.PAT,
		AiBaseURL:           cfg.AiBaseURL,
		AiAPIKey:            cfg.AiAPIKey,
		AiModel:             cfg.AiModel,
		AiSystemPrompt:      cfg.AiSystemPrompt,
		AiMaxTokens:         cfg.AiMaxTokens,
		AiImageMaxSize:      cfg.AiImageMaxSize,
		AiReplyDelaySeconds: cfg.AiReplyDelaySeconds,
	}
	return c.JSON(http.StatusOK, resp)
}

func (s *APIV1Service) handleUpdateWebhookReceiverConfig(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()

	var req webhookReceiverConfigUpdateRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	cfg, err := mgr.ReadConfig()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Apply updates — non-nil fields overwrite; empty string for sensitive fields preserves existing.
	if req.Port != nil {
		cfg.Port = *req.Port
	}
	if req.Secret != nil {
		cfg.Secret = *req.Secret
	}
	if req.Log != nil {
		cfg.Log = *req.Log
	}
	if req.Debug != nil {
		cfg.Debug = *req.Debug
	}
	if req.MemosURL != nil {
		cfg.MemosURL = *req.MemosURL
	}
	if req.PAT != nil {
		// Empty string means "keep existing"; to clear, send a sentinel.
		if *req.PAT != "" {
			cfg.PAT = *req.PAT
		}
	}
	if req.AiBaseURL != nil {
		cfg.AiBaseURL = *req.AiBaseURL
	}
	if req.AiAPIKey != nil {
		if *req.AiAPIKey != "" {
			cfg.AiAPIKey = *req.AiAPIKey
		}
	}
	if req.AiModel != nil {
		cfg.AiModel = *req.AiModel
	}
	if req.AiSystemPrompt != nil {
		cfg.AiSystemPrompt = *req.AiSystemPrompt
	}
	if req.AiMaxTokens != nil {
		cfg.AiMaxTokens = *req.AiMaxTokens
	}
	if req.AiImageMaxSize != nil {
		cfg.AiImageMaxSize = *req.AiImageMaxSize
	}
	if req.AiReplyDelaySeconds != nil {
		cfg.AiReplyDelaySeconds = *req.AiReplyDelaySeconds
	}

	if err := mgr.WriteConfig(cfg); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "ok"})
}

func (s *APIV1Service) handleWebhookReceiverStatus(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	return c.JSON(http.StatusOK, mgr.Status())
}

func (s *APIV1Service) handleWebhookReceiverAIReplyStatus(c *echo.Context, _ *store.User) error {
	memoName := c.QueryParam("memo_name")
	if memoName == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "memo_name is required")
	}

	mgr := s.webhookReceiverMgr()
	status := mgr.Status()
	if !status.Running {
		return c.JSON(http.StatusOK, map[string]any{
			"code": 0,
			"data": map[string]any{
				"memo_name": memoName,
				"status":    "none",
			},
		})
	}

	cfg, err := mgr.ReadConfig()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	port := cfg.Port
	if port == 0 {
		port = 5000
	}

	url := fmt.Sprintf("http://127.0.0.1:%d/ai-reply-status?memo_name=%s", port, memoName)
	resp, err := http.Get(url)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	c.Response().Header().Set("Content-Type", "application/json")
	return c.String(resp.StatusCode, string(body))
}

func (s *APIV1Service) handleStartWebhookReceiver(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	if err := mgr.Start(); err != nil {
		return echo.NewHTTPError(http.StatusConflict, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "receiver started"})
}

func (s *APIV1Service) handleStopWebhookReceiver(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	if err := mgr.Stop(); err != nil {
		return echo.NewHTTPError(http.StatusConflict, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "receiver stopped"})
}

func (s *APIV1Service) handleWebhookReceiverLogs(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	w := c.Response()

	// Set SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// Send recent logs first.
	for _, line := range mgr.ReadRecentLogs(200) {
		data, _ := json.Marshal(map[string]string{"line": line})
		fmt.Fprintf(w, "data: %s\n\n", data)
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	// Subscribe to live logs.
	client := mgr.logHub.Subscribe()
	defer mgr.logHub.Unsubscribe(client)

	// Also support context cancellation.
	ctx := c.Request().Context()
	for {
		select {
		case <-ctx.Done():
			return nil
		case line, ok := <-client.ch:
			if !ok {
				return nil
			}
			data, _ := json.Marshal(map[string]string{"line": line})
			fmt.Fprintf(w, "data: %s\n\n", data)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}

func (s *APIV1Service) handleGetWebhookReceiverScript(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	content, err := mgr.ReadScript()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"content": content})
}

func (s *APIV1Service) handleUpdateWebhookReceiverScript(c *echo.Context, _ *store.User) error {
	mgr := s.webhookReceiverMgr()
	var req struct {
		Content string `json:"content"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if err := mgr.WriteScript(req.Content); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "ok"})
}
