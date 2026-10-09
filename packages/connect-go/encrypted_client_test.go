package connect

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	esBox      = "bbbbbbbbbbbbbbbbbbbbbbbbbb"
	esItem     = "iiiiiiiiiiiiiiiiiiiiiiiiii"
	esOwner    = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10"
	esToken    = "synthetic-session-secret"
	esPassword = "synthetic-login-secret"
	esRemote   = "synthetic-remote-secret"
)

func esB64(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
func esEnvelope(version uint64) EncryptedItem {
	return EncryptedItem{1, ItemContext{esBox, esItem, version, 1}, esB64(24), esB64(16)}
}
func esBundle() OwnerKeyBundle {
	return OwnerKeyBundle{1, esB64(16), WrappedPasswordBoxKey{1, OwnerKeyContext{esBox, esOwner, 1}, esB64(24), esB64(48)}}
}
func esJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic("invalid synthetic fixture")
	}
	return string(b)
}
func esObject(v any) map[string]any {
	var out map[string]any
	if json.Unmarshal([]byte(esJSON(v)), &out) != nil {
		panic("invalid synthetic fixture")
	}
	return out
}

type esReply struct {
	status     int
	body, wire string
}
type esRequest struct {
	method, uri string
	header      http.Header
	body        string
}
type esFixture struct {
	server  *httptest.Server
	mu      sync.Mutex
	seen    []esRequest
	replies []esReply
}

func esServer(t *testing.T, replies ...esReply) *esFixture {
	t.Helper()
	f := &esFixture{replies: replies}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("fixture request read failed")
		}
		f.mu.Lock()
		index := len(f.seen)
		f.seen = append(f.seen, esRequest{r.Method, r.URL.RequestURI(), r.Header.Clone(), string(body)})
		var reply esReply
		if index < len(f.replies) {
			reply = f.replies[index]
		} else {
			reply = esReply{status: 500}
		}
		f.mu.Unlock()
		if reply.wire != "" {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("fixture hijack failed")
				return
			}
			defer conn.Close()
			_, _ = io.WriteString(conn, reply.wire)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.status)
		_, _ = io.WriteString(w, reply.body)
	}))
	t.Cleanup(f.server.Close)
	return f
}
func (f *esFixture) requests() []esRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]esRequest(nil), f.seen...)
}
func (f *esFixture) client(t *testing.T, prefix string) *EncryptedSessionClient {
	t.Helper()
	c, err := NewEncryptedSessionClient(f.server.URL+prefix, esToken)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func esOK(v any) esReply { return esReply{status: 200, body: esJSON(v)} }
func esAPI(t *testing.T, err error, status int, code string) {
	t.Helper()
	e, ok := err.(*EncryptedSessionError)
	if !ok || e.HTTPStatus() != status || e.Code() != code {
		t.Fatalf("unexpected API result: %v", err)
	}
}
func esReject(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("invalid input/response accepted")
	}
}

