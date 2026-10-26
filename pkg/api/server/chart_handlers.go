package server

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
	"github.com/golang-jwt/jwt/v5"
)

func chartStudioHandler(config *core.Config, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !config.Security.Enabled {
			next(w, r)
			return
		}
		authHeader := r.Header.Get("Authorization")
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
		if !core.CanAccessChartStudio(claims.Role) {
			http.Error(w, "Chart Studio access required", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func registerChartRoutes(config *core.Config) {
	http.HandleFunc("/api/charts/evaluate", jwtAuthMiddleware(config, "", chartStudioHandler(config, handleChartEvaluate)))
	http.HandleFunc("/api/charts/saved", jwtAuthMiddleware(config, "", chartStudioHandler(config, handleSavedCharts)))
	http.HandleFunc("/api/charts/pinned", jwtAuthMiddleware(config, "", handlePinnedCharts))
	http.HandleFunc("/api/charts/reference", jwtAuthMiddleware(config, "", chartStudioHandler(config, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"language": "QCL",
			"version":  "1.0",
			"directives": []string{"CHART", "METRIC", "RANGE", "GROUP", "PROJECT"},
			"metrics": []map[string]string{
				{"id": "incidents", "description": "Total failure count per bucket"},
				{"id": "flaky", "description": "Flaky-tagged failures ([FLAKY] prefix)"},
				{"id": "stable", "description": "Non-flaky structural failures"},
				{"id": "resolved", "description": "Resolved incident count"},
				{"id": "active", "description": "Unresolved backlog count"},
				{"id": "mttr", "description": "Mean time to resolution (minutes)"},
				{"id": "resolution_rate", "description": "Resolved / total × 100 (%)"},
				{"id": "flaky_ratio", "description": "Flaky / total × 100 (%)"},
				{"id": "finops_cost", "description": "Total loaded cost: CI + investigation (USD)"},
				{"id": "finops_flaky_cost", "description": "Flaky subset loaded cost (USD)"},
				{"id": "ci_minutes", "description": "Runner minutes lost (incidents × T_pipe)"},
				{"id": "ci_cost", "description": "CI spend only (USD)"},
				{"id": "invest_cost", "description": "Investigation spend only (USD)"},
			},
			"example": "CHART line \"Weekly FinOps exposure\"\nMETRIC finops_cost\nRANGE 12w\nGROUP week\n# PROJECT optional-gateway",
		})
	})))
}

type savedChartRow struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	QCLQuery      string `json:"qcl_query"`
	PinDashboard  bool   `json:"pin_dashboard"`
	PinFinops     bool   `json:"pin_finops"`
	CreatedBy     string `json:"created_by,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"`
}

