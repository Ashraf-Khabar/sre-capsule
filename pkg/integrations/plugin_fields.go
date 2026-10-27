package integrations

// PluginField is one labeled input for a plugin. Each integration has its own set.
type PluginField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder"`
	InputType   string `json:"input_type"` // text, url, password, textarea
	Group       string `json:"group"`      // connection, delivery, message
	Hint        string `json:"hint,omitempty"`
	Gateway     bool   `json:"gateway"`
}

const templateHint = "Placeholders: {{name}} {{status}} {{error}} {{console}}. Set on the workflow action for one gateway."

func textField(key, label, placeholder, group string, gateway bool) PluginField {
	return PluginField{Key: key, Label: label, Placeholder: placeholder, Group: group, Gateway: gateway}
}

func secretField(key, label, group string, gateway bool) PluginField {
	return PluginField{Key: key, Label: label, InputType: "password", Group: group, Gateway: gateway}
}

func urlField(key, label, placeholder, group string, gateway bool) PluginField {
	return PluginField{Key: key, Label: label, Placeholder: placeholder, InputType: "url", Group: group, Gateway: gateway}
}

func messageField(key, label, placeholder string, area bool) PluginField {
	f := PluginField{Key: key, Label: label, Placeholder: placeholder, Group: "message", Hint: templateHint}
	if area {
		f.InputType = "textarea"
	}
	return f
}

