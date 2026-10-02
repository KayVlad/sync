package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPrivateAndPublicAccess(t *testing.T) {
	a := testApp(t)
	createTestUser(t, a, "sender", "user", "sender-password-123")
	owner := loginTest(t, a, "sender", "sender-password-123")
	admin := &http.Cookie{Name: sessionCookie, Value: testAdminSession}
	text := "private https://example.com/\n"
	w := rawCall(a, "POST", "/api/notes", jsonBody(map[string]string{"text": text, "sha256": digest([]byte(text))}), owner)
	status(t, w, 201)
	var v item
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	path := "/api/items/" + v.ID
	if v.Public || v.OwnerID == "" {
		t.Fatal("new item must be private and owned")
	}
	for _, visitor := range []*http.Cookie{nil, admin} {
		list := rawCall(a, "GET", "/api/items", nil, visitor)
		status(t, list, 200)
		var listed []item
		_ = json.Unmarshal(list.Body.Bytes(), &listed)
		if len(listed) != 0 {
			t.Fatal("private item leaked")
		}
		for _, suffix := range []string{"/download", "/preview"} {
			status(t, rawCall(a, "GET", path+suffix, nil, visitor), 404)
		}
	}
	for _, method := range []string{"DELETE", "PATCH"} {
		status(t, rawCall(a, method, path, jsonBody(map[string]bool{"public": true}), admin), 404)
		status(t, rawCall(a, method, path, jsonBody(map[string]bool{"public": true}), nil), 401)
	}
	status(t, rawCall(a, "PATCH", path, []byte(`{}`), owner), 400)
	status(t, rawCall(a, "PATCH", path, jsonBody(map[string]bool{"public": true}), owner), 200)
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	a = restored
	for _, visitor := range []*http.Cookie{nil, admin, owner} {
		list := rawCall(a, "GET", "/api/items", nil, visitor)
		status(t, list, 200)
		var listed []item
		_ = json.Unmarshal(list.Body.Bytes(), &listed)
		if len(listed) != 1 || !listed[0].Public || listed[0].CanManage != (visitor == owner) {
			t.Fatal("wrong public visibility or controls")
		}
		download := rawCall(a, "GET", path+"/download", nil, visitor)
		status(t, download, 200)
		if download.Body.String() != text {
			t.Fatal("download differs")
		}
	}
	r := httptest.NewRequest("GET", path+"/download", nil)
	r.Header.Set("Range", "bytes=0-6")
	rw := httptest.NewRecorder()
	a.handler().ServeHTTP(rw, r)
	status(t, rw, 206)
	status(t, rawCall(a, "HEAD", path+"/download", nil, nil), 200)
	status(t, rawCall(a, "PATCH", path, jsonBody(map[string]bool{"public": false}), owner), 200)
	status(t, rawCall(a, "GET", path+"/download", nil, nil), 404)
	status(t, rawCall(a, "PATCH", path, jsonBody(map[string]bool{"public": true}), owner), 200)
	a.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	status(t, rawCall(a, "GET", path+"/download", nil, nil), 404)
}

func TestOtherUsersCannotModifyUploads(t *testing.T) {
	a := testApp(t)
	v := startUpload(t, a, "private.bin", 1)
	createTestUser(t, a, "other", "user", "other-password-123")
	cookie := loginTest(t, a, "other", "other-password-123")
	status(t, rawCall(a, "PUT", "/api/uploads/"+v.ID+"/0", []byte("x"), cookie), 404)
	status(t, rawCall(a, "POST", "/api/uploads/"+v.ID+"/complete", jsonBody(map[string]string{"sha256": digest([]byte("x"))}), cookie), 404)
	status(t, rawCall(a, "PATCH", "/api/items/"+v.ID, jsonBody(map[string]bool{"public": true}), &http.Cookie{Name: sessionCookie, Value: testAdminSession}), 404)
}
