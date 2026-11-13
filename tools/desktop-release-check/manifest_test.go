package main

import (
	"encoding/base64"
	"encoding/json"
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
