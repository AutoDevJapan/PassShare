package main

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Called only with evidence produced by the live cryptographic/native verifier.
// This creates a local candidate manifest, never a release or reachable URL.
func verifiedWindowsManifest(src source, a asset, payloadURL, signature string) ([]byte, error) {
	if !versionPattern.MatchString(src.TauriVersion) || a.EmbeddedVersion != src.TauriVersion || a.UpdaterSignature != "verified" || a.OSSignature != "authenticode_trusted_publisher_and_timestamp" || a.Bytes <= 0 || !sha256Pattern.MatchString(a.SHA256) || !sha256Pattern.MatchString(a.ApplicationSHA256) {
		return nil, fail("verified Windows candidate required for update manifest")
	}
	if !strings.HasSuffix(a.Name, "-setup.exe") {
		return nil, fail("manifest requires verified NSIS payload")
	}
	expected := "https://github.com/" + repository + "/releases/download/v" + src.TauriVersion + "/" + url.PathEscape(a.Name)
	if payloadURL != expected {
		return nil, fail("update URL must bind exact repository version and payload")
	}
	if signature == "" || len(signature) > 8192 {
		return nil, fail("verified updater signature content required")
	}
	if _, err := base64.StdEncoding.DecodeString(signature); err != nil {
		return nil, fail("invalid updater signature encoding")
	}
	type platform struct {
		URL       string `json:"url"`
		Signature string `json:"signature"`
	}
	m := struct {
		Version   string              `json:"version"`
		Platforms map[string]platform `json:"platforms"`
	}{src.TauriVersion, map[string]platform{"windows-x86_64-nsis": {payloadURL, signature}}}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, fail("cannot encode update manifest")
	}
	return append(data, '\n'), nil
}
func writeVerifiedWindowsManifest(output string, src source, payloadURL string) error {
	if runtime.GOOS != "windows" {
		return fail("update manifest currently supports Windows NSIS only")
	}
	raw, err := os.ReadFile(filepath.Join(output, "evidence.json"))
	if err != nil {
		return fail("verified candidate evidence missing")
	}
	var e evidence
	if json.Unmarshal(raw, &e) != nil || !e.CandidateVerified || e.Source != src || e.Platform != "windows-amd64" || len(e.Assets) != 1 {
		return fail("verified candidate evidence mismatch")
	}
	a := e.Assets[0]
	checked, err := updaterCheck(filepath.Join(output, a.Name), trustedKey)
	if err != nil || checked.SHA256 != a.SHA256 || checked.Bytes != a.Bytes {
		return fail("staged payload no longer matches verified candidate")
	}
	data, err := verifiedWindowsManifest(src, a, payloadURL, checked.verifiedSignature)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(output, "latest.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fail("cannot create new candidate update manifest")
	}
	n, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil || n != len(data) || closeErr != nil {
		return fail("candidate update manifest write failed")
	}
	return nil
}