func TestEncryptedSessionWireContracts(t *testing.T) {
	bundle, envelope := esBundle(), esEnvelope(1)
	owner := bundle.Wrapped.Context
	cursor := "aaaaaaaaaaaaaaaaaaaaaaaaaa"
	f := esServer(t,
		esOK(BoxState{Mode: "compatibility"}),
		esOK(map[string]any{"mode": "encrypted", "keyEpoch": 1}),
		esOK(SetupResult{"encrypted", 1, 1, bundle}),
		esOK(ItemPage{Items: []ItemSummary{{esItem, 1, 1}}}),
		esOK(envelope), esOK(envelope),
		esReply{status: 204},
		esOK(OwnerKeyRecord{1, bundle}),
		esOK(OwnerKeyRecord{1, bundle}),
		esOK(OwnerKeyRecord{2, bundle}),
	)
	c := f.client(t, "/proxy/")
	ctx := context.Background()
	state, err := c.State(ctx, esBox)
	if err != nil || state.Mode != "compatibility" || state.KeyEpoch != nil {
		t.Fatalf("state: %v", err)
	}
	epoch, err := c.EnableEmptyBox(ctx, esBox)
	if err != nil || epoch != 1 {
		t.Fatalf("enable: %v", err)
	}
	setup, err := c.SetupEmptyBox(ctx, esBox, bundle)
	if err != nil || setup.Bundle != bundle {
		t.Fatalf("setup: %v", err)
	}
	page, err := c.List(ctx, esBox, &cursor)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %v", err)
	}
	got, err := c.GetItem(ctx, esBox, esItem)
	if err != nil || got != envelope {
		t.Fatalf("get: %v", err)
	}
	if err := got.ValidateContext(envelope.Context); err != nil {
		t.Fatal(err)
	}
	stored, err := c.PutItem(ctx, esBox, esItem, 0, envelope)
	if err != nil || stored != envelope {
		t.Fatalf("put: %v", err)
	}
	if err := c.DeleteItem(ctx, esBox, esItem, encryptedMaxInteger, encryptedMaxInteger); err != nil {
		t.Fatal(err)
	}
	key, err := c.GetOwnerKey(ctx, esBox, owner)
	if err != nil || key.Bundle != bundle {
		t.Fatalf("owner get: %v", err)
	}
	key, err = c.PutOwnerKey(ctx, esBox, 0, bundle, nil)
	if err != nil || key.BundleVersion != 1 {
		t.Fatalf("owner create: %v", err)
	}
	password := esPassword
	key, err = c.PutOwnerKey(ctx, esBox, 1, bundle, &password)
	if err != nil || key.BundleVersion != 2 {
		t.Fatalf("owner replace: %v", err)
	}
	base := "/proxy/api/encrypted/boxes/" + esBox
	expected := []struct {
		method, path string
		body         any
	}{
		{"GET", base, nil},
		{"POST", base + "/enable", map[string]any{"keyEpoch": 1}},
		{"POST", base + "/setup", map[string]any{"bundle": bundle}},
		{"GET", base + "/items?after=" + cursor, nil},
		{"GET", base + "/items/" + esItem, nil},
		{"PUT", base + "/items/" + esItem, map[string]any{"expectedVersion": 0, "envelope": envelope}},
		{"DELETE", base + "/items/" + esItem, map[string]any{"expectedVersion": encryptedMaxInteger, "keyEpoch": encryptedMaxInteger}},
		{"GET", base + "/owner-key", nil},
		{"PUT", base + "/owner-key", map[string]any{"expectedVersion": 0, "bundle": bundle}},
		{"PUT", base + "/owner-key", map[string]any{"expectedVersion": 1, "bundle": bundle, "currentPassword": password}},
	}
	seen := f.requests()
	if len(seen) != len(expected) {
		t.Fatalf("requests: %d", len(seen))
	}
	for i, want := range expected {
		r := seen[i]
		if r.method != want.method || r.uri != want.path {
			t.Errorf("request %d method/path mismatch", i)
		}
		if r.header.Get("Authorization") != "Bearer "+esToken || r.header.Get("Accept") != "application/json" {
			t.Errorf("request %d auth/accept mismatch", i)
		}
		if r.header.Get("Cookie") != "" || r.header.Get("x-csrf-token") != "" || r.header.Get("x-passshare-client") != "" {
			t.Errorf("request %d ambient authentication", i)
		}
		if r.header.Get("Connection") != "close" {
			t.Errorf("request %d reused connection", i)
		}
		if want.body == nil {
			if r.body != "" {
				t.Errorf("request %d unexpected body", i)
			}
			continue
		}
		if r.header.Get("Content-Type") != "application/json" {
			t.Errorf("request %d content type", i)
		}
		var actual, wanted any
		if json.Unmarshal([]byte(r.body), &actual) != nil || json.Unmarshal([]byte(esJSON(want.body)), &wanted) != nil || !reflect.DeepEqual(actual, wanted) {
			t.Errorf("request %d body mismatch", i)
		}
	}
}

func TestEncryptedSessionURLAndBearerValidation(t *testing.T) {
	for _, host := range []string{
		"", "https://", "http://example.com", "ftp://localhost", "//localhost", "https://user:secret@example.com", "https://@example.com",
		"https://example.com?", "https://example.com#", "https://example.com/?token=" + esToken,
		"https://example.com/a/../b", "https://example.com/%2E%2e", "https://example.com/%2f", "https://example.com/%5C", "https://example.com/%252e%252e",
		"https://example.com/a\\b", "https://example.com/%00", "https://example.com/\n" + esToken, "https://example.com:invalid",
		"http://localhost.example.com", "http://127.0.0.2", "http://[::ffff:127.0.0.1]",
	} {
		_, err := NewEncryptedSessionClient(host, esToken)
		esReject(t, err)
		if strings.Contains(fmt.Sprintf("%v %#v", err, err), esToken) || strings.Contains(fmt.Sprint(err), "secret") {
			t.Fatal("URL error exposed credentials")
		}
	}
	for _, token := range []string{"", "has space", "tab\t", "newline\r\n", "\x00", "é"} {
		_, err := NewEncryptedSessionClient("https://example.com", token)
		esReject(t, err)
	}
	for _, host := range []string{"https://example.com", "https://example.com/prefix/", "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"} {
		c, err := NewEncryptedSessionClient(host, esToken)
		if err != nil {
			t.Fatal(err)
		}
		for _, shown := range []string{fmt.Sprint(c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c), fmt.Sprintf("%#v", *c)} {
			if strings.Contains(shown, esToken) || strings.Contains(shown, host) {
				t.Fatal("client debug exposed credentials or URL")
			}
		}
		if c.http.Jar != nil || c.http.Timeout <= 0 || c.http.Transport.(*http.Transport).Proxy != nil {
			t.Fatal("ambient client state")
		}
	}
}

