// desktop-release-check verifies private candidates, never publication readiness.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"aead.dev/minisign"
)

// Independent of candidate metadata: the existing deployed updater trust anchor.
const trustedKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM1NDc3MTVFQjFGMjQzMEUKUldRT1EvS3hYbkZITlZzVzUzOGxja3ZodGFsVzM4RnNsbmhtNXJ3dXV6dmlqdFlSMzR5cUxRd0oK"
const repository = "AutoDevJapan/PassShare"

var shaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type source struct {
	SHA              string `json:"source_sha"`
	PackageVersion   string `json:"package_version"`
	TauriVersion     string `json:"tauri_version"`
	CargoVersion     string `json:"cargo_version"`
	UpdaterKeySHA256 string `json:"updater_key_sha256"`
}
type asset struct {
	Name              string `json:"name"`
	Bytes             int64  `json:"bytes"`
	SHA256            string `json:"sha256"`
	UpdaterSignature  string `json:"updater_signature"`
	OSSignature       string `json:"os_signature"`
	EmbeddedVersion   string `json:"embedded_version"`
	ApplicationSHA256 string `json:"application_sha256"`
}
type evidence struct {
	Schema                         int     `json:"schema"`
	Source                         source  `json:"source"`
	Platform                       string  `json:"platform"`
	RunID                          string  `json:"run_id"`
	RunAttempt                     string  `json:"run_attempt"`
	VerifiedUTC                    string  `json:"verified_utc"`
	Assets                         []asset `json:"assets"`
	CandidateVerified              bool    `json:"candidate_verified"`
	Published                      bool    `json:"published"`
	InstallUpdateUninstallVerified bool    `json:"install_update_uninstall_verified"`
}

func fail(message string) error { return errors.New(message) }

// Only fixed messages reach logs; child output, inputs and secret values never do.
func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return fail("expected preflight, build, verify or sign-windows")
	}
	if args[0] == "sign-windows" {
		if len(args) != 2 || runtime.GOOS != "windows" {
			return fail("invalid signing invocation")
		}
		return signWindows(args[1])
	}
	fs := flag.NewFlagSet("candidate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	repo := fs.String("repo", ".", "source checkout")
	sha := fs.String("source-sha", "", "independently selected main SHA")
	out := fs.String("out", "", "new output directory outside checkout")
	bundle := fs.String("bundle", "", "bundle directory")
	if fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
		return fail("invalid arguments")
	}
	root, err := filepath.Abs(*repo)
	if err != nil {
		return fail("invalid source path")
	}
	if err = checkTrust(*sha, os.Getenv); err != nil {
		return err
	}
	src, err := inspectSource(root, *sha)
	if err != nil {
		return err
	}
	switch args[0] {
	case "preflight":
		return nil
	case "build":
		return build(root, src)
	case "verify":
		if *out == "" || *bundle == "" {
			return fail("bundle and new output directory required")
		}
		return verify(root, *bundle, *out, src)
	default:
		return fail("unknown command")
	}
}

func checkTrust(sha string, env func(string) string) error {
	if !shaPattern.MatchString(sha) || env("GITHUB_SHA") != sha || env("GITHUB_WORKFLOW_SHA") != sha {
		return fail("source SHA must equal trusted main workflow SHA")
	}
	if env("GITHUB_REPOSITORY") != repository || env("GITHUB_EVENT_NAME") != "workflow_dispatch" || env("GITHUB_REF") != "refs/heads/main" || env("CANDIDATE_REPOSITORY_PRIVATE") != "true" {
		return fail("only a manual private repository main run is trusted")
	}
	if env("GITHUB_WORKFLOW_REF") != repository+"/.github/workflows/desktop-signed-candidate.yml@refs/heads/main" {
		return fail("untrusted workflow ref")
	}
	return nil
}

