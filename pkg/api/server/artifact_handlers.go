package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/service"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/storage"
)

var artifactSvc *service.ArtifactService

func initArtifactService(config *core.Config) error {
	base := config.Storage.LocalPath
	if base == "" {
		base = "./data/artifacts"
	}
	provider, err := storage.NewProviderFromEnv(base)
	if err != nil {
		return err
	}
	artifactSvc = service.NewArtifactService(provider)
	return nil
}

// registerArtifactRoutes binds artifact upload/list and flaky check endpoints under /api/incidents/.
func registerArtifactRoutes(config *core.Config) {
	if err := initArtifactService(config); err != nil {
		slog.Error("artifact service init failed", "error", err)
	}
	http.HandleFunc("/api/incidents/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/incidents/")
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) >= 2 && parts[1] == "comments" {
			commentID := int64(0)
			if len(parts) >= 3 && parts[2] != "" {
				parsed, err := strconv.ParseInt(parts[2], 10, 64)
				if err != nil || parsed <= 0 {
					http.Error(w, "Invalid comment id", http.StatusBadRequest)
					return
				}
				commentID = parsed
			}
			jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
				handleIncidentComments(config, w, r, parts[0], commentID)
			})(w, r)
			return
		}
		if len(parts) >= 2 && parts[1] == "ops" {
			jwtAuthMiddleware(config, core.RoleLead, func(w http.ResponseWriter, r *http.Request) {
				handleIncidentOps(w, r, parts[0])
			})(w, r)
			return
		}
		if len(parts) >= 2 && parts[1] == "artifacts" {
			handleIncidentArtifacts(config, w, r, parts[0])
			return
		}
		if len(parts) >= 2 && parts[0] == "check-flaky" {
			handleCheckFlaky(config, w, r, parts[1])
			return
		}
		if len(parts) >= 3 && parts[1] == "healing" {
			if parts[2] == "context" {
				jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
					handleIncidentHealingAction(w, r, parts[0], parts[2])
				})(w, r)
				return
			}
			jwtAuthMiddleware(config, core.RoleLead, func(w http.ResponseWriter, r *http.Request) {
				handleIncidentHealingAction(w, r, parts[0], parts[2])
			})(w, r)
			return
		}
		http.NotFound(w, r)
	})
}

func handleCheckFlaky(config *core.Config, w http.ResponseWriter, r *http.Request, hash string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if config.Security.Enabled {
		if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
			var n int
			core.DB.QueryRow(`SELECT COUNT(*) FROM projects WHERE api_key = ?`, apiKey).Scan(&n)
			if n == 0 {
				writeJSONError(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
		} else if _, err := parseBearerClaims(r); err != nil {
			writeJSONError(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}
	hash = strings.TrimSpace(hash)
	if len(hash) != 64 {
		writeJSONError(w, "Invalid fingerprint hash", http.StatusBadRequest)
		return
	}
	flaky, err := core.IsFlakyFingerprint(hash)
	if err != nil {
		writeJSONError(w, "Database error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"fingerprint": hash,
		"flaky":       flaky,
		"label":       "[FLAKY]",
		"message":     flakyMessage(flaky),
	})
}

func flakyMessage(flaky bool) string {
	if flaky {
		return "This fingerprint was tagged [FLAKY] in the last 30 days. New failures are tagged when the same test fails again within 48 hours."
	}
	return "No recent flaky history for this fingerprint."
}

func handleIncidentArtifacts(config *core.Config, w http.ResponseWriter, r *http.Request, idStr string) {
	incidentID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || incidentID <= 0 {
		writeJSONError(w, "Invalid incident id", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		serveArtifactList(config, w, r, incidentID)
	case http.MethodPost:
		uploadArtifact(config, w, r, incidentID)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func serveArtifactList(config *core.Config, w http.ResponseWriter, r *http.Request, incidentID int64) {
	if config.Security.Enabled {
		jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
			listArtifactsJSON(w, incidentID)
		})(w, r)
		return
	}
	listArtifactsJSON(w, incidentID)
}

func listArtifactsJSON(w http.ResponseWriter, incidentID int64) {
	arts, err := core.ListArtifactsByIncident(incidentID)
	if err != nil {
		writeJSONError(w, "Database error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(arts)
}

func uploadArtifact(config *core.Config, w http.ResponseWriter, r *http.Request, incidentID int64) {
	if artifactSvc == nil {
		writeJSONError(w, "Artifact service unavailable", http.StatusServiceUnavailable)
		return
	}
	if !authorizeArtifactUpload(config, r) {
		writeJSONError(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseMultipartForm(service.MaxArtifactBytes + (1 << 20)); err != nil {
		writeJSONError(w, "Invalid multipart form", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSONError(w, "Missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, service.MaxArtifactBytes+1))
	if err != nil {
		writeJSONError(w, "Failed to read upload", http.StatusInternalServerError)
		return
	}
	if int64(len(data)) > service.MaxArtifactBytes {
		writeJSONError(w, "File exceeds 50MB limit", http.StatusRequestEntityTooLarge)
		return
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if err := artifactSvc.SaveBackground(incidentID, header.Filename, contentType, data); err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "accepted",
		"incident_id": incidentID,
		"message":     "Artifact upload queued for storage",
	})
}

func authorizeArtifactUpload(config *core.Config, r *http.Request) bool {
	if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
		var n int
		core.DB.QueryRow(`SELECT COUNT(*) FROM projects WHERE api_key = ?`, apiKey).Scan(&n)
		return n > 0
	}
	if !config.Security.Enabled {
		return true
	}
	_, err := parseBearerClaims(r)
	return err == nil
}
