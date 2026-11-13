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
	text := string(data)
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
	if strings.Count(matrix, "- os:") != 1 || !strings.Contains(matrix, "- os: windows") || !strings.Contains(matrix, "passshare-windows-signing") {
		t.Fatal("candidate must select only the existing Windows signing runner")
	}
	for _, preserved := range []string{"$env:CANDIDATE_REPOSITORY_PRIVATE -ne 'true'", "$env:CANDIDATE_SHA -cne $env:GITHUB_WORKFLOW_SHA", "Verify actual signatures, versions and stage allowlisted files only", "TAURI_SIGNING_PRIVATE_KEY:"} {
		if !strings.Contains(text, preserved) {
			t.Fatalf("required trust/signature boundary missing: %s", preserved)
		}
	}
}
