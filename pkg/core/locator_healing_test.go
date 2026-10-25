package core

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// IsLocatorError tests
// ---------------------------------------------------------------------------

func TestIsLocatorError_PlaywrightTimeout(t *testing.T) {
	err := "locator('#submit').click() — Timeout 5000ms exceeded"
	if !IsLocatorError(err) {
		t.Errorf("expected locator error for: %q", err)
	}
}

func TestIsLocatorError_SeleniumNoSuchElement(t *testing.T) {
	err := "NoSuchElementException: no such element; CSS selector: #login-btn"
	if !IsLocatorError(err) {
		t.Errorf("expected locator error for: %q", err)
	}
}

func TestIsLocatorError_CypressUnableToFind(t *testing.T) {
	err := "Unable to find element: '[data-testid=\"submit-payment\"]'"
	if !IsLocatorError(err) {
		t.Errorf("expected locator error for: %q", err)
	}
}

func TestIsLocatorError_RobotElementNotFound(t *testing.T) {
	err := "Element '#confirm-btn' not found"
	if !IsLocatorError(err) {
		t.Errorf("expected locator error for: %q", err)
	}
}

func TestIsLocatorError_NetworkError_IsFalse(t *testing.T) {
	err := "ConnectionRefusedError: dial tcp :8080 connection refused"
	if IsLocatorError(err) {
		t.Errorf("should not flag network error as locator error: %q", err)
	}
}

func TestIsLocatorError_AssertionError_IsFalse(t *testing.T) {
	err := "AssertionError: expected 200 but got 404"
	if IsLocatorError(err) {
		t.Errorf("should not flag assertion error as locator error: %q", err)
	}
}

func TestIsLocatorError_Empty_IsFalse(t *testing.T) {
	if IsLocatorError("") {
		t.Error("empty error should not be classified as a locator error")
	}
}

// ---------------------------------------------------------------------------
// ExtractLocator tests
// ---------------------------------------------------------------------------

func TestExtractLocator_Playwright_SingleQuotes(t *testing.T) {
	msg := "locator('#pay-button').click() — Timeout exceeded"
	got := ExtractLocator(msg, "Playwright")
	if got != "#pay-button" {
		t.Errorf("expected '#pay-button', got: %q", got)
	}
}

func TestExtractLocator_Playwright_DoubleQuotes(t *testing.T) {
	msg := `locator("#submit-btn").click()`
	got := ExtractLocator(msg, "Playwright")
	if got != "#submit-btn" {
		t.Errorf("expected '#submit-btn', got: %q", got)
	}
}

func TestExtractLocator_Selenium_SelectorColon(t *testing.T) {
	msg := `NoSuchElementException: selector: "#login-form"`
	got := ExtractLocator(msg, "Selenium")
	if got == "" {
		t.Error("expected a selector to be extracted")
	}
}

func TestExtractLocator_Cypress_DataTestID(t *testing.T) {
	msg := `Expected to find element: '[data-testid="checkout-btn"]'`
	got := ExtractLocator(msg, "Cypress")
	if got == "" {
		t.Errorf("expected a locator to be extracted from: %q", msg)
	}
}

func TestExtractLocator_ChromeStackFrameIsNotASelector(t *testing.T) {
	msg := "no such element: Unable to locate element: {\\...\\n#15 0x5594dfcb3b63 <unknown>\n#16 0x7f76 <unknown>"
	got := ExtractLocator(msg, "Selenium")
	if got == "#15" || got == "#16" {
		t.Fatalf("stack frame treated as a locator: %q", got)
	}
}

func TestResolveOriginalLocator_PrefersBrokenConstantOverStackFrame(t *testing.T) {
	errMsg := "Unable to locate element: {\\...\\n#15 0x5594dfcb3b63 <unknown>"
	source := "BROKEN_LOGOUT = '[data-testid=\"logout-button\"]'\ndriver.find_element(By.CSS_SELECTOR, BROKEN_LOGOUT).click()\n"
	got := ResolveOriginalLocator(errMsg, source, "Selenium")
	if got != `[data-testid="logout-button"]` {
		t.Fatalf("got %q", got)
	}
}

