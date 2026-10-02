package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestUploadReceiptsAreOwnerOnlyAndSurviveRestart(t *testing.T) {
	a := testApp(t)
	owner := &http.Cookie{Name: sessionCookie, Value: testAdminSession}
	v := startUpload(t, a, "resume.bin", chunkSize+1)
	data := bytes.Repeat([]byte{7}, chunkSize)
	status(t, rawCall(a, "PUT", "/api/uploads/"+v.ID+"/0", data, owner), 400) // checksum is required
	status(t, sendChunk(a, v.ID, 0, data), 204)
	path := "/api/uploads/" + v.ID
	status(t, rawCall(a, "GET", path, nil, nil), 401)
	createTestUser(t, a, "reader", "user", "p")
	other := loginTest(t, a, "reader", "p")
	status(t, rawCall(a, "GET", path, nil, other), 404)
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	reply := rawCall(restored, "GET", path, nil, owner)
	status(t, reply, 200)
	var receipt item
	if err := json.Unmarshal(reply.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt.Chunks) != 2 || receipt.Chunks[0] != digest(data) || receipt.Chunks[1] != "" || receipt.Complete {
		t.Fatal("wrong persisted receipt")
	}
	restored.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	status(t, rawCall(restored, "GET", path, nil, owner), 404)
}

func TestExtensionNotesAreIdempotentAcrossConcurrentRetriesAndRestart(t *testing.T) {
	a := testApp(t)
	owner := &http.Cookie{Name: sessionCookie, Value: testAdminSession}
	text := "  Привіт\t🦊\r\n"
	request := jsonBody(map[string]string{"text": text, "sha256": digest([]byte(text)), "clientId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	ids := make(chan string, 6)
	var workers sync.WaitGroup
	for i := 0; i < 6; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			reply := rawCall(a, "POST", "/api/notes", request, owner)
			if reply.Code != 200 && reply.Code != 201 {
				t.Errorf("status %d", reply.Code)
				return
			}
			var v item
			_ = json.Unmarshal(reply.Body.Bytes(), &v)
			if v.ClientID != "" {
				t.Error("client ID exposed")
			}
			ids <- v.ID
		}()
	}
	workers.Wait()
	close(ids)
	var id string
	for value := range ids {
		if id != "" && id != value {
			t.Fatal("duplicate note")
		}
		id = value
	}
	if id == "" || len(a.entries) != 1 {
		t.Fatal("note was not deduplicated")
	}
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	reply := rawCall(restored, "POST", "/api/notes", request, owner)
	status(t, reply, 200)
	var v item
	_ = json.Unmarshal(reply.Body.Bytes(), &v)
	if v.ID != id || v.Text != text {
		t.Fatal("retry changed original note")
	}
	different := jsonBody(map[string]string{"text": "different", "sha256": digest([]byte("different")), "clientId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	status(t, rawCall(restored, "POST", "/api/notes", different, owner), 409)
	status(t, rawCall(restored, "POST", "/api/notes", jsonBody(map[string]string{"text": text, "sha256": digest([]byte(text)), "clientId": "invalid"}), owner), 400)
}

func TestExtensionAllocationsAreIdempotentWithoutChangingExpiryOrQuota(t *testing.T) {
	a := testApp(t)
	owner := &http.Cookie{Name: sessionCookie, Value: testAdminSession}
	body := jsonBody(map[string]any{"name": "original.bin", "type": "application/octet-stream", "size": 1, "clientId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	first := rawCall(a, "POST", "/api/uploads", body, owner)
	status(t, first, 201)
	var initial item
	_ = json.Unmarshal(first.Body.Bytes(), &initial)
	restored, err := newApp(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	again := rawCall(restored, "POST", "/api/uploads", body, owner)
	status(t, again, 200)
	var repeated item
	_ = json.Unmarshal(again.Body.Bytes(), &repeated)
	if repeated.ID != initial.ID || !repeated.Expires.Equal(initial.Expires) || restored.reserved != 1 || len(restored.entries) != 1 {
		t.Fatal("retry reserved another file or changed expiry")
	}
	mismatch := jsonBody(map[string]any{"name": "different.bin", "size": 1, "clientId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	status(t, rawCall(restored, "POST", "/api/uploads", mismatch, owner), 409)
}
