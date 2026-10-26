package integrations

import "testing"

func TestPluginURLAllowed(t *testing.T) {
	allowed := []string{
		"https://hooks.slack.com/services/T/B/X",
		"https://api.datadoghq.com/api/v1/events",
		"http://10.1.2.3/gitops/restart",
	}
	for _, u := range allowed {
		if err := pluginURLAllowed(u); err != nil {
			t.Fatalf("%s should be allowed: %v", u, err)
		}
	}
	blocked := []string{
		"file:///etc/passwd",
		"http://127.0.0.1/secret",
		"http://localhost/hook",
		"http://169.254.169.254/latest/meta-data",
		"http://metadata.google.internal/",
		"",
	}
	for _, u := range blocked {
		if err := pluginURLAllowed(u); err == nil {
			t.Fatalf("%s should be blocked", u)
		}
	}
}

func TestPlanExecution_blocksWhenGatewayHasNoAllowList(t *testing.T) {
	doc := &WorkflowDocument{
		Version: 1,
		Enabled: true,
		Entry:   "start",
		Nodes: map[string]WorkflowNode{
			"start": {Type: "trigger"},
			"hook":  {Type: "action", FilePath: "webhook/custom-webhook.json"},
		},
		Edges: []WorkflowEdge{{From: "start", To: "hook"}},
	}
	plan := NewWorkflowEngine(&Engine{}).PlanExecution(doc, WorkflowContext{
		Incident: IncidentContext{Name: "checkout", Status: "Critical"},
		Allowed:  map[string]bool{},
	})
	if len(plan.Actions) != 0 {
		t.Fatalf("expected no actions without a gateway allow list, got %#v", plan.Actions)
	}
	if len(plan.Skipped) != 1 {
		t.Fatalf("expected the action to be skipped, got %#v", plan.Skipped)
	}
}
