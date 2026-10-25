package server

import (
	"encoding/json"
	"net/http"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
)

func registerSuiteHealthRoutes(config *core.Config) {
	http.HandleFunc("/api/suite-health", jwtAuthMiddleware(config, "", handleSuiteHealth))
}

func handleSuiteHealth(w http.ResponseWriter, r *http.Request) {
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
	cards, err := core.ListSuiteHealth(core.DB, allowed, r.URL.Query().Get("project"))
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	if cards == nil {
		cards = []core.SuiteHealth{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cards)
}

func suiteProjectsFor(username, role string) (map[string]struct{}, error) {
	if role == "admin" || role == "manager" {
		return nil, nil
	}
	rows, err := core.DB.Query(`
		SELECT DISTINCT p.name
		FROM projects p
		JOIN user_teams ut ON p.team_id = ut.team_id
		JOIN users u ON u.id = ut.user_id
		WHERE u.username = ?`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := map[string]struct{}{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		allowed[name] = struct{}{}
	}
	return allowed, rows.Err()
}
