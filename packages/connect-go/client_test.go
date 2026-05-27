package connect

import "testing"

func TestNormalizeBaseURL(t *testing.T) {
	if got := normalizeBaseURL("https://example.com"); got != "https://example.com/v1" {
		t.Fatalf("expected /v1 suffix, got %s", got)
	}
}
