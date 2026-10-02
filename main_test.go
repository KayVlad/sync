package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

const testAdminPassword = "test-admin-password-123"
const testAdminSession = "test-session-only-for-automated-tests"

func testApp(t *testing.T) *app {
	t.Helper()
	a, err := newApp(config{Dir: t.TempDir(), AdminPassword: testAdminPassword, MaxFile: 32 << 20, MaxStorage: 64 << 20})
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range a.auth.data.Users {
		a.auth.data.Sessions[tokenHash(testAdminSession)] = session{UserID: u.ID, Expires: time.Now().Add(sessionLifetime), Created: time.Now()}
		break
	}
	if err := a.saveAuth(a.auth.data); err != nil {
		t.Fatal(err)
	}
	return a
}
func call(a *app, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: testAdminSession})
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}
func jsonBody(v any) []byte { b, _ := json.Marshal(v); return b }
func status(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d, want %d: %s", w.Code, want, w.Body.String())
	}
}
func startUpload(t *testing.T, a *app, name string, size int) item {
	t.Helper()
	w := call(a, "POST", "/api/uploads", jsonBody(map[string]any{"name": name, "size": size, "type": "application/octet-stream"}), nil)
	status(t, w, 201)
	var v item
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func sendChunk(a *app, id string, index int, b []byte) *httptest.ResponseRecorder {
	return call(a, "PUT", "/api/uploads/"+id+"/"+strconv.Itoa(index), b, map[string]string{"X-Chunk-SHA256": digest(b)})
}
func finish(a *app, id string, b []byte) *httptest.ResponseRecorder {
	return call(a, "POST", "/api/uploads/"+id+"/complete", jsonBody(map[string]string{"sha256": digest(b)}), nil)
}

func TestParallelTransferRestartAndRange(t *testing.T) {
	a := testApp(t)
	b := make([]byte, 3*chunkSize+127)
	for i := range b {
		b[i] = byte(i * 37)
	}
	v := startUpload(t, a, "文件 🦊.bin", len(b))
	var wg sync.WaitGroup
	for i := 3; i >= 0; i-- {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			start := index * chunkSize
			w := sendChunk(a, v.ID, index, b[start:min(start+chunkSize, len(b))])
			if w.Code != 204 {
				t.Errorf("chunk %d: %s", index, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	// Chunk acknowledgements survive a process restart; retries are idempotent.
	restarted, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	a = restarted
	status(t, sendChunk(a, v.ID, 0, b[:chunkSize]), 204)
	status(t, finish(a, v.ID, b), 200)
	status(t, finish(a, v.ID, b), 200)
	w := call(a, "GET", "/api/items/"+v.ID+"/download", nil, nil)
	status(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), b) || w.Header().Get("X-Content-SHA256") != digest(b) {
		t.Fatal("download bytes or checksum changed")
	}
	w = call(a, "GET", "/api/items/"+v.ID+"/download", nil, map[string]string{"Range": "bytes=7-83"})
	status(t, w, 206)
	if !bytes.Equal(w.Body.Bytes(), b[7:84]) {
		t.Fatal("incorrect range")
	}
	w = call(a, "GET", "/api/items", nil, nil)
	status(t, w, 200)
	var list []item
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Name != v.Name || list[0].SHA256 != digest(b) {
		t.Fatal("incorrect listing")
	}
	status(t, sendChunk(a, v.ID, 0, b[:chunkSize]), 409)
}

func TestChecksumAndIncompleteRejection(t *testing.T) {
	a := testApp(t)
	b := []byte("original bytes\x00\xff")
	v := startUpload(t, a, "original.bin", len(b))
	status(t, finish(a, v.ID, b), 409)
	status(t, call(a, "PUT", "/api/uploads/"+v.ID+"/0", b, map[string]string{"X-Chunk-SHA256": strings.Repeat("0", 64)}), 422)
	status(t, sendChunk(a, v.ID, 0, b[:2]), 400)
	w := call(a, "GET", "/api/items", nil, nil)
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal("incomplete upload exposed")
	}
	status(t, sendChunk(a, v.ID, 0, b), 204)
	status(t, finish(a, v.ID, []byte("wrong")), 422)
	status(t, finish(a, v.ID, b), 200)
	if err := os.WriteFile(filepath.Join(a.path(v.ID), "data"), []byte("corruption"), 0600); err != nil {
		t.Fatal(err)
	}
	status(t, call(a, "GET", "/api/items/"+v.ID+"/download", nil, nil), 500)
}

func TestEmptyFile(t *testing.T) {
	a := testApp(t)
	v := startUpload(t, a, "empty", 0)
	status(t, finish(a, v.ID, nil), 200)
	w := call(a, "GET", "/api/items/"+v.ID+"/download", nil, nil)
	status(t, w, 200)
	if w.Body.Len() != 0 {
		t.Fatal("not empty")
	}
}

func TestNoteExactUnicodeAndWhitespace(t *testing.T) {
	a := testApp(t)
	text := "  tabs:\t\t\nПривіт 🦊 e\u0301\r\n<svg onload='bad()'>\n\n"
	w := call(a, "POST", "/api/notes", jsonBody(map[string]string{"text": text, "sha256": digest([]byte(text))}), nil)
	status(t, w, 201)
	var v item
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	if v.Text != text {
		t.Fatal("text changed")
	}
	w = call(a, "GET", "/api/items/"+v.ID+"/download", nil, nil)
	status(t, w, 200)
	if w.Body.String() != text {
		t.Fatal("download text changed")
	}
	status(t, call(a, "POST", "/api/notes", jsonBody(map[string]string{"text": text, "sha256": strings.Repeat("0", 64)}), nil), 422)
}

func TestExpiryDeletesCompletedAndPartialData(t *testing.T) {
	a := testApp(t)
	now := time.Now().UTC()
	a.now = func() time.Time { return now }
	v := startUpload(t, a, "complete", 3)
	u := startUpload(t, a, "partial", 20)
	status(t, sendChunk(a, v.ID, 0, []byte("abc")), 204)
	status(t, finish(a, v.ID, []byte("abc")), 200)
	now = now.Add(lifetime)
	status(t, call(a, "GET", "/api/items/"+v.ID+"/download", nil, nil), 404)
	status(t, sendChunk(a, u.ID, 0, make([]byte, 20)), 410)
	a.cleanup()
	for _, id := range []string{v.ID, u.ID} {
		if _, err := os.Stat(a.path(id)); !os.IsNotExist(err) {
			t.Fatal("expired data remains")
		}
	}
	if a.reserved != 0 {
		t.Fatal("quota not released")
	}
}

func TestStartupRemovesExpiredAndOrphanDirectories(t *testing.T) {
	a := testApp(t)
	a.now = func() time.Time { return time.Now().Add(-25 * time.Hour) }
	v := startUpload(t, a, "old", 16)
	orphan := filepath.Join(a.cfg.Dir, strings.Repeat("a", 32))
	if err := os.Mkdir(orphan, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "data"), []byte("orphan"), 0600); err != nil {
		t.Fatal(err)
	}
	restarted, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.entries) != 0 {
		t.Fatal("expired entries loaded")
	}
	for _, p := range []string{a.path(v.ID), orphan} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("startup retained data")
		}
	}
}

