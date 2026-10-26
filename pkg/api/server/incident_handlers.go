package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

// registerIncidentRoutes binds endpoints for tracking alerts and calculating FinOps
func registerIncidentRoutes(config *core.Config) {

	// ==========================================
	// INCIDENTS DASHBOARD API
	// ==========================================
	http.HandleFunc("/api/incidents", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)

		if r.Method == http.MethodGet {
			projectFilter := r.URL.Query().Get("project")
			tw := incidentTimeWindowFromRequest(r)
			var query string
			var args []interface{}

			if claims.Role == "admin" || claims.Role == "manager" {
				query = `SELECT id, project_name, name, status, error_message, console_logs, error_logs, is_resolved, resolved_by, created_at, resolved_at, pipeline_run_id 
					FROM incidents WHERE created_at >= ? AND created_at <= ? AND COALESCE(archived, 0) = 0`
				args = []interface{}{tw.From, tw.To}
				if projectFilter != "" && projectFilter != "all" {
					query += " AND project_name = ?"
					args = append(args, projectFilter)
				}
				query += " ORDER BY created_at DESC LIMIT 500"
			} else {
				query = `SELECT DISTINCT i.id, i.project_name, i.name, i.status, i.error_message, i.console_logs, i.error_logs, i.is_resolved, i.resolved_by, i.created_at, i.resolved_at, i.pipeline_run_id 
						 FROM incidents i
						 JOIN projects p ON i.project_name = p.name
						 JOIN user_teams ut ON p.team_id = ut.team_id
						 JOIN users u ON u.id = ut.user_id
						 WHERE u.username = ? AND i.created_at >= ? AND i.created_at <= ? AND COALESCE(i.archived, 0) = 0`
				args = []interface{}{claims.Username, tw.From, tw.To}
				if projectFilter != "" && projectFilter != "all" {
					query += " AND i.project_name = ?"
					args = append(args, projectFilter)
				}
				query += " ORDER BY i.created_at DESC LIMIT 500"
			}

			rows, err := core.DB.Query(query, args...)
			if err != nil {
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			defer rows.Close()

			var incidents []map[string]interface{}
			runIDsByProject := make(map[string]map[string]struct{})
			for rows.Next() {
				var id, isResolved int
				var pName, name, status, errMsg, cLogs, eLogs string
				var resolvedBy, createdAt, resolvedAt, pipelineRunID sql.NullString

				rows.Scan(&id, &pName, &name, &status, &errMsg, &cLogs, &eLogs, &isResolved, &resolvedBy, &createdAt, &resolvedAt, &pipelineRunID)
				inc := map[string]interface{}{
					"id": id, "project_name": pName, "name": name, "status": status,
					"error_message": errMsg, "console_logs": cLogs, "error_logs": eLogs, "is_resolved": isResolved == 1,
					"resolved_by": resolvedBy.String, "created_at": createdAt.String, "resolved_at": resolvedAt.String,
					"pipeline_run_id": pipelineRunID.String,
				}
				if pipelineRunID.Valid && pipelineRunID.String != "" {
					if runIDsByProject[pName] == nil {
						runIDsByProject[pName] = make(map[string]struct{})
					}
					runIDsByProject[pName][pipelineRunID.String] = struct{}{}
				}
				incidents = append(incidents, inc)
			}

			pipelineMeta := make(map[string]core.PipelineRunRecord)
			for proj, runSet := range runIDsByProject {
				var runIDs []string
				for rid := range runSet {
					runIDs = append(runIDs, rid)
				}
				for runID, rec := range core.LoadPipelineFlagsByRuns(proj, runIDs) {
					pipelineMeta[proj+"|"+runID] = rec
				}
			}
			for _, inc := range incidents {
				pName, _ := inc["project_name"].(string)
				runID, _ := inc["pipeline_run_id"].(string)
				if runID == "" {
					continue
				}
				if rec, ok := pipelineMeta[pName+"|"+runID]; ok {
					inc["execution_env"] = rec.Flags.Env
					inc["execution_type"] = rec.Flags.Type
					inc["execution_summary"] = rec.Summary
				}
			}
			attachNearestDeploys(incidents, tw.From, tw.To)
			attachIncidentOps(incidents)
			attachMaintenance(incidents, tw.From, tw.To)

			json.NewEncoder(w).Encode(incidents)

		} else if r.Method == http.MethodPut {
			if !core.CanResolveIncidents(claims.Role) {
				http.Error(w, "Lead or Manager role required to resolve incidents.", http.StatusForbidden)
				return
			}

			var req struct {
				ID  int   `json:"id"`
				IDs []int `json:"ids"`
			}

			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
				return
			}

			idsToResolve := req.IDs
			if req.ID != 0 {
				idsToResolve = append(idsToResolve, req.ID)
			}

			if len(idsToResolve) > 0 {
				if !core.UserCanAccessAllIncidents(claims.Username, claims.Role, idsToResolve) {
					http.Error(w, "Access denied: incident outside your teams", http.StatusForbidden)
					return
				}

				placeholders := make([]string, len(idsToResolve))
				args := make([]interface{}, len(idsToResolve)+1)

				resolvedUser := claims.Username
				if resolvedUser == "" {
					resolvedUser = "authenticated_user"
				}
				args[0] = resolvedUser

				for i, id := range idsToResolve {
					placeholders[i] = "?"
					args[i+1] = id
				}

				query := "UPDATE incidents SET is_resolved = 1, status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id IN (" + strings.Join(placeholders, ",") + ")"

				var dbErr error
				for attempt := 1; attempt <= 5; attempt++ {
					_, dbErr = core.DB.Exec(query, args...)
					if dbErr == nil {
						break
					}
					errStr := strings.ToLower(dbErr.Error())
					if strings.Contains(errStr, "locked") || strings.Contains(errStr, "busy") {
						time.Sleep(time.Duration(attempt*50) * time.Millisecond)
						continue
					}
					break
				}

				if dbErr != nil {
					http.Error(w, "Database write contention failed: "+dbErr.Error(), http.StatusInternalServerError)
					return
				}
			}
			w.WriteHeader(http.StatusOK)

		} else if r.Method == http.MethodPatch {
			if !core.CanDeleteIncidents(claims.Role) {
				http.Error(w, "Lead or Manager role required to archive records.", http.StatusForbidden)
				return
			}
			var req struct {
				IDs      []int `json:"ids"`
				Archived *bool `json:"archived"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
				http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
				return
			}
			if !core.UserCanAccessAllIncidents(claims.Username, claims.Role, req.IDs) {
				http.Error(w, "Access denied: incident outside your teams", http.StatusForbidden)
				return
			}
			archived := 1
			if req.Archived != nil && !*req.Archived {
				archived = 0
			}
			placeholders := make([]string, len(req.IDs))
			args := make([]interface{}, 0, len(req.IDs)+1)
			args = append(args, archived)
			for i, id := range req.IDs {
				placeholders[i] = "?"
				args = append(args, id)
			}
			query := "UPDATE incidents SET archived = ? WHERE id IN (" + strings.Join(placeholders, ",") + ")"
			if _, err := core.DB.Exec(query, args...); err != nil {
				http.Error(w, "Database error", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)

		} else if r.Method == http.MethodDelete {
			if !core.CanDeleteIncidents(claims.Role) {
				http.Error(w, "Lead or Manager role required to delete records.", http.StatusForbidden)
				return
			}

			idsStr := r.URL.Query().Get("ids")
			if idsStr == "" {
				http.Error(w, "Missing fields: ids parameter required", http.StatusBadRequest)
				return
			}

			idList := strings.Split(idsStr, ",")
			var args []interface{}
			var placeholders []string

			for _, idStr := range idList {
				idStr = strings.TrimSpace(idStr)
				if idStr == "" {
					continue
				}
				id, err := strconv.Atoi(idStr)
				if err != nil {
					http.Error(w, "Invalid ID format in parameter", http.StatusBadRequest)
					return
				}
				placeholders = append(placeholders, "?")
				args = append(args, id)
			}

			if len(args) > 0 {
				deleteIDs := make([]int, 0, len(args))
				for _, a := range args {
					if id, ok := a.(int); ok {
						deleteIDs = append(deleteIDs, id)
					}
				}
				if !core.UserCanAccessAllIncidents(claims.Username, claims.Role, deleteIDs) {
					http.Error(w, "Access denied: incident outside your teams", http.StatusForbidden)
					return
				}

				query := "DELETE FROM incidents WHERE id IN (" + strings.Join(placeholders, ",") + ")"

				var dbErr error
				for attempt := 1; attempt <= 5; attempt++ {
					_, dbErr = core.DB.Exec(query, args...)
					if dbErr == nil {
						break
					}
					errStr := strings.ToLower(dbErr.Error())
					if strings.Contains(errStr, "locked") || strings.Contains(errStr, "busy") {
						time.Sleep(time.Duration(attempt*50) * time.Millisecond)
						continue
					}
					break
				}

				if dbErr != nil {
					http.Error(w, "Database delete contention failed: "+dbErr.Error(), http.StatusInternalServerError)
					return
				}
			}
			w.WriteHeader(http.StatusOK)
		}
	}))

	// Weekly Report & Metrics APIs
	http.HandleFunc("/api/reports/weekly", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			return
		}

		projectFilter := r.URL.Query().Get("project")
		tw := incidentTimeWindowFromRequest(r)
		var query string
		var args []interface{}

		if projectFilter != "" && projectFilter != "all" {
			query = `
				SELECT 
					project_name, 
					COUNT(*) as total_failures, 
					SUM(case when is_resolved = 1 then 1 else 0 end) as total_resolved,
					SUM(case when name LIKE '[FLAKY]%' then 1 else 0 end) as flaky_count
				FROM incidents 
				WHERE created_at >= ? AND created_at <= ? AND project_name = ?
				GROUP BY project_name
				ORDER BY total_failures DESC
			`
			args = []interface{}{tw.From, tw.To, projectFilter}
		} else {
			query = `
				SELECT 
					project_name, 
					COUNT(*) as total_failures, 
					SUM(case when is_resolved = 1 then 1 else 0 end) as total_resolved,
					SUM(case when name LIKE '[FLAKY]%' then 1 else 0 end) as flaky_count
				FROM incidents 
				WHERE created_at >= ? AND created_at <= ?
				GROUP BY project_name
				ORDER BY total_failures DESC
			`
			args = []interface{}{tw.From, tw.To}
		}

		rows, err := core.DB.Query(query, args...)
		if err != nil {
			http.Error(w, "Failed to generate report", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var report []map[string]interface{}
		for rows.Next() {
			var projName string
			var total, resolved, flaky int
			rows.Scan(&projName, &total, &resolved, &flaky)

			healthScore := 100
			if total > 0 {
				healthScore = (resolved * 100) / total
			}

			report = append(report, map[string]interface{}{
				"pipeline":        projName,
				"total_alerts":    total,
				"resolved_alerts": resolved,
				"flaky_tests":     flaky,
				"health_score":    healthScore,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(report)
	}))

	http.HandleFunc("/api/metrics", jwtAuthMiddleware(config, "", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			return
		}

		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		metricsClaims := &Claims{}
		jwt.ParseWithClaims(tokenString, metricsClaims, jwtSigningKey)

		tw := incidentTimeWindowFromRequest(r)
		fromT, _ := time.Parse("2006-01-02 15:04:05", tw.From)
		toT, _ := time.Parse("2006-01-02 15:04:05", tw.To)
		bucketExpr := evolutionBucketExpr(fromT, toT)
		bucketLabel := evolutionBucketLabel(fromT, toT)

		var total, resolved, flaky int
		core.DB.QueryRow("SELECT COUNT(*) FROM incidents WHERE created_at >= ? AND created_at <= ?", tw.From, tw.To).Scan(&total)
		core.DB.QueryRow("SELECT COUNT(*) FROM incidents WHERE is_resolved = 1 AND created_at >= ? AND created_at <= ?", tw.From, tw.To).Scan(&resolved)
		core.DB.QueryRow("SELECT COUNT(*) FROM incidents WHERE name LIKE '[FLAKY]%' AND created_at >= ? AND created_at <= ?", tw.From, tw.To).Scan(&flaky)

		// 1. CALCULATE MTTR
		var mttrMinutes sql.NullFloat64
		core.DB.QueryRow(`
			SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60) 
			FROM incidents 
			WHERE is_resolved = 1 
			  AND resolved_at IS NOT NULL 
			  AND created_at IS NOT NULL
			  AND created_at >= ? AND created_at <= ?
			  AND ((julianday(resolved_at) - julianday(created_at)) * 24 * 60) >= 1.0
		`, tw.From, tw.To).Scan(&mttrMinutes)

		mttrValue := 0.0
		if mttrMinutes.Valid {
			mttrValue = mttrMinutes.Float64
		}

		mttrDisplay := int(math.Round(mttrValue))
		if mttrValue == 0 && resolved > 0 {
			mttrDisplay = 1
		}

		// 2. CALCULATE MTTF
		var mttfMinutes sql.NullFloat64
		core.DB.QueryRow(`
			SELECT 
				CASE 
					WHEN COUNT(*) > 1 THEN ((julianday(MAX(created_at)) - julianday(MIN(created_at))) * 24 * 60) / (COUNT(*) - 1)
					ELSE 0 
				END
			FROM incidents
			WHERE created_at >= ? AND created_at <= ?
		`, tw.From, tw.To).Scan(&mttfMinutes)

		mttfDisplay := int(math.Round(mttfMinutes.Float64))

		// 3. CALCULATE 5-WEEK EVOLUTION TRENDS (ADDED FLAKY COUNT)
		type WeekEvolution struct {
			WeekStart     string  `json:"week_start"`
			TotalFailures int     `json:"total_failures"`
			FlakyCount    int     `json:"flaky_count"`
			MTTR          float64 `json:"mttr"`
		}

		var evolution []WeekEvolution
		evoSQL := fmt.Sprintf(`
			SELECT 
				%s as week_start,
				COUNT(*) as total_failures,
				SUM(CASE WHEN name LIKE '[FLAKY]%%' THEN 1 ELSE 0 END) as flaky_count,
				AVG(CASE WHEN is_resolved = 1 AND resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 24 * 60 ELSE 0 END) as mttr
			FROM incidents
			WHERE created_at >= ? AND created_at <= ?
			GROUP BY week_start
			ORDER BY week_start ASC
		`, bucketExpr)
		rowsEvo, errEvo := core.DB.Query(evoSQL, tw.From, tw.To)

		if errEvo == nil {
			defer rowsEvo.Close()
			for rowsEvo.Next() {
				var wStart string
				var tFailures, fCount int
				var wMttr sql.NullFloat64
				rowsEvo.Scan(&wStart, &tFailures, &fCount, &wMttr)
				evolution = append(evolution, WeekEvolution{
					WeekStart:     wStart,
					TotalFailures: tFailures,
					FlakyCount:    fCount,
					MTTR:          wMttr.Float64,
				})
			}
		}

		// 4. FINANCIAL CALCULATIONS
		var devRate, ciCost, avgDuration, avgInvestigation float64
		core.DB.QueryRow("SELECT dev_hourly_rate, ci_minute_cost, avg_pipeline_duration, avg_investigation_time FROM finops_settings WHERE id = 1").Scan(&devRate, &ciCost, &avgDuration, &avgInvestigation)

		costPerInvestigation := (devRate / 60.0) * avgInvestigation
		totalMinutesLost := float64(total) * avgDuration
		flakyMinutesLost := float64(flaky) * avgDuration

		totalFinancialImpact := (totalMinutesLost * ciCost) + (float64(total) * costPerInvestigation)
		flakyFinancialImpact := (flakyMinutesLost * ciCost) + (float64(flaky) * costPerInvestigation)

		response := map[string]interface{}{
			"total_incidents":    total,
			"resolved_incidents": resolved,
			"flaky_tests":        flaky,
			"stable_failures":    total - flaky,
			"mttr_minutes":       mttrDisplay,
			"mttf_minutes":       mttfDisplay,
			"evolution":          evolution,
			"evolution_bucket":   bucketLabel,
			"time_from":          tw.From,
			"time_to":            tw.To,
		}

		if core.CanAccessFinOps(metricsClaims.Role) {
			response["sre_impact"] = map[string]interface{}{
				"ci_minutes_lost":      int(totalMinutesLost),
				"flaky_minutes_lost":   int(flakyMinutesLost),
				"estimated_cost_usd":   math.Round(totalFinancialImpact),
				"flaky_waste_cost_usd": math.Round(flakyFinancialImpact),
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	}))

	http.HandleFunc("/api/finops", jwtAuthMiddleware(config, "", managerOnlyHandler(config, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodGet {
			var devRate, ciCost, avgDuration, avgInvestigation float64
			var currency sql.NullString
			err := core.DB.QueryRow(
				"SELECT dev_hourly_rate, ci_minute_cost, avg_pipeline_duration, avg_investigation_time, currency FROM finops_settings WHERE id = 1",
			).Scan(&devRate, &ciCost, &avgDuration, &avgInvestigation, &currency)
			if err == sql.ErrNoRows {
				devRate, ciCost, avgDuration, avgInvestigation = 50, 0.008, 15, 30
			}
			cur := "USD"
			if currency.Valid && currency.String != "" {
				cur = currency.String
			}
			json.NewEncoder(w).Encode(map[string]interface{}{
				"dev_hourly_rate":        devRate,
				"ci_minute_cost":         ciCost,
				"avg_pipeline_duration":  avgDuration,
				"avg_investigation_time": avgInvestigation,
				"currency":               cur,
			})
		} else if r.Method == http.MethodPut {
			var req struct {
				DevHourlyRate        float64 `json:"dev_hourly_rate"`
				CiMinuteCost         float64 `json:"ci_minute_cost"`
				AvgPipelineDuration  float64 `json:"avg_pipeline_duration"`
				AvgInvestigationTime float64 `json:"avg_investigation_time"`
				Currency             string  `json:"currency"`
			}

			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
				return
			}

			currency := strings.TrimSpace(req.Currency)
			if currency == "" {
				currency = "USD"
			}

			var dbErr error
			for attempt := 1; attempt <= 5; attempt++ {
				_, dbErr = core.DB.Exec(`
					INSERT INTO finops_settings (id, dev_hourly_rate, ci_minute_cost, avg_pipeline_duration, avg_investigation_time, currency)
					VALUES (1, ?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						dev_hourly_rate = excluded.dev_hourly_rate,
						ci_minute_cost = excluded.ci_minute_cost,
						avg_pipeline_duration = excluded.avg_pipeline_duration,
						avg_investigation_time = excluded.avg_investigation_time,
						currency = excluded.currency`,
					req.DevHourlyRate, req.CiMinuteCost, req.AvgPipelineDuration, req.AvgInvestigationTime, currency)
				if dbErr == nil {
					break
				}
				errStr := strings.ToLower(dbErr.Error())
				if strings.Contains(errStr, "locked") || strings.Contains(errStr, "busy") {
					time.Sleep(time.Duration(attempt*50) * time.Millisecond)
					continue
				}
				break
			}

			if dbErr != nil {
				http.Error(w, "Database update failed", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		}
	})))
}

func attachNearestDeploys(incidents []map[string]interface{}, fromS, toS string) {
	if len(incidents) == 0 {
		return
	}
	seen := map[string]struct{}{}
	var projects []string
	for _, inc := range incidents {
		name, _ := inc["project_name"].(string)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		projects = append(projects, name)
	}
	fromT, _ := time.Parse("2006-01-02 15:04:05", fromS)
	toT, _ := time.Parse("2006-01-02 15:04:05", toS)
	if fromT.IsZero() {
		fromT = time.Now().UTC().Add(-30 * 24 * time.Hour)
	}
	if toT.IsZero() {
		toT = time.Now().UTC()
	}
	stamps := core.LoadPipelineStamps(projects, fromT.Add(-24*time.Hour), toT)
	for _, inc := range incidents {
		name, _ := inc["project_name"].(string)
		runID, _ := inc["pipeline_run_id"].(string)
		created, _ := inc["created_at"].(string)
		link, ok := core.LinkDeploy(stamps, name, runID, created)
		if ok {
			inc["deploy"] = link
		}
	}
}
