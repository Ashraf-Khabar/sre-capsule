package server

import (
	"encoding/csv"
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

func registerFinOpsRoutes(config *core.Config) {
	http.HandleFunc("/api/finops/evolution", jwtAuthMiddleware(config, "", managerOnlyHandler(config, handleFinOpsEvolution)))
	http.HandleFunc("/api/finops/export", jwtAuthMiddleware(config, "", managerOnlyHandler(config, handleFinOpsExport)))
}

func managerOnlyHandler(config *core.Config, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !config.Security.Enabled {
			next(w, r)
			return
		}
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
		if !core.CanAccessFinOps(claims.Role) {
			http.Error(w, "Manager access required", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func periodToDays(period string) int {
	switch strings.ToLower(period) {
	case "week", "7d":
		return 7
	case "month", "30d":
		return 30
	case "year", "365d":
		return 365
	default:
		return 7
	}
}

func loadFinOpsBaseline() (devRate, ciCost, avgDuration, avgInvestigation float64) {
	devRate, ciCost, avgDuration, avgInvestigation = 50, 0.008, 15, 30
	_ = core.DB.QueryRow("SELECT dev_hourly_rate, ci_minute_cost, avg_pipeline_duration, avg_investigation_time FROM finops_settings WHERE id = 1").
		Scan(&devRate, &ciCost, &avgDuration, &avgInvestigation)
	return
}

func finopsCostPerIncident(devRate, avgInvestigation, ciCost, avgDuration float64) float64 {
	invest := (devRate / 60.0) * avgInvestigation
	ci := avgDuration * ciCost
	return invest + ci
}

// handleFinOpsEvolution returns weekly FinOps metrics (cost, volume, flaky).
func handleFinOpsEvolution(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	tw := incidentTimeWindowFromRequest(r)
	fromT, _ := time.Parse("2006-01-02 15:04:05", tw.From)
	toT, _ := time.Parse("2006-01-02 15:04:05", tw.To)
	if fromT.IsZero() || toT.IsZero() {
		fromT = time.Now().UTC().Add(-90 * 24 * time.Hour)
		toT = time.Now().UTC()
	}
	bucketExpr := evolutionBucketExpr(fromT, toT)
	bucketLabel := evolutionBucketLabel(fromT, toT)

	devRate, ciCost, avgDuration, avgInvestigation := loadFinOpsBaseline()
	costPerInc := finopsCostPerIncident(devRate, avgInvestigation, ciCost, avgDuration)

	rows, err := core.DB.Query(fmt.Sprintf(`
		SELECT 
			%s as week_start,
			COUNT(*) as total_incidents,
			SUM(CASE WHEN name LIKE '[FLAKY]%%' THEN 1 ELSE 0 END) as flaky_count,
			SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved_count,
			AVG(CASE WHEN is_resolved = 1 AND resolved_at IS NOT NULL 
				THEN (julianday(resolved_at) - julianday(created_at)) * 24 * 60 ELSE NULL END) as avg_mttr
		FROM incidents
		WHERE created_at >= ? AND created_at <= ?
		GROUP BY week_start
		ORDER BY week_start ASC
	`, bucketExpr), tw.From, tw.To)
	if err != nil {
		http.Error(w, "Failed to load evolution", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type weekRow struct {
		WeekStart        string  `json:"week_start"`
		TotalIncidents   int     `json:"total_incidents"`
		FlakyCount       int     `json:"flaky_count"`
		ResolvedCount    int     `json:"resolved_count"`
		MTTRMinutes      float64 `json:"mttr_minutes"`
		EstimatedCostUSD float64 `json:"estimated_cost_usd"`
		FlakyCostUSD     float64 `json:"flaky_cost_usd"`
		CIMinutesLost    int     `json:"ci_minutes_lost"`
	}

	var series []weekRow
	for rows.Next() {
		var w weekRow
		var mttr *float64
		rows.Scan(&w.WeekStart, &w.TotalIncidents, &w.FlakyCount, &w.ResolvedCount, &mttr)
		if mttr != nil {
			w.MTTRMinutes = *mttr
		}
		w.CIMinutesLost = int(float64(w.TotalIncidents) * avgDuration)
		w.EstimatedCostUSD = math.Round(float64(w.TotalIncidents) * costPerInc)
		w.FlakyCostUSD = math.Round(float64(w.FlakyCount) * costPerInc)
		series = append(series, w)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"series":          series,
		"evolution_bucket": bucketLabel,
		"time_from":       tw.From,
		"time_to":         tw.To,
		"baseline": map[string]float64{
			"dev_hourly_rate":        devRate,
			"ci_minute_cost":         ciCost,
			"avg_pipeline_duration":  avgDuration,
			"avg_investigation_time": avgInvestigation,
		},
	})
}

// handleFinOpsExport exports per-gateway execution report for week, month, or year.
func handleFinOpsExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "week"
	}
	days := periodToDays(period)
	projectFilter := r.URL.Query().Get("project")
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "csv"
	}

	devRate, ciCost, avgDuration, avgInvestigation := loadFinOpsBaseline()
	costPerInc := finopsCostPerIncident(devRate, avgInvestigation, ciCost, avgDuration)

	query := `
		SELECT 
			project_name,
			COUNT(*) as total_failures,
			SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved,
			SUM(CASE WHEN name LIKE '[FLAKY]%' THEN 1 ELSE 0 END) as flaky
		FROM incidents
		WHERE created_at >= datetime('now', ?)
	`
	args := []interface{}{fmt.Sprintf("-%d days", days)}
	if projectFilter != "" && projectFilter != "all" {
		query += " AND project_name = ?"
		args = append(args, projectFilter)
	}
	query += " GROUP BY project_name ORDER BY total_failures DESC"

	rows, err := core.DB.Query(query, args...)
	if err != nil {
		http.Error(w, "Export failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type exportRow struct {
		Project       string  `json:"project"`
		Period        string  `json:"period"`
		TotalFailures int     `json:"total_failures"`
		Resolved      int     `json:"resolved"`
		Flaky         int     `json:"flaky"`
		CIMinutes     int     `json:"ci_minutes_lost"`
		EstimatedUSD  float64 `json:"estimated_cost_usd"`
		FlakyUSD      float64 `json:"flaky_waste_usd"`
		HealthScore   int     `json:"health_score"`
	}

	var report []exportRow
	for rows.Next() {
		var proj string
		var total, resolved, flaky int
		rows.Scan(&proj, &total, &resolved, &flaky)
		health := 100
		if total > 0 {
			health = (resolved * 100) / total
		}
		report = append(report, exportRow{
			Project:       proj,
			Period:        period,
			TotalFailures: total,
			Resolved:      resolved,
			Flaky:         flaky,
			CIMinutes:     int(float64(total) * avgDuration),
			EstimatedUSD:  math.Round(float64(total) * costPerInc),
			FlakyUSD:      math.Round(float64(flaky) * costPerInc),
			HealthScore:   health,
		})
	}

	if format == "json" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"generated_at": time.Now().UTC().Format(time.RFC3339),
			"period":       period,
			"days":         days,
			"rows":         report,
		})
		return
	}

	filename := fmt.Sprintf("finops-report-%s-%s.csv", period, time.Now().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"Project", "Period", "Total Failures", "Resolved", "Flaky", "CI Minutes Lost", "Estimated Cost USD", "Flaky Waste USD", "Health Score %"})
	for _, row := range report {
		_ = cw.Write([]string{
			row.Project, row.Period,
			strconv.Itoa(row.TotalFailures), strconv.Itoa(row.Resolved), strconv.Itoa(row.Flaky),
			strconv.Itoa(row.CIMinutes),
			fmt.Sprintf("%.0f", row.EstimatedUSD), fmt.Sprintf("%.0f", row.FlakyUSD),
			strconv.Itoa(row.HealthScore),
		})
	}
	cw.Flush()
}
