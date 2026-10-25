package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	aiPkg "github.com/SRE-Capsule/sre-capsule-community/pkg/ai"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
	"github.com/SRE-Capsule/sre-capsule-community/pkg/integrations"
)

func attachIncidentOps(incidents []map[string]interface{}) {
	ids := make([]int, 0, len(incidents))
	for _, inc := range incidents {
		if id, ok := inc["id"].(int); ok {
			ids = append(ids, id)
		}
	}
	loaded := core.LoadIncidentOps(ids)
	for _, inc := range incidents {
		id, _ := inc["id"].(int)
		op := loaded[id]
		inc["fingerprint"] = op.Fingerprint
		inc["acknowledged_at"] = op.Acknowledged
		inc["acknowledged_by"] = op.AcknowledgedBy
		inc["severity"] = op.Severity
		inc["mitigated_at"] = op.MitigatedAt
		inc["runbook_summary"] = op.Runbook
		inc["postmortem"] = op.Postmortem
	}
	attachSameCauseHistory(incidents)
}

func attachSameCauseHistory(incidents []map[string]interface{}) {
	keys := make([]core.CauseKey, 0, len(incidents))
	for _, inc := range incidents {
		id, _ := inc["id"].(int)
		project, _ := inc["project_name"].(string)
		name, _ := inc["name"].(string)
		fp, _ := inc["fingerprint"].(string)
		keys = append(keys, core.CauseKey{ID: id, Project: project, Fingerprint: fp, Name: name})
	}
	history := core.LoadSameCauseHistory(core.DB, keys)
	for _, inc := range incidents {
		id, _ := inc["id"].(int)
		if priors := history[id]; len(priors) > 0 {
			inc["prior_causes"] = priors
		}
	}
}

func handleIncidentOps(w http.ResponseWriter, r *http.Request, idStr string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, "Invalid incident id", http.StatusBadRequest)
		return
	}
	claims := parseClaims(r)
	if !core.CanResolveIncidents(claims.Role) {
		writeJSONError(w, "Lead or Manager role required", http.StatusForbidden)
		return
	}
	if !core.UserCanAccessAllIncidents(claims.Username, claims.Role, []int{int(id)}) {
		writeJSONError(w, "Forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Action     string `json:"action"`
		Severity   string `json:"severity"`
		TemplateID string `json:"template_id"`
		Body       string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	switch body.Action {
	case "ack":
		err = core.AcknowledgeIncident(id, claims.Username, body.Severity)
	case "mitigate":
		err = core.MitigateIncident(id, claims.Username)
	case "runbook_preview", "runbook":
		tmpl, steps, matchErr := matchIncidentRunbook(id, body.TemplateID)
		if matchErr != nil {
			writeJSONError(w, matchErr.Error(), http.StatusBadRequest)
			return
		}
		summary := strings.Join(steps, ", ")
		if body.Action == "runbook_preview" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"template_id": tmpl.ID, "template_name": tmpl.Name, "summary": summary,
			})
			return
		}
		summary += ". Dry-run through the plugin engine. No external system was called."
		err = core.RecordRunbook(id, tmpl.ID, tmpl.Name, summary, claims.Username)
	case "postmortem":
		text, saveErr := writeIncidentPostmortem(id, claims.Username, body.Body)
		if saveErr != nil {
			writeJSONError(w, saveErr.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"body": text})
		return
	default:
		writeJSONError(w, "Unknown action", http.StatusBadRequest)
		return
	}
	if err != nil {
		msg := "Could not update the incident"
		if _, ok := err.(opsError); ok || err.Error() == "empty postmortem" {
			msg = err.Error()
		}
		writeJSONError(w, msg, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func matchIncidentRunbook(id int64, templateID string) (*integrations.RunbookTemplate, []string, error) {
	var name, errText, status string
	if err := core.DB.QueryRow(`SELECT name, COALESCE(error_message,'') || ' ' || COALESCE(error_logs,''), COALESCE(status,'') FROM incidents WHERE id = ?`, id).Scan(&name, &errText, &status); err != nil {
		return nil, nil, err
	}
	var tmpl *integrations.RunbookTemplate
	if strings.TrimSpace(templateID) != "" {
		found, ok := integrations.GetRunbookTemplate(strings.TrimSpace(templateID))
		if !ok {
			return nil, nil, errUnknownRunbook
		}
		tmpl = found
	} else {
		tmpl = integrations.SuggestRunbook(name, errText)
		if tmpl == nil {
			return nil, nil, errUnknownRunbook
		}
	}
	steps := integrations.PlanRunbook(tmpl, name, errText, status)
	if len(steps) == 0 {
		return nil, nil, errUnknownRunbook
	}
	return tmpl, steps, nil
}

func writeIncidentPostmortem(id int64, actor, edited string) (string, error) {
	var resolved int
	if err := core.DB.QueryRow(`SELECT COALESCE(is_resolved, 0) FROM incidents WHERE id = ?`, id).Scan(&resolved); err != nil {
		return "", err
	}
	if resolved == 0 {
		return "", opsError("resolve the incident before writing a postmortem")
	}
	text := strings.TrimSpace(edited)
	if text == "" {
		facts, err := core.LoadPostmortemFacts(id, deployNote(id))
		if err != nil {
			return "", err
		}
		text = polishPostmortem(core.ComposePostmortem(facts))
	}
	if err := core.SavePostmortem(id, text, actor); err != nil {
		return "", err
	}
	return text, nil
}

func polishPostmortem(draft string) string {
	draft = strings.TrimSpace(draft)
	if draft == "" || core.AIService == nil {
		return draft
	}
	cfg, err := core.AIService.GetConfig(context.Background())
	if err != nil || !cfg.Enabled || cfg.Provider == "" || cfg.Provider == aiPkg.ProviderDisabled {
		return draft
	}
	prompt := "Rewrite this incident postmortem in plain text, under 250 words. Use only the facts below. Do not invent a root cause, a person, a system, or a timestamp. If the cause is not in the facts, say the cause is unknown.\n\n" + draft
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	raw, err := aiPkg.AnalyzeRaw(ctx, cfg, prompt)
	raw = strings.TrimSpace(raw)
	if err != nil || len(raw) < 40 {
		return draft
	}
	if len(raw) > 4000 {
		raw = raw[:4000]
	}
	return raw
}

func deployNote(id int64) string {
	var project, runID string
	if err := core.DB.QueryRow(`SELECT project_name, COALESCE(pipeline_run_id,'') FROM incidents WHERE id = ?`, id).Scan(&project, &runID); err != nil || runID == "" || strings.HasPrefix(runID, "legacy-") {
		return ""
	}
	var sha, branch, outcome string
	if err := core.DB.QueryRow(`SELECT COALESCE(commit_sha,''), COALESCE(branch,''), COALESCE(outcome,'') FROM pipeline_runs WHERE project_name = ? AND pipeline_run_id = ?`, project, runID).Scan(&sha, &branch, &outcome); err != nil {
		return ""
	}
	short := sha
	if len(short) > 7 {
		short = short[:7]
	}
	return strings.TrimSpace(short + " " + branch + " " + outcome)
}

type opsError string

func (e opsError) Error() string { return string(e) }

const errUnknownRunbook opsError = "no runbook step matches this incident"