func inspectSource(root, sha string) (source, error) {
	var s source
	head, err := command(root, nil, "git", "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(string(head)) != sha {
		return s, fail("checkout source SHA mismatch")
	}
	if _, err = command(root, nil, "git", "diff", "--quiet", "HEAD", "--"); err != nil {
		return s, fail("tracked source must be clean")
	}
	for _, pattern := range []string{"apps/desktop/src-tauri/tauri.*.conf.*", "apps/desktop/src-tauri/tauri.conf.json5", "apps/desktop/src-tauri/Tauri*.toml"} {
		paths, e := filepath.Glob(filepath.Join(root, pattern))
		if e != nil || len(paths) != 0 {
			return s, fail("additional Tauri configs require explicit verifier support")
		}
	}
	read := func(path string, value any) error {
		b, e := os.ReadFile(filepath.Join(root, path))
		if e != nil || json.Unmarshal(b, value) != nil {
			return fail("invalid source metadata")
		}
		return nil
	}
	var pkg struct {
		Version string `json:"version"`
	}
	var cfg struct {
		Version string `json:"version"`
		Plugins struct {
			Updater struct {
				Pubkey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if read("apps/desktop/package.json", &pkg) != nil || read("apps/desktop/src-tauri/tauri.conf.json", &cfg) != nil {
		return s, fail("cannot read desktop versions")
	}
	cargo, err := os.ReadFile(filepath.Join(root, "Cargo.toml"))
	if err != nil {
		return s, fail("cannot read workspace version")
	}
	m := regexp.MustCompile(`(?ms)^\[workspace\.package\]\s*\n(.*?)(?:^\[|\z)`).FindSubmatch(cargo)
	if len(m) != 2 {
		return s, fail("workspace version section missing")
	}
	v := regexp.MustCompile(`(?m)^version\s*=\s*"([^"\r\n]+)"\s*$`).FindSubmatch(m[1])
	if len(v) != 2 {
		return s, fail("workspace version missing")
	}
	if err = checkVersions(pkg.Version, cfg.Version, string(v[1])); err != nil {
		return s, err
	}
	if cfg.Plugins.Updater.Pubkey != trustedKey {
		return s, fail("updater public key differs from independent trust anchor")
	}
	k := sha256.Sum256([]byte(trustedKey))
	return source{sha, pkg.Version, cfg.Version, string(v[1]), hex.EncodeToString(k[:])}, nil
}

func checkVersions(pkg, tauri, cargo string) error {
	if !versionPattern.MatchString(pkg) || pkg != tauri || pkg != cargo {
		return fail("package, Tauri and Cargo versions must match")
	}
	return nil
}

// The signing process is the only child permitted to inherit signing secrets.
func cleanEnv(signing bool) []string {
	var env []string
	for _, v := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(v, "=", 2)[0])
		// PS7 module paths cannot be loaded by Windows PowerShell 5.1.
		// Let the native PowerShell child construct its own system module path.
		if runtime.GOOS == "windows" && name == "PSMODULEPATH" {
			continue
		}
		allowed := signing && (name == "TAURI_SIGNING_PRIVATE_KEY" || name == "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" || name == "APPLE_SIGNING_IDENTITY" || name == "APPLE_TEAM_ID")
		sensitive := strings.HasPrefix(name, "TAURI_") || strings.HasPrefix(name, "APPLE_") || strings.Contains(name, "TOKEN") || strings.Contains(name, "PASSWORD") || strings.Contains(name, "SECRET") || strings.Contains(name, "PRIVATE_KEY") || strings.Contains(name, "API_KEY")
		if sensitive && !allowed {
			continue
		}
		env = append(env, v)
	}
	return env
}

type boundedBuffer struct{ buffer bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.buffer.Len() < 1024*1024 {
		remain := 1024*1024 - b.buffer.Len()
		if len(p) > remain {
			p = p[:remain]
		}
		_, _ = b.buffer.Write(p)
	}
	return n, nil
}
func command(dir string, extra []string, program string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, program, args...)
	c.Dir = dir
	c.Env = append(cleanEnv(false), extra...)
	var out boundedBuffer
	c.Stdout = &out
	c.Stderr = io.Discard
	c.WaitDelay = 5 * time.Second
	if c.Run() != nil {
		return nil, fail("native command failed")
	}
	return out.buffer.Bytes(), nil
}

