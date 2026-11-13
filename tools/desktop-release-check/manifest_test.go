package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifiedManifestPayloadBinding(t *testing.T) {
	src := source{TauriVersion: "0.1.0"}
	a := asset{Name: "PassShare_0.1.0_x64-setup.exe", Bytes: 12, SHA256: strings.Repeat("a", 64), UpdaterSignature: "verified", OSSignature: "authenticode_trusted_publisher_and_timestamp", EmbeddedVersion: "0.1.0", ApplicationSHA256: strings.Repeat("b", 64)}
	url := "https://github.com/AutoDevJapan/PassShare/releases/download/v0.1.0/" + a.Name
	data, err := verifiedWindowsManifest(src, a, url, "dGVzdA==")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Version   string `json:"version"`
		Platforms map[string]struct {
			URL       string `json:"url"`
			Signature string `json:"signature"`
		} `json:"platforms"`
	}
	if json.Unmarshal(data, &m) != nil || m.Version != "0.1.0" || len(m.Platforms) != 1 || m.Platforms["windows-x86_64-nsis"].URL != url || m.Platforms["windows-x86_64-nsis"].Signature != "dGVzdA==" {
		t.Fatal("manifest contract")
	}
	for _, bad := range []string{"http://github.com/AutoDevJapan/PassShare/releases/download/v0.1.0/" + a.Name, strings.Replace(url, "v0.1.0", "v0.2.0", 1), url + "?token=x", strings.Replace(url, "AutoDevJapan", "elsewhere", 1), url + ".zip"} {
		if _, err := verifiedWindowsManifest(src, a, bad, "dGVzdA=="); err == nil {
			t.Fatal("unbound URL accepted")
		}
	}
	for _, field := range []string{"signature", "native", "version", "hash"} {
		bad := a
		switch field {
		case "signature":
			bad.UpdaterSignature = ""
		case "native":
			bad.OSSignature = ""
		case "version":
			bad.EmbeddedVersion = "0.2.0"
		case "hash":
			bad.SHA256 = ""
		}
		if _, err := verifiedWindowsManifest(src, bad, url, "dGVzdA=="); err == nil {
			t.Fatalf("missing verification %s", field)
		}
	}
}

func TestManifestRetainsCryptographicallyCheckedSignature(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(readFixture(t, "minisign.pub"))
	signature := base64.StdEncoding.EncodeToString(readFixture(t, "message.txt.minisig"))
	path := filepath.Join(scratch(t), "PassShare_0.1.0_x64-setup.exe")
	write(t, path, readFixture(t, "message.txt"))
	write(t, path+".sig", []byte(signature))
	a, err := updaterCheck(path, key)
	if err != nil {
		t.Fatal(err)
	}
	write(t, path+".sig", []byte("cmVwbGFjZWQ="))
	if a.verifiedSignature != signature {
		t.Fatal("signature bytes no longer bound to crypto verification")
	}
	// Native status here is an explicit synthetic formatter fixture, not OS signing.
	a.OSSignature = "authenticode_trusted_publisher_and_timestamp"
	a.EmbeddedVersion = "0.1.0"
	a.ApplicationSHA256 = strings.Repeat("b", 64)
	data, err := verifiedWindowsManifest(source{TauriVersion: "0.1.0"}, a, "https://github.com/"+repository+"/releases/download/v0.1.0/"+a.Name, a.verifiedSignature)
	if err != nil || !strings.Contains(string(data), signature) || strings.Contains(string(data), "cmVwbGFjZWQ=") {
		t.Fatal("manifest signature differs from verified bytes")
	}
	if _, err := updaterCheck(path, key); err == nil {
		t.Fatal("replacement signature accepted on new verification")
	}
}

func TestManifestFilePublicationIsCompleteAndNonOverwriting(t *testing.T) {
	dir := scratch(t)
	data := []byte(`{"version":"0.1.0"}`)
	if err := publishManifestFile(dir, data); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "latest.json"))
	if err != nil || string(got) != string(data) {
		t.Fatal("complete readback")
	}
	if err := publishManifestFile(dir, []byte("replacement")); err == nil {
		t.Fatal("existing manifest overwritten")
	}
	got, _ = os.ReadFile(filepath.Join(dir, "latest.json"))
	if string(got) != string(data) {
		t.Fatal("existing bytes changed")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatal("partial file remains")
	}
	if err := publishManifestFile(filepath.Join(dir, "absent"), data); err == nil {
		t.Fatal("missing output accepted")
	}
}

type failedManifestFile struct {
	*os.File
	mode string
}

