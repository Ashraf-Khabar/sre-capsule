package integrations

import (
	"encoding/json"
	"fmt"
	"strings"
)

const WorkflowSchemaVersion = 1

// WorkflowDocument is the canonical DAG format stored in projects.sre_workflow_json.
type WorkflowDocument struct {
	Version int                     `json:"version"`
	Enabled bool                    `json:"enabled"`
	Meta    WorkflowMeta            `json:"meta,omitempty"`
	Entry   string                  `json:"entry"`
	Nodes   map[string]WorkflowNode `json:"nodes"`
	Edges   []WorkflowEdge          `json:"edges"`
	UI      json.RawMessage         `json:"ui,omitempty"`
}

type WorkflowMeta struct {
	Name      string `json:"name,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type WorkflowNode struct {
	Type        string         `json:"type"` // trigger | condition | action
	Label       string         `json:"label,omitempty"`
	When        *ConditionExpr `json:"when,omitempty"`
	FilePath    string            `json:"file_path,omitempty"`
	Integration string            `json:"integration,omitempty"`
	Config      map[string]string `json:"config,omitempty"`
}

type WorkflowEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	When string `json:"when,omitempty"` // "true" | "false" | "" (any)
}

// ConditionExpr supports tag, status, text, and, or operators.
type ConditionExpr struct {
	Op    string          `json:"op"`
	Field string          `json:"field,omitempty"`
	Match string          `json:"match,omitempty"`
	Value interface{}     `json:"value,omitempty"`
	And   []ConditionExpr `json:"and,omitempty"`
	Or    []ConditionExpr `json:"or,omitempty"`
}

// WorkflowContext carries incident data for condition evaluation.
type WorkflowContext struct {
	Incident IncidentContext
	Tags     []string
	Allowed  map[string]bool
}

// ParseWorkflowJSON decodes a workflow document. Returns nil for empty input.
func ParseWorkflowJSON(raw string) (*WorkflowDocument, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var doc WorkflowDocument
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, fmt.Errorf("invalid workflow JSON: %w", err)
	}
	if doc.Version == 0 {
		doc.Version = WorkflowSchemaVersion
	}
	return &doc, nil
}

// MarshalWorkflowJSON encodes a workflow for persistence.
func MarshalWorkflowJSON(doc *WorkflowDocument) string {
	if doc == nil {
		return ""
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return ""
	}
	return string(b)
}

// IsWorkflowActive reports whether the DAG engine should run instead of legacy auto-trigger.
func IsWorkflowActive(doc *WorkflowDocument) bool {
	return doc != nil && doc.Enabled && doc.Version >= 1 && doc.Entry != "" && len(doc.Nodes) > 0
}

// DeriveTags extracts FLAKY, PERF, etc. from incident name prefixes.
func DeriveTags(incidentName string) []string {
	var tags []string
	name := strings.ToUpper(incidentName)
	for _, prefix := range []struct{ tag, p string }{
		{"FLAKY", "[FLAKY]"},
		{"PERF", "[PERF]"},
	} {
		if strings.Contains(name, prefix.p) {
			tags = append(tags, prefix.tag)
		}
	}
	return tags
}

// ValidateWorkflow checks structure, cycles, registry paths, routing-active plugins, and gateway allow-list.
func ValidateWorkflow(doc *WorkflowDocument, reg *Registry, allowed map[string]bool) error {
	return validateWorkflow(doc, reg, allowed, true)
}

// ValidateWorkflowStructure validates DAG shape and registry paths (for runbook catalog / templates).
func ValidateWorkflowStructure(doc *WorkflowDocument, reg *Registry) error {
	return validateWorkflow(doc, reg, nil, false)
}

func validateWorkflow(doc *WorkflowDocument, reg *Registry, allowed map[string]bool, requireRoutingActive bool) error {
	if doc == nil {
		return fmt.Errorf("workflow is nil")
	}
	if doc.Version < 1 {
		return fmt.Errorf("unsupported workflow version")
	}
	if doc.Entry == "" {
		return fmt.Errorf("workflow entry node is required")
	}
	if len(doc.Nodes) == 0 {
		return fmt.Errorf("workflow must contain at least one node")
	}
	entry, ok := doc.Nodes[doc.Entry]
	if !ok {
		return fmt.Errorf("entry node %q not found", doc.Entry)
	}
	if entry.Type != "trigger" {
		return fmt.Errorf("entry node must be type trigger")
	}

	outgoing := buildAdjacency(doc.Edges)
	if hasCycle(doc.Entry, outgoing) {
		return fmt.Errorf("workflow contains a cycle")
	}

	for id, node := range doc.Nodes {
		switch node.Type {
		case "trigger", "condition", "action":
		default:
			return fmt.Errorf("node %q has invalid type %q", id, node.Type)
		}
		if node.Type == "condition" && node.When == nil {
			return fmt.Errorf("condition node %q requires when", id)
		}
		if node.Type == "action" {
			if strings.TrimSpace(node.FilePath) == "" {
				return fmt.Errorf("action node %q requires an integration (file_path)", id)
			}
			if reg == nil {
				return fmt.Errorf("remediation registry not loaded")
			}
			m, ok := reg.GetByPath(node.FilePath)
			if !ok {
				return fmt.Errorf("unknown integration path: %s", node.FilePath)
			}
			if requireRoutingActive && !IsActiveForRouting(m.Status, m.RoutingEnabled, m.AutoRun) {
				return fmt.Errorf("integration %q is not active for routing", m.Name)
			}
			if requireRoutingActive && (len(allowed) == 0 || !allowed[node.FilePath]) {
				return fmt.Errorf("integration %q is not configured on this gateway", m.Name)
			}
		}
	}

	for _, e := range doc.Edges {
		if _, ok := doc.Nodes[e.From]; !ok {
			return fmt.Errorf("edge from unknown node %q", e.From)
		}
		if _, ok := doc.Nodes[e.To]; !ok {
			return fmt.Errorf("edge to unknown node %q", e.To)
		}
		if e.When != "" && e.When != "true" && e.When != "false" {
			return fmt.Errorf("edge when must be true, false, or empty")
		}
	}
	return nil
}

func buildAdjacency(edges []WorkflowEdge) map[string][]string {
	adj := make(map[string][]string)
	for _, e := range edges {
		adj[e.From] = append(adj[e.From], e.To)
	}
	return adj
}

func hasCycle(entry string, adj map[string][]string) bool {
	visiting := make(map[string]bool)
	visited := make(map[string]bool)
	var dfs func(string) bool
	dfs = func(n string) bool {
		if visiting[n] {
			return true
		}
		if visited[n] {
			return false
		}
		visiting[n] = true
		for _, next := range adj[n] {
			if dfs(next) {
				return true
			}
		}
		delete(visiting, n)
		visited[n] = true
		return false
	}
	return dfs(entry)
}

// EvaluateCondition returns whether the expression matches the workflow context.
func EvaluateCondition(expr *ConditionExpr, ctx WorkflowContext) bool {
	if expr == nil {
		return false
	}
	switch strings.ToLower(expr.Op) {
	case "and":
		for _, sub := range expr.And {
			if !EvaluateCondition(&sub, ctx) {
				return false
			}
		}
		return len(expr.And) > 0
	case "or":
		for _, sub := range expr.Or {
			if EvaluateCondition(&sub, ctx) {
				return true
			}
		}
		return false
	case "tag":
		return evalTag(expr, ctx)
	case "status":
		return evalStatus(expr, ctx.Incident.Status)
	case "text":
		return evalText(expr, ctx.Incident)
	default:
		return false
	}
}

// incidentTitles returns the stored title and the title shown on the card.
// The card hides a leading [FLAKY] or [PERF] badge, so name conditions use both.
func incidentTitles(name string) []string {
	raw := strings.TrimSpace(name)
	visible := raw
	for {
		lower := strings.ToLower(visible)
		next := visible
		for _, p := range []string{"[flaky] ", "[perf] "} {
			if strings.HasPrefix(lower, p) {
				next = strings.TrimSpace(visible[len(p):])
				break
			}
		}
		if next == visible {
			break
		}
		visible = next
	}
	if strings.EqualFold(visible, raw) {
		return []string{raw}
	}
	return []string{raw, visible}
}

func titleMatches(name, want, match string) bool {
	want = strings.ToLower(strings.TrimSpace(want))
	bracket := strings.HasPrefix(want, "[") && strings.HasSuffix(want, "]") && len(want) > 2
	saw := false
	for _, title := range incidentTitles(name) {
		hay := strings.ToLower(title)
		switch match {
		case "prefix":
			if strings.HasPrefix(hay, want) {
				return true
			}
		case "contains":
			if want != "" && strings.Contains(hay, want) {
				return true
			}
		case "not_contains", "not-contains":
			saw = true
			if want != "" && strings.Contains(hay, want) {
				return false
			}
		case "eq", "equals":
			if hay == want || (bracket && strings.Contains(hay, want)) {
				return true
			}
		}
	}
	if saw && (match == "not_contains" || match == "not-contains") {
		return want != ""
	}
	return false
}

func evalTag(expr *ConditionExpr, ctx WorkflowContext) bool {
	want := strings.TrimSpace(fmt.Sprint(expr.Value))
	match := strings.ToLower(expr.Match)
	if match == "" {
		match = "eq"
	}
	field := strings.ToLower(strings.TrimSpace(expr.Field))
	field = strings.TrimPrefix(field, "incident.")
	if (field == "" || field == "name") && titleMatches(ctx.Incident.Name, want, match) {
		return true
	}
	wantNorm := strings.ToLower(want)
	for _, t := range ctx.Tags {
		tagNorm := strings.ToLower(t)
		switch match {
		case "eq", "equals":
			if tagNorm == wantNorm || (strings.HasPrefix(wantNorm, "[") && tagNorm == strings.Trim(wantNorm, "[]")) {
				return true
			}
		case "in":
			for _, part := range strings.Split(want, ",") {
				part = strings.ToLower(strings.TrimSpace(part))
				part = strings.Trim(part, "[]")
				if tagNorm == part {
					return true
				}
			}
		}
	}
	return false
}

func evalStatus(expr *ConditionExpr, status string) bool {
	want := strings.TrimSpace(fmt.Sprint(expr.Value))
	match := strings.ToLower(expr.Match)
	if match == "" {
		match = "eq"
	}
	statusNorm := strings.ToLower(strings.TrimSpace(status))
	wantNorm := strings.ToLower(want)
	switch match {
	case "eq", "equals":
		return statusNorm == wantNorm
	case "in":
		for _, part := range strings.Split(want, ",") {
			if statusNorm == strings.ToLower(strings.TrimSpace(part)) {
				return true
			}
		}
	}
	return false
}

// workflowFieldValue resolves incident fields for conditions (case-insensitive field names).
func workflowFieldValue(inc IncidentContext, field string) string {
	f := strings.ToLower(strings.TrimSpace(field))
	f = strings.TrimPrefix(f, "incident.")
	switch f {
	case "error", "error_message", "err", "message":
		return inc.Error
	case "console", "console_logs", "logs", "stdout":
		return inc.ConsoleLogs
	case "status":
		return inc.Status
	case "action":
		return inc.Action
	case "name", "":
		return inc.Name
	default:
		return inc.Name
	}
}

func evalText(expr *ConditionExpr, inc IncidentContext) bool {
	want := strings.TrimSpace(fmt.Sprint(expr.Value))
	match := strings.ToLower(expr.Match)
	if match == "" {
		match = "contains"
	}
	field := strings.ToLower(strings.TrimSpace(expr.Field))
	field = strings.TrimPrefix(field, "incident.")
	if field == "name" || field == "" {
		return titleMatches(inc.Name, want, match)
	}
	want = strings.ToLower(want)
	hay := strings.ToLower(workflowFieldValue(inc, expr.Field))
	switch match {
	case "contains":
		return strings.Contains(hay, want)
	case "not_contains", "not-contains":
		return !strings.Contains(hay, want)
	case "prefix":
		return strings.HasPrefix(hay, want)
	case "eq", "equals":
		return hay == want
	}
	return false
}

func outgoingEdges(edges []WorkflowEdge, from, when string) []string {
	var out []string
	for _, e := range edges {
		if e.From != from {
			continue
		}
		if when == "" {
			if e.When == "" {
				out = append(out, e.To)
			}
			continue
		}
		if e.When == when {
			out = append(out, e.To)
		}
	}
	return out
}
