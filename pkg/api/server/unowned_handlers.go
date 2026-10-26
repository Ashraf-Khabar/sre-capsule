package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
)

func registerUnownedRoutes(config *core.Config) {
	http.HandleFunc("/api/unowned", jwtAuthMiddleware(config, "", handleUnowned))
}

func handleUnowned(w http.ResponseWriter, r *http.Request) {
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
	rows, err := core.ListUnowned(core.DB, allowed, time.Now().UTC())
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	if rows == nil {
		rows = []core.UnownedIncident{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rows)
}
