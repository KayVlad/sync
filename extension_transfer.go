package main

import (
	"encoding/hex"
	"net/http"
)

func validClientID(id string) bool {
	b, err := hex.DecodeString(id)
	return err == nil && len(b) == 16 && len(id) == 32
}

// Upload receipts are visible only to their owner, including incomplete uploads.
func (a *app) uploadStatus(w http.ResponseWriter, r *http.Request) {
	e := a.get(r.PathValue("id"))
	if e == nil {
		fail(w, 404, "Upload not found.")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !a.live(e) || !canManage(r, e.item) || e.item.Kind != "file" {
		fail(w, 404, "Upload not found.")
		return
	}
	jsonReply(w, 200, e.item)
}

func (a *app) existingNote(w http.ResponseWriter, r *http.Request, clientID, digest string) bool {
	a.mu.Lock()
	entries := make([]*entry, 0, len(a.entries))
	for _, e := range a.entries {
		entries = append(entries, e)
	}
	a.mu.Unlock()
	for _, e := range entries {
		e.mu.Lock()
		if a.live(e) && e.item.Complete && e.item.Kind == "text" && e.item.ClientID == clientID && canManage(r, e.item) {
			if e.item.SHA256 != digest {
				fail(w, 409, "Client ID already belongs to different text.")
			} else {
				jsonReply(w, 200, publicItem(e.item))
			}
			e.mu.Unlock()
			return true
		}
		e.mu.Unlock()
	}
	return false
}

func (a *app) existingUpload(w http.ResponseWriter, r *http.Request, clientID, name, typ string, size int64) bool {
	a.mu.Lock()
	entries := make([]*entry, 0, len(a.entries))
	for _, e := range a.entries {
		entries = append(entries, e)
	}
	a.mu.Unlock()
	for _, e := range entries {
		e.mu.Lock()
		if a.live(e) && e.item.Kind == "file" && e.item.ClientID == clientID && canManage(r, e.item) {
			if e.item.Name != name || e.item.Type != typ || e.item.Size != size {
				fail(w, 409, "Client ID already belongs to a different file.")
			} else {
				jsonReply(w, 200, publicItem(e.item))
			}
			e.mu.Unlock()
			return true
		}
		e.mu.Unlock()
	}
	return false
}
