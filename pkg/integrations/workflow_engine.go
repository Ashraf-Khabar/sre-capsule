package integrations

import (
	"context"
	"log/slog"
	"strings"
)

// WorkflowEngine walks a DAG and runs native integration actions.
type WorkflowEngine struct {
	engine *Engine
}

// WorkflowExecutionPlan describes nodes visited during a dry-run.
type WorkflowExecutionPlan struct {
	Visited []string `json:"visited"`
	Actions []string `json:"actions"`
	Skipped []string `json:"skipped"`
}

func NewWorkflowEngine(engine *Engine) *WorkflowEngine {
	return &WorkflowEngine{engine: engine}
}

// Execute traverses the workflow from entry and runs action nodes sequentially per branch.
// Remediation uses a detached context so upstream HTTP timeouts cannot cancel plugin actions.
func (we *WorkflowEngine) Execute(ctx context.Context, doc *WorkflowDocument, wctx WorkflowContext, routing ProjectRouting) {
	if we == nil || we.engine == nil || doc == nil || !IsWorkflowActive(doc) {
		return
	}
	_ = ctx
	ctx = context.Background()
	visited := make(map[string]bool)
	we.walk(ctx, doc, doc.Entry, wctx, routing, visited)
}

// PlanExecution dry-runs the DAG and returns which action file paths would run.
func (we *WorkflowEngine) PlanExecution(doc *WorkflowDocument, wctx WorkflowContext) WorkflowExecutionPlan {
	plan := WorkflowExecutionPlan{}
	if we == nil || doc == nil || doc.Entry == "" {
		return plan
	}
	visited := make(map[string]bool)
	we.walkPlan(doc, doc.Entry, wctx, &plan, visited)
	return plan
}

func (we *WorkflowEngine) walk(ctx context.Context, doc *WorkflowDocument, nodeID string, wctx WorkflowContext, routing ProjectRouting, visited map[string]bool) {
	if ctx.Err() != nil {
		return
	}
	if visited[nodeID] {
		slog.Warn("workflow cycle detected at runtime", "node", nodeID)
		return
	}
	visited[nodeID] = true

	node, ok := doc.Nodes[nodeID]
	if !ok {
		return
	}
	switch node.Type {
	case "trigger":
		for _, next := range outgoingEdges(doc.Edges, nodeID, "") {
			we.walk(ctx, doc, next, wctx, routing, visited)
		}
	case "condition":
		result := EvaluateCondition(node.When, wctx)
		branch := "false"
		if result {
			branch = "true"
		}
		slog.Debug("workflow condition", "node", nodeID, "result", result, "branch", branch)
		for _, next := range outgoingEdges(doc.Edges, nodeID, branch) {
			we.walk(ctx, doc, next, wctx, routing, visited)
		}
	case "action":
		skipReason := actionSkipReason(wctx, node.FilePath)
		if skipReason == "" {
			m, ok := we.engine.registry.GetByPath(node.FilePath)
			if !ok {
				slog.Warn("workflow action skipped: unknown manifest", "path", node.FilePath)
			} else {
				inc := wctx.Incident
				if inc.Action == "" {
					inc.Action = "AUTO_EVENT:" + inc.Name
				}
				slog.Info("workflow action", "path", node.FilePath, "label", node.Label)
				res := we.engine.runManifest(ctx, m, inc, routingForAction(routing, node))
				if !res.Success {
					slog.Warn("workflow action failed", "path", node.FilePath, "logs", res.Logs)
				}
			}
		} else {
			slog.Warn("workflow action skipped", "path", node.FilePath, "reason", skipReason)
		}
		for _, next := range outgoingEdges(doc.Edges, nodeID, "") {
			we.walk(ctx, doc, next, wctx, routing, visited)
		}
	}
}

func (we *WorkflowEngine) walkPlan(doc *WorkflowDocument, nodeID string, wctx WorkflowContext, plan *WorkflowExecutionPlan, visited map[string]bool) {
	if visited[nodeID] {
		return
	}
	visited[nodeID] = true
	node, ok := doc.Nodes[nodeID]
	if !ok {
		return
	}
	plan.Visited = append(plan.Visited, nodeID+":"+node.Type)
	switch node.Type {
	case "trigger":
		for _, next := range outgoingEdges(doc.Edges, nodeID, "") {
			we.walkPlan(doc, next, wctx, plan, visited)
		}
	case "condition":
		result := EvaluateCondition(node.When, wctx)
		branch := "false"
		if result {
			branch = "true"
		}
		for _, next := range outgoingEdges(doc.Edges, nodeID, branch) {
			we.walkPlan(doc, next, wctx, plan, visited)
		}
	case "action":
		if reason := actionSkipReason(wctx, node.FilePath); reason != "" {
			plan.Skipped = append(plan.Skipped, node.FilePath+": "+reason)
		} else if node.FilePath == "" {
			plan.Skipped = append(plan.Skipped, "action: missing file_path")
		} else {
			plan.Actions = append(plan.Actions, node.FilePath)
		}
		for _, next := range outgoingEdges(doc.Edges, nodeID, "") {
			we.walkPlan(doc, next, wctx, plan, visited)
		}
	}
}

// routingForAction overlays the action node's own fields on the gateway routing.
// Empty node values keep the gateway or plugin default.
func routingForAction(base ProjectRouting, node WorkflowNode) ProjectRouting {
	if len(node.Config) == 0 {
		return base
	}
	values := make(map[string]string, len(base.Values)+len(node.Config))
	for k, v := range base.Values {
		values[k] = v
	}
	for k, v := range node.Config {
		if strings.TrimSpace(v) != "" {
			values[k] = strings.TrimSpace(v)
		}
	}
	out := base
	out.Values = values
	if v := values["SLACK_CHANNEL"]; v != "" {
		out.SlackChannel = v
	}
	if v := values["JIRA_PROJECT_KEY"]; v != "" {
		out.JiraProjectKey = v
	}
	if v := values["TEAMS_WEBHOOK_URL"]; v != "" {
		out.TeamsWebhookURL = v
	}
	return out
}

func actionSkipReason(wctx WorkflowContext, filePath string) string {
	if wctx.Allowed == nil {
		return ""
	}
	if len(wctx.Allowed) == 0 {
		return "gateway has no allowed plugins"
	}
	if filePath == "" {
		return "missing file_path"
	}
	if !wctx.Allowed[filePath] {
		return "not configured on gateway"
	}
	return ""
}
