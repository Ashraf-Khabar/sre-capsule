package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

func registerIntelligenceRoutes(config *core.Config) {
	http.HandleFunc("/api/healing/insights", jwtAuthMiddleware(config, "", handleHealingInsights))
	http.HandleFunc("/api/healing/locator-interventions", jwtAuthMiddleware(config, "", handleLocatorInterventions))
	registerQuarantineRoutes(config)
}

func handleHealingInsights(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := parseClaims(r)
	if !core.CanViewHealing(claims.Role) {
		writeJSONError(w, "Access denied", http.StatusForbidden)
		return
	}
	if core.HealingService == nil {
		writeJSONError(w, "Healing service not initialized", http.StatusServiceUnavailable)
		return
	}
	project := r.URL.Query().Get("project")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	load := core.HealingService.ListInsights
	if r.URL.Query().Get("archived") == "1" {
		load = core.HealingService.ListArchivedInsights
	}
	rows, err := load(r.Context(), project, limit)
	if err != nil {
		writeJSONError(w, "Failed to load healing insights", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rows)
}

func handleLocatorInterventions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := parseClaims(r)
	if !core.CanViewHealing(claims.Role) {
		writeJSONError(w, "Access denied", http.StatusForbidden)
		return
	}
	project := r.URL.Query().Get("project")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, err := core.ListLocatorHealings(project, limit)
	if err != nil {
		writeJSONError(w, "Failed to load locator interventions", http.StatusInternalServerError)
		return
	}
	if rows == nil {
		rows = []core.LocatorHealing{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rows)
}

func handleQuarantineManage(w http.ResponseWriter, r *http.Request) {
	claims := parseClaims(r)
	if !core.CanViewQuarantine(claims.Role) {
		writeJSONError(w, "Access denied", http.StatusForbidden)
		return
	}
	if core.QuarantineEngine == nil {
		writeJSONError(w, "Quarantine engine not initialized", http.StatusServiceUnavailable)
		return
	}
	project := r.URL.Query().Get("project")
	if project == "" {
		writeJSONError(w, "project query required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		resp, err := core.QuarantineEngine.ListCI(r.Context(), project)
		if err != nil {
			writeJSONError(w, "Failed to list quarantine", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	case http.MethodPost:
		if !core.CanManageQuarantine(claims.Role) {
			writeJSONError(w, "Lead+ required", http.StatusForbidden)
			return
		}
		var body struct {
			TestName string `json:"test_name"`
			Project  string `json:"project"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		pn := body.Project
		if pn == "" {
			pn = project
		}
		if err := core.QuarantineEngine.ManualQuarantine(r.Context(), pn, body.TestName, claims.Username); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
	case http.MethodDelete:
		if !core.CanManageQuarantine(claims.Role) {
			writeJSONError(w, "Lead+ required", http.StatusForbidden)
			return
		}
		fp := r.URL.Query().Get("fingerprint")
		if fp == "" {
			writeJSONError(w, "fingerprint required", http.StatusBadRequest)
			return
		}
		if err := core.QuarantineEngine.Lift(r.Context(), project, fp, claims.Username); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func parseClaims(r *http.Request) *Claims {
	authHeader := r.Header.Get("Authorization")
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	claims := &Claims{}
	_, _ = jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
	return claims
}
