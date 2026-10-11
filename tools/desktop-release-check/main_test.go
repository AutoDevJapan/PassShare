package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"debug/elf"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The caller supplies runner scratch or a safe-delete owned PC directory.
func scratch(t *testing.T) string {
	t.Helper()
	root := os.Getenv("TEST_SCRATCH")
	if root == "" {
		t.Fatal("TEST_SCRATCH must name runner/owned temporary storage")
	}
	dir, err := os.MkdirTemp(root, "release-check-test-")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}
func write(t *testing.T, path string, data []byte) {
	t.Helper()
	if os.MkdirAll(filepath.Dir(path), 0700) != nil || os.WriteFile(path, data, 0600) != nil {
		t.Fatal("fixture write failed")
	}
}
func readFixture(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", path))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestUpdaterActualSignatureAndRejections(t *testing.T) {
	// Existing upstream public verification vector; no keys are generated/loaded.
	key := base64.StdEncoding.EncodeToString(readFixture(t, "minisign.pub"))
	message := readFixture(t, "message.txt")
	signature := readFixture(t, "message.txt.minisig")
	path := filepath.Join(scratch(t), "candidate.AppImage")
	write(t, path, message)
	write(t, path+".sig", []byte(base64.StdEncoding.EncodeToString(signature)))
	a, err := updaterCheck(path, key)
	if err != nil || a.UpdaterSignature != "verified" || a.Bytes != int64(len(message)) || len(a.SHA256) != 64 {
		t.Fatalf("public vector must verify: %v", err)
	}
	if _, err = updaterCheck(path, trustedKey); err == nil {
		t.Fatal("a different public key accepted the vector")
	}
	write(t, path, append(append([]byte{}, message...), 0))
	if _, err = updaterCheck(path, key); err == nil {
		t.Fatal("tampered bytes accepted")
	}
	write(t, path, message)
	write(t, path+".sig", []byte(base64.StdEncoding.EncodeToString(append(signature, 0))))
	if _, err = updaterCheck(path, key); err == nil {
		t.Fatal("tampered signature accepted")
	}
	unsigned := filepath.Join(filepath.Dir(path), "unsigned.AppImage")
	write(t, unsigned, message)
	if _, err = updaterCheck(unsigned, key); err == nil {
		t.Fatal("unsigned updater accepted")
	}
}

func trustedEnv() map[string]string {
	sha := strings.Repeat("a", 40)
	return map[string]string{"GITHUB_SHA": sha, "GITHUB_WORKFLOW_SHA": sha, "GITHUB_REPOSITORY": repository, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main", "CANDIDATE_REPOSITORY_PRIVATE": "true", "GITHUB_WORKFLOW_REF": repository + "/.github/workflows/desktop-signed-candidate.yml@refs/heads/main"}
}
func TestTrustAndInputRejections(t *testing.T) {
	env := trustedEnv()
	sha := env["GITHUB_SHA"]
	get := func(k string) string { return env[k] }
	if err := checkTrust(sha, get); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "CANDIDATE_REPOSITORY_PRIVATE"} {
		t.Run(key, func(t *testing.T) {
			original := env[key]
			env[key] = "untrusted"
			if checkTrust(sha, get) == nil {
				t.Fatal("untrusted run accepted")
			}
			env[key] = original
		})
	}
	for _, input := range []string{"", sha + ";echo secret", strings.Repeat("b", 40), "refs/pull/1/head"} {
		if checkTrust(input, get) == nil {
			t.Fatal("invalid source input accepted")
		}
	}
}