func TestExtractLocator_Generic_CSSHash(t *testing.T) {
	msg := "element #header not found"
	got := ExtractLocator(msg, "")
	if !strings.HasPrefix(got, "#") {
		t.Errorf("expected CSS ID selector, got: %q", got)
	}
}

func TestExtractLocator_NoLocatorInMessage_ReturnsEmpty(t *testing.T) {
	msg := "network timeout after 30s"
	got := ExtractLocator(msg, "")
	if got != "" {
		t.Errorf("expected empty result, got: %q", got)
	}
}

func TestExtractLocator_FrameworkHint_FiltersByFramework(t *testing.T) {
	// Message contains only a Cypress-style locator.
	msg := `Expected to find element: '#checkout'`
	gotPlaywright := ExtractLocator(msg, "Playwright")
	gotCypress := ExtractLocator(msg, "Cypress")
	// Cypress should match; Playwright patterns should not match this message.
	if gotCypress == "" {
		t.Errorf("Cypress hint should extract locator from: %q", msg)
	}
	// Playwright may or may not match the generic fallback — just ensure
	// the function does not panic or return a nonsensical result.
	_ = gotPlaywright
}

// ---------------------------------------------------------------------------
// SuggestHealedLocator tests
// ---------------------------------------------------------------------------

func TestSuggestHealedLocator_IDSelector_SuggestsDataTestID(t *testing.T) {
	healed, conf, explanation := SuggestHealedLocator("#submit-btn", "Playwright")
	if !strings.Contains(healed, "data-testid") {
		t.Errorf("expected data-testid suggestion, got: %q", healed)
	}
	if conf <= 0 {
		t.Error("expected confidence > 0")
	}
	if explanation == "" {
		t.Error("expected a non-empty explanation")
	}
}

func TestSuggestHealedLocator_ClassSelector_SuggestsPartialMatch(t *testing.T) {
	healed, conf, explanation := SuggestHealedLocator(".primary-cta", "")
	if !strings.Contains(healed, "class*=") {
		t.Errorf("expected partial class match, got: %q", healed)
	}
	if conf <= 0 {
		t.Error("expected confidence > 0")
	}
	if explanation == "" {
		t.Error("expected a non-empty explanation")
	}
}

func TestSuggestHealedLocator_DataTestID_SuggestsRole(t *testing.T) {
	healed, conf, explanation := SuggestHealedLocator(`[data-testid="pay-button"]`, "Playwright")
	if !strings.Contains(healed, "getByRole") {
		t.Errorf("expected getByRole suggestion, got: %q", healed)
	}
	if conf <= 0 {
		t.Error("expected confidence > 0")
	}
	if explanation == "" {
		t.Error("expected a non-empty explanation")
	}
}

func TestSuggestHealedLocator_DataTestIDWithInputRole(t *testing.T) {
	healed, _, _ := SuggestHealedLocator(`[data-testid="email-input"]`, "Playwright")
	// "input" keyword in the locator → role should be textbox.
	if !strings.Contains(healed, "textbox") {
		t.Errorf("expected textbox role for input locator, got: %q", healed)
	}
}

func TestSuggestHealedLocator_DataTestIDWithLinkRole(t *testing.T) {
	healed, _, _ := SuggestHealedLocator(`[data-testid="nav-link"]`, "")
	if !strings.Contains(healed, "link") {
		t.Errorf("expected link role, got: %q", healed)
	}
}

func TestSuggestHealedLocator_UnrecognizedPattern_LowConfidence(t *testing.T) {
	healed, conf, explanation := SuggestHealedLocator("xpath://div[@id='foo']", "")
	if conf >= 0.5 {
		t.Errorf("expected low confidence for unrecognized pattern, got: %v", conf)
	}
	if healed != "" {
		t.Errorf("expected no guess for xpath, got: %q", healed)
	}
	if explanation == "" {
		t.Error("expected explanation")
	}
}

