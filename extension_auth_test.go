package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func extensionCall(a *app, method, path string, body []byte, token, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.Header.Set("X-Sync-Client", "extension")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}
func TestExtensionLoginAndSession(t *testing.T) {
	a := testApp(t)
	origin := "chrome-extension://" + strings.Repeat("a", 32)
	w := extensionCall(a, "POST", "/api/auth/extension/login", loginBody("admin", testAdminPassword), "", origin)
	status(t, w, 200)
	var login struct {
		Token string `json:"token"`
		User  user   `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil {
		t.Fatal(err)
	}
	if len(login.Token) < 32 || login.User.Name != "admin" || len(w.Result().Cookies()) != 0 {
		t.Fatal("invalid extension login")
	}
	status(t, extensionCall(a, "GET", "/api/auth/me", nil, login.Token, origin), 200)
	text := "  Unicode 🦊\t\r\nhttps://example.com/"
	w = extensionCall(a, "POST", "/api/notes", jsonBody(map[string]string{"text": text, "sha256": digest([]byte(text))}), login.Token, origin)
	status(t, w, 201)
	var v item
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	if v.Public || v.OwnerID != login.User.ID {
		t.Fatal("extension uploads must retain private ownership")
	}
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	a = restored
	w = extensionCall(a, "GET", "/api/items/"+v.ID+"/download", nil, login.Token, origin)
	status(t, w, 200)
	if w.Body.String() != text {
		t.Fatal("text changed")
	}
	status(t, extensionCall(a, "POST", "/api/auth/logout", nil, login.Token, origin), 204)
	status(t, extensionCall(a, "GET", "/api/auth/me", nil, login.Token, origin), 401)
	status(t, call(a, "GET", "/api/auth/me", nil, nil), 200)
}
func TestExtensionOriginDoesNotWeakenBrowserProtection(t *testing.T) {
	a := testApp(t)
	body := loginBody("admin", testAdminPassword)
	for _, origin := range []string{"https://evil.example", "chrome-extension://short", "chrome-extension://" + strings.Repeat("z", 32), "chrome-extension://" + strings.Repeat("a", 32) + "/path"} {
		status(t, extensionCall(a, "POST", "/api/auth/extension/login", body, "", origin), 403)
	}
	origin := "chrome-extension://" + strings.Repeat("a", 32)
	r := httptest.NewRequest("POST", "/api/auth/extension/login", bytes.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Sync-Client", "extension")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: testAdminSession})
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	status(t, w, 403)
	status(t, extensionCall(a, "POST", "/api/notes", jsonBody(map[string]string{"text": "x", "sha256": digest([]byte("x"))}), "", origin), 403)
	status(t, extensionCall(a, "POST", "/api/notes", jsonBody(map[string]string{"text": "x", "sha256": digest([]byte("x"))}), "invalid", origin), 401)
}
