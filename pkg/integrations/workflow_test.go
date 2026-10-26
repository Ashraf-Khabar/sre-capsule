package integrations

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestParseWorkflowJSON_andValidate(t *testing.T) {
	raw := `{
		"version": 1,
		"enabled": true,
		"entry": "start",
		"nodes": {
			"start": {"type": "trigger"},
			"cond": {"type": "condition", "when": {"op": "tag", "match": "prefix", "value": "[FLAKY]"}},
			"act": {"type": "action", "file_path": "slack/slack-notifier.json"}
		},
		"edges": [
			{"from": "start", "to": "cond"},
			{"from": "cond", "to": "act", "when": "true"}
		]
	}`
	doc, err := ParseWorkflowJSON(raw)
	if err != nil || doc == nil {
		t.Fatalf("parse: %v", err)
	}
	reg, err := LoadRegistry(filepath.Join("..", "..", "plugins"))
	if err != nil {
		t.Skip("plugins dir:", err)
	}
	if err := ValidateWorkflow(doc, reg, map[string]bool{"slack/slack-notifier.json": true}); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestValidateWorkflow_rejectsCycle(t *testing.T) {
	doc := &WorkflowDocument{
		Version: 1,
		Enabled: true,
		Entry:   "a",
		Nodes: map[string]WorkflowNode{
			"a": {Type: "trigger"},
			"b": {Type: "trigger"},
		},
		Edges: []WorkflowEdge{
			{From: "a", To: "b"},
			{From: "b", To: "a"},
		},
	}
	if err := ValidateWorkflow(doc, nil, nil); err == nil {
		t.Fatal("expected cycle error")
	}
}

func TestEvaluateCondition_flakyPrefix(t *testing.T) {
	ctx := WorkflowContext{
		Incident: IncidentContext{Name: "[FLAKY] checkout test"},
		Tags:     DeriveTags("[FLAKY] checkout test"),
	}
	expr := &ConditionExpr{Op: "tag", Match: "prefix", Value: "[FLAKY]", Field: "incident.name"}
	if !EvaluateCondition(expr, ctx) {
		t.Fatal("expected flaky prefix match")
	}
}

func TestEvaluateCondition_fieldCaseInsensitive(t *testing.T) {
	ctx := WorkflowContext{
		Incident: IncidentContext{
			Name:   "[PIPELINE CRASH] Execution Failed",
			Status: "Failed",
			Error:  "install phase timeout",
		},
	}
	expr := &ConditionExpr{Op: "text", Match: "contains", Field: "Incident.Name", Value: "pipeline crash"}
	if !EvaluateCondition(expr, ctx) {
		t.Fatal("expected case-insensitive field match on incident name")
	}
	statusExpr := &ConditionExpr{Op: "status", Match: "equals", Value: "failed"}
	if !EvaluateCondition(statusExpr, ctx) {
		t.Fatal("expected case-insensitive status equals")
	}
}

func TestEvaluateCondition_textEquals(t *testing.T) {
	ctx := WorkflowContext{
		Incident: IncidentContext{Error: "upstream timeout after 30s"},
	}
	contains := &ConditionExpr{Op: "text", Match: "contains", Field: "incident.error", Value: "timeout"}
	if !EvaluateCondition(contains, ctx) {
		t.Fatal("expected contains match")
	}
	equals := &ConditionExpr{Op: "text", Match: "equals", Field: "incident.error", Value: "upstream timeout after 30s"}
	if !EvaluateCondition(equals, ctx) {
		t.Fatal("expected equals match on error field")
	}
	prefix := &ConditionExpr{Op: "text", Match: "prefix", Field: "incident.error", Value: "upstream"}
	if !EvaluateCondition(prefix, ctx) {
		t.Fatal("expected prefix match on error field")
	}
	absent := &ConditionExpr{Op: "text", Match: "not_contains", Field: "incident.error", Value: "disk full"}
	if !EvaluateCondition(absent, ctx) {
		t.Fatal("expected not_contains match")
	}
}

func TestWorkflowEngine_runsActionOnBranch(t *testing.T) {
	pluginsDir := filepath.Join("..", "..", "plugins")
	if _, err := os.Stat(pluginsDir); err != nil {
		t.Skip("plugins directory missing")
	}
	reg, err := LoadRegistry(pluginsDir)
	if err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(reg)
	doc := &WorkflowDocument{
		Version: 1,
		Enabled: true,
		Entry:   "start",
		Nodes: map[string]WorkflowNode{
			"start": {Type: "trigger"},
			"cond": {
				Type: "condition",
				When: &ConditionExpr{Op: "tag", Match: "prefix", Value: "[FLAKY]", Field: "incident.name"},
			},
			"slack": {Type: "action", FilePath: "slack/slack-notifier.json"},
			"jira":  {Type: "action", FilePath: "jira/jira-ticket.json"},
		},
		Edges: []WorkflowEdge{
			{From: "start", To: "cond"},
			{From: "cond", To: "slack", When: "true"},
			{From: "cond", To: "jira", When: "false"},
		},
	}
	wctx := WorkflowContext{
		Incident: IncidentContext{
			Name:   "[FLAKY] payment",
			Status: "CRITICAL",
			Action: "AUTO_EVENT:test",
		},
		Tags:    []string{"FLAKY"},
		Allowed: map[string]bool{"slack/slack-notifier.json": true, "jira/jira-ticket.json": true},
	}
	routing := ProjectRouting{SlackChannel: "#test", Values: map[string]string{"SLACK_CHANNEL": "#test"}}
	we := NewWorkflowEngine(engine)
	we.Execute(context.Background(), doc, wctx, routing)
}

func TestMatchesTrigger_legacyUnchanged(t *testing.T) {
	text := "critical timeout in login"
	if !matchesTrigger(text, []string{"timeout"}) {
		t.Fatal("expected trigger match")
	}
	if matchesTrigger(text, []string{"flaky"}) {
		t.Fatal("unexpected trigger match")
	}
}