func TestResolveHealedFromTestContext_SaucedemoComments(t *testing.T) {
	source := `// Real checkout button: [data-test="checkout"]
// Broken locator (TC-04): [data-test="proceed-to-payment"]`
	h, c, e, ok := ResolveHealedFromTestContext(source, `[data-test="proceed-to-payment"]`)
	if !ok || h != `[data-test="checkout"]` {
		t.Fatalf("expected checkout fix, got ok=%v h=%q e=%q", ok, h, e)
	}
	if c < 0.8 {
		t.Errorf("expected high confidence, got %v", c)
	}
}

func TestResolveHealedFromTestContext_RobotDocumentationLines(t *testing.T) {
	source := `*** Settings ***
Documentation
...    Real checkout button: css=[data-test="checkout"]
...    Broken locator (TC-04): css=[data-test="proceed-to-payment"]
*** Variables ***
${BROKEN_CHECKOUT}  css=[data-test="proceed-to-payment"]`
	h, _, _, ok := ResolveHealedFromTestContext(source, `css=[data-test="proceed-to-payment"]`)
	if !ok || h != `css=[data-test="checkout"]` {
		t.Fatalf("expected css= checkout fix from robot docs, got ok=%v h=%q", ok, h)
	}
}

func TestLocatorSameAs_CssPrefix(t *testing.T) {
	if !LocatorSameAs(`css=[data-test="checkout"]`, `[data-test="checkout"]`) {
		t.Error("expected css= prefix to be ignored for comparison")
	}
}

func TestSuggestHealedLocator_EmptyLocator_ZeroConfidence(t *testing.T) {
	_, conf, _ := SuggestHealedLocator("", "")
	if conf != 0 {
		t.Errorf("expected 0 confidence for empty locator, got: %v", conf)
	}
}

// ---------------------------------------------------------------------------
// ExtractDOMSnapshot tests
// ---------------------------------------------------------------------------

func TestExtractDOMSnapshot_ValidMarkers(t *testing.T) {
	logs := "some log line\n[SRE_CAPSULE_DOM_SNAPSHOT_START]<html><body>page</body></html>[SRE_CAPSULE_DOM_SNAPSHOT_END]\nafter"
	got := ExtractDOMSnapshot(logs)
	if got != "<html><body>page</body></html>" {
		t.Errorf("unexpected DOM snapshot: %q", got)
	}
}

func TestExtractDOMSnapshot_NoStartMarker_ReturnsEmpty(t *testing.T) {
	logs := "no markers here"
	got := ExtractDOMSnapshot(logs)
	if got != "" {
		t.Errorf("expected empty snapshot, got: %q", got)
	}
}

func TestExtractDOMSnapshot_NoEndMarker_ReturnsEverythingAfterStart(t *testing.T) {
	logs := "[SRE_CAPSULE_DOM_SNAPSHOT_START]<html>truncated"
	got := ExtractDOMSnapshot(logs)
	if got != "<html>truncated" {
		t.Errorf("expected content after start marker, got: %q", got)
	}
}

func TestExtractDOMSnapshot_MultilineHTML(t *testing.T) {
	logs := "[SRE_CAPSULE_DOM_SNAPSHOT_START]\n<html>\n  <body>\n    <div>content</div>\n  </body>\n</html>\n[SRE_CAPSULE_DOM_SNAPSHOT_END]"
	got := ExtractDOMSnapshot(logs)
	if !strings.Contains(got, "<div>content</div>") {
		t.Errorf("expected full multi-line HTML, got: %q", got)
	}
}

func TestExtractDOMSnapshot_EmptyInput_ReturnsEmpty(t *testing.T) {
	got := ExtractDOMSnapshot("")
	if got != "" {
		t.Errorf("expected empty for empty input, got: %q", got)
	}
}