func TestSourceVersionKeyAndSHA(t *testing.T) {
	root := scratch(t)
	write(t, filepath.Join(root, "apps/desktop/package.json"), []byte(`{"version":"0.1.0"}`))
	config, _ := json.Marshal(map[string]any{"version": "0.1.0", "plugins": map[string]any{"updater": map[string]any{"pubkey": trustedKey}}})
	cfg := filepath.Join(root, "apps/desktop/src-tauri/tauri.conf.json")
	write(t, cfg, config)
	write(t, filepath.Join(root, "Cargo.toml"), []byte("[workspace.package]\nversion = \"0.1.0\"\n"))
	for _, args := range [][]string{{"init", "--quiet"}, {"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "public metadata fixture"}} {
		if _, err := command(root, nil, "git", args...); err != nil {
			t.Fatal(err)
		}
	}
	head, err := command(root, nil, "git", "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	sha := strings.TrimSpace(string(head))
	if s, err := inspectSource(root, sha); err != nil || s.TauriVersion != "0.1.0" {
		t.Fatalf("clean source must pass: %v", err)
	}
	if _, err = inspectSource(root, strings.Repeat("b", 40)); err == nil {
		t.Fatal("wrong checkout SHA accepted")
	}
	for _, versions := range [][3]string{{"1.1.0", "0.1.0", "0.1.0"}, {"0.1.0", "0.1.1", "0.1.0"}, {"0.1.0", "0.1.0", "1.1.0"}, {"0.1.0;echo", "0.1.0;echo", "0.1.0;echo"}} {
		if checkVersions(versions[0], versions[1], versions[2]) == nil {
			t.Fatal("wrong version accepted")
		}
	}
	write(t, cfg, []byte(`{"version":"0.1.0","plugins":{"updater":{"pubkey":"wrong"}}}`))
	if _, err = command(root, nil, "git", "add", "."); err != nil {
		t.Fatal(err)
	}
	if _, err = command(root, nil, "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "wrong public key"); err != nil {
		t.Fatal(err)
	}
	head, err = command(root, nil, "git", "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = inspectSource(root, strings.TrimSpace(string(head))); err == nil {
		t.Fatal("candidate-supplied wrong public key accepted")
	}
}

func TestUnsignedWindowsAuthenticodeRejected(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("actual Authenticode check only on Windows")
	}
	t.Setenv("WINDOWS_CERT_THUMBPRINT", strings.Repeat("A", 40))
	t.Setenv("WINDOWS_PUBLISHER_SUBJECT", "CN=Public Test Identity")
	t.Setenv("WINDOWS_TIMESTAMP_URL", "https://timestamp.example.invalid")
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	observed, err := command("", []string{"CHECK_ASSET=" + path}, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; (Get-AuthenticodeSignature -LiteralPath $env:CHECK_ASSET).Status.ToString()`)
	if err != nil || strings.TrimSpace(string(observed)) != "NotSigned" {
		t.Fatalf("actual Windows unsigned fixture observation failed: status=%q error=%v", string(observed), err)
	}
	if windowsVerify(path, "0.1.0") == nil {
		t.Fatal("unsigned Go test binary accepted as signed candidate")
	}
}

func TestArchiveCannotEscapeOrUseLinks(t *testing.T) {
	root := scratch(t)
	archive := filepath.Join(root, "valid.tar.gz")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	g := gzip.NewWriter(f)
	w := tar.NewWriter(g)
	data := []byte("public archive fixture")
	if w.WriteHeader(&tar.Header{Name: "PassShare.app/Contents/Info.plist", Mode: 0600, Size: int64(len(data))}) != nil {
		t.Fatal("valid fixture header failed")
	}
	if _, err = w.Write(data); err != nil {
		t.Fatal(err)
	}
	if w.Close() != nil || g.Close() != nil || f.Close() != nil {
		t.Fatal("valid archive fixture failed")
	}
	extraction := filepath.Join(root, "extracted")
	if os.Mkdir(extraction, 0700) != nil {
		t.Fatal("valid fixture mkdir failed")
	}
	app, err := extractApp(archive, extraction)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filepath.Join(app, "Contents/Info.plist"))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("valid app archive was not extracted")
	}
	for _, header := range []*tar.Header{{Name: "../escape", Mode: 0600}, {Name: "PassShare.app/link", Typeflag: tar.TypeSymlink, Linkname: "../../escape", Mode: 0777}, {Name: "PassShare.app/link", Typeflag: tar.TypeLink, Linkname: "../escape", Mode: 0600}} {
		t.Run(header.Name+string(header.Typeflag), func(t *testing.T) {
			root := scratch(t)
			path := filepath.Join(root, "candidate.tar.gz")
			f, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			g := gzip.NewWriter(f)
			w := tar.NewWriter(g)
			if w.WriteHeader(header) != nil || w.Close() != nil || g.Close() != nil || f.Close() != nil {
				t.Fatal("archive fixture failed")
			}
			extraction := filepath.Join(root, "extracted")
			if os.Mkdir(extraction, 0700) != nil {
				t.Fatal("fixture mkdir failed")
			}
			if _, err = extractApp(path, extraction); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

func TestSecretEnvironmentMinimized(t *testing.T) {
	for _, k := range []string{"TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "APPLE_PASSWORD", "APPLE_CERTIFICATE", "UNRELATED_API_KEY", "GITHUB_TOKEN"} {
		t.Setenv(k, "DO_NOT_LOG_TEST_SENTINEL")
	}
	for _, entry := range cleanEnv(false) {
		if strings.Contains(entry, "DO_NOT_LOG_TEST_SENTINEL") {
			t.Fatal("non-signing process received secret environment")
		}
	}
	for _, entry := range cleanEnv(true) {
		if strings.Contains(entry, "DO_NOT_LOG_TEST_SENTINEL") && !strings.HasPrefix(entry, "TAURI_SIGNING_PRIVATE_KEY=") && !strings.HasPrefix(entry, "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=") {
			t.Fatal("signing process received unrelated credentials")
		}
	}
}

func TestLinuxCompiledPayloadRejectsCodeTampering(t *testing.T) {
	path := os.Getenv("ELF_TEST_BINARY")
	if runtime.GOOS == "linux" {
		path, _ = os.Executable()
	}
	if path == "" {
		t.Skip("Linux ELF fixture supplied by caller or Linux test executable")
	}
	f, err := elf.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	section := f.Section(".text")
	if section == nil || section.Size == 0 {
		t.Fatal("ELF code fixture missing")
	}
	offset := section.Offset
	_ = f.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(scratch(t), "payload.elf")
	write(t, copyPath, data)
	if !sameELFPayload(path, copyPath) {
		t.Fatal("actual ELF code/data fixture mismatch")
	}
	data[offset] ^= 1
	write(t, copyPath, data)
	if sameELFPayload(path, copyPath) {
		t.Fatal("tampered ELF executable code accepted")
	}
}

func TestChildOutputCaptureIsBounded(t *testing.T) {
	var b boundedBuffer
	// io.Copy must not bypass Write through a promoted Buffer.ReadFrom method.
	if n, err := io.Copy(&b, io.LimitReader(bytes.NewReader(make([]byte, 2*1024*1024)), 2*1024*1024)); err != nil || n != 2*1024*1024 || b.buffer.Len() != 1024*1024 {
		t.Fatal("child output capture was not bounded")
	}
}
