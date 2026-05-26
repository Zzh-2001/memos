package v1

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/webhook"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

// globalWebhookResponse is the JSON response shape for a global webhook.
type globalWebhookResponse struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// createGlobalWebhookRequest is the JSON body for creating a global webhook.
type createGlobalWebhookRequest struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// RegisterGlobalWebhookRoutes registers the admin-only global webhook REST endpoints
// onto the provided Echo group.
//
//	GET    /api/v1/instance/global-webhooks        list all global webhooks
//	POST   /api/v1/instance/global-webhooks        create a global webhook
//	DELETE /api/v1/instance/global-webhooks/:id    delete a global webhook
func (s *APIV1Service) RegisterGlobalWebhookRoutes(g *echo.Group) {
	authenticator := auth.NewAuthenticator(s.Store, s.Secret)
	g.GET("/api/v1/instance/global-webhooks", s.makeGlobalWebhookHandler(authenticator, s.handleListGlobalWebhooks))
	g.POST("/api/v1/instance/global-webhooks", s.makeGlobalWebhookHandler(authenticator, s.handleCreateGlobalWebhook))
	g.DELETE("/api/v1/instance/global-webhooks/:id", s.makeGlobalWebhookHandler(authenticator, s.handleDeleteGlobalWebhook))
}

// makeGlobalWebhookHandler wraps a handler with admin authentication.
func (s *APIV1Service) makeGlobalWebhookHandler(authenticator *auth.Authenticator, next func(*echo.Context, *store.User) error) echo.HandlerFunc {
	return func(c *echo.Context) error {
		authHeader := c.Request().Header.Get("Authorization")
		result := authenticator.Authenticate(c.Request().Context(), authHeader)
		if result == nil {
			return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
		}
		var userID int32
		if result.Claims != nil {
			userID = result.Claims.UserID
		} else if result.User != nil {
			userID = result.User.ID
		}
		if userID == 0 {
			return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
		}
		user, err := s.Store.GetUser(c.Request().Context(), &store.FindUser{ID: &userID})
		if err != nil || user == nil || user.Role != store.RoleAdmin {
			return echo.NewHTTPError(http.StatusForbidden, "admin permission required")
		}
		return next(c, user)
	}
}

// handleListGlobalWebhooks returns all admin-configured global webhooks.
func (s *APIV1Service) handleListGlobalWebhooks(c *echo.Context, _ *store.User) error {
	ctx := c.Request().Context()

	hooks, err := s.Store.GetInstanceGlobalWebhooks(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, errors.Wrap(err, "failed to get global webhooks").Error())
	}

	resp := make([]globalWebhookResponse, 0, len(hooks))
	for _, h := range hooks {
		resp = append(resp, globalWebhookResponse{
			ID:    h.GetId(),
			Title: h.GetTitle(),
			URL:   h.GetUrl(),
		})
	}
	return c.JSON(http.StatusOK, resp)
}

// handleCreateGlobalWebhook creates a new global webhook.
func (s *APIV1Service) handleCreateGlobalWebhook(c *echo.Context, _ *store.User) error {
	ctx := c.Request().Context()

	var req createGlobalWebhookRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.URL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url is required")
	}
	if err := webhook.ValidateURL(req.URL); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	existing, err := s.Store.GetInstanceGlobalWebhooks(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, errors.Wrap(err, "failed to get global webhooks").Error())
	}

	newHook := &storepb.InstanceNotificationSetting_GlobalWebhook{
		Id:    uuid.NewString(),
		Title: req.Title,
		Url:   req.URL,
	}
	updated := append(existing, newHook)
	if err := s.Store.UpsertInstanceGlobalWebhooks(ctx, updated); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, errors.Wrap(err, "failed to save global webhook").Error())
	}

	return c.JSON(http.StatusOK, globalWebhookResponse{
		ID:    newHook.Id,
		Title: newHook.Title,
		URL:   newHook.Url,
	})
}

// handleDeleteGlobalWebhook removes a global webhook by ID.
func (s *APIV1Service) handleDeleteGlobalWebhook(c *echo.Context, _ *store.User) error {
	ctx := c.Request().Context()

	id := c.Param("id")
	if id == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "webhook id is required")
	}

	existing, err := s.Store.GetInstanceGlobalWebhooks(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, errors.Wrap(err, "failed to get global webhooks").Error())
	}

	filtered := make([]*storepb.InstanceNotificationSetting_GlobalWebhook, 0, len(existing))
	found := false
	for _, h := range existing {
		if h.GetId() == id {
			found = true
			continue
		}
		filtered = append(filtered, h)
	}
	if !found {
		return echo.NewHTTPError(http.StatusNotFound, "global webhook not found")
	}

	if err := s.Store.UpsertInstanceGlobalWebhooks(ctx, filtered); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, errors.Wrap(err, "failed to delete global webhook").Error())
	}

	return c.JSON(http.StatusOK, map[string]string{})
}