func TestQuotaDeletionAndOversize(t *testing.T) {
	a := testApp(t)
	a.cfg.MaxFile = 10
	a.cfg.MaxStorage = 15
	v := startUpload(t, a, "one", 10)
	status(t, call(a, "POST", "/api/uploads", jsonBody(map[string]any{"name": "big", "size": 11}), nil), 413)
	status(t, call(a, "POST", "/api/uploads", jsonBody(map[string]any{"name": "full", "size": 6}), nil), 507)
	status(t, call(a, "DELETE", "/api/items/"+v.ID, nil, nil), 204)
	startUpload(t, a, "new", 10)
}

func TestOriginsAuthenticationAndUnsafePreview(t *testing.T) {
	a := testApp(t)
	status(t, call(a, "POST", "/api/uploads", nil, map[string]string{"Origin": "http://evil.test"}), 403)
	status(t, call(a, "POST", "/api/uploads", nil, map[string]string{"Sec-Fetch-Site": "cross-site"}), 403)
	b := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`)
	v := startUpload(t, a, "bad.svg", len(b))
	status(t, sendChunk(a, v.ID, 0, b), 204)
	status(t, finish(a, v.ID, b), 200)
	status(t, call(a, "GET", "/api/items/"+v.ID+"/preview", nil, nil), 415)
	status(t, call(a, "GET", "/api/auth/me", nil, map[string]string{"Cookie": "sync_session=invalid"}), 401)
	status(t, call(a, "GET", "/healthz", nil, nil), 200)
	r := httptest.NewRequest("GET", "/api/items", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: testAdminSession})
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	status(t, w, 200)
}

func TestSSEPublishesUpdates(t *testing.T) {
	a := testApp(t)
	srv := httptest.NewServer(a.handler())
	defer srv.Close()
	client := http.Client{Timeout: 2 * time.Second}
	req, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: testAdminSession})
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b := make([]byte, len("event: change\ndata: ready\n\n"))
	if _, err := io.ReadFull(resp.Body, b); err != nil {
		t.Fatal(err)
	}
	a.broadcast()
	b = make([]byte, len("event: change\ndata: update\n\n"))
	if _, err := io.ReadFull(resp.Body, b); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "update") {
		t.Fatal("missing event")
	}
}
