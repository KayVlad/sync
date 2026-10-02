package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func rawCall(a *app, method, path string, body []byte, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}
func loginBody(name, password string) []byte {
	return jsonBody(map[string]string{"username": name, "password": password})
}
func loginTest(t *testing.T, a *app, name, password string) *http.Cookie {
	t.Helper()
	w := rawCall(a, "POST", "/api/auth/login", loginBody(name, password), nil)
	status(t, w, 200)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing cookie")
	}
	return cookies[0]
}
func createTestUser(t *testing.T, a *app, name, role, password string) user {
	t.Helper()
	w := call(a, "POST", "/api/admin/users", jsonBody(map[string]string{"name": name, "role": role, "password": password}), nil)
	status(t, w, 201)
	var u user
	_ = json.Unmarshal(w.Body.Bytes(), &u)
	if u.PasswordHash != "" || u.TokenHash != "" || !u.PasswordSet {
		t.Fatal("invalid public user")
	}
	return u
}

func TestPasswordHashAndExactPassword(t *testing.T) {
	p := "  spaces-Привіт-🦊  "
	a, err := hashPassword(p)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := hashPassword(p)
	if a == b {
		t.Fatal("salts were reused")
	}
	if !checkPassword(a, p) || checkPassword(a, strings.TrimSpace(p)) || checkPassword(a, "wrong") {
		t.Fatal("incorrect password verification")
	}
	if checkPassword("malformed", p) {
		t.Fatal("accepted malformed hash")
	}
}
func TestPasswordLoginSessionAndRestart(t *testing.T) {
	a := testApp(t)
	status(t, rawCall(a, "GET", "/", nil, nil), 200)
	for _, path := range []string{"/api/auth/me", "/api/config", "/api/admin/users", "/api/auth/me"} {
		status(t, rawCall(a, "GET", path, nil, nil), 401)
	}
	wrong := rawCall(a, "POST", "/api/auth/login", loginBody("admin", "bad"), nil)
	status(t, wrong, 401)
	missing := rawCall(a, "POST", "/api/auth/login", loginBody("unknown", "bad"), nil)
	status(t, missing, 401)
	if wrong.Body.String() != missing.Body.String() {
		t.Fatal("username disclosure")
	}
	cookie := loginTest(t, a, "ADMIN", testAdminPassword)
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Secure {
		t.Fatal("invalid cookie")
	}
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 200)
	b, _ := os.ReadFile(a.authPath())
	if bytes.Contains(b, []byte(testAdminPassword)) || bytes.Contains(b, []byte(cookie.Value)) {
		t.Fatal("plaintext secret stored")
	}
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	status(t, rawCall(restored, "GET", "/api/auth/me", nil, cookie), 200)
	status(t, rawCall(restored, "POST", "/api/auth/logout", nil, cookie), 204)
	status(t, rawCall(restored, "GET", "/api/auth/me", nil, cookie), 401)
}
func TestUserCRUDPasswordResetAndRevocation(t *testing.T) {
	a := testApp(t)
	password := "p"
	u := createTestUser(t, a, "phone", "user", password)
	cookie := loginTest(t, a, "phone", password)
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 200)
	status(t, rawCall(a, "GET", "/api/admin/users", nil, cookie), 403)
	for _, method := range []string{"PATCH", "DELETE"} {
		status(t, rawCall(a, method, "/api/admin/users/"+u.ID, jsonBody(map[string]string{"name": "elevated", "role": "admin"}), cookie), 403)
	}
	status(t, rawCall(a, "POST", "/api/admin/users/"+u.ID+"/password", jsonBody(map[string]string{"password": "another-password"}), cookie), 403)
	status(t, call(a, "PATCH", "/api/admin/users/"+u.ID, jsonBody(map[string]string{"name": "tablet", "role": "admin"}), nil), 200)
	status(t, rawCall(a, "GET", "/api/admin/users", nil, cookie), 200)
	status(t, call(a, "PATCH", "/api/admin/users/"+u.ID, jsonBody(map[string]string{"name": "tablet", "role": "user"}), nil), 200)
	status(t, rawCall(a, "GET", "/api/admin/users", nil, cookie), 403)
	next := "q"
	w := call(a, "POST", "/api/admin/users/"+u.ID+"/password", jsonBody(map[string]string{"password": next}), nil)
	status(t, w, 200)
	if strings.Contains(w.Body.String(), next) || strings.Contains(w.Body.String(), "passwordHash") {
		t.Fatal("password response leaked secret")
	}
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 401)
	status(t, rawCall(a, "POST", "/api/auth/login", loginBody("tablet", password), nil), 401)
	cookie = loginTest(t, a, "tablet", next)
	status(t, call(a, "DELETE", "/api/admin/users/"+u.ID, nil, nil), 204)
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 401)
}
func TestLastAdminDuplicateNamesAndExpiredSessions(t *testing.T) {
	a := testApp(t)
	var admin user
	for _, u := range a.auth.data.Users {
		admin = u
	}
	status(t, call(a, "DELETE", "/api/admin/users/"+admin.ID, nil, nil), 409)
	status(t, call(a, "PATCH", "/api/admin/users/"+admin.ID, jsonBody(map[string]string{"name": "admin", "role": "user"}), nil), 409)
	status(t, call(a, "POST", "/api/admin/users", jsonBody(map[string]string{"name": "ADMIN", "role": "user", "password": "another-good-password"}), nil), 409)
	status(t, call(a, "POST", "/api/admin/users", jsonBody(map[string]string{"name": "bad", "role": "user", "password": ""}), nil), 400)
	cookie := loginTest(t, a, "admin", testAdminPassword)
	a.now = func() time.Time { return time.Now().Add(sessionLifetime + time.Second) }
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 401)
}
func TestBootstrapAndLoginRateLimit(t *testing.T) {
	a, err := newApp(config{Dir: t.TempDir(), MaxFile: 1024, MaxStorage: 4096})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.cfg.Dir, "admin-password")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	password := strings.TrimSuffix(string(b), "\n")
	cookie := loginTest(t, a, "admin", password)
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("bootstrap secret retained")
	}
	status(t, rawCall(a, "GET", "/api/auth/me", nil, cookie), 200)
	for i := 0; i < 11; i++ {
		status(t, rawCall(a, "POST", "/api/auth/login", loginBody("admin", "wrong"), nil), 401)
	}
	status(t, rawCall(a, "POST", "/api/auth/login", loginBody("admin", "wrong"), nil), 429)
	a.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	loginTest(t, a, "admin", password)
}
func TestHTTPSCookieAndCrossSiteLogin(t *testing.T) {
	a := testApp(t)
	w := call(a, "POST", "/api/auth/login", loginBody("admin", testAdminPassword), map[string]string{"Origin": "https://example.com"})
	status(t, w, 200)
	if !w.Result().Cookies()[0].Secure {
		t.Fatal("missing secure cookie")
	}
	status(t, call(a, "POST", "/api/auth/login", loginBody("admin", testAdminPassword), map[string]string{"Origin": "https://evil.test"}), 403)
}
func TestMigrateTokenAccountsWithoutLosingFiles(t *testing.T) {
	a := testApp(t)
	v := startUpload(t, a, "keep.bin", 0)
	status(t, finish(a, v.ID, nil), 200)
	d := cloneAuth(a.auth.data)
	d.Version = 0
	for id, u := range d.Users {
		u.PasswordHash = ""
		u.TokenHash = tokenHash("old-token")
		d.Users[id] = u
	}
	if err := a.saveAuth(d); err != nil {
		t.Fatal(err)
	}
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	status(t, rawCall(restored, "GET", "/api/auth/me", nil, &http.Cookie{Name: sessionCookie, Value: testAdminSession}), 401)
	cookie := loginTest(t, restored, "admin", testAdminPassword)
	status(t, rawCall(restored, "GET", "/api/items/"+v.ID+"/download", nil, cookie), 200)
	b, _ := os.ReadFile(restored.authPath())
	if strings.Contains(string(b), "tokenHash") {
		t.Fatal("legacy tokens retained")
	}
}