func TestEncryptedSessionInvalidArgumentsNeverReachHTTP(t *testing.T) {
	f := esServer(t, esOK(esEnvelope(1)))
	c, ctx := f.client(t, ""), context.Background()
	e, b := esEnvelope(1), esBundle()
	badIDs := []string{"", "short", strings.Repeat("A", 26), strings.Repeat("i", 25) + "/", strings.Repeat("é", 26), strings.Repeat("i", 27)}
	for _, id := range badIDs {
		_, err := c.State(ctx, id)
		esReject(t, err)
		_, err = c.EnableEmptyBox(ctx, id)
		esReject(t, err)
		_, err = c.SetupEmptyBox(ctx, id, b)
		esReject(t, err)
		_, err = c.List(ctx, esBox, &id)
		esReject(t, err)
		_, err = c.GetItem(ctx, esBox, id)
		esReject(t, err)
		_, err = c.PutItem(ctx, id, esItem, 0, e)
		esReject(t, err)
		esReject(t, c.DeleteItem(ctx, esBox, id, 1, 1))
		_, err = c.GetOwnerKey(ctx, id, b.Wrapped.Context)
		esReject(t, err)
		_, err = c.PutOwnerKey(ctx, id, 0, b, nil)
		esReject(t, err)
	}
	for _, value := range []uint64{0, encryptedMaxInteger + 1, ^uint64(0)} {
		esReject(t, c.DeleteItem(ctx, esBox, esItem, value, 1))
		esReject(t, c.DeleteItem(ctx, esBox, esItem, 1, value))
		other := e
		other.Context.KeyEpoch = value
		_, err := c.PutItem(ctx, esBox, esItem, 0, other)
		esReject(t, err)
		owner := b.Wrapped.Context
		owner.KeyEpoch = value
		_, err = c.GetOwnerKey(ctx, esBox, owner)
		esReject(t, err)
	}
	for _, value := range []uint64{encryptedMaxInteger, encryptedMaxInteger + 1, ^uint64(0)} {
		_, err := c.PutItem(ctx, esBox, esItem, value, e)
		esReject(t, err)
		_, err = c.PutOwnerKey(ctx, esBox, value, b, nil)
		esReject(t, err)
	}
	other := e
	other.Context.ItemVersion = 2
	_, err := c.PutItem(ctx, esBox, esItem, 0, other)
	esReject(t, err)
	for _, nonce := range []string{"", esB64(23), esB64(25), "!" + esB64(24)[1:], esB64(24) + "\n"} {
		other = e
		other.Nonce = nonce
		_, err = c.PutItem(ctx, esBox, esItem, 0, other)
		esReject(t, err)
	}
	for _, ciphertext := range []string{esB64(15), esB64(encryptedMaxCiphertext + 1), strings.TrimRight(esB64(16), "="), esB64(16)[:21] + "B=="} {
		other = e
		other.Ciphertext = ciphertext
		_, err = c.PutItem(ctx, esBox, esItem, 0, other)
		esReject(t, err)
	}
	password, empty := esPassword, ""
	_, err = c.PutOwnerKey(ctx, esBox, 0, b, &password)
	esReject(t, err)
	_, err = c.PutOwnerKey(ctx, esBox, 1, b, nil)
	esReject(t, err)
	_, err = c.PutOwnerKey(ctx, esBox, 1, b, &empty)
	esReject(t, err)
	otherBundle := b
	otherBundle.Wrapped.Context.KeyEpoch = 2
	_, err = c.SetupEmptyBox(ctx, esBox, otherBundle)
	esReject(t, err)
	for _, ownerID := range []string{strings.ToUpper(esOwner), "00000000-0000-0000-0000-000000000000", "not-uuid"} {
		owner := b.Wrapped.Context
		owner.OwnerAccountID = ownerID
		_, err = c.GetOwnerKey(ctx, esBox, owner)
		esReject(t, err)
	}
	_, err = c.State(nil, esBox)
	esReject(t, err)
	if len(f.requests()) != 0 {
		t.Fatal("invalid input reached HTTP")
	}
	// Positive control proves this fixture and request recording work.
	_, err = c.GetItem(ctx, esBox, esItem)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.requests()) != 1 {
		t.Fatal("positive control did not reach origin")
	}
}

