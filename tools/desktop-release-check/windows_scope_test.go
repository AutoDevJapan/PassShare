package main

import (
	"os"
	"strings"
	"testing"
)

// Keep the manual candidate's platform prerequisites aligned with Windows-first
// acceptance without relaxing its independent private-main or signature gates.
func TestCandidateWindowsOnlyPrerequisites(t *testing.T) {
	data, err := os.ReadFile("../../.github/workflows/desktop-signed-candidate.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	start := strings.Index(text, "      - name: Require ")
	if start < 0 {
		t.Fatal("candidate readiness gate missing")
	}
	end := strings.Index(text[start:], "\n  signed:")
	if end < 0 {
		t.Fatal("candidate readiness gate missing")
	}
	readiness := text[start : start+end]
	if strings.Contains(readiness, "MACOS_READY") || strings.Contains(readiness, "LINUX_READY") {
		t.Fatal("Windows candidate depends on deferred platform readiness")
	}
	if !strings.Contains(readiness, "$env:WINDOWS_READY -ne 'true'") {
		t.Fatal("Windows readiness must remain fail closed")
	}
	matrixStart := strings.Index(text, "      matrix:")
	if matrixStart < 0 {
		t.Fatal("candidate matrix missing")
	}
	matrixEnd := strings.Index(text[matrixStart:], "\n    runs-on:")
	if matrixEnd < 0 {
		t.Fatal("candidate matrix missing")
	}
	matrix := text[matrixStart : matrixStart+matrixEnd]
	if strings.TrimSpace(matrix) != "matrix:\n        include:\n          - os: windows\n            runner: [self-hosted, Windows, X64, passshare-windows-signing]" {
		t.Fatal("candidate must select only the existing Windows signing runner")
	}
	if strings.Contains(text, "MACOS_READY") || strings.Contains(text, "LINUX_READY") || strings.Contains(text, "DESKTOP_MACOS_SIGNING_READY") || strings.Contains(text, "DESKTOP_LINUX_SIGNING_READY") {
		t.Fatal("deferred readiness dependency anywhere in workflow")
	}
	if !strings.Contains(text, "  signed:\n    needs: gate\n") {
		t.Fatal("signed candidate must depend on trust gate")
	}
	for _, preserved := range []string{"$env:CANDIDATE_REPOSITORY_PRIVATE -ne 'true'", "$env:CANDIDATE_SHA -cne $env:GITHUB_WORKFLOW_SHA", "Verify actual signatures, versions and stage allowlisted files only", "TAURI_SIGNING_PRIVATE_KEY:"} {
		if !strings.Contains(text, preserved) {
			t.Fatalf("required trust/signature boundary missing: %s", preserved)
		}
	}
}
