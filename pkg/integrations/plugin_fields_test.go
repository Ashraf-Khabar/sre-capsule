package integrations

import "testing"

func TestConfigFieldsDifferByPlugin(t *testing.T) {
	smtp := ConfigFieldsForIntegration("smtp")
	slack := ConfigFieldsForIntegration("slack")
	github := ConfigFieldsForIntegration("github")
	if len(smtp) == 0 || smtp[0].Key == slack[0].Key || smtp[0].Key == github[0].Key {
		t.Fatal("smtp, slack, and github forms must not share the same first field")
	}
	var sawBody bool
	for _, f := range smtp {
		if f.Key == "SMTP_BODY" && f.InputType == "textarea" && f.Group == "message" {
			sawBody = true
		}
	}
	if !sawBody {
		t.Fatal("smtp form must include a message body")
	}
	for _, f := range RoutingFieldsForIntegration("smtp") {
		if f.Key == "SMTP_PASS" {
			t.Fatal("smtp password must stay on the plugin, not the gateway")
		}
	}
	got := alertText(map[string]string{"SMTP_SUBJECT": "Fail {{name}}"}, "SMTP_SUBJECT", "fallback", IncidentContext{Name: "checkout"})
	if got != "Fail checkout" {
		t.Fatalf("template: %q", got)
	}
	if alertText(map[string]string{}, "SMTP_SUBJECT", "fallback", IncidentContext{}) != "fallback" {
		t.Fatal("empty template must keep the default text")
	}
}