func TestEncryptedSessionStrictItemResponses(t *testing.T) {
	good := esEnvelope(1)
	cases := map[string]string{}
	mutate := func(name string, change func(map[string]any)) {
		object := esObject(good)
		change(object)
		cases[name] = esJSON(object)
	}
	mutate("unknown", func(o map[string]any) { o["plaintext"] = esRemote })
	mutate("missing", func(o map[string]any) { delete(o, "ciphertext") })
	mutate("null", func(o map[string]any) { o["nonce"] = nil })
	mutate("format", func(o map[string]any) { o["format"] = 2 })
	mutate("decimal", func(o map[string]any) { o["context"].(map[string]any)["itemVersion"] = 1.5 })
	mutate("unsafe", func(o map[string]any) { o["context"].(map[string]any)["keyEpoch"] = uint64(encryptedMaxInteger + 1) })
	mutate("zero", func(o map[string]any) { o["context"].(map[string]any)["keyEpoch"] = 0 })
	mutate("box", func(o map[string]any) { o["context"].(map[string]any)["passwordBoxId"] = strings.Repeat("c", 26) })
	mutate("item", func(o map[string]any) { o["context"].(map[string]any)["itemId"] = strings.Repeat("A", 26) })
	mutate("nested unknown", func(o map[string]any) { o["context"].(map[string]any)["password"] = esPassword })
	mutate("nonce", func(o map[string]any) { o["nonce"] = esB64(23) })
	mutate("base64", func(o map[string]any) { o["ciphertext"] = strings.TrimRight(esB64(16), "=") })
	mutate("padding bits", func(o map[string]any) { o["ciphertext"] = esB64(16)[:21] + "B==" })
	cases["duplicate"] = strings.Replace(esJSON(good), `"format":1`, `"format":1,"format":1`, 1)
	cases["case folded"] = strings.Replace(esJSON(good), `"format"`, `"Format"`, 1)
	cases["integer decimal"] = strings.Replace(esJSON(good), `"itemVersion":1`, `"itemVersion":1.0`, 1)
	cases["integer exponent"] = strings.Replace(esJSON(good), `"itemVersion":1`, `"itemVersion":1e0`, 1)
	cases["trailing"] = esJSON(good) + ` {}`
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			f := esServer(t, esReply{status: 200, body: body})
			_, err := f.client(t, "").GetItem(context.Background(), esBox, esItem)
			esReject(t, err)
			if len(f.requests()) != 1 {
				t.Fatal("response validation skipped HTTP")
			}
		})
	}
	for _, expected := range []ItemContext{{esBox, esItem, 2, 1}, {esBox, esItem, 1, 2}, {esBox, strings.Repeat("j", 26), 1, 1}} {
		esReject(t, good.ValidateContext(expected))
	}
	max := esEnvelope(encryptedMaxInteger)
	max.Context.KeyEpoch = encryptedMaxInteger
	max.Ciphertext = esB64(encryptedMaxCiphertext)
	f := esServer(t, esOK(max))
	got, err := f.client(t, "").GetItem(context.Background(), esBox, esItem)
	if err != nil || got != max {
		t.Fatalf("valid upper boundary: %v", err)
	}
}