func build(root string, src source) error {
	if os.Getenv("TAURI_SIGNING_PRIVATE_KEY") == "" {
		return fail("updater signing key is required; unsigned build is prohibited")
	}
	var bundles string
	// Build with public OS policy only, then supply the updater key solely to signer.
	// Intermediate files are never accepted or uploaded as verified candidates.
	overlay := map[string]any{"bundle": map[string]any{"createUpdaterArtifacts": false}}
	b := overlay["bundle"].(map[string]any)
	switch runtime.GOOS {
	case "windows":
		if err := windowsPrerequisites(); err != nil {
			return err
		}
		exe, err := os.Executable()
		if err != nil {
			return fail("cannot locate signer")
		}
		b["windows"] = map[string]any{"signCommand": map[string]any{"cmd": exe, "args": []string{"sign-windows", "%1"}}}
		bundles = "nsis"
	case "darwin":
		if err := macPrerequisites(); err != nil {
			return err
		}
		bundles = "app"
		b["macOS"] = map[string]any{"signingIdentity": os.Getenv("APPLE_SIGNING_IDENTITY"), "hardenedRuntime": true}
		// Notarize with an existing keychain profile, never a password in argv.
		b["createUpdaterArtifacts"] = false
	case "linux":
		bundles = "appimage,deb"
	default:
		return fail("unsupported candidate OS")
	}
	// JSON argument, never shell source; the overlay does not change version/key/endpoints.
	config, err := json.Marshal(overlay)
	if err != nil {
		return fail("cannot create candidate overlay")
	}
	if os.Getenv("RUNNER_TEMP") == "" {
		return fail("runner-owned temporary directory required")
	}
	configDir, err := os.MkdirTemp(os.Getenv("RUNNER_TEMP"), "candidate-config-")
	if err != nil {
		return fail("cannot prepare candidate overlay")
	}
	configPath := filepath.Join(configDir, "overlay.json")
	if os.WriteFile(configPath, config, 0600) != nil {
		return fail("cannot prepare candidate overlay")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	program := "pnpm"
	c := exec.CommandContext(ctx, program, "exec", "tauri", "build", "--ci", "--config", configPath, "--bundles", bundles, "--", "--locked")
	if runtime.GOOS == "windows" {
		// pnpm can be a .cmd shim. PowerShell receives data via env, never evaluated source.
		c = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `& pnpm exec tauri build --ci --config $env:CANDIDATE_CONFIG --bundles $env:CANDIDATE_BUNDLES -- --locked; exit $LASTEXITCODE`)
	}
	c.Dir = filepath.Join(root, "apps/desktop")
	c.Env = cleanEnv(false)
	if runtime.GOOS == "windows" {
		c.Env = append(c.Env, "CANDIDATE_CONFIG="+configPath, "CANDIDATE_BUNDLES="+bundles)
	}
	c.Stdout = io.Discard
	c.Stderr = io.Discard
	c.WaitDelay = 5 * time.Second
	if c.Run() != nil {
		return fail("signed candidate build failed; child logs suppressed to protect secrets")
	}
	if runtime.GOOS == "darwin" {
		if err = notarizeAndSignMac(root, program); err != nil {
			return err
		}
	} else {
		pattern := "appimage/*.AppImage"
		if runtime.GOOS == "windows" {
			pattern = "nsis/*-setup.exe"
		}
		path, e := single(filepath.Join(root, "target/release/bundle"), pattern)
		if e != nil {
			return e
		}
		if err = signUpdater(root, program, path); err != nil {
			return err
		}
	}
	_, err = inspectSource(root, src.SHA)
	return err
}

func signUpdater(root, program, path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, program, "exec", "tauri", "signer", "sign", path)
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `& pnpm exec tauri signer sign $env:CANDIDATE_UPDATER; exit $LASTEXITCODE`)
	}
	c.Dir = filepath.Join(root, "apps/desktop")
	c.Env = append(cleanEnv(true), "CANDIDATE_UPDATER="+path)
	c.Stdout = io.Discard
	c.Stderr = io.Discard
	c.WaitDelay = 5 * time.Second
	if c.Run() != nil {
		return fail("updater signing failed; child logs suppressed to protect secrets")
	}
	if _, err := updaterCheck(path, trustedKey); err != nil {
		return err
	}
	return nil
}

func updaterCheck(path, key string) (asset, error) {
	var a asset
	pubText, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return a, fail("invalid updater trust anchor")
	}
	var pub minisign.PublicKey
	if pub.UnmarshalText(pubText) != nil {
		return a, fail("invalid updater public key")
	}
	sigText, err := os.ReadFile(path + ".sig")
	if err != nil || len(sigText) > 8192 {
		return a, fail("updater signature missing or invalid")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigText)))
	if err != nil {
		return a, fail("updater signature is not Tauri base64")
	}
	var parsed minisign.Signature
	if parsed.UnmarshalText(sig) != nil {
		return a, fail("invalid minisign signature")
	}
	f, err := os.Open(path)
	if err != nil {
		return a, fail("cannot read candidate")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return a, fail("candidate must be a nonempty regular file")
	}
	h := sha256.New()
	reader := io.TeeReader(f, h)
	verified := false
	if parsed.Algorithm == minisign.HashEdDSA {
		r := minisign.NewReader(reader)
		if _, err = io.Copy(io.Discard, r); err == nil {
			verified = r.Verify(pub, sig)
		}
	} else if parsed.Algorithm == minisign.EdDSA && info.Size() <= 512*1024*1024 {
		message, e := io.ReadAll(io.LimitReader(reader, 512*1024*1024+1))
		if e == nil && int64(len(message)) == info.Size() {
			verified = minisign.Verify(pub, message, sig)
		}
	}
	if !verified {
		return a, fail("updater signature does not authenticate candidate with trusted key")
	}
	return asset{Name: filepath.Base(path), Bytes: info.Size(), SHA256: hex.EncodeToString(h.Sum(nil)), UpdaterSignature: "verified"}, nil
}

func single(bundle, pattern string) (string, error) {
	paths, err := filepath.Glob(filepath.Join(bundle, pattern))
	if err != nil || len(paths) != 1 {
		return "", fail("expected exactly one candidate for this platform")
	}
	return paths[0], nil
}

func verify(root, bundle, out string, src source) error {
	output, err := filepath.Abs(out)
	if err != nil {
		return fail("invalid output path")
	}
	rel, err := filepath.Rel(root, output)
	if err != nil || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
		return fail("evidence output must be outside source checkout")
	}
	if _, err = os.Lstat(output); !os.IsNotExist(err) {
		return fail("output must be new; stale evidence is prohibited")
	}
	var path string
	switch runtime.GOOS {
	case "windows":
		path, err = single(bundle, "nsis/*-setup.exe")
	case "darwin":
		path, err = single(bundle, "macos/*.app.tar.gz")
	case "linux":
		path, err = single(bundle, "appimage/*.AppImage")
	default:
		return fail("unsupported verification OS")
	}
	if err != nil {
		return err
	}
	a, err := updaterCheck(path, trustedKey)
	if err != nil {
		return err
	}
	// Native checks operate on actual bytes, never a candidate-supplied success manifest.
	native, appHash, err := nativeCheck(root, bundle, path, src.TauriVersion)
	if err != nil {
		return err
	}
	if appHash == "" {
		return fail("verified application byte hash missing")
	}
	a.OSSignature = native
	a.EmbeddedVersion = src.TauriVersion
	a.ApplicationSHA256 = appHash
	// Reject mutation between cryptographic/native verification and staging.
	again, err := updaterCheck(path, trustedKey)
	if err != nil || a.SHA256 != again.SHA256 || a.Bytes != again.Bytes {
		return fail("candidate changed during verification")
	}
	if _, err = inspectSource(root, src.SHA); err != nil {
		return err
	}
	if os.Mkdir(output, 0700) != nil {
		return fail("cannot create evidence directory")
	}
	for _, p := range []string{path, path + ".sig"} {
		data, e := os.ReadFile(p)
		if e != nil {
			return fail("cannot stage verified candidate")
		}
		if p == path {
			h := sha256.Sum256(data)
			if hex.EncodeToString(h[:]) != a.SHA256 {
				return fail("candidate changed before staging")
			}
		}
		if os.WriteFile(filepath.Join(output, filepath.Base(p)), data, 0600) != nil {
			return fail("cannot stage verified candidate")
		}
	}
	// Verify the actual staged bytes too. Upload is allowed only after this succeeds.
	staged, err := updaterCheck(filepath.Join(output, a.Name), trustedKey)
	if err != nil || staged.SHA256 != a.SHA256 {
		return fail("staged candidate signature mismatch")
	}
	e := evidence{1, src, runtime.GOOS + "-" + runtime.GOARCH, os.Getenv("GITHUB_RUN_ID"), os.Getenv("GITHUB_RUN_ATTEMPT"), time.Now().UTC().Format(time.RFC3339), []asset{a}, true, false, false}
	data, err := json.MarshalIndent(e, "", "  ")
	if err != nil || os.WriteFile(filepath.Join(output, "evidence.json"), append(data, '\n'), 0600) != nil {
		return fail("cannot save evidence")
	}
	return nil
}
