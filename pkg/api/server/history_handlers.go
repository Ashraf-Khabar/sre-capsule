package server

import (
	"encoding/json"
	"net/http"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
)

func registerHistoryRoutes(config *core.Config) {
	http.HandleFunc("/api/history/flow", jwtAuthMiddleware(config, "", handleHistoryFlow))
}

func handleHistoryFlow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := parseClaims(r)
	allowed, err := suiteProjectsFor(claims.Username, claims.Role)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	flow, err := core.ListHistoryFlow(core.DB, allowed)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(flow)
}