func handleSavedCharts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		listSavedCharts(w)
	case http.MethodPost:
		createSavedChart(w, r)
	case http.MethodPut:
		updateSavedChart(w, r)
	case http.MethodDelete:
		deleteSavedChart(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func listSavedCharts(w http.ResponseWriter) {
	rows, err := core.DB.Query(`
		SELECT id, name, description, qcl_query, pin_dashboard, pin_finops, created_by, updated_at
		FROM saved_charts ORDER BY updated_at DESC`)
	if err != nil {
		http.Error(w, "Failed to list charts", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var list []savedChartRow
	for rows.Next() {
		var row savedChartRow
		var pinDash, pinFin int
		rows.Scan(&row.ID, &row.Name, &row.Description, &row.QCLQuery, &pinDash, &pinFin, &row.CreatedBy, &row.UpdatedAt)
		row.PinDashboard = pinDash == 1
		row.PinFinops = pinFin == 1
		list = append(list, row)
	}
	if list == nil {
		list = []savedChartRow{}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"charts": list})
}

func createSavedChart(w http.ResponseWriter, r *http.Request) {
	var req savedChartRow
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.QCLQuery) == "" {
		http.Error(w, "name and qcl_query are required", http.StatusBadRequest)
		return
	}
	if _, err := core.ParseChartQuery(req.QCLQuery); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	createdBy := chartAuthorFromRequest(r)
	pinDash := boolToInt(req.PinDashboard)
	pinFin := 0
	if core.CanAccessFinOps(chartRoleFromRequest(r)) {
		pinFin = boolToInt(req.PinFinops)
	}
	res, err := core.DB.Exec(`
		INSERT INTO saved_charts (name, description, qcl_query, pin_dashboard, pin_finops, created_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
		req.Name, req.Description, req.QCLQuery, pinDash, pinFin, createdBy)
	if err != nil {
		http.Error(w, "Failed to save chart", http.StatusInternalServerError)
		return
	}
	id, _ := res.LastInsertId()
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "message": "Chart saved"})
}

func updateSavedChart(w http.ResponseWriter, r *http.Request) {
	var req savedChartRow
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID < 1 {
		http.Error(w, "Invalid chart payload", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.QCLQuery) == "" {
		http.Error(w, "name and qcl_query are required", http.StatusBadRequest)
		return
	}
	if _, err := core.ParseChartQuery(req.QCLQuery); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	pinDash := boolToInt(req.PinDashboard)
	pinFin := 0
	if core.CanAccessFinOps(chartRoleFromRequest(r)) {
		pinFin = boolToInt(req.PinFinops)
	}
	res, err := core.DB.Exec(`
		UPDATE saved_charts SET name = ?, description = ?, qcl_query = ?, pin_dashboard = ?, pin_finops = ?, updated_at = datetime('now')
		WHERE id = ?`,
		req.Name, req.Description, req.QCLQuery, pinDash, pinFin, req.ID)
	if err != nil {
		http.Error(w, "Failed to update chart", http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "Chart not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"message": "Chart updated"})
}

func deleteSavedChart(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.Atoi(idStr)
	if err != nil || id < 1 {
		http.Error(w, "Invalid chart id", http.StatusBadRequest)
		return
	}
	res, err := core.DB.Exec(`DELETE FROM saved_charts WHERE id = ?`, id)
	if err != nil {
		http.Error(w, "Failed to delete chart", http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "Chart not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"message": "Chart deleted"})
}

func handlePinnedCharts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	role := chartRoleFromRequest(r)
	if !core.CanAccessChartStudio(role) {
		http.Error(w, "Chart Studio access required", http.StatusForbidden)
		return
	}

	location := strings.ToLower(r.URL.Query().Get("location"))
	var pinCol string
	switch location {
	case "dashboard":
		pinCol = "pin_dashboard"
	case "finops":
		if !core.CanAccessFinOps(role) {
			http.Error(w, "FinOps access required", http.StatusForbidden)
			return
		}
		pinCol = "pin_finops"
	default:
		http.Error(w, "location must be dashboard or finops", http.StatusBadRequest)
		return
	}

	query := fmt.Sprintf(`
		SELECT id, name, description, qcl_query FROM saved_charts
		WHERE %s = 1 ORDER BY updated_at DESC`, pinCol)
	rows, err := core.DB.Query(query)
	if err != nil {
		http.Error(w, "Failed to load pinned charts", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type pinnedChart struct {
		ID          int                    `json:"id"`
		Name        string                 `json:"name"`
		Description string                 `json:"description"`
		Spec        map[string]interface{} `json:"spec"`
	}

	var charts []pinnedChart
	for rows.Next() {
		var id int
		var name, desc, qcl string
		rows.Scan(&id, &name, &desc, &qcl)
		spec, err := buildChartSpec(qcl)
		if err != nil {
			continue
		}
		charts = append(charts, pinnedChart{ID: id, Name: name, Description: desc, Spec: spec})
	}
	if charts == nil {
		charts = []pinnedChart{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"location": location,
		"charts":   charts,
	})
}

func buildChartSpec(qcl string) (map[string]interface{}, error) {
	q, err := core.ParseChartQuery(qcl)
	if err != nil {
		return nil, err
	}
	labels, datasets, err := evaluateChartQuery(q)
	if err != nil {
		return nil, err
	}
	title := q.Title
	if title == "" {
		title = fmt.Sprintf("%s by %s", q.Metric, q.GroupBy)
	}
	return map[string]interface{}{
		"chart_type": q.ChartType,
		"title":      title,
		"labels":     labels,
		"datasets":   datasets,
	}, nil
}

func chartClaimsFromRequest(r *http.Request) *Claims {
	authHeader := r.Header.Get("Authorization")
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	claims := &Claims{}
	if _, err := jwt.ParseWithClaims(tokenString, claims, jwtSigningKey); err == nil {
		return claims
	}
	return &Claims{}
}

func chartAuthorFromRequest(r *http.Request) string {
	return chartClaimsFromRequest(r).Username
}

func chartRoleFromRequest(r *http.Request) string {
	return chartClaimsFromRequest(r).Role
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func handleChartEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Query string `json:"query"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Query) == "" {
		http.Error(w, "Invalid query body", http.StatusBadRequest)
		return
	}

	spec, q, err := buildChartSpecWithQuery(req.Query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	spec["parsed"] = q

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(spec)
}

func buildChartSpecWithQuery(query string) (map[string]interface{}, core.ChartQuery, error) {
	q, err := core.ParseChartQuery(query)
	if err != nil {
		return nil, q, err
	}
	spec, err := buildChartSpec(query)
	return spec, q, err
}

func evaluateChartQuery(q core.ChartQuery) ([]string, []map[string]interface{}, error) {
	devRate, ciCost, avgDuration, avgInvestigation := loadFinOpsBaseline()

	if q.GroupBy == "project" {
		return evaluateByProject(q, devRate, ciCost, avgDuration, avgInvestigation)
	}
	return evaluateByWeek(q, devRate, ciCost, avgDuration, avgInvestigation)
}

func evaluateByWeek(q core.ChartQuery, devRate, ciCost, avgDuration, avgInvestigation float64) ([]string, []map[string]interface{}, error) {
	filter := ""
	args := []interface{}{fmt.Sprintf("-%d days", q.RangeDays)}
	if q.Project != "" {
		filter = " AND project_name = ?"
		args = append(args, q.Project)
	}

	rows, err := core.DB.Query(`
		SELECT 
			date(created_at, 'weekday 0', '-6 days') as bucket,
			COUNT(*) as total,
			SUM(CASE WHEN name LIKE '[FLAKY]%' THEN 1 ELSE 0 END) as flaky,
			SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved,
			SUM(CASE WHEN is_resolved = 0 THEN 1 ELSE 0 END) as active,
			AVG(CASE WHEN is_resolved = 1 AND resolved_at IS NOT NULL 
				THEN (julianday(resolved_at) - julianday(created_at)) * 24 * 60 ELSE NULL END) as mttr
		FROM incidents
		WHERE created_at >= datetime('now', ?)`+filter+`
		GROUP BY bucket
		ORDER BY bucket ASC`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var labels []string
	var values []float64
	for rows.Next() {
		var bucket string
		var total, flaky, resolved, active int
		var mttr *float64
		rows.Scan(&bucket, &total, &flaky, &resolved, &active, &mttr)
		labels = append(labels, bucket)
		values = append(values, metricValue(q.Metric, total, flaky, resolved, active, mttr, devRate, ciCost, avgDuration, avgInvestigation))
	}

	return labels, []map[string]interface{}{{
		"label": metricLabel(q.Metric),
		"data":  values,
	}}, nil
}

func evaluateByProject(q core.ChartQuery, devRate, ciCost, avgDuration, avgInvestigation float64) ([]string, []map[string]interface{}, error) {
	rows, err := core.DB.Query(`
		SELECT 
			project_name,
			COUNT(*) as total,
			SUM(CASE WHEN name LIKE '[FLAKY]%' THEN 1 ELSE 0 END) as flaky,
			SUM(CASE WHEN is_resolved = 1 THEN 1 ELSE 0 END) as resolved,
			SUM(CASE WHEN is_resolved = 0 THEN 1 ELSE 0 END) as active,
			AVG(CASE WHEN is_resolved = 1 AND resolved_at IS NOT NULL 
				THEN (julianday(resolved_at) - julianday(created_at)) * 24 * 60 ELSE NULL END) as mttr
		FROM incidents
		WHERE created_at >= datetime('now', ?)
		GROUP BY project_name
		ORDER BY total DESC`, fmt.Sprintf("-%d days", q.RangeDays))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var labels []string
	var values []float64
	for rows.Next() {
		var proj string
		var total, flaky, resolved, active int
		var mttr *float64
		rows.Scan(&proj, &total, &flaky, &resolved, &active, &mttr)
		if q.Project != "" && q.Project != proj {
			continue
		}
		labels = append(labels, proj)
		values = append(values, metricValue(q.Metric, total, flaky, resolved, active, mttr, devRate, ciCost, avgDuration, avgInvestigation))
	}

	return labels, []map[string]interface{}{{
		"label": metricLabel(q.Metric),
		"data":  values,
	}}, nil
}

func metricValue(metric string, total, flaky, resolved, active int, mttr *float64, devRate, ciCost, avgDuration, avgInvestigation float64) float64 {
	invest := (devRate / 60.0) * avgInvestigation
	ciPerInc := avgDuration * ciCost
	costPerInc := invest + ciPerInc

	switch metric {
	case "incidents":
		return float64(total)
	case "flaky":
		return float64(flaky)
	case "stable":
		return float64(total - flaky)
	case "resolved":
		return float64(resolved)
	case "active":
		return float64(active)
	case "mttr":
		if mttr != nil {
			return math.Round(*mttr*10) / 10
		}
		return 0
	case "resolution_rate":
		if total == 0 {
			return 0
		}
		return math.Round((float64(resolved)/float64(total))*1000) / 10
	case "flaky_ratio":
		if total == 0 {
			return 0
		}
		return math.Round((float64(flaky)/float64(total))*1000) / 10
	case "finops_cost":
		return math.Round(float64(total) * costPerInc)
	case "finops_flaky_cost":
		return math.Round(float64(flaky) * costPerInc)
	case "ci_minutes":
		return float64(total) * avgDuration
	case "ci_cost":
		return math.Round(float64(total) * ciPerInc)
	case "invest_cost":
		return math.Round(float64(total) * invest)
	default:
		return 0
	}
}

func metricLabel(metric string) string {
	switch metric {
	case "incidents":
		return "Incidents"
	case "flaky":
		return "Flaky"
	case "resolved":
		return "Resolved"
	case "stable":
		return "Stable failures"
	case "active":
		return "Active backlog"
	case "resolution_rate":
		return "Resolution rate (%)"
	case "flaky_ratio":
		return "Flaky ratio (%)"
	case "mttr":
		return "MTTR (min)"
	case "finops_cost":
		return "FinOps Cost (USD)"
	case "finops_flaky_cost":
		return "Flaky Waste (USD)"
	case "ci_minutes":
		return "CI Minutes"
	case "ci_cost":
		return "CI cost (USD)"
	case "invest_cost":
		return "Investigation cost (USD)"
	default:
		return metric
	}
}