package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

var thumbPattern = regexp.MustCompile(`^[0-9A-Fa-f]{40}$`)
var teamPattern = regexp.MustCompile(`^[A-Z0-9]{10}$`)
var profilePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func windowsPolicy() error {
	if !thumbPattern.MatchString(os.Getenv("WINDOWS_CERT_THUMBPRINT")) || strings.TrimSpace(os.Getenv("WINDOWS_PUBLISHER_SUBJECT")) == "" {
		return fail("Windows signer thumbprint and publisher subject required")
	}
	u, err := url.Parse(os.Getenv("WINDOWS_TIMESTAMP_URL"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return fail("HTTPS issuer-approved Windows timestamp URL required")
	}
	return nil
}

const windowsStoreScript = `$ErrorActionPreference='Stop'
$c=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$env:WINDOWS_CERT_THUMBPRINT)
if (!$c.HasPrivateKey -or $c.Subject -cne $env:WINDOWS_PUBLISHER_SUBJECT -or $c.NotAfter -le (Get-Date) -or $c.NotBefore -gt (Get-Date)) {exit 1}
if (@($c.EnhancedKeyUsageList | Where-Object {$_.ObjectId -eq '1.3.6.1.5.5.7.3.3'}).Count -eq 0) {exit 1}
$chain=New-Object System.Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode='Online'
if (!$chain.Build($c)) {exit 1}
`

func windowsPrerequisites() error {
	if err := windowsPolicy(); err != nil {
		return err
	}
	if _, err := command("", nil, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsStoreScript); err != nil {
		return fail("Windows trusted code-signing identity/provider missing or invalid")
	}
	_, err := signtool()
	return err
}
func signtool() (string, error) {
	// Fixed SDK location: no provider executable or shell command from user input.
	paths, _ := filepath.Glob(`C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe`)
	if len(paths) == 0 {
		return "", fail("Windows SDK signtool missing")
	}
	p := paths[len(paths)-1]
	const script = `$s=Get-AuthenticodeSignature -LiteralPath $env:CHECK_SIGNTOOL
if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {exit 1}`
	if _, err := command("", []string{"CHECK_SIGNTOOL=" + p}, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script); err != nil {
		return "", fail("Windows SDK signer is not trusted")
	}
	return p, nil
}
func signWindows(path string) error {
	if err := checkTrust(os.Getenv("CANDIDATE_SHA"), os.Getenv); err != nil {
		return err
	}
	root := os.Getenv("GITHUB_WORKSPACE")
	if root == "" {
		return fail("trusted workspace required for signing")
	}
	if _, err := inspectSource(root, os.Getenv("CANDIDATE_SHA")); err != nil {
		return err
	}
	if err := windowsPrerequisites(); err != nil {
		return err
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return fail("invalid signing target")
	}
	if strings.ToLower(filepath.Ext(p)) != ".exe" {
		return fail("Windows signing target must be executable")
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return fail("cannot resolve signing target")
	}
	rel, err := filepath.Rel(filepath.Join(root, "target/release"), resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fail("signing target must stay inside candidate build output")
	}
	tool, err := signtool()
	if err != nil {
		return err
	}
	if _, err = command("", nil, tool, "sign", "/fd", "SHA256", "/sha1", os.Getenv("WINDOWS_CERT_THUMBPRINT"), "/s", "My", "/tr", os.Getenv("WINDOWS_TIMESTAMP_URL"), "/td", "SHA256", p); err != nil {
		return fail("Windows provider signing failed")
	}
	return windowsVerify(p, "")
}

const windowsVerifyScript = `$ErrorActionPreference='Stop'
$s=Get-AuthenticodeSignature -LiteralPath $env:CHECK_ASSET
if ($s.Status -ne 'Valid' -or !$s.SignerCertificate -or !$s.TimeStamperCertificate) {exit 1}
if ($s.SignerCertificate.Thumbprint -ine $env:WINDOWS_CERT_THUMBPRINT -or $s.SignerCertificate.Subject -cne $env:WINDOWS_PUBLISHER_SUBJECT) {exit 1}
if (@($s.SignerCertificate.EnhancedKeyUsageList | Where-Object {$_.ObjectId -eq '1.3.6.1.5.5.7.3.3'}).Count -eq 0) {exit 1}
if (@($s.TimeStamperCertificate.EnhancedKeyUsageList | Where-Object {$_.ObjectId -eq '1.3.6.1.5.5.7.3.8'}).Count -eq 0) {exit 1}
if ($env:CHECK_VERSION) {
 $v=(Get-Item -LiteralPath $env:CHECK_ASSET).VersionInfo.ProductVersion
 if ($v -cne $env:CHECK_VERSION -and $v -cne ($env:CHECK_VERSION+'.0')) {exit 1}
}
`

func windowsVerify(path, version string) error {
	if err := windowsPolicy(); err != nil {
		return err
	}
	if _, err := command("", []string{"CHECK_ASSET=" + path, "CHECK_VERSION=" + version}, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsVerifyScript); err != nil {
		return fail("Windows Authenticode trust, publisher, timestamp or embedded version failed")
	}
	return nil
}

func macPrerequisites() error {
	identity := os.Getenv("APPLE_SIGNING_IDENTITY")
	team := os.Getenv("APPLE_TEAM_ID")
	if !teamPattern.MatchString(team) || !strings.HasPrefix(identity, "Developer ID Application: ") || !strings.HasSuffix(identity, " ("+team+")") {
		return fail("Developer ID Application identity and matching Apple team required")
	}
	if !profilePattern.MatchString(os.Getenv("MACOS_NOTARY_PROFILE")) {
		return fail("existing Apple notarization keychain profile required")
	}
	text, err := command("", nil, "/usr/bin/security", "find-identity", "-v", "-p", "codesigning")
	if err != nil || !strings.Contains(string(text), `"`+identity+`"`) {
		return fail("Developer ID identity missing from runner keychain")
	}
	if _, err = command("", nil, "/usr/bin/xcrun", "notarytool", "history", "--keychain-profile", os.Getenv("MACOS_NOTARY_PROFILE")); err != nil {
		return fail("existing notarization keychain profile unavailable")
	}
	return nil
}

func notarizeAndSignMac(root, program string) error {
	macdir := filepath.Join(root, "target/release/bundle/macos")
	app, err := single(macdir, "*.app")
	if err != nil {
		return err
	}
	scratch, err := os.MkdirTemp(os.Getenv("RUNNER_TEMP"), "candidate-notary-")
	if err != nil {
		return fail("cannot prepare notarization archive")
	}
	zip := filepath.Join(scratch, "app.zip")
	if _, err = command("", nil, "/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip); err != nil {
		return fail("cannot prepare notarization archive")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "/usr/bin/xcrun", "notarytool", "submit", zip, "--keychain-profile", os.Getenv("MACOS_NOTARY_PROFILE"), "--wait")
	c.Env = cleanEnv(false)
	c.Stdout = io.Discard
	c.Stderr = io.Discard
	c.WaitDelay = 5 * time.Second
	if c.Run() != nil {
		return fail("Apple notarization submission failed")
	}
	if _, err = command("", nil, "/usr/bin/xcrun", "stapler", "staple", app); err != nil {
		return fail("Apple notarization stapling failed")
	}
	archive := app + ".tar.gz"
	if _, err = command(macdir, []string{"COPYFILE_DISABLE=1"}, "/usr/bin/tar", "--no-xattrs", "-czf", archive, filepath.Base(app)); err != nil {
		return fail("cannot package notarized updater")
	}
	return signUpdater(root, program, archive)
}

func nativeCheck(root, bundle, path, version string) (string, string, error) {
	switch runtime.GOOS {
	case "windows":
		if err := windowsVerify(path, version); err != nil {
			return "", "", err
		}
		// The installer signature alone cannot establish that the application is signed.
		if err := windowsVerify(filepath.Join(root, "target/release/passshare-desktop.exe"), version); err != nil {
			return "", "", err
		}
		scratch, err := os.MkdirTemp(os.Getenv("RUNNER_TEMP"), "candidate-nsis-")
		if err != nil {
			return "", "", fail("cannot prepare installer inspection")
		}
		if _, err = command("", nil, "7z", "x", "-y", "-o"+scratch, path); err != nil {
			return "", "", fail("cannot inspect signed NSIS payload; 7-Zip required")
		}
		var applications []string
		if filepath.WalkDir(scratch, func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if !d.IsDir() && strings.EqualFold(d.Name(), "passshare-desktop.exe") {
				applications = append(applications, p)
			}
			return nil
		}) != nil || len(applications) != 1 {
			return "", "", fail("NSIS must contain exactly one application")
		}
		if !sameFiles(applications[0], filepath.Join(root, "target/release/passshare-desktop.exe")) {
			return "", "", fail("installer payload and signed application bytes differ")
		}
		if err = windowsVerify(applications[0], version); err != nil {
			return "", "", err
		}
		return "authenticode_trusted_publisher_and_timestamp", fileHash(filepath.Join(root, "target/release/passshare-desktop.exe")), nil
	case "darwin":
		if !teamPattern.MatchString(os.Getenv("APPLE_TEAM_ID")) {
			return "", "", fail("trusted Apple team required")
		}
		scratch, err := os.MkdirTemp(os.Getenv("RUNNER_TEMP"), "candidate-mac-")
		if err != nil {
			return "", "", fail("cannot create Mac inspection directory")
		}
		// Scratch is runner-owned and excluded from uploaded artifacts.
		app, err := extractApp(path, scratch)
		if err != nil {
			return "", "", err
		}
		info := filepath.Join(app, "Contents/Info.plist")
		v, err := command("", nil, "/usr/libexec/PlistBuddy", "-c", "Print:CFBundleShortVersionString", info)
		if err != nil || strings.TrimSpace(string(v)) != version {
			return "", "", fail("macOS embedded version mismatch")
		}
		id, err := command("", nil, "/usr/libexec/PlistBuddy", "-c", "Print:CFBundleIdentifier", info)
		if err != nil || strings.TrimSpace(string(id)) != "com.passshare.app" {
			return "", "", fail("macOS bundle identifier mismatch")
		}
		requirement := `=anchor apple generic and certificate leaf[subject.OU] = "` + os.Getenv("APPLE_TEAM_ID") + `" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "com.passshare.app"`
		if _, err = command("", nil, "/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", requirement, app); err != nil {
			return "", "", fail("macOS Developer ID signature failed")
		}
		if _, err = command("", nil, "/usr/sbin/spctl", "--assess", "--type", "execute", app); err != nil {
			return "", "", fail("macOS Gatekeeper notarization assessment failed")
		}
		if _, err = command("", nil, "/usr/bin/xcrun", "stapler", "validate", app); err != nil {
			return "", "", fail("macOS notarization ticket missing or invalid")
		}
		return "developer_id_codesign_gatekeeper_and_stapled_notarization", fileHash(filepath.Join(app, "Contents/MacOS/passshare-desktop")), nil
	case "linux":
		deb, err := single(bundle, "deb/*.deb")
		if err != nil {
			return "", "", err
		}
		v, err := command("", nil, "dpkg-deb", "--field", deb, "Version")
		if err != nil || strings.TrimSpace(string(v)) != version {
			return "", "", fail("Linux embedded package version mismatch")
		}
		arch, err := command("", nil, "dpkg-deb", "--field", deb, "Architecture")
		if err != nil || strings.TrimSpace(string(arch)) != "amd64" || runtime.GOARCH != "amd64" {
			return "", "", fail("unsupported Linux candidate architecture")
		}
		scratch, err := os.MkdirTemp(os.Getenv("RUNNER_TEMP"), "candidate-linux-")
		if err != nil {
			return "", "", fail("cannot create Linux inspection directory")
		}
		// Only executed after its actual updater signature verifies with the trust anchor.
		if _, err = command(scratch, nil, path, "--appimage-extract"); err != nil {
			return "", "", fail("cannot inspect authenticated AppImage")
		}
		if _, err = command("", nil, "dpkg-deb", "--extract", deb, filepath.Join(scratch, "deb")); err != nil {
			return "", "", fail("cannot inspect companion package")
		}
		appBinary := filepath.Join(scratch, "squashfs-root/usr/bin/passshare-desktop")
		debBinary := filepath.Join(scratch, "deb/usr/bin/passshare-desktop")
		// linuxdeploy strips debug sections and rewrites RPATH; those are not
		// whole-file-identical to the original. Compare actual compiled code/data.
		if !sameELFPayload(appBinary, debBinary) || !sameFiles(debBinary, filepath.Join(root, "target/release/passshare-desktop")) {
			return "", "", fail("AppImage code/data, versioned package and built application differ")
		}
		return "not_applicable_linux_updater_signature_verified", fileHash(appBinary), nil
	}
	return "", "", fail("unsupported OS")
}

// This is a compiled payload identity check, not a second authenticity check.
// The updater signature authenticates ALL AppImage bytes including loader data.
func elfPayloadHash(path string) (string, error) {
	f, err := elf.Open(path)
	if err != nil {
		return "", fail("cannot inspect Linux ELF")
	}
	defer f.Close()
	if f.Class != elf.ELFCLASS64 || f.Machine != elf.EM_X86_64 || f.Data != elf.ELFDATA2LSB {
		return "", fail("unsupported Linux ELF")
	}
	if f.Section(".text") == nil || f.Section(".rodata") == nil {
		return "", fail("Linux compiled code/data sections missing")
	}
	dataSections := map[string]bool{".rodata": true, ".data": true, ".data.rel.ro": true, ".bss": true, ".init_array": true, ".fini_array": true, ".preinit_array": true, ".note.gnu.build-id": true}
	var sections []*elf.Section
	for _, s := range f.Sections {
		if s.Flags&elf.SHF_EXECINSTR != 0 || dataSections[s.Name] {
			sections = append(sections, s)
		}
	}
	sort.Slice(sections, func(i, j int) bool { return sections[i].Name < sections[j].Name })
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "%d:%d:%d:%d:%d\n", f.Class, f.Data, f.Type, f.Machine, f.Entry)
	for _, s := range sections {
		_, _ = fmt.Fprintf(h, "%s:%d:%d:%d:%d\n", s.Name, s.Type, s.Flags, s.Addr, s.Size)
		if s.Type != elf.SHT_NOBITS {
			if _, err = io.Copy(h, s.Open()); err != nil {
				return "", fail("cannot read Linux code/data")
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func sameELFPayload(a, b string) bool {
	x, e := elfPayloadHash(a)
	if e != nil {
		return false
	}
	y, e := elfPayloadHash(b)
	return e == nil && x == y
}
func sameFiles(a, b string) bool {
	digest := func(p string) ([]byte, error) {
		f, e := os.Open(p)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		h := sha256.New()
		n, e := io.Copy(h, f)
		if e != nil || n == 0 {
			return nil, fail("empty binary")
		}
		return h.Sum(nil), nil
	}
	x, e := digest(a)
	if e != nil {
		return false
	}
	y, e := digest(b)
	return e == nil && string(x) == string(y)
}
func fileHash(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil || n == 0 {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Extract into caller-owned, empty scratch. Rooted operations confine writes;
// links are resolved within the app before creation and before external readers.
func extractApp(archive, root string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", fail("invalid Mac inspection root")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fail("Mac inspection root must be a real directory")
	}
	scratchRoot, err := os.OpenRoot(root)
	if err != nil {
		return "", fail("cannot open Mac inspection root")
	}
	defer scratchRoot.Close()
	dir, err := scratchRoot.Open(".")
	if err != nil {
		return "", fail("cannot inspect Mac root")
	}
	entries, readErr := dir.ReadDir(1)
	closeErr := dir.Close()
	if len(entries) != 0 || (readErr != nil && readErr != io.EOF) || closeErr != nil {
		return "", fail("Mac inspection root must be empty")
	}
	f, err := os.Open(archive)
	if err != nil {
		return "", fail("cannot read Mac archive")
	}
	defer f.Close()
	g, err := gzip.NewReader(f)
	if err != nil {
		return "", fail("invalid Mac archive")
	}
	defer g.Close()
	t := tar.NewReader(g)
	app := ""
	var appRoot *os.Root
	defer func() {
		if appRoot != nil {
			_ = appRoot.Close()
		}
	}()
	links := make(map[string]string)
	var size int64
	count := 0
	for {
		h, e := t.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", fail("invalid Mac archive member")
		}
		count++
		if count > 100000 || h.Size < 0 || h.Size > 8*1024*1024*1024-size {
			return "", fail("Mac archive exceeds inspection limit")
		}
		size += h.Size
		name, err := macArchiveName(h.Name)
		if err != nil {
			return "", err
		}
		if name == "." && h.Typeflag == tar.TypeDir {
			continue
		}
		top, local, hasChild := strings.Cut(name, "/")
		if top == ".app" || !strings.HasSuffix(top, ".app") || (app != "" && app != top) {
			return "", fail("Mac archive must contain exactly one app")
		}
		if !hasChild {
			local = "."
			if h.Typeflag != tar.TypeDir {
				return "", fail("Mac app root must be a directory")
			}
		}
		if appRoot == nil {
			if scratchRoot.Mkdir(top, 0700) != nil {
				return "", fail("cannot create new Mac app root")
			}
			appRoot, err = scratchRoot.OpenRoot(top)
			if err != nil {
				return "", fail("cannot open Mac app root")
			}
			app = top
		}
		if _, exists := links[local]; exists {
			return "", fail("duplicate Mac archive link")
		}
		if appRoot.MkdirAll(filepath.FromSlash(path.Dir(local)), 0700) != nil {
			return "", fail("cannot create archive directory")
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if appRoot.MkdirAll(filepath.FromSlash(local), os.FileMode(h.Mode)&0777) != nil {
				return "", fail("cannot extract archive directory")
			}
		case tar.TypeReg, tar.TypeRegA:
			w, e := appRoot.OpenFile(filepath.FromSlash(local), os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(h.Mode)&0777)
			if e != nil {
				return "", fail("cannot extract archive file")
			}
			_, e = io.Copy(w, t)
			closeErr := w.Close()
			if e != nil || closeErr != nil {
				return "", fail("cannot extract archive bytes")
			}
		case tar.TypeSymlink:
			if h.Linkname == "" || strings.HasPrefix(h.Linkname, "/") || strings.ContainsAny(h.Linkname, "\\:\x00") {
				return "", fail("unsafe archive symlink")
			}
			if _, e := appRoot.Lstat(filepath.FromSlash(local)); !os.IsNotExist(e) {
				return "", fail("Mac link destination already exists or cannot be inspected")
			}
			// Defer until all regular targets exist; preserve the raw relative target.
			links[local] = h.Linkname
		default:
			return "", fail("unsupported archive member")
		}
	}
	if app == "" {
		return "", fail("empty Mac archive")
	}
	if err = materializeMacLinks(appRoot, links); err != nil {
		return "", err
	}
	// Root.Symlink bounds the destination, NOT the target. Check every actual
	// link with the app root (not scratch) before codesign/spctl see real paths.
	if err = fs.WalkDir(appRoot.FS(), ".", func(name string, d fs.DirEntry, e error) error {
		if e != nil {
			return fail("cannot inspect extracted Mac tree")
		}
		if d.Type()&os.ModeSymlink != 0 {
			if _, e = appRoot.Stat(filepath.FromSlash(name)); e != nil {
				return fail("Mac link must resolve inside app")
			}
		}
		return nil
	}); err != nil {
		return "", err
	}
	return filepath.Join(root, app), nil
}

// Tar member names use slash separators. Reject traversal/volume syntax on
// every host instead of cleaning away meaningful symlink/.. components.
func macArchiveName(raw string) (string, error) {
	if raw == "" || strings.HasPrefix(raw, "/") || strings.ContainsAny(raw, "\\:\x00") {
		return "", fail("unsafe Mac archive path")
	}
	for strings.HasPrefix(raw, "./") {
		raw = strings.TrimPrefix(raw, "./")
	}
	raw = strings.TrimRight(raw, "/")
	if raw == "" {
		raw = "."
	}
	if !fs.ValidPath(raw) {
		return "", fail("unsafe Mac archive path")
	}
	return raw, nil
}

func materializeMacLinks(root *os.Root, links map[string]string) error {
	var names []string
	for name := range links {
		names = append(names, name)
	}
	sort.Strings(names)
	remaining := len(names)
	budget := 40 * remaining
	for remaining > 0 {
		progress := false
		for _, name := range names {
			target, waiting := links[name]
			if !waiting {
				continue
			}
			budget--
			if budget < 0 {
				return fail("Mac link resolution exceeds inspection limit")
			}
			// Do NOT path.Join/Clean this expression: resolve symlinks before .. .
			targetPath := target
			if parent := path.Dir(name); parent != "." {
				targetPath = parent + "/" + target
			}
			if _, err := root.Stat(filepath.FromSlash(targetPath)); err != nil {
				continue
			}
			if err := root.Symlink(filepath.FromSlash(target), filepath.FromSlash(name)); err != nil {
				return fail("cannot create internal Mac link")
			}
			if _, err := root.Stat(filepath.FromSlash(name)); err != nil {
				return fail("Mac link must resolve inside app")
			}
			delete(links, name)
			remaining--
			progress = true
		}
		if !progress {
			return fail("Mac links are outside app, dangling or cyclic")
		}
	}
	return nil
}
