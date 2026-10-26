package server

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

// registerProjectRoutes binds the CI/CD gateway settings endpoints
func registerProjectRoutes(config *core.Config) {

	// List projects based on user permissions
	http.HandleFunc("/api/my-projects", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)

		var rows *sql.Rows
		var err error

		if claims.Role == "admin" || claims.Role == "manager" {
			rows, err = core.DB.Query(`
				SELECT id, name, ci_system, repo_path, team_id, api_key, slack_channel, jira_project_key, teams_webhook, sre_routing_json, sre_workflow_json
				FROM projects`)
		} else {
			query := `
				SELECT p.id, p.name, p.ci_system, p.repo_path, p.team_id, p.api_key, p.slack_channel, p.jira_project_key, p.teams_webhook, p.sre_routing_json, p.sre_workflow_json
				FROM projects p
				JOIN user_teams ut ON p.team_id = ut.team_id
				JOIN users u ON u.id = ut.user_id
				WHERE u.username = ?
			`
			rows, err = core.DB.Query(query, claims.Username)
		}

		if err != nil {
			log.Println("[DB ERROR] Failed to fetch projects:", err)
			http.Error(w, "Database error", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var projects []map[string]interface{}
		for rows.Next() {
			var id, name, ciSystem, apiKey string
			var repoPath, slackChan, jiraKey, teamsHook, sreRouting, sreWorkflow sql.NullString
			var teamId sql.NullInt64

			err := rows.Scan(&id, &name, &ciSystem, &repoPath, &teamId, &apiKey, &slackChan, &jiraKey, &teamsHook, &sreRouting, &sreWorkflow)
			if err != nil {
				log.Println("[SCAN ERROR] Projects:", err)
				continue
			}

			entries := core.ParseSRERoutingJSON(sreRouting.String)
			wfSummary := core.WorkflowSummaryFromJSON(sreWorkflow.String)
			projects = append(projects, map[string]interface{}{
				"id":        id,
				"name":      name,
				"ci_system": ciSystem,
				"repo_path": repoPath.String,
				"team_id":   teamId.Int64,
				"api_key":   apiKey,
				"slack_channel":    slackChan.String,
				"jira_project_key": jiraKey.String,
				"teams_webhook":    teamsHook.String,
				"sre_routing":      entries,
				"has_workflow":     wfSummary.HasWorkflow,
				"workflow_enabled": wfSummary.Enabled,
				"routing": map[string]string{
					"slack_channel":    slackChan.String,
					"jira_project_key": jiraKey.String,
					"teams_webhook":    teamsHook.String,
				},
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(projects)
	}))

	// Manage Project Configuration (CRUD)
	http.HandleFunc("/api/config/projects", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)

		if r.Method != http.MethodGet && !core.CanManageProjects(claims.Role) {
			http.Error(w, "Admin or Operator access required", http.StatusForbidden)
			return
		}

		if r.Method == http.MethodPost {
			var newProject struct {
				core.ProjectConfig
				RepoPath    string                `json:"repo_path"`
				TeamID      int                   `json:"team_id"`
				SRERouting  []core.SRERoutingEntry `json:"sre_routing"`
			}
			json.NewDecoder(r.Body).Decode(&newProject)

			if newProject.TeamID == 0 {
				http.Error(w, "Team ID is required", http.StatusBadRequest)
				return
			}
			if err := core.ValidateSRERoutingEntries(newProject.SRERouting); err != nil {
				writeJSONError(w, err.Error(), http.StatusBadRequest)
				return
			}
			slack, jira, teams := core.SyncLegacyRoutingColumns(newProject.SRERouting)
			if slack == "" {
				slack = newProject.Routing.SlackChannel
			}
			if jira == "" {
				jira = newProject.Routing.JiraProjectKey
			}
			if teams == "" {
				teams = newProject.Routing.TeamsWebhook
			}
			routingJSON := core.MarshalSRERoutingJSON(newProject.SRERouting)

			_, err := core.DB.Exec(`INSERT INTO projects (id, name, team_id, ci_system, repo_path, api_key, slack_channel, jira_project_key, teams_webhook, sre_routing_json) 
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				newProject.ID, newProject.Name, newProject.TeamID, newProject.CISystem, newProject.RepoPath, newProject.APIKey, slack, jira, teams, routingJSON)

			if err != nil {
				log.Println("[DB ERROR] Failed to provision project:", err)
				http.Error(w, "Database error.", http.StatusInternalServerError)
				return
			}

			var userID int
			if err := core.DB.QueryRow("SELECT id FROM users WHERE username = ?", claims.Username).Scan(&userID); err == nil {
				_ = core.EnsureUserTeamMembership(userID, newProject.TeamID, "team_operator")
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id": newProject.ID, "name": newProject.Name, "team_id": newProject.TeamID, "ci_system": newProject.CISystem,
			})

		} else if r.Method == http.MethodPut {
			var updateProject struct {
				core.ProjectConfig
				RepoPath   string                 `json:"repo_path"`
				TeamID     int                    `json:"team_id"`
				SRERouting []core.SRERoutingEntry `json:"sre_routing"`
			}
			if err := json.NewDecoder(r.Body).Decode(&updateProject); err != nil {
				http.Error(w, "Invalid request", http.StatusBadRequest)
				return
			}
			if err := core.ValidateSRERoutingEntries(updateProject.SRERouting); err != nil {
				writeJSONError(w, err.Error(), http.StatusBadRequest)
				return
			}
			slack, jira, teams := core.SyncLegacyRoutingColumns(updateProject.SRERouting)
			if slack == "" {
				slack = updateProject.Routing.SlackChannel
			}
			if jira == "" {
				jira = updateProject.Routing.JiraProjectKey
			}
			if teams == "" {
				teams = updateProject.Routing.TeamsWebhook
			}
			routingJSON := core.MarshalSRERoutingJSON(updateProject.SRERouting)

			_, err := core.DB.Exec(`UPDATE projects SET name = ?, team_id = ?, ci_system = ?, repo_path = ?, slack_channel = ?, jira_project_key = ?, teams_webhook = ?, sre_routing_json = ? WHERE id = ?`,
				updateProject.Name, updateProject.TeamID, updateProject.CISystem, updateProject.RepoPath, slack, jira, teams, routingJSON, updateProject.ID)

			if err != nil {
				log.Println("[DB ERROR] Failed to update project:", err)
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)

		} else if r.Method == http.MethodDelete {
			projectID := r.URL.Query().Get("id")
			_, err := core.DB.Exec("DELETE FROM projects WHERE id = ?", projectID)
			if err != nil {
				http.Error(w, "Failed to delete project", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		}
	}))
}