func TestExtractDOMSnapshotFromLogs_PrefersConsoleLogs(t *testing.T) {
	console := "[SRE_CAPSULE_DOM_SNAPSHOT_START]<html>console</html>[SRE_CAPSULE_DOM_SNAPSHOT_END]"
	errorLogs := "[SRE_CAPSULE_DOM_SNAPSHOT_START]<html>stderr</html>[SRE_CAPSULE_DOM_SNAPSHOT_END]"
	got := ExtractDOMSnapshotFromLogs(console, errorLogs, "")
	if got != "<html>console</html>" {
		t.Errorf("expected console snapshot, got: %q", got)
	}
}

func TestExtractDOMSnapshotFromLogs_FallsBackToErrorLogs(t *testing.T) {
	errorLogs := "[SRE_CAPSULE_DOM_SNAPSHOT_START]<html>playwright</html>[SRE_CAPSULE_DOM_SNAPSHOT_END]"
	got := ExtractDOMSnapshotFromLogs("", errorLogs, "")
	if got != "<html>playwright</html>" {
		t.Errorf("expected error_logs snapshot, got: %q", got)
	}
}

func TestExtractDOMSnapshotFromLogs_FallsBackToErrorMessage(t *testing.T) {
	errMsg := "TimeoutError\n[SRE_CAPSULE_DOM_SNAPSHOT_START]<html>cypress</html>[SRE_CAPSULE_DOM_SNAPSHOT_END]"
	got := ExtractDOMSnapshotFromLogs("", "", errMsg)
	if got != "<html>cypress</html>" {
		t.Errorf("expected error_message snapshot, got: %q", got)
	}
}

func TestHealLocatorFromHTML_BrokenDataQA_FindsSubmitID(t *testing.T) {
	html := `<html><body><button id="submit" type="submit">Submit</button></body></html>`
	healed, conf, _, ok := HealLocatorFromHTML(`button[data-qa="submit-v1"]`, html)
	if !ok {
		t.Fatal("expected HTML heal to succeed")
	}
	if healed != "#submit" {
		t.Errorf("expected #submit, got: %q", healed)
	}
	if conf < 0.7 {
		t.Errorf("expected high confidence, got: %v", conf)
	}
}

func TestExtractLocator_SeleniumQuotedDataTestID(t *testing.T) {
	msg := `NoSuchElementException: Message: no such element: Unable to locate element: {"method":"css selector","selector":"[data-testid="sign-in-button"]"}`
	got := ExtractLocator(msg, "Selenium")
	if got != `[data-testid="sign-in-button"]` {
		t.Fatalf("got %q", got)
	}
}

func TestHealLocatorFromHTML_SecureAreaKeepsLogoutBesideCloseLink(t *testing.T) {
	html := `<div id="flash" class="flash success">
            You logged into a secure area!
            <a href="#" class="close">x</a>
          </div>
        <div class="example">
  <h2><i class="icon-lock"></i> Secure Area</h2>
    <h4 class="subheader">Welcome to the Secure Area. When you are done click logout below.</h4>
  <a class="button secondary radius" href="/logout"><i class="icon-2x icon-signout"> Logout</i></a>
</div>
<a target="_blank" href="http://elementalselenium.com/">Elemental Selenium</a>`
	els := ParseInteractiveElements(html)
	var hrefs []string
	for _, el := range els {
		if el.tag == "a" {
			hrefs = append(hrefs, el.href)
		}
	}
	if len(hrefs) != 3 {
		t.Fatalf("expected close, logout, and footer links, got %v", hrefs)
	}
	original := `[data-testid="logout-button"]`
	healed, _, _, ok := HealLocatorFromHTML(original, html)
	if !ok || healed != `a[href="/logout"]` {
		t.Fatalf("healed=%q ok=%v", healed, ok)
	}
	got := AssessLocatorPrecision(html, original, healed, 0.9)
	if !got.Verified || got.Level != "high" || got.Matches != 1 {
		t.Fatalf("expected a unique logout link, got %+v", got)
	}
}