func TestEncryptedSessionStateEnableAndSetupValidation(t *testing.T) {
	for _, body := range []string{`{"mode":"compatibility"}`, `{"mode":"compatibility","keyEpoch":1}`, `{"mode":"encrypted","keyEpoch":null}`, `{"mode":"encrypted","keyEpoch":0}`, `{"mode":"other","keyEpoch":1}`, `{"mode":"encrypted","keyEpoch":1,"plaintext":"secret"}`} {
		f := esServer(t, esReply{status: 200, body: body})
		_, err := f.client(t, "").State(context.Background(), esBox)
		esReject(t, err)
	}
	for _, body := range []string{`{"mode":"encrypted"}`, `{"mode":"compatibility","keyEpoch":1}`, `{"mode":"encrypted","keyEpoch":2}`, `{"mode":"encrypted","keyEpoch":1.0}`} {
		f := esServer(t, esReply{status: 200, body: body})
		_, err := f.client(t, "").EnableEmptyBox(context.Background(), esBox)
		esReject(t, err)
	}
	b := esBundle()
	for _, change := range []func(*SetupResult){func(s *SetupResult) { s.KeyEpoch = 2 }, func(s *SetupResult) { s.BundleVersion = 2 }, func(s *SetupResult) { s.Mode = "compatibility" }, func(s *SetupResult) { s.Bundle.Salt = base64.StdEncoding.EncodeToString([]byte("changed-salt-1234")) }} {
		reply := SetupResult{"encrypted", 1, 1, b}
		change(&reply)
		f := esServer(t, esOK(reply))
		_, err := f.client(t, "").SetupEmptyBox(context.Background(), esBox, b)
		esReject(t, err)
	}
	epoch := encryptedMaxInteger
	f := esServer(t, esOK(BoxState{"encrypted", &epoch}))
	state, err := f.client(t, "").State(context.Background(), esBox)
	if err != nil || *state.KeyEpoch != epoch {
		t.Fatalf("positive state: %v", err)
	}
}

func TestEncryptedSessionListValidation(t *testing.T) {
	items := make([]ItemSummary, 100)
	for i := range items {
		items[i] = ItemSummary{fmt.Sprintf("%026d", i+1), 1, 1}
	}
	last, wrong := items[99].ItemID, items[50].ItemID
	cases := []ItemPage{
		{items, &wrong}, {items, nil}, {items[:99], &last},
		{append(append([]ItemSummary(nil), items...), ItemSummary{fmt.Sprintf("%026d", 101), 1, 1}), &last},
		{[]ItemSummary{items[0], items[0]}, nil}, {[]ItemSummary{items[1], items[0]}, nil},
		{[]ItemSummary{{strings.Repeat("A", 26), 1, 1}}, nil}, {[]ItemSummary{{esItem, 0, 1}}, nil}, {[]ItemSummary{{esItem, 1, encryptedMaxInteger + 1}}, nil},
	}
	for _, page := range cases {
		f := esServer(t, esOK(page))
		_, err := f.client(t, "").List(context.Background(), esBox, nil)
		esReject(t, err)
	}
	for _, body := range []string{`{"items":null,"nextCursor":null}`, `{"items":[]}`, `{"items":[],"nextCursor":null,"plaintext":true}`} {
		f := esServer(t, esReply{status: 200, body: body})
		_, err := f.client(t, "").List(context.Background(), esBox, nil)
		esReject(t, err)
	}
	f := esServer(t, esOK(ItemPage{items, &last}), esOK(ItemPage{[]ItemSummary{}, nil}), esOK(ItemPage{items[:1], nil}))
	c := f.client(t, "")
	page, err := c.List(context.Background(), esBox, nil)
	if err != nil || len(page.Items) != 100 || *page.NextCursor != last {
		t.Fatalf("full page: %v", err)
	}
	page, err = c.List(context.Background(), esBox, &last)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("empty page: %v", err)
	}
	_, err = c.List(context.Background(), esBox, &items[0].ItemID)
	esReject(t, err)
}