func (f failedManifestFile) Write(b []byte) (int, error) {
	if f.mode == "short" {
		return f.File.Write(b[:1])
	}
	if f.mode == "write" {
		_, _ = f.File.Write(b[:1])
		return 1, errors.New("injected")
	}
	return f.File.Write(b)
}
func (f failedManifestFile) Close() error {
	err := f.File.Close()
	if f.mode == "close" {
		return errors.New("injected")
	}
	return err
}
func TestManifestFailedWritesLeaveNoFinalOrPartial(t *testing.T) {
	for _, mode := range []string{"short", "write", "close"} {
		t.Run(mode, func(t *testing.T) {
			dir := scratch(t)
			err := publishManifestWith(dir, []byte("complete"), func() (manifestFile, error) {
				f, e := os.CreateTemp(dir, ".latest-partial-*")
				return failedManifestFile{f, mode}, e
			})
			if err == nil {
				t.Fatal("failure accepted")
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 0 {
				t.Fatal("failed manifest remains")
			}
		})
	}
}

func TestManifestWiringRechecksStagedBytesAndIgnoresDiskEvidence(t *testing.T) {
	dir := scratch(t)
	name := "PassShare_0.1.0_x64-setup.exe"
	path := filepath.Join(dir, name)
	key := base64.StdEncoding.EncodeToString(readFixture(t, "minisign.pub"))
	sig := base64.StdEncoding.EncodeToString(readFixture(t, "message.txt.minisig"))
	write(t, path, readFixture(t, "message.txt"))
	write(t, path+".sig", []byte(sig))
	a, err := updaterCheck(path, key)
	if err != nil {
		t.Fatal(err)
	}
	a.OSSignature = "authenticode_trusted_publisher_and_timestamp"
	a.EmbeddedVersion = "0.1.0"
	a.ApplicationSHA256 = strings.Repeat("b", 64)
	src := source{TauriVersion: "0.1.0"}
	u := "https://github.com/" + repository + "/releases/download/v0.1.0/" + name
	write(t, filepath.Join(dir, "evidence.json"), []byte(`{"candidate_verified":true,"assets":[{"name":"../evil-setup.exe"}]}`))
	bad := a
	bad.Name = "../evil-setup.exe"
	if writeVerifiedManifestWithKey(dir, src, u, bad, key) == nil {
		t.Fatal("path escape accepted")
	}
	bad = a
	bad.SHA256 = strings.Repeat("c", 64)
	if writeVerifiedManifestWithKey(dir, src, u, bad, key) == nil {
		t.Fatal("staged hash ignored")
	}
	if err := writeVerifiedManifestWithKey(dir, src, u, a, key); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "latest.json"))
	if !strings.Contains(string(data), sig) || strings.Contains(string(data), "evil") {
		t.Fatal("disk evidence influenced output")
	}
}

func TestManifestEarlyURLAndExplicitEmpty(t *testing.T) {
	good := "https://github.com/" + repository + "/releases/download/v0.1.0/PassShare_0.1.0_x64-setup.exe"
	if validateManifestURL("0.1.0", good) != nil {
		t.Fatal("valid early URL")
	}
	for _, bad := range []string{strings.Replace(good, "_x64", "_arm64", 1), good + "?x=1", strings.Replace(good, "v0.1.0", "v0.2.0", 1), strings.Replace(good, "https:", "http:", 1)} {
		if validateManifestURL("0.1.0", bad) == nil {
			t.Fatal("invalid early URL")
		}
	}
	for _, cmd := range []string{"preflight", "build", "verify"} {
		if err := run([]string{cmd, "--payload-url="}); err == nil || err.Error() != "explicit payload URL must not be empty" {
			t.Fatal("explicit empty must fail before trust")
		}
	}
}
func TestManifestRejectsMultilineSignature(t *testing.T) {
	a := asset{Name: "PassShare_0.1.0_x64-setup.exe", Bytes: 1, SHA256: strings.Repeat("a", 64), UpdaterSignature: "verified", OSSignature: "authenticode_trusted_publisher_and_timestamp", EmbeddedVersion: "0.1.0", ApplicationSHA256: strings.Repeat("b", 64)}
	u := "https://github.com/" + repository + "/releases/download/v0.1.0/" + a.Name
	for _, sig := range []string{"dGVz\ndA==", "dGVz\rdA=="} {
		if _, err := verifiedWindowsManifest(source{TauriVersion: "0.1.0"}, a, u, sig); err == nil {
			t.Fatal("multiline accepted")
		}
	}
}