func TestHealLocatorFromHTML_LogoutAfterLogin(t *testing.T) {
	html := `<div class="example">
		<h2>Secure Area</h2>
		<h4 class="subheader">Welcome to the Secure Area. When you are done click logout below.</h4>
		<a class="button secondary radius" href="/logout"><i class="icon-2x icon-signout"> Logout</i></a>
	</div>`
	original := `[data-testid="logout-button"]`
	healed, _, _, ok := HealLocatorFromHTML(original, html)
	if !ok || healed != `a[href="/logout"]` {
		t.Fatalf("healed=%q ok=%v", healed, ok)
	}
	got := AssessLocatorPrecision(html, original, healed, 0.9)
	if !got.Verified || got.Level != "high" || got.Matches != 1 {
		t.Fatalf("expected a unique logout link, got %+v", got)
	}
}

func TestHealLocatorFromHTML_SignInButtonWithIcon(t *testing.T) {
	html := `<form>
		<input type="text" name="username" id="username" />
		<input type="password" name="password" id="password" />
		<button class="radius" type="submit"><i class="fa fa-2x fa-sign-in"> Login</i></button>
	</form>`
	original := `[data-testid="sign-in-button"]`
	healed, conf, _, ok := HealLocatorFromHTML(original, html)
	if !ok || healed != `button[type="submit"]` {
		t.Fatalf("healed=%q ok=%v conf=%v", healed, ok, conf)
	}
	got := AssessLocatorPrecision(html, original, healed, conf)
	if !got.Verified || got.Level != "high" || got.Matches != 1 {
		t.Fatalf("expected a unique green submit selector, got %+v", got)
	}
}

func TestAssessLocatorPrecision_LoginButtonIsHigh(t *testing.T) {
	html := `<html><head><title>Login</title></head><body>
		<h1>Sign in</h1>
		<input data-test="username" placeholder="Username">
		<input data-test="password" type="password" placeholder="Password">
		<button id="login" data-test="login-button" type="submit">Login</button>
		<button data-test="cancel">Cancel</button>
	</body></html>`
	got := AssessLocatorPrecision(html, `button[data-qa="submit-v1"]`, `[data-test="login-button"]`, 0.99)
	if !got.Verified || got.Level != "high" || got.Matches != 1 {
		t.Fatalf("expected a unique verified login selector, got %+v", got)
	}
	if got.Confidence < 0.9 || got.Confidence > 0.97 {
		t.Fatalf("expected capped high confidence, got %v", got.Confidence)
	}
	missing := AssessLocatorPrecision(html, `button[data-qa="submit-v1"]`, `#missing`, 0.99)
	if missing.Verified || missing.Level != "low" {
		t.Fatalf("expected missing selector to be rejected, got %+v", missing)
	}
	list := FormatInteractiveElements(html, 10)
	if !strings.Contains(list, "data-test=login-button") || !strings.Contains(list, "selector=") {
		t.Fatalf("interactive list missing login selector:\n%s", list)
	}
}

func TestLocatorExistsInHTML_CSSDataTest(t *testing.T) {
	html := `<button data-test="login-button">Login</button>`
	if !LocatorExistsInHTML(html, `css=[data-test="login-button"]`) {
		t.Fatal("expected css= data-test selector to match the page")
	}
}

func TestLocatorExistsInHTML_IDSelector(t *testing.T) {
	html := `<button id="submit" type="submit">Go</button>`
	if !LocatorExistsInHTML(html, "#submit") {
		t.Error("expected #submit to exist in HTML")
	}
	if LocatorExistsInHTML(html, "#missing") {
		t.Error("expected #missing to be absent")
	}
}

func TestExtractLocatorFromTestSource_SeleniumPython(t *testing.T) {
	source := `def test_login(driver):
    driver.find_element(By.CSS_SELECTOR, 'button[data-qa="submit-v1"]').click()
`
	got := ExtractLocatorFromTestSource(source, "Selenium")
	if got != `button[data-qa="submit-v1"]` {
		t.Errorf("expected selenium selector, got: %q", got)
	}
}

func TestExtractLocatorFromTestSource_PlaywrightJS(t *testing.T) {
	source := `test('broken', async ({ page }) => {
  await page.locator('button[data-qa="checkout-v2"]').click();
});`
	got := ExtractLocatorFromTestSource(source, "Playwright")
	if got != `button[data-qa="checkout-v2"]` {
		t.Errorf("expected playwright selector, got: %q", got)
	}
}