func TestEncryptedSessionOwnerRecordValidation(t *testing.T) {
	b := esBundle()
	mutations := []func(map[string]any){
		func(o map[string]any) { o["keyEpoch"] = 1 },
		func(o map[string]any) { delete(o, "bundleVersion") },
		func(o map[string]any) { o["bundleVersion"] = 0 },
		func(o map[string]any) { o["bundleVersion"] = encryptedMaxInteger + 1 },
		func(o map[string]any) { o["bundle"].(map[string]any)["kdf"] = "argon2id" },
		func(o map[string]any) { o["bundle"].(map[string]any)["password"] = esPassword },
		func(o map[string]any) { o["bundle"].(map[string]any)["format"] = 2 },
		func(o map[string]any) { o["bundle"].(map[string]any)["salt"] = esB64(15) },
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["ciphertext"] = esB64(47)
		},
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["context"].(map[string]any)["ownerAccountId"] = strings.ToUpper(esOwner)
		},
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["context"].(map[string]any)["ownerAccountId"] = "00000000-0000-0000-0000-000000000000"
		},
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["context"].(map[string]any)["passwordBoxId"] = strings.Repeat("c", 26)
		},
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["context"].(map[string]any)["ownerAccountId"] = "8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10"
		},
		func(o map[string]any) {
			o["bundle"].(map[string]any)["wrapped"].(map[string]any)["context"].(map[string]any)["keyEpoch"] = 2
		},
	}
	for i, change := range mutations {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			o := esObject(OwnerKeyRecord{1, b})
			change(o)
			f := esServer(t, esReply{status: 200, body: esJSON(o)})
			_, err := f.client(t, "").GetOwnerKey(context.Background(), esBox, b.Wrapped.Context)
			esReject(t, err)
		})
	}
	// PUT must echo the exact ciphertext as well as revision, not just context.
	changed := b
	changed.Wrapped.Ciphertext = base64.StdEncoding.EncodeToString(bytesOf(48, 1))
	f := esServer(t, esOK(OwnerKeyRecord{2, b}), esOK(OwnerKeyRecord{1, changed}), esOK(esEnvelope(2)))
	c := f.client(t, "")
	_, err := c.PutOwnerKey(context.Background(), esBox, 0, b, nil)
	esReject(t, err)
	_, err = c.PutOwnerKey(context.Background(), esBox, 0, b, nil)
	esReject(t, err)
	_, err = c.PutItem(context.Background(), esBox, esItem, 0, esEnvelope(1))
	esReject(t, err)
}
func bytesOf(n int, value byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = value
	}
	return out
}

func TestEncryptedSessionRedirectsNeverForward(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		for _, sameOrigin := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/%t", status, sameOrigin), func(t *testing.T) {
				var destinationCalls, originCalls atomic.Int32
				destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1); w.WriteHeader(204) }))
				defer destination.Close()
				origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/stolen" {
						destinationCalls.Add(1)
						w.WriteHeader(204)
						return
					}
					originCalls.Add(1)
					if r.Header.Get("Authorization") != "Bearer "+esToken {
						t.Error("origin did not receive authorized request")
					}
					location := destination.URL + "/stolen"
					if sameOrigin {
						location = "/stolen"
					}
					w.Header().Set("Location", location)
					w.WriteHeader(status)
				}))
				defer origin.Close()
				c, err := NewEncryptedSessionClient(origin.URL, esToken)
				if err != nil {
					t.Fatal(err)
				}
				err = c.DeleteItem(context.Background(), esBox, esItem, 1, 1)
				esAPI(t, err, status, "")
				if originCalls.Load() != 1 || destinationCalls.Load() != 0 {
					t.Fatal("redirect followed or positive origin not called")
				}
			})
		}
	}
}

