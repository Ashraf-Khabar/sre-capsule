package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/integrations"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"gopkg.in/yaml.v3"
)

// registerSystemRoutes binds plugins, system settings, and websocket endpoints
func registerSystemRoutes(config *core.Config) {
	registerAIRoutes(config)

	// List remediation integrations (loaded at startup; no shell scripts).
	http.HandleFunc("/api/plugins", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		claims := claimsFromRequest(r)
		if claims == nil || !core.CanAccessPlugins(claims.Role) {
			writeJSONError(w, "Lead or Manager role required", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = core.MaybeReloadRemediationRegistry(config.Plugins.Directory, config.Plugins.AutoReload)
		reg := core.RemediationRegistry()
		if reg == nil {
			json.NewEncoder(w).Encode([]map[string]interface{}{})
			return
		}
		json.NewEncoder(w).Encode(reg.ToAPIList())
	}))

	// Execute a specific plugin manually from the UI
	http.HandleFunc("/api/plugins/run", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		claims := claimsFromRequest(r)
		if claims == nil || !core.CanAccessPlugins(claims.Role) {
			writeJSONError(w, "Lead or Manager role required", http.StatusForbidden)
			return
		}
		var req struct {
			FilePath string `json:"file_path"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		logs, err := core.RunSinglePlugin(*config, req.FilePath, "MANUAL", nil) // native Go integration

		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": "Execution failed", "logs": logs})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"logs": logs})
	}))

	// Toggle AUTO-RUN per integration (Manager or Platform Admin)
	http.HandleFunc("/api/plugins/autorun", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
		if !core.CanManagePluginAutoRun(claims.Role) {
			writeJSONError(w, "Manager or Platform Admin role required", http.StatusForbidden)
			return
		}
		var req struct {
			FilePath string `json:"file_path"`
			AutoRun  bool   `json:"auto_run"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid body", http.StatusBadRequest)
			return
		}
		reg := core.RemediationRegistry()
		if reg == nil {
			http.Error(w, "Remediation engine not initialized", http.StatusServiceUnavailable)
			return
		}
		if err := reg.UpdateAutoRun(req.FilePath, req.AutoRun); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "auto_run": req.AutoRun})
	}))

	// Toggle CI/CD gateway routing eligibility (Manager or Platform Admin)
	http.HandleFunc("/api/plugins/routing", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
		if !core.CanManagePluginAutoRun(claims.Role) {
			writeJSONError(w, "Manager or Platform Admin role required", http.StatusForbidden)
			return
		}
		var req struct {
			FilePath string `json:"file_path"`
			Enabled  bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid body", http.StatusBadRequest)
			return
		}
		reg := core.RemediationRegistry()
		if reg == nil {
			http.Error(w, "Remediation engine not initialized", http.StatusServiceUnavailable)
			return
		}
		if err := reg.UpdateRoutingEnabled(req.FilePath, req.Enabled); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "routing_enabled": req.Enabled})
	}))

	// Active integrations for CI/CD gateway routing dropdown
	http.HandleFunc("/api/plugins/active", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		claims := claimsFromRequest(r)
		if claims == nil || !core.CanAccessPlugins(claims.Role) {
			writeJSONError(w, "Lead or Manager role required", http.StatusForbidden)
			return
		}
		_ = core.MaybeReloadRemediationRegistry(config.Plugins.Directory, config.Plugins.AutoReload)
		reg := core.RemediationRegistry()
		if reg == nil {
			json.NewEncoder(w).Encode([]map[string]interface{}{})
			return
		}
		out := make([]map[string]interface{}, 0)
		for _, m := range reg.List() {
			if !integrations.IsActiveForRouting(m.Status, m.RoutingEnabled, m.AutoRun) {
				continue
			}
			out = append(out, map[string]interface{}{
				"file_path":       m.FilePath,
				"integration":     m.Integration,
				"name":            m.Name,
				"status":          m.Status,
				"auto_run":        m.AutoRun,
				"routing_enabled": m.RoutingEnabled,
				"routing_fields":  integrations.RoutingFieldsForIntegration(m.Integration),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}))

	// Update Plugin JSON configurations
	http.HandleFunc("/api/plugins/config", jwtAuthMiddleware(config, core.RoleLead, func(w http.ResponseWriter, r *http.Request) {
		claims := claimsFromRequest(r)
		if claims == nil {
			writeJSONError(w, "Invalid token", http.StatusUnauthorized)
			return
		}
		var req struct {
			FilePath       string            `json:"file_path"`
			Env            map[string]string `json:"env"`
			EnableRouting  bool              `json:"enable_routing"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		reg := core.RemediationRegistry()
		if reg == nil {
			http.Error(w, "Remediation engine not initialized", http.StatusServiceUnavailable)
			return
		}
		if err := reg.UpdateConfig(req.FilePath, req.Env, req.EnableRouting); err != nil {
			log.Printf("[ERROR] Cannot update integration config %s: %v", req.FilePath, err)
			http.Error(w, "Failed to save configuration", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}))

	// Fetch current global config.yaml
	http.HandleFunc("/api/config", jwtAuthMiddleware(config, core.RoleAdmin, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(config)
	}))

	// Update SMTP block in config.yaml
	http.HandleFunc("/api/config/smtp", jwtAuthMiddleware(config, core.RoleAdmin, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&config.SMTP)
		data, _ := yaml.Marshal(config)
		os.WriteFile("config.yaml", data, 0644)
		w.WriteHeader(http.StatusOK)
	}))

	// Update Security Policies in config.yaml
	http.HandleFunc("/api/config/policy", jwtAuthMiddleware(config, core.RoleAdmin, func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			AllowedDomain string `json:"allowed_domain"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		config.Security.AllowedDomain = payload.AllowedDomain
		data, _ := yaml.Marshal(config)
		os.WriteFile("config.yaml", data, 0644)
		w.WriteHeader(http.StatusOK)
	}))

	// Real-time raw telemetry stream for the dashboard
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if config.Security.Enabled {
			token := strings.TrimSpace(r.URL.Query().Get("token"))
			if token == "" {
				token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			if _, err := validateTokenString(token); err != nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			data, _ := os.ReadFile(config.Telemetry.ReportPath)
			if conn.WriteMessage(websocket.TextMessage, data) != nil {
				break
			}
			time.Sleep(1 * time.Second)
		}
	})
}