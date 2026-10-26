package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/integrations"

	"github.com/golang-jwt/jwt/v5"
)

func registerRunbooksRoutes(config *core.Config) {
	http.HandleFunc("/api/runbooks/templates", jwtAuthMiddleware(config, "", handleRunbookTemplates))
	http.HandleFunc("/api/runbooks/apply", jwtAuthMiddleware(config, core.RoleLead, handleRunbookApply))
}

func handleRunbookTemplates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id != "" {
		t, ok := integrations.GetRunbookTemplate(id)
		if !ok {
			writeJSONError(w, "Unknown template", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"template": runbookTemplateDTO(*t, true),
		})
		return
	}
	list := make([]map[string]interface{}, 0)
	for _, t := range integrations.RunbookCatalog() {
		list = append(list, runbookTemplateDTO(t, false))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"templates": list})
}

func runbookTemplateDTO(t integrations.RunbookTemplate, includeWorkflow bool) map[string]interface{} {
	dto := map[string]interface{}{
		"id":                t.ID,
		"name":              t.Name,
		"description":       t.Description,
		"tags":              t.Tags,
		"required_plugins":  t.Plugins,
		"node_count":        len(t.Document.Nodes),
	}
	if includeWorkflow {
		dto["workflow"] = t.Document
	}
	return dto
}

func handleRunbookApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ProjectID  string `json:"project_id"`
		TemplateID string `json:"template_id"`
		Enable     *bool  `json:"enable"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if body.ProjectID == "" || body.TemplateID == "" {
		writeJSONError(w, "project_id and template_id required", http.StatusBadRequest)
		return
	}

	authHeader := r.Header.Get("Authorization")
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	claims := &Claims{}
	_, _ = jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
	if !core.CanManageWorkflow(claims.Role) {
		writeJSONError(w, "Runbook apply requires Lead, Manager, or Platform Admin", http.StatusForbidden)
		return
	}
	if !core.UserCanAccessProject(claims.Username, claims.Role, body.ProjectID) {
		writeJSONError(w, "Access denied", http.StatusForbidden)
		return
	}

	tmpl, ok := integrations.GetRunbookTemplate(body.TemplateID)
	if !ok {
		writeJSONError(w, "Unknown template", http.StatusNotFound)
		return
	}
	doc := integrations.CloneRunbookDocument(tmpl)
	if body.Enable != nil {
		doc.Enabled = *body.Enable
	}
	reg := core.RemediationRegistry()
	_, allowed := projectAllowedPathsByID(body.ProjectID)
	if doc.Enabled {
		if err := integrations.ValidateWorkflowStructure(doc, reg); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		for _, node := range doc.Nodes {
			if node.Type != "action" || node.FilePath == "" {
				continue
			}
			if len(allowed) > 0 && !allowed[node.FilePath] {
				writeJSONError(w, "Enable plugin on gateway first: "+node.FilePath, http.StatusBadRequest)
				return
			}
			if m, ok := reg.GetByPath(node.FilePath); ok && !integrations.IsActiveForRouting(m.Status, m.RoutingEnabled, m.AutoRun) {
				writeJSONError(w, "Plugin not active for routing: "+m.Name, http.StatusBadRequest)
				return
			}
		}
	}
	if err := core.SaveProjectWorkflow(body.ProjectID, doc); err != nil {
		writeJSONError(w, "Failed to save workflow", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "ok",
		"project_id":  body.ProjectID,
		"template_id": body.TemplateID,
		"applied_at":  time.Now().UTC().Format(time.RFC3339),
	})
}