// ConfigFieldsForIntegration is the full form for this integration.
// Connection and delivery are edited in Plugin Engine. Message fields are edited on the workflow action.
func ConfigFieldsForIntegration(integration string) []PluginField {
	switch integration {
	case "smtp":
		return []PluginField{
			textField("SMTP_HOST", "SMTP server", "smtp.office365.com", "connection", false),
			textField("SMTP_PORT", "Port", "587", "connection", false),
			textField("SMTP_USER", "Username", "", "connection", false),
			secretField("SMTP_PASS", "Password", "connection", false),
			textField("SMTP_FROM", "From", "sre@company.com", "delivery", false),
			textField("SMTP_TO", "To", "oncall@company.com", "delivery", true),
			textField("SMTP_CC", "Cc", "lead@company.com, manager@company.com", "delivery", true),
			messageField("SMTP_SUBJECT", "Subject", "[SRE Capsule] {{name}}", false),
			messageField("SMTP_BODY", "Body", "Incident: {{name}}\nStatus: {{status}}\n\n{{error}}", true),
		}
	case "sendgrid":
		return []PluginField{
			secretField("SENDGRID_API_KEY", "API key", "connection", false),
			textField("SENDGRID_FROM", "From", "sre@company.com", "delivery", false),
			textField("SENDGRID_FROM_NAME", "From name", "SRE Capsule", "delivery", false),
			textField("SENDGRID_TO", "To", "oncall@company.com", "delivery", true),
			textField("SENDGRID_CC", "Cc", "lead@company.com", "delivery", true),
			messageField("SENDGRID_SUBJECT", "Subject", "[SRE Capsule] {{name}}", false),
			messageField("SENDGRID_BODY", "Body", "{{name}}\n{{status}}\n\n{{error}}", true),
		}
	case "slack":
		return []PluginField{
			urlField("SLACK_WEBHOOK_URL", "Webhook URL", "https://hooks.slack.com/services/...", "connection", false),
			textField("SLACK_CHANNEL", "Channel", "#alerts-backend", "delivery", true),
			textField("SLACK_USERNAME", "Bot name", "SRE Capsule", "delivery", false),
			textField("SLACK_ICON_EMOJI", "Icon emoji", ":rotating_light:", "delivery", false),
			textField("SLACK_COLOR", "Attachment color", "#ff4444", "delivery", false),
			messageField("SLACK_TITLE", "Title", "SRE Alert: {{name}}", false),
			messageField("SLACK_TEXT", "Message", "Status: {{status}}\n\n{{error}}", true),
		}
	case "jira":
		return []PluginField{
			urlField("JIRA_URL", "Jira URL", "https://company.atlassian.net", "connection", false),
			textField("JIRA_EMAIL", "Email", "sre@company.com", "connection", false),
			secretField("JIRA_API_TOKEN", "API token", "connection", false),
			textField("JIRA_ISSUE_TYPE", "Issue type", "Bug", "delivery", false),
			textField("JIRA_PROJECT_KEY", "Project key", "PAY", "delivery", true),
			textField("JIRA_PRIORITY", "Priority", "Highest", "delivery", true),
			textField("JIRA_LABELS", "Labels", "sre,ci", "delivery", true),
			textField("JIRA_ASSIGNEE", "Assignee", "oncall", "delivery", true),
			textField("JIRA_COMPONENTS", "Components", "checkout", "delivery", true),
			messageField("JIRA_SUMMARY", "Summary", "[SRE Capsule] {{name}}", false),
			messageField("JIRA_DESCRIPTION", "Description", "Status: {{status}}\n\n{{error}}\n\n{{console}}", true),
		}
	case "teams":
		return []PluginField{
			urlField("TEAMS_WEBHOOK_URL", "Webhook URL", "https://outlook.office.com/webhook/...", "connection", true),
			textField("TEAMS_THEME_COLOR", "Theme color", "E81123", "delivery", false),
			messageField("TEAMS_TITLE", "Title", "SRE incident: {{name}}", false),
			messageField("TEAMS_SUBTITLE", "Subtitle", "Status: {{status}}", false),
			messageField("TEAMS_TEXT", "Message", "{{error}}", true),
		}
	case "pagerduty":
		return []PluginField{
			secretField("PAGERDUTY_ROUTING_KEY", "Routing key", "connection", true),
			urlField("PAGERDUTY_API_URL", "Events API URL", "https://events.pagerduty.com/v2/enqueue", "connection", false),
			textField("PAGERDUTY_SEVERITY", "Severity", "critical", "delivery", true),
			textField("PAGERDUTY_SOURCE", "Source", "sre-capsule", "delivery", false),
			textField("PAGERDUTY_COMPONENT", "Component", "checkout", "delivery", true),
			textField("PAGERDUTY_GROUP", "Group", "qa", "delivery", true),
			textField("PAGERDUTY_CLASS", "Class", "test", "delivery", false),
			messageField("PAGERDUTY_SUMMARY", "Summary", "[SRE Capsule] {{name}}", false),
			messageField("PAGERDUTY_DETAILS", "Custom details", "{{error}}", true),
		}
	case "opsgenie":
		return []PluginField{
			secretField("OPSGENIE_API_KEY", "API key", "connection", false),
			urlField("OPSGENIE_API_URL", "API URL", "https://api.opsgenie.com", "connection", false),
			textField("OPSGENIE_TEAM", "Team", "team-name", "delivery", true),
			textField("OPSGENIE_PRIORITY", "Priority", "P1", "delivery", true),
			textField("OPSGENIE_TAGS", "Tags", "sre,ci", "delivery", true),
			messageField("OPSGENIE_MESSAGE", "Message", "[SRE Capsule] {{name}}", false),
			messageField("OPSGENIE_DESCRIPTION", "Description", "Status: {{status}}\n\n{{error}}", true),
		}
	case "victorops":
		return []PluginField{
			urlField("VICTOROPS_ROUTING_URL", "Routing URL", "https://alert.victorops.com/integrations/generic/...", "connection", true),
			textField("VICTOROPS_MESSAGE_TYPE", "Message type", "CRITICAL", "delivery", true),
			textField("VICTOROPS_ENTITY", "Entity", "SRE Capsule", "delivery", true),
			textField("VICTOROPS_ENTITY_ID", "Entity ID", "sre-capsule", "delivery", false),
			messageField("VICTOROPS_MESSAGE", "State message", "[SRE Capsule] {{name}}\n{{error}}", true),
		}
	case "datadog":
		return []PluginField{
			secretField("DD_API_KEY", "API key", "connection", false),
			secretField("DD_APP_KEY", "Application key", "connection", false),
			textField("DD_SITE", "Site", "datadoghq.com", "connection", false),
			textField("DATADOG_TAGS", "Tags", "env:ci,service:api", "delivery", true),
			textField("DD_ALERT_TYPE", "Alert type", "error", "delivery", true),
			textField("DD_PRIORITY", "Priority", "normal", "delivery", true),
			textField("DD_SOURCE", "Source type", "sre-capsule", "delivery", false),
			messageField("DD_TITLE", "Title", "SRE Capsule: {{name}}", false),
			messageField("DD_TEXT", "Text", "Status: {{status}}\n\n{{error}}", true),
		}
	case "github":
		return []PluginField{
			secretField("GITHUB_TOKEN", "Token", "connection", false),
			textField("GITHUB_OWNER", "Owner", "org", "delivery", true),
			textField("GITHUB_REPO", "Repository", "repo", "delivery", true),
			textField("GITHUB_WORKFLOW_ID", "Workflow file", "ci.yml", "delivery", true),
			textField("GITHUB_REF", "Git ref", "main", "delivery", true),
			{Key: "GITHUB_NOTE", Label: "Dispatch note", Placeholder: "Failure {{name}} status {{status}}", Group: "message", Hint: templateHint + " Sent only when filled, as the workflow input named note."},
		}
	case "webhook":
		return []PluginField{
			urlField("WEBHOOK_URL", "Webhook URL", "https://...", "connection", true),
			urlField("QA_WEBHOOK_URL", "QA webhook URL", "https://...", "connection", true),
			secretField("WEBHOOK_AUTH_HEADER", "Authorization header", "connection", false),
			textField("WEBHOOK_EVENT", "Event name", "incident.detected", "delivery", true),
			messageField("WEBHOOK_MESSAGE", "Message", "{{name}}\n{{status}}\n{{error}}", true),
		}
	case "testrail":
		return []PluginField{
			urlField("TESTRAIL_URL", "TestRail URL", "https://company.testrail.io", "connection", false),
			textField("TESTRAIL_USER", "User", "sre@company.com", "connection", false),
			secretField("TESTRAIL_API_KEY", "API key", "connection", false),
			textField("TESTRAIL_PROJECT_ID", "Project ID", "1", "delivery", true),
			textField("TESTRAIL_RUN_ID", "Run ID", "12", "delivery", true),
			textField("TESTRAIL_CASE_ID", "Case ID", "34", "delivery", true),
			textField("TESTRAIL_STATUS_ID", "Status ID", "5", "delivery", true),
			messageField("TESTRAIL_COMMENT", "Comment", "{{name}}\n{{error}}", true),
		}
	case "zephyr":
		return []PluginField{
			urlField("ZEPHYR_API_URL", "API URL", "https://api.zephyrscale.smartbear.com/v2", "connection", false),
			secretField("ZEPHYR_API_TOKEN", "API token", "connection", false),
			textField("ZEPHYR_PROJECT_KEY", "Project key", "PAY", "delivery", true),
			textField("ZEPHYR_TEST_CASE_KEY", "Test case key", "PAY-T1", "delivery", true),
			textField("ZEPHYR_STATUS", "Status name", "Fail", "delivery", true),
			textField("ZEPHYR_ENVIRONMENT", "Environment", "CI", "delivery", true),
			messageField("ZEPHYR_COMMENT", "Comment", "{{name}}\n{{error}}", true),
		}
	case "xray":
		return []PluginField{
			textField("XRAY_CLIENT_ID", "Client ID", "", "connection", false),
			secretField("XRAY_CLIENT_SECRET", "Client secret", "connection", false),
			urlField("XRAY_API_URL", "Cloud API URL", "https://xray.cloud.getxray.app", "connection", false),
			textField("XRAY_PROJECT_KEY", "Project key", "PAY", "delivery", true),
			textField("XRAY_TEST_KEY", "Test key", "PAY-1", "delivery", true),
			textField("XRAY_TEST_EXEC", "Test execution key", "", "delivery", true),
			textField("XRAY_STATUS", "Status", "FAILED", "delivery", true),
			messageField("XRAY_SUMMARY", "Execution summary", "[SRE Capsule] {{name}}", false),
			messageField("XRAY_COMMENT", "Comment", "{{error}}", true),
		}
	case "k8s":
		return []PluginField{
			textField("K8S_CONTEXT", "Context", "prod", "connection", false),
			textField("K8S_NAMESPACE", "Namespace", "default", "delivery", true),
			textField("DEPLOYMENT_NAME", "Deployment name", "my-app", "delivery", true),
			textField("K8S_CONTAINER", "Container", "app", "delivery", true),
		}
	default:
		return nil
	}
}
