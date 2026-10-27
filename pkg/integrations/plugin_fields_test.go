package integrations

import (
	"strings"
	"testing"
)

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
		if f.Key == "SMTP_PASS" || f.Key == "SMTP_BODY" || f.Key == "SMTP_SUBJECT" {
			t.Fatal("smtp password and message stay off the gateway routing form")
		}
	}
	got := alertText(map[string]string{"SMTP_SUBJECT": "Fail {{name}}"}, "SMTP_SUBJECT", "fallback", IncidentContext{Name: "checkout"})
	if got != "Fail checkout" {
		t.Fatalf("template: %q", got)
	}
	doc := brandedMailHTML("Incident: checkout\nStatus: Critical")
	if !strings.Contains(doc, "Incident: checkout") || !strings.Contains(doc, "SRE CAPSULE") || strings.Contains(doc, "<script>") {
		t.Fatalf("plain mail frame: %s", doc)
	}
	sized := brandedMailHTML(`<span style="font-size:18px;color:#ef4444">big</span>`)
	if !strings.Contains(sized, "font-size:18px") || !strings.Contains(sized, "color:#ef4444") {
		t.Fatalf("sized mail: %s", sized)
	}
	if strings.Contains(brandedMailHTML(`<span style="font-size:99px">no</span>`), "99px") {
		t.Fatal("rejected font size was kept")
	}
	unsafe := brandedMailHTML(`<b onclick="alert(1)">ok</b><script>alert(1)</script>`)
	if strings.Contains(unsafe, "<script>") || strings.Contains(unsafe, "onclick") || !strings.Contains(unsafe, "<b>ok</b>") {
		t.Fatalf("html mail frame: %s", unsafe)
	}
	if alertText(map[string]string{}, "SMTP_SUBJECT", "fallback", IncidentContext{}) != "fallback" {
		t.Fatal("empty template must keep the default text")
	}
	routed := routingForAction(ProjectRouting{Values: map[string]string{"SMTP_TO": "gateway@example.com"}}, WorkflowNode{
		Config: map[string]string{"SMTP_TO": "", "SMTP_SUBJECT": "Robot {{name}}"},
	})
	if routed.Values["SMTP_TO"] != "gateway@example.com" || routed.Values["SMTP_SUBJECT"] != "Robot {{name}}" {
		t.Fatalf("node config: %#v", routed.Values)
	}
}
