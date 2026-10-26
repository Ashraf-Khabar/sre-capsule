package server

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

// registerTeamRoutes binds organization and team management endpoints
func registerTeamRoutes(config *core.Config) {

	// CRUD for Teams (GET is public for authenticated users, Mutations are Admin only)
	http.HandleFunc("/api/teams", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {

		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)

		if r.Method == http.MethodGet {
			rows, err := core.DB.Query("SELECT id, name, parent_id FROM teams")
			if err != nil {
				log.Println("[DB ERROR] Failed to fetch teams:", err)
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			defer rows.Close()

			var teams []map[string]interface{}
			for rows.Next() {
				var id int
				var name string
				var parentId sql.NullInt64
				rows.Scan(&id, &name, &parentId)

				team := map[string]interface{}{"id": id, "name": name, "parent_id": nil}
				if parentId.Valid {
					team["parent_id"] = parentId.Int64
				}
				teams = append(teams, team)
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(teams)

		} else {
			if !core.CanManageTeams(claims.Role) {
				http.Error(w, "Manager access required", http.StatusForbidden)
				return
			}

			if r.Method == http.MethodPost {
				var req struct {
					Name     string `json:"name"`
					ParentID *int   `json:"parent_id"`
				}
				json.NewDecoder(r.Body).Decode(&req)

				if req.Name == "" {
					http.Error(w, "Group name required", http.StatusBadRequest)
					return
				}

				_, err := core.DB.Exec("INSERT INTO teams (name, parent_id) VALUES (?, ?)", req.Name, req.ParentID)
				if err != nil {
					http.Error(w, "Failed to create group", http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusCreated)

			} else if r.Method == http.MethodPut {
				var req struct {
					ID       int     `json:"id"`
					Name     *string `json:"name"`
					ParentID *int    `json:"parent_id"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == 0 {
					http.Error(w, "Invalid request", http.StatusBadRequest)
					return
				}

				if req.ID == 1 && req.ParentID != nil {
					http.Error(w, "Cannot move Root Organization", http.StatusForbidden)
					return
				}

				if req.ParentID != nil {
					if *req.ParentID == req.ID {
						http.Error(w, "A group cannot be its own parent", http.StatusBadRequest)
						return
					}
					if *req.ParentID == 0 {
						_, err := core.DB.Exec("UPDATE teams SET parent_id = NULL WHERE id = ?", req.ID)
						if err != nil {
							http.Error(w, "Failed to move group", http.StatusInternalServerError)
							return
						}
					} else {
						if isTeamDescendant(req.ID, *req.ParentID) {
							http.Error(w, "Cannot move a group into its own sub-group", http.StatusBadRequest)
							return
						}
						var parentExists int
						if err := core.DB.QueryRow("SELECT 1 FROM teams WHERE id = ?", *req.ParentID).Scan(&parentExists); err != nil {
							http.Error(w, "Parent group not found", http.StatusBadRequest)
							return
						}
						_, err := core.DB.Exec("UPDATE teams SET parent_id = ? WHERE id = ?", *req.ParentID, req.ID)
						if err != nil {
							http.Error(w, "Failed to move group", http.StatusInternalServerError)
							return
						}
					}
				}

				if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
					_, err := core.DB.Exec("UPDATE teams SET name = ? WHERE id = ?", strings.TrimSpace(*req.Name), req.ID)
					if err != nil {
						http.Error(w, "Failed to rename group", http.StatusInternalServerError)
						return
					}
				}

				if req.Name == nil && req.ParentID == nil {
					http.Error(w, "Nothing to update", http.StatusBadRequest)
					return
				}
				w.WriteHeader(http.StatusOK)

			} else if r.Method == http.MethodDelete {
				teamID := r.URL.Query().Get("id")
				if teamID == "1" {
					http.Error(w, "Cannot delete Root Organization", http.StatusForbidden)
					return
				}
				_, err := core.DB.Exec("DELETE FROM teams WHERE id = ?", teamID)
				if err != nil {
					http.Error(w, "Failed to delete group", http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusOK)
			}
		}
	}))

	// Associate/Dissociate users with teams (Admin only -> true)
	http.HandleFunc("/api/user-teams", jwtAuthMiddleware(config, core.RoleManager, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var payload struct {
				UserEmail string `json:"user_email"`
				TeamID    int    `json:"team_id"`
				Role      string `json:"role"`
			}

			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, "Invalid payload", http.StatusBadRequest)
				return
			}

			var userID int
			err := core.DB.QueryRow("SELECT id FROM users WHERE username = ?", payload.UserEmail).Scan(&userID)
			if err != nil {
				http.Error(w, "User not found", http.StatusNotFound)
				return
			}

			_, err = core.DB.Exec(`
				INSERT INTO user_teams (user_id, team_id, team_role) 
				VALUES (?, ?, ?) 
				ON CONFLICT(user_id, team_id) DO UPDATE SET team_role = ?`,
				userID, payload.TeamID, payload.Role, payload.Role)

			if err != nil {
				log.Println("[DB ERROR] Failed to assign user to team:", err)
				http.Error(w, "Failed to assign group", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method == http.MethodDelete {
			userID := r.URL.Query().Get("user_id")
			teamID := r.URL.Query().Get("team_id")
			core.DB.Exec("DELETE FROM user_teams WHERE user_id = ? AND team_id = ?", userID, teamID)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}))

	// Fetch teams for a specific user (Read Only - Open to all -> false)
	http.HandleFunc("/api/users/teams", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			username := r.URL.Query().Get("username")
			query := `
				SELECT t.id, t.name, ut.team_role 
				FROM teams t
				JOIN user_teams ut ON t.id = ut.team_id
				JOIN users u ON u.id = ut.user_id
				WHERE u.username = ?`

			rows, err := core.DB.Query(query, username)
			if err != nil {
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			defer rows.Close()

			var teams []map[string]interface{}
			for rows.Next() {
				var id int
				var name, teamRole string
				rows.Scan(&id, &name, &teamRole)
				teams = append(teams, map[string]interface{}{"id": id, "name": name, "role": teamRole})
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(teams)
		}
	}))

	// Manage team members (GET is open, POST/DELETE are reserved for Admins)
	http.HandleFunc("/api/teams/members", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)

		if r.Method == http.MethodGet {
			teamID := r.URL.Query().Get("team_id")
			query := `
				SELECT u.username, u.fullname, u.role, ut.team_role, ut.inherited_from
				FROM users u
				JOIN user_teams ut ON u.id = ut.user_id
				WHERE ut.team_id = ?`

			rows, err := core.DB.Query(query, teamID)
			if err != nil {
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			defer rows.Close()

			var members []map[string]interface{}
			for rows.Next() {
				var u, fn, globalRole, teamRole string
				var inheritedFrom sql.NullInt64
				rows.Scan(&u, &fn, &globalRole, &teamRole, &inheritedFrom)
				m := map[string]interface{}{
					"username":    u,
					"fullname":    fn,
					"global_role": globalRole,
					"team_role":   teamRole,
					"inherited":   inheritedFrom.Valid,
				}
				if inheritedFrom.Valid {
					m["inherited_from"] = inheritedFrom.Int64
				}
				members = append(members, m)
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(members)

		} else {
			if !core.CanManageTeams(claims.Role) {
				http.Error(w, "Admin access required", http.StatusForbidden)
				return
			}

			if r.Method == http.MethodPost {
				var req struct {
					Username string `json:"username"`
					TeamID   int    `json:"team_id"`
					TeamRole string `json:"team_role"`
				}
				json.NewDecoder(r.Body).Decode(&req)

				if req.TeamRole == "" {
					req.TeamRole = "team_viewer"
				}

				var userID int
				err := core.DB.QueryRow("SELECT id FROM users WHERE username = ?", req.Username).Scan(&userID)
				if err != nil {
					http.Error(w, "User not found", http.StatusNotFound)
					return
				}

				propagate := core.CanManageTeams(claims.Role)
				if err := core.AssignUserToTeamWithInheritance(userID, req.TeamID, req.TeamRole, propagate); err != nil {
					http.Error(w, "Failed to assign user", http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusOK)

			} else if r.Method == http.MethodDelete {
				username := r.URL.Query().Get("username")
				teamID, _ := strconv.Atoi(r.URL.Query().Get("team_id"))

				var userID int
				err := core.DB.QueryRow("SELECT id FROM users WHERE username = ?", username).Scan(&userID)
				if err != nil {
					http.Error(w, "User not found", http.StatusNotFound)
					return
				}

				if err := core.RemoveUserFromTeam(userID, teamID); err != nil {
					http.Error(w, "Failed to remove user", http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusOK)
			}
		}
	}))
}

// isTeamDescendant returns true if ancestorID is a descendant of nodeID (nodeID is an ancestor in the tree).
func isTeamDescendant(nodeID, candidateParentID int) bool {
	current := candidateParentID
	for current != 0 {
		if current == nodeID {
			return true
		}
		var parent sql.NullInt64
		err := core.DB.QueryRow("SELECT parent_id FROM teams WHERE id = ?", current).Scan(&parent)
		if err != nil || !parent.Valid {
			return false
		}
		current = int(parent.Int64)
	}
	return false
}