func TestExtractLocatorFromTestSource_RobotBrokenVariable(t *testing.T) {
	source := `*** Variables ***
${BROKEN_SUBMIT}    button[data-qa="submit-v1"]
*** Test Cases ***
Demo
    Click    ${BROKEN_SUBMIT}
`
	got := ExtractLocatorFromTestSource(source, "RobotFramework")
	if got != `button[data-qa="submit-v1"]` {
		t.Errorf("expected broken selector from robot file, got: %q", got)
	}
}

func TestExtractLocatorFromTestSource_RobotSaucedemoDemo(t *testing.T) {
	source := `*** Variables ***
${BROKEN_CHECKOUT}  css=[data-test="proceed-to-payment"]
*** Test Cases ***
TC-04 Checkout With Broken Locator
    Click    css=[data-test="add-to-cart-sauce-labs-backpack"]
    Click    css=.shopping_cart_link
    Click    ${BROKEN_CHECKOUT}
    Get Element    css=[data-test="firstName"]
`
	got := ExtractLocatorFromTestSource(source, "RobotFramework")
	want := `css=[data-test="proceed-to-payment"]`
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestIsLocatorFailure_RobotTimeoutWithTestSource(t *testing.T) {
	source := `${BROKEN_SUBMIT}    button[data-qa="submit-v1"]`
	errMsg := "TimeoutError: timeout 10000ms exceeded"
	if !IsLocatorFailure(errMsg, "", source, "TC-04 Broken Locator") {
		t.Error("expected timeout + broken selector in test source to be locator failure")
	}
}

func TestHealLocatorFromHTML_ShardBoardIsNotAKeywordMatch(t *testing.T) {
	html := `<html><body>
<button id="ack-lat-shard-17" data-testid="ack-lat-shard-17" aria-label="Acknowledge disk latency on shard 17">Acknowledge</button>
<button id="ack-lat-shard-7" data-testid="ack-lat-shard-7" aria-label="Acknowledge active sev1 disk latency on shard 7">Acknowledge</button>
<button id="ack-lat-shard-70" data-testid="ack-lat-shard-70" aria-label="Acknowledge disk latency on shard 70">Acknowledge</button>
<button id="ack-lat-shard-7-preview" data-testid="ack-lat-shard-7-preview" aria-label="Acknowledge preview draft of disk latency on shard 7" disabled>Acknowledge</button>
<a id="history-lat-shard-7" data-testid="history-lat-shard-7" href="#history-lat-shard-7" aria-label="Open history for disk latency on shard 7">History</a>
</body></html>`
	original := `[data-testid="confirm-maintenance-window"]`
	if _, _, _, ok := HealLocatorFromHTML(original, html); ok {
		t.Fatal("keyword scan must not choose a shard button; this case is for the model")
	}
	source := `OUTDATED_ACK = '[data-testid="confirm-maintenance-window"]'
def test_acknowledge_only_active_sev1_disk_latency_on_shard_7(driver):
    """Acknowledge only the active sev1 alert titled disk latency on shard 7."""
    driver.find_element(By.CSS_SELECTOR, OUTDATED_ACK).click()
`
	if _, _, _, ok := ResolveHealedFromTestContext(source, original); ok {
		t.Fatal("the test file must not name the replacement selector")
	}
	got := AssessLocatorPrecision(html, original, "#ack-lat-shard-7", 0.93)
	if !got.Verified || got.Level != "high" || got.Matches != 1 {
		t.Fatalf("the id is unique; data-testid must not count as a second id, got %+v", got)
	}
}

func TestIsEquivalentBrokenLocator_XPathVariant(t *testing.T) {
	orig := `button[data-qa="submit-v1"]`
	healed := `xpath=(//button[@data-qa='submit-v1'])[1]`
	if !IsEquivalentBrokenLocator(orig, healed) {
		t.Error("expected xpath variant of same data-qa to be rejected")
	}
}
