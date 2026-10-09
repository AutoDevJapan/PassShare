package connect

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const (
	encryptedMaxInteger    uint64 = 9007199254740991
	encryptedMaxCiphertext        = 1048592
	encryptedMaxResponse          = 1536 * 1024
	encryptedMaxError             = 64 * 1024
)

// EncryptedSessionError retains only local categories, HTTP status and PSnnn.
// No underlying URL, network, JSON or remote message is retained.
type EncryptedSessionError struct {
	kind   string
	status int
	code   string
}

func (e *EncryptedSessionError) Error() string {
	if e.status != 0 {
		return fmt.Sprintf("encrypted API error (HTTP %d, code %s)", e.status, e.code)
	}
	return "encrypted session: " + e.kind
}
func (e *EncryptedSessionError) String() string   { return e.Error() }
func (e *EncryptedSessionError) GoString() string { return e.Error() }
func (e *EncryptedSessionError) HTTPStatus() int  { return e.status }
func (e *EncryptedSessionError) Code() string     { return e.code }
func encryptedError(kind string) error            { return &EncryptedSessionError{kind: kind} }

// All DTOs contain only opaque ciphertext and public metadata. Rust Core/WASM
// owns encryption, full item JSON serialization and authenticated decryption.
type ItemContext struct {
	PasswordBoxID string `json:"passwordBoxId"`
	ItemID        string `json:"itemId"`
	ItemVersion   uint64 `json:"itemVersion"`
	KeyEpoch      uint64 `json:"keyEpoch"`
}

type EncryptedItem struct {
	Format     uint32      `json:"format"`
	Context    ItemContext `json:"context"`
	Nonce      string      `json:"nonce"`
	Ciphertext string      `json:"ciphertext"`
}

type OwnerKeyContext struct {
	PasswordBoxID  string `json:"passwordBoxId"`
	OwnerAccountID string `json:"ownerAccountId"`
	KeyEpoch       uint64 `json:"keyEpoch"`
}

type WrappedPasswordBoxKey struct {
	Format     uint32          `json:"format"`
	Context    OwnerKeyContext `json:"context"`
	Nonce      string          `json:"nonce"`
	Ciphertext string          `json:"ciphertext"`
}

// OwnerKeyBundle uses Core's fixed format-1 KDF; KDF parameters and passwords
// are deliberately absent. Reauthentication is a separate method argument.
type OwnerKeyBundle struct {
	Format  uint32                `json:"format"`
	Salt    string                `json:"salt"`
	Wrapped WrappedPasswordBoxKey `json:"wrapped"`
}

type OwnerKeyRecord struct {
	BundleVersion uint64         `json:"bundleVersion"`
	Bundle        OwnerKeyBundle `json:"bundle"`
}

type BoxState struct {
	Mode     string  `json:"mode"`
	KeyEpoch *uint64 `json:"keyEpoch"`
}

type ItemSummary struct {
	ItemID      string `json:"itemId"`
	ItemVersion uint64 `json:"itemVersion"`
	KeyEpoch    uint64 `json:"keyEpoch"`
}

