package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type macMember struct {
	name   string
	kind   byte
	target string
	data   string
	size   int64
}

func macFile(name, data string) macMember {
	return macMember{name: name, kind: tar.TypeReg, data: data, size: int64(len(data))}
}
func macLink(name, target string) macMember {
	return macMember{name: name, kind: tar.TypeSymlink, target: target}
}
func macTar(t *testing.T, root string, members ...macMember) string {
	t.Helper()
	archive := filepath.Join(root, "candidate.tar.gz")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	g := gzip.NewWriter(f)
	w := tar.NewWriter(g)
	for _, m := range members {
		if err = w.WriteHeader(&tar.Header{Name: m.name, Typeflag: m.kind, Linkname: m.target, Mode: 0755, Size: m.size}); err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(m.data)); err != nil {
			t.Fatal(err)
		}
	}
	if w.Close() != nil || g.Close() != nil || f.Close() != nil {
		t.Fatal("cannot write Mac archive fixture")
	}
	return archive
}
func macDestination(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "extracted")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestMacArchiveFrameworkForwardLinks(t *testing.T) {
	root := scratch(t)
	prefix := "PassShare.app/Contents/Frameworks/F.framework/"
	archive := macTar(t, root,
		macLink(prefix+"Resources", "Versions/Current/Resources"),
		macLink(prefix+"Versions/Current", "A"),
		macLink(prefix+"F", "Versions/Current/F"),
		macFile(prefix+"Versions/A/F", "framework executable fixture"),
		macFile(prefix+"Versions/A/Resources/info", "framework resources fixture"),
		macFile("PassShare.app/Contents/Info.plist", "app metadata fixture"))
	app, err := extractApp(archive, macDestination(t, root))
	if err != nil {
		t.Fatal(err)
	}
	framework := filepath.Join(app, "Contents/Frameworks/F.framework")
	for _, entry := range []struct{ name, target, data string }{{"Versions/Current", "A", ""}, {"F", "Versions/Current/F", "framework executable fixture"}, {"Resources", "Versions/Current/Resources", ""}} {
		got, err := os.Readlink(filepath.Join(framework, entry.name))
		if err != nil || filepath.ToSlash(got) != entry.target {
			t.Fatalf("framework link not preserved: %s", entry.name)
		}
		if entry.data != "" {
			data, err := os.ReadFile(filepath.Join(framework, entry.name))
			if err != nil || string(data) != entry.data {
				t.Fatal("framework link cannot be read")
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(framework, "Resources/info")); err != nil || string(data) != "framework resources fixture" {
		t.Fatal("forward directory link cannot be read")
	}
}

func sentinel(t *testing.T, root string) (string, []byte, time.Time) {
	t.Helper()
	p := filepath.Join(root, "outside")
	data := []byte("outside sentinel: unchanged")
	write(t, p, data)
	stamp := time.Unix(1700000000, 0)
	if err := os.Chtimes(p, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	// Positive control: the sentinel really exists and is readable outside scratch.
	actual, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("sentinel control failed")
	}
	return p, data, info.ModTime()
}
func assertSentinel(t *testing.T, p string, data []byte, mtime time.Time) {
	t.Helper()
	actual, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("outside sentinel changed")
	}
	info, err := os.Stat(p)
	if err != nil || !info.ModTime().Equal(mtime) {
		t.Fatal("outside sentinel mtime changed")
	}
}

func TestMacArchiveRejectsLinkDotDotEscape(t *testing.T) {
	root := scratch(t)
	outside, data, mtime := sentinel(t, root)
	archive := macTar(t, root,
		macLink("PassShare.app/a", "."),
		macMember{name: "PassShare.app/Contents", kind: tar.TypeDir},
		macLink("PassShare.app/Contents/Info.plist", "../a/../../outside"))
	app, err := extractApp(archive, macDestination(t, root))
	if err == nil {
		// On POSIX the old lexical guard accepts this link and reads the sentinel.
		leaked, readErr := os.ReadFile(filepath.Join(app, "Contents/Info.plist"))
		if readErr == nil && bytes.Equal(leaked, data) {
			t.Fatal("archive returned an app whose link reads outside scratch")
		}
		t.Fatal("unsafe link chain was not rejected")
	}
	assertSentinel(t, outside, data, mtime)
}

func TestMacArchiveRejectsUnsafeNamesAndTargets(t *testing.T) {
	cases := []struct {
		name    string
		members []macMember
	}{
		{"member traversal", []macMember{macFile("PassShare.app/../../outside", "overwrite")}},
		{"absolute member", []macMember{macFile("/PassShare.app/outside", "overwrite")}},
		{"drive relative", []macMember{macFile("C:PassShare.app/outside", "overwrite")}},
		{"backslash traversal", []macMember{macFile(`PassShare.app\..\outside`, "overwrite")}},
		{"absolute target", []macMember{macLink("PassShare.app/link", "/outside")}},
		{"drive target", []macMember{macLink("PassShare.app/link", `C:\outside`)}},
		{"scratch sibling", []macMember{macFile("PassShare.app/file", "control"), macLink("PassShare.app/link", "../outside")}},
		{"dangling", []macMember{macLink("PassShare.app/link", "missing")}},
		{"cycle", []macMember{macLink("PassShare.app/a", "b"), macLink("PassShare.app/b", "a")}},
		{"two apps", []macMember{macFile("PassShare.app/file", "control"), macFile("Second.app/file", "reject")}},
		{"root alias", []macMember{macLink("PassShare.app", ".")}},
		{"hard link", []macMember{{name: "PassShare.app/file", kind: tar.TypeLink, target: "../outside"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := scratch(t)
			outside, data, mtime := sentinel(t, root)
			archive := macTar(t, root, c.members...)
			if _, err := extractApp(archive, macDestination(t, root)); err == nil {
				t.Fatal("unsafe archive accepted")
			}
			assertSentinel(t, outside, data, mtime)
		})
	}
}

func TestMacArchiveRejectsPreexistingParentLink(t *testing.T) {
	root := scratch(t)
	outside, data, mtime := sentinel(t, root)
	destination := macDestination(t, root)
	app := filepath.Join(destination, "PassShare.app")
	if os.Mkdir(app, 0700) != nil {
		t.Fatal("cannot prepare preexisting parent")
	}
	if err := os.Symlink(root, filepath.Join(app, "Contents")); err != nil {
		t.Fatal(err)
	}
	archive := macTar(t, root, macFile("PassShare.app/Contents/outside", "overwrite"))
	if _, err := extractApp(archive, destination); err == nil {
		t.Fatal("preexisting parent link accepted")
	}
	assertSentinel(t, outside, data, mtime)
}

func TestMacArchiveRejectsRootSymlink(t *testing.T) {
	root := scratch(t)
	outside, data, mtime := sentinel(t, root)
	destination := filepath.Join(root, "root-link")
	if err := os.Symlink(root, destination); err != nil {
		t.Fatal(err)
	}
	archive := macTar(t, root, macFile("PassShare.app/outside", "overwrite"))
	if _, err := extractApp(archive, destination); err == nil {
		t.Fatal("symlink inspection root accepted")
	}
	assertSentinel(t, outside, data, mtime)
}