func TestEncryptedSessionDeleteFramingAndStatus(t *testing.T) {
	for _, wire := range []string{
		"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
		"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
	} {
		f := esServer(t, esReply{wire: wire})
		if err := f.client(t, "").DeleteItem(context.Background(), esBox, esItem, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	for _, wire := range []string{
		"HTTP/1.1 204 No Content\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
		"HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nx\r\n0\r\n\r\n",
	} {
		f := esServer(t, esReply{wire: wire})
		esReject(t, f.client(t, "").DeleteItem(context.Background(), esBox, esItem, 1, 1))
	}
	for _, status := range []int{200, 201, 202, 205, 206, 299} {
		f := esServer(t, esReply{status: status, body: `{}`})
		esAPI(t, f.client(t, "").DeleteItem(context.Background(), esBox, esItem, 1, 1), status, "")
	}
	for _, status := range []int{201, 202, 204, 206, 299} {
		f := esServer(t, esReply{status: status, body: `{}`})
		_, err := f.client(t, "").State(context.Background(), esBox)
		esAPI(t, err, status, "")
	}
}

func TestEncryptedSessionBoundsAndTrailingJSON(t *testing.T) {
	validState := `{"mode":"compatibility","keyEpoch":null}`
	oversizedState := validState + strings.Repeat(" ", encryptedMaxResponse+1-len(validState))
	for _, declared := range []bool{true, false} {
		header := "HTTP/1.1 200 OK\r\nConnection: close\r\n"
		if declared {
			header += fmt.Sprintf("Content-Length: %d\r\n", len(oversizedState))
		}
		f := esServer(t, esReply{wire: header + "\r\n" + oversizedState})
		_, err := f.client(t, "").State(context.Background(), esBox)
		e, ok := err.(*EncryptedSessionError)
		if !ok || e.kind != "response too large" {
			t.Fatal("valid oversized JSON must fail at the size boundary")
		}
	}
	for _, reply := range []esReply{
		{wire: fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\nx", encryptedMaxResponse+1)},
		{wire: "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + strings.Repeat("x", encryptedMaxResponse+1)},
		{status: 200, body: `{"mode":"compatibility","keyEpoch":null} {}`},
	} {
		f := esServer(t, reply)
		_, err := f.client(t, "").State(context.Background(), esBox)
		esReject(t, err)
	}
	for _, reply := range []esReply{
		{wire: fmt.Sprintf("HTTP/1.1 503 Error\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", encryptedMaxError+1)},
		{wire: "HTTP/1.1 503 Error\r\nConnection: close\r\n\r\n" + `{"error":"PS015","message":"` + strings.Repeat("x", encryptedMaxError) + `"}`},
		{status: 503, body: `{"error":"PS015"} {}`},
	} {
		f := esServer(t, reply)
		_, err := f.client(t, "").State(context.Background(), esBox)
		esAPI(t, err, 503, "")
	}
}

type esCountReader struct {
	reader io.Reader
	read   int
}

func (r *esCountReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += n
	return n, err
}

func TestEncryptedSessionReadStopsAtSizeBoundary(t *testing.T) {
	for _, limit := range []int{encryptedMaxResponse, encryptedMaxError} {
		for _, declared := range []bool{true, false} {
			valid := `{"error":"PS015"}`
			body := valid + strings.Repeat(" ", limit+100-len(valid))
			reader := &esCountReader{reader: strings.NewReader(body)}
			length := int64(-1)
			wantRead := limit + 1
			if declared {
				length = int64(len(body))
				wantRead = 0
			}
			response := &http.Response{ContentLength: length, Body: io.NopCloser(reader)}
			_, err := encryptedRead(response, limit)
			e, ok := err.(*EncryptedSessionError)
			if !ok || e.kind != "response too large" || reader.read != wantRead {
				t.Fatal("response reader must reject declared size before reading and bound unknown size to limit+1")
			}
		}
	}
}

func TestEncryptedSessionErrorsRedactedAndConflictsNeverRetried(t *testing.T) {
	for _, code := range []string{"PS015", "PS056", "PS024", "PS032", "PS044", "PS028", "PS999", "PS01", "PS0000", "ps015", "PS０１５", esRemote} {
		body := map[string]any{"error": code, "message": esRemote, "token": esToken, "password": esPassword}
		f := esServer(t, esReply{status: 409, body: esJSON(body)}, esReply{status: 204})
		err := f.client(t, "").DeleteItem(context.Background(), esBox, esItem, 1, 1)
		want := ""
		if len(code) == 5 && strings.HasPrefix(code, "PS") && code[2] >= '0' && code[2] <= '9' && code[3] >= '0' && code[3] <= '9' && code[4] >= '0' && code[4] <= '9' {
			want = code
		}
		esAPI(t, err, 409, want)
		shown := fmt.Sprintf("%v %+v %#v", err, err, err)
		for _, secret := range []string{esRemote, esToken, esPassword} {
			if strings.Contains(shown, secret) {
				t.Fatal("error exposed a secret")
			}
		}
		if len(f.requests()) != 1 {
			t.Fatal("conflict retried; queued second response must remain unused")
		}
	}
	f := esServer(t, esReply{status: 409, body: `{"error":"PS015"}`}, esOK(esEnvelope(1)))
	_, err := f.client(t, "").PutItem(context.Background(), esBox, esItem, 0, esEnvelope(1))
	esAPI(t, err, 409, "PS015")
	if len(f.requests()) != 1 {
		t.Fatal("PUT conflict retried")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := f.client(t, "/"+esRemote)
	_, err = c.State(ctx, esBox)
	esReject(t, err)
	if strings.Contains(fmt.Sprintf("%v %#v", err, err), esRemote) {
		t.Fatal("transport error exposed path")
	}
	if len(f.requests()) != 1 {
		t.Fatal("canceled context reached HTTP")
	}
}

func TestEncryptedSessionBundleArgumentsAndUpperBoundaries(t *testing.T) {
	b := esBundle()
	e := esEnvelope(encryptedMaxInteger)
	e.Context.KeyEpoch = encryptedMaxInteger
	recordBundle := b
	recordBundle.Wrapped.Context.KeyEpoch = encryptedMaxInteger
	f := esServer(t, esOK(e), esOK(OwnerKeyRecord{encryptedMaxInteger, recordBundle}))
	c := f.client(t, "")
	ctx := context.Background()
	changes := []func(*OwnerKeyBundle){
		func(b *OwnerKeyBundle) { b.Format = 2 },
		func(b *OwnerKeyBundle) { b.Wrapped.Format = 0 },
		func(b *OwnerKeyBundle) { b.Salt = esB64(17) },
		func(b *OwnerKeyBundle) { b.Wrapped.Nonce = esB64(25) },
		func(b *OwnerKeyBundle) { b.Wrapped.Ciphertext = esB64(49) },
		func(b *OwnerKeyBundle) { b.Wrapped.Context.PasswordBoxID = "bad" },
		func(b *OwnerKeyBundle) { b.Wrapped.Context.OwnerAccountID = strings.ToUpper(esOwner) },
		func(b *OwnerKeyBundle) { b.Wrapped.Context.KeyEpoch = 0 },
	}
	for _, change := range changes {
		other := b
		change(&other)
		esReject(t, other.Validate())
		_, err := c.SetupEmptyBox(ctx, esBox, other)
		esReject(t, err)
		_, err = c.PutOwnerKey(ctx, esBox, 0, other, nil)
		esReject(t, err)
	}
	owner := b.Wrapped.Context
	owner.PasswordBoxID = strings.Repeat("c", 26)
	_, err := c.GetOwnerKey(ctx, esBox, owner)
	esReject(t, err)
	if len(f.requests()) != 0 {
		t.Fatal("invalid bundle/context reached HTTP")
	}
	if err := b.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.PutItem(ctx, esBox, esItem, encryptedMaxInteger-1, e); err != nil {
		t.Fatal(err)
	}
	password := esPassword
	if _, err := c.PutOwnerKey(ctx, esBox, encryptedMaxInteger-1, recordBundle, &password); err != nil {
		t.Fatal(err)
	}
	if len(f.requests()) != 2 {
		t.Fatal("valid boundary controls did not reach HTTP")
	}
}

type esRoundTrip func(*http.Request) (*http.Response, error)

func (f esRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestEncryptedSessionRejectsBodyExposedByTransportOn204(t *testing.T) {
	f := esServer(t, esReply{status: 204})
	c := f.client(t, "")
	transport := c.http.Transport
	// net/http hides a wire 204 body. Explicitly exercise the exposed-body guard
	// while retaining a real positive HTTP request/response through httptest.
	c.http.Transport = esRoundTrip(func(r *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(r)
		if err == nil {
			response.Body.Close()
			response.Body = io.NopCloser(strings.NewReader(esRemote))
		}
		return response, err
	})
	esReject(t, c.DeleteItem(context.Background(), esBox, esItem, 1, 1))
	if len(f.requests()) != 1 {
		t.Fatal("body validation did not reach real HTTP")
	}
}

func TestEncryptedSessionHTTPStatusAndCodeOnly(t *testing.T) {
	for _, status := range []int{401, 403, 404, 409, 429, 503} {
		f := esServer(t, esReply{status: status, body: esJSON(map[string]any{
			"error": "PS024", "message": esRemote, "password": esPassword, "token": esToken,
		})})
		_, err := f.client(t, "").State(context.Background(), esBox)
		esAPI(t, err, status, "PS024")
		for _, secret := range []string{esRemote, esPassword, esToken} {
			if strings.Contains(fmt.Sprintf("%v %#v", err, err), secret) {
				t.Fatal("API error exposed remote data")
			}
		}
	}
}

func TestEncryptedSessionExactEchoAndNoSetupOwnerRetry(t *testing.T) {
	ctx := context.Background()
	e := esEnvelope(1)
	changed := e
	changed.Ciphertext = base64.StdEncoding.EncodeToString(bytesOf(16, 1))
	f := esServer(t, esOK(changed))
	_, err := f.client(t, "").PutItem(ctx, esBox, esItem, 0, e)
	esReject(t, err)
	b := esBundle()
	for _, operation := range []string{"setup", "owner"} {
		f := esServer(t, esReply{status: 409, body: `{"error":"PS015"}`}, esOK(OwnerKeyRecord{1, b}))
		c := f.client(t, "")
		if operation == "setup" {
			_, err = c.SetupEmptyBox(ctx, esBox, b)
		} else {
			_, err = c.PutOwnerKey(ctx, esBox, 0, b, nil)
		}
		esAPI(t, err, 409, "PS015")
		if len(f.requests()) != 1 {
			t.Fatal("conflict retried; second reply must remain unused")
		}
	}
}
