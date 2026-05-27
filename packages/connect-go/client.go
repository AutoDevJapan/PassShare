package connect

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func FromEnv() (*Client, error) {
	host := os.Getenv("OP_CONNECT_HOST")
	token := os.Getenv("OP_CONNECT_TOKEN")
	if host == "" {
		return nil, fmt.Errorf("missing OP_CONNECT_HOST")
	}
	if token == "" {
		return nil, fmt.Errorf("missing OP_CONNECT_TOKEN")
	}
	return New(host, token), nil
}

func New(host, token string) *Client {
	base := strings.TrimRight(host, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return &Client{BaseURL: base, Token: token, HTTP: http.DefaultClient}
}

func (c *Client) ListVaults() ([]map[string]any, error) {
	var out []map[string]any
	err := c.request("GET", "/vaults", nil, "", &out)
	return out, err
}

func (c *Client) GetVault(vaultID string) (map[string]any, error) {
	var out map[string]any
	err := c.request("GET", "/vaults/"+vaultID, nil, "", &out)
	return out, err
}

func (c *Client) ListItems(vaultID string) ([]map[string]any, error) {
	var out []map[string]any
	err := c.request("GET", "/vaults/"+vaultID+"/items", nil, "", &out)
	return out, err
}

func (c *Client) GetItem(vaultID, itemID string) (map[string]any, error) {
	var out map[string]any
	err := c.request("GET", "/vaults/"+vaultID+"/items/"+itemID, nil, "", &out)
	return out, err
}

func (c *Client) DeleteItem(vaultID, itemID string) error {
	return c.request("DELETE", "/vaults/"+vaultID+"/items/"+itemID, nil, "", nil)
}

func (c *Client) request(method, path string, body any, contentType string, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
		if contentType == "" {
			contentType = "application/json"
		}
	}
	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("connect api %d: %s", resp.StatusCode, string(payload))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(payload, out)
}