type ItemPage struct {
	Items      []ItemSummary `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

type SetupResult struct {
	Mode          string         `json:"mode"`
	KeyEpoch      uint64         `json:"keyEpoch"`
	BundleVersion uint64         `json:"bundleVersion"`
	Bundle        OwnerKeyBundle `json:"bundle"`
}

// EncryptedSessionClient is separate from the legacy Connect-token Client.
// Its client, URL and session bearer cannot be exported or reconfigured.
type EncryptedSessionClient struct {
	base url.URL
	auth string
	http *http.Client
}

func (c EncryptedSessionClient) String() string   { return "EncryptedSessionClient{<redacted>}" }
func (c EncryptedSessionClient) GoString() string { return c.String() }

// NewEncryptedSessionClient appends /api/encrypted to an optional proxy prefix.
// HTTP is allowed only for literal localhost, 127.0.0.1 and [::1], as in Rust.
func NewEncryptedSessionClient(host, sessionBearer string) (*EncryptedSessionClient, error) {
	bad := func() (*EncryptedSessionClient, error) { return nil, encryptedError("invalid base URL") }
	for i := 0; i < len(host); i++ {
		if host[i] <= 32 || host[i] == 127 || host[i] == '\\' {
			return bad()
		}
	}
	u, err := url.Parse(host)
	if err != nil || u == nil || u.Opaque != "" || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.ContainsAny(host, "?#") {
		return bad()
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return bad()
	}
	// Inspect the escaped path before joining: url.Parse does not reject dots.
	for _, part := range strings.Split(u.EscapedPath(), "/") {
		decoded, err := url.PathUnescape(part)
		if err != nil || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "/\\%") {
			return bad()
		}
		for i := 0; i < len(decoded); i++ {
			if decoded[i] <= 32 || decoded[i] == 127 {
				return bad()
			}
		}
	}
	if sessionBearer == "" {
		return nil, encryptedError("invalid session bearer")
	}
	for i := 0; i < len(sessionBearer); i++ {
		if sessionBearer[i] <= 32 || sessionBearer[i] >= 127 {
			return nil, encryptedError("invalid session bearer")
		}
	}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: -1}).DialContext,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  30 * time.Second,
		MaxResponseHeaderBytes: 64 * 1024,
		DisableCompression:     true,
		DisableKeepAlives:      true,
	}
	return &EncryptedSessionClient{base: *u, auth: "Bearer " + sessionBearer, http: &http.Client{
		Transport: transport, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func encryptedID(id string) bool {
	if len(id) != 26 {
		return false
	}
	for i := range id {
		if !(id[i] >= 'a' && id[i] <= 'z' || id[i] >= '0' && id[i] <= '9') {
			return false
		}
	}
	return true
}
func encryptedPositive(n uint64) bool { return n > 0 && n <= encryptedMaxInteger }
func encryptedUUID(id string) bool {
	if len(id) != 36 || id == "00000000-0000-0000-0000-000000000000" {
		return false
	}
	for i := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if id[i] != '-' {
				return false
			}
			continue
		}
		if !(id[i] >= '0' && id[i] <= '9' || id[i] >= 'a' && id[i] <= 'f') {
			return false
		}
	}
	return true
}

// Check encoded size BEFORE allocating decoded bytes. Strict rejects nonzero
// padding bits; reencoding rejects newline-containing and unpadded spellings.
func encryptedBase64(s string, min, max int) bool {
	if len(s) > base64.StdEncoding.EncodedLen(max) || len(s) < base64.StdEncoding.EncodedLen(min) {
		return false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	return err == nil && len(b) >= min && len(b) <= max && base64.StdEncoding.EncodeToString(b) == s
}
func (e EncryptedItem) valid(box, item string) bool {
	return e.Format == 1 && encryptedID(box) && encryptedID(item) &&
		e.Context.PasswordBoxID == box && e.Context.ItemID == item &&
		encryptedPositive(e.Context.ItemVersion) && encryptedPositive(e.Context.KeyEpoch) &&
		encryptedBase64(e.Nonce, 24, 24) && encryptedBase64(e.Ciphertext, 16, encryptedMaxCiphertext)
}
func (c OwnerKeyContext) valid(box string) bool {
	return encryptedID(box) && c.PasswordBoxID == box && encryptedUUID(c.OwnerAccountID) && encryptedPositive(c.KeyEpoch)
}
func (b OwnerKeyBundle) valid(box string) bool {
	return b.Format == 1 && b.Wrapped.Format == 1 && b.Wrapped.Context.valid(box) &&
		encryptedBase64(b.Salt, 16, 16) && encryptedBase64(b.Wrapped.Nonce, 24, 24) &&
		encryptedBase64(b.Wrapped.Ciphertext, 48, 48)
}

// Validate checks structure only, never AEAD or password correctness.
func (b OwnerKeyBundle) Validate() error {
	if !b.valid(b.Wrapped.Context.PasswordBoxID) {
		return encryptedError("invalid owner bundle")
	}
	return nil
}

// ValidateContext binds all public headers to caller-owned expectations.
// Core must still authenticate/decrypt using this SAME independently held context.
func (e EncryptedItem) ValidateContext(expected ItemContext) error {
	if !e.valid(expected.PasswordBoxID, expected.ItemID) || !encryptedPositive(expected.ItemVersion) || !encryptedPositive(expected.KeyEpoch) || e.Context != expected {
		return encryptedError("item context mismatch")
	}
	return nil
}

func (c *EncryptedSessionClient) State(ctx context.Context, boxID string) (BoxState, error) {
	var out BoxState
	if !encryptedID(boxID) {
		return out, encryptedError("invalid argument")
	}
	err := c.exchange(ctx, "GET", "/boxes/"+boxID, nil, 200, &out)
	if err == nil && !(out.Mode == "compatibility" && out.KeyEpoch == nil || out.Mode == "encrypted" && out.KeyEpoch != nil && encryptedPositive(*out.KeyEpoch)) {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return BoxState{}, err
	}
	return out, nil
}

func (c *EncryptedSessionClient) EnableEmptyBox(ctx context.Context, boxID string) (uint64, error) {
	if !encryptedID(boxID) {
		return 0, encryptedError("invalid argument")
	}
	var out struct {
		Mode     string `json:"mode"`
		KeyEpoch uint64 `json:"keyEpoch"`
	}
	body := struct {
		KeyEpoch uint64 `json:"keyEpoch"`
	}{1}
	err := c.exchange(ctx, "POST", "/boxes/"+boxID+"/enable", body, 200, &out)
	if err == nil && (out.Mode != "encrypted" || out.KeyEpoch != 1) {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return 0, err
	}
	return out.KeyEpoch, nil
}

// SetupEmptyBox atomically activates an empty box and stores its initial bundle.
func (c *EncryptedSessionClient) SetupEmptyBox(ctx context.Context, boxID string, bundle OwnerKeyBundle) (SetupResult, error) {
	var out SetupResult
	if !bundle.valid(boxID) || bundle.Wrapped.Context.KeyEpoch != 1 {
		return out, encryptedError("invalid argument")
	}
	body := struct {
		Bundle OwnerKeyBundle `json:"bundle"`
	}{bundle}
	err := c.exchange(ctx, "POST", "/boxes/"+boxID+"/setup", body, 200, &out)
	if err == nil && (out.Mode != "encrypted" || out.KeyEpoch != 1 || out.BundleVersion != 1 || out.Bundle != bundle) {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return SetupResult{}, err
	}
	return out, nil
}

func (c *EncryptedSessionClient) List(ctx context.Context, boxID string, after *string) (ItemPage, error) {
	var out ItemPage
	if !encryptedID(boxID) || after != nil && !encryptedID(*after) {
		return out, encryptedError("invalid argument")
	}
	path := "/boxes/" + boxID + "/items"
	if after != nil {
		path += "?after=" + *after
	}
	if err := c.exchange(ctx, "GET", path, nil, 200, &out); err != nil {
		return ItemPage{}, err
	}
	previous := ""
	if after != nil {
		previous = *after
	}
	if len(out.Items) > 100 {
		return ItemPage{}, encryptedError("invalid response")
	}
	for _, item := range out.Items {
		if !encryptedID(item.ItemID) || item.ItemID <= previous || !encryptedPositive(item.ItemVersion) || !encryptedPositive(item.KeyEpoch) {
			return ItemPage{}, encryptedError("invalid response")
		}
		previous = item.ItemID
	}
	if out.NextCursor != nil {
		if len(out.Items) != 100 || *out.NextCursor != previous {
			return ItemPage{}, encryptedError("invalid response")
		}
	} else if len(out.Items) == 100 {
		return ItemPage{}, encryptedError("invalid response")
	}
	return out, nil
}

// GetItem binds box/item and checks public structure. It cannot infer a trusted
// version/epoch: call ValidateContext and Core with independently held headers.
func (c *EncryptedSessionClient) GetItem(ctx context.Context, boxID, itemID string) (EncryptedItem, error) {
	var out EncryptedItem
	if !encryptedID(boxID) || !encryptedID(itemID) {
		return out, encryptedError("invalid argument")
	}
	err := c.exchange(ctx, "GET", "/boxes/"+boxID+"/items/"+itemID, nil, 200, &out)
	if err == nil && !out.valid(boxID, itemID) {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return EncryptedItem{}, err
	}
	return out, nil
}

func (c *EncryptedSessionClient) PutItem(ctx context.Context, boxID, itemID string, expectedVersion uint64, envelope EncryptedItem) (EncryptedItem, error) {
	var out EncryptedItem
	if expectedVersion >= encryptedMaxInteger || !envelope.valid(boxID, itemID) || envelope.Context.ItemVersion != expectedVersion+1 {
		return out, encryptedError("invalid argument")
	}
	body := struct {
		ExpectedVersion uint64        `json:"expectedVersion"`
		Envelope        EncryptedItem `json:"envelope"`
	}{expectedVersion, envelope}
	err := c.exchange(ctx, "PUT", "/boxes/"+boxID+"/items/"+itemID, body, 200, &out)
	if err == nil && out != envelope {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return EncryptedItem{}, err
	}
	return out, nil
}

func (c *EncryptedSessionClient) DeleteItem(ctx context.Context, boxID, itemID string, expectedVersion, keyEpoch uint64) error {
	if !encryptedID(boxID) || !encryptedID(itemID) || !encryptedPositive(expectedVersion) || !encryptedPositive(keyEpoch) {
		return encryptedError("invalid argument")
	}
	body := struct {
		ExpectedVersion uint64 `json:"expectedVersion"`
		KeyEpoch        uint64 `json:"keyEpoch"`
	}{expectedVersion, keyEpoch}
	return c.exchange(ctx, "DELETE", "/boxes/"+boxID+"/items/"+itemID, body, 204, nil)
}

func (c *EncryptedSessionClient) GetOwnerKey(ctx context.Context, boxID string, expectedOwnerCtx OwnerKeyContext) (OwnerKeyRecord, error) {
	var out OwnerKeyRecord
	if !expectedOwnerCtx.valid(boxID) {
		return out, encryptedError("invalid argument")
	}
	err := c.exchange(ctx, "GET", "/boxes/"+boxID+"/owner-key", nil, 200, &out)
	if err == nil && (!encryptedPositive(out.BundleVersion) || !out.Bundle.valid(boxID)) {
		err = encryptedError("invalid response")
	}
	if err == nil && out.Bundle.Wrapped.Context != expectedOwnerCtx {
		err = encryptedError("owner context mismatch")
	}
	if err != nil {
		return OwnerKeyRecord{}, err
	}
	return out, nil
}

// currentLoginPassword is nil for create; replacement requires a nonempty
// login password. This is not the encryption password and is never retained.
func (c *EncryptedSessionClient) PutOwnerKey(ctx context.Context, boxID string, expectedVersion uint64, bundle OwnerKeyBundle, currentLoginPassword *string) (OwnerKeyRecord, error) {
	var out OwnerKeyRecord
	if expectedVersion >= encryptedMaxInteger || !bundle.valid(boxID) || expectedVersion == 0 && currentLoginPassword != nil || expectedVersion > 0 && (currentLoginPassword == nil || *currentLoginPassword == "") {
		return out, encryptedError("invalid argument")
	}
	body := struct {
		ExpectedVersion uint64         `json:"expectedVersion"`
		Bundle          OwnerKeyBundle `json:"bundle"`
		CurrentPassword *string        `json:"currentPassword,omitempty"`
	}{expectedVersion, bundle, currentLoginPassword}
	err := c.exchange(ctx, "PUT", "/boxes/"+boxID+"/owner-key", body, 200, &out)
	if err == nil && (out.BundleVersion != expectedVersion+1 || out.Bundle != bundle) {
		err = encryptedError("invalid response")
	}
	if err != nil {
		return OwnerKeyRecord{}, err
	}
	return out, nil
}

func (c *EncryptedSessionClient) exchange(ctx context.Context, method, path string, body any, status int, out any) error {
	if ctx == nil || c == nil || c.http == nil {
		return encryptedError("invalid argument")
	}
	u := c.base
	p, query, _ := strings.Cut(path, "?")
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/encrypted" + p
	u.RawPath = ""
	u.RawQuery = query
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			return encryptedError("invalid argument")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(raw))
	if err != nil {
		return encryptedError("request failed")
	}
	req.GetBody = nil // No replayable request, including within net/http.
	req.Close = true
	req.Header.Set("Authorization", c.auth)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return encryptedError("transport failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != status {
		b, _ := encryptedRead(resp, encryptedMaxError)
		return &EncryptedSessionError{status: resp.StatusCode, code: encryptedCode(b)}
	}
	if status == 204 {
		if len(resp.TransferEncoding) != 0 || len(resp.Header.Values("Transfer-Encoding")) != 0 || resp.ContentLength > 0 {
			return encryptedError("invalid empty response")
		}
		for _, value := range resp.Header.Values("Content-Length") {
			if value != "0" {
				return encryptedError("invalid empty response")
			}
		}
		_, err := encryptedRead(resp, 0)
		if err != nil {
			return encryptedError("invalid empty response")
		}
		return nil
	}
	b, err := encryptedRead(resp, encryptedMaxResponse)
	if err != nil {
		return err
	}
	return encryptedDecode(b, out)
}

func encryptedRead(resp *http.Response, max int) ([]byte, error) {
	if resp.ContentLength > int64(max) {
		return nil, encryptedError("response too large")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)+1))
	if err != nil {
		return nil, encryptedError("response read failed")
	}
	if len(b) > max {
		return nil, encryptedError("response too large")
	}
	return b, nil
}

func encryptedCode(b []byte) string {
	var object map[string]json.RawMessage
	if json.Unmarshal(b, &object) != nil {
		return ""
	}
	var code string
	if json.Unmarshal(object["error"], &code) != nil || len(code) != 5 || code[:2] != "PS" {
		return ""
	}
	for i := 2; i < 5; i++ {
		if code[i] < '0' || code[i] > '9' {
			return ""
		}
	}
	return code
}

// Validate exact JSON shape before decoding into zero-valued Go structs. Every
// field is required (including nullable fields); unknown, duplicate, case-folded
// names, null scalars, decimal/exponent integers and trailing JSON are rejected.
// The schema bounds recursion and arrays; body limits apply before tokenization.
func encryptedDecode(b []byte, out any) error {
	if len(b) > encryptedMaxResponse {
		return encryptedError("response too large")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	t := reflect.TypeOf(out)
	if t == nil || t.Kind() != reflect.Pointer {
		return encryptedError("invalid response")
	}
	if !encryptedShape(d, t.Elem()) {
		return encryptedError("invalid response")
	}
	if _, err := d.Token(); err != io.EOF {
		return encryptedError("invalid response")
	}
	if json.Unmarshal(b, out) != nil {
		return encryptedError("invalid response")
	}
	return nil
}

func encryptedShape(d *json.Decoder, t reflect.Type) bool {
	token, err := d.Token()
	if err != nil {
		return false
	}
	if t.Kind() == reflect.Pointer {
		if token == nil {
			return true
		}
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Struct:
		if token != json.Delim('{') {
			return false
		}
		seen := make([]bool, t.NumField())
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return false
			}
			name, ok := key.(string)
			if !ok {
				return false
			}
			index := -1
			for i := 0; i < t.NumField(); i++ {
				if strings.Split(t.Field(i).Tag.Get("json"), ",")[0] == name {
					index = i
					break
				}
			}
			if index < 0 || seen[index] || !encryptedShape(d, t.Field(index).Type) {
				return false
			}
			seen[index] = true
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return false
		}
		for _, present := range seen {
			if !present {
				return false
			}
		}
		return true
	case reflect.Slice:
		if token != json.Delim('[') {
			return false
		}
		count := 0
		for d.More() {
			count++
			if count > 100 || !encryptedShape(d, t.Elem()) {
				return false
			}
		}
		end, err := d.Token()
		return err == nil && end == json.Delim(']')
	case reflect.String:
		_, ok := token.(string)
		return ok
	case reflect.Uint32, reflect.Uint64:
		n, ok := token.(json.Number)
		if !ok {
			return false
		}
		value, err := strconv.ParseUint(string(n), 10, t.Bits())
		return err == nil && value <= encryptedMaxInteger
	}
	return false
}
