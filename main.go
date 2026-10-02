package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

const chunkSize = 4 << 20
const lifetime = 24 * time.Hour
const maxNote = 1 << 20

type config struct {
	Dir, Addr, AdminUsername, AdminPassword string
	MaxFile, MaxStorage                     int64
}

type item struct {
	ClientID  string    `json:"clientId,omitempty"`
	OwnerID   string    `json:"ownerId,omitempty"`
	Public    bool      `json:"public"`
	CanManage bool      `json:"canManage,omitempty"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	Kind      string    `json:"kind"`
	Size      int64     `json:"size"`
	Created   time.Time `json:"created"`
	Expires   time.Time `json:"expires"`
	SHA256    string    `json:"sha256,omitempty"`
	Complete  bool      `json:"complete"`
	Chunks    []string  `json:"chunks,omitempty"`
	Text      string    `json:"text,omitempty"`
}

type entry struct {
	mu      sync.Mutex
	item    item
	deleted bool
}

type app struct {
	noteMu     sync.Mutex
	uploadMu   sync.Mutex
	cfg        config
	mu         sync.Mutex
	entries    map[string]*entry
	reserved   int64
	subs       map[chan struct{}]struct{}
	chunkSlots chan struct{}
	closing    <-chan struct{}
	now        func() time.Time
	auth       *authStore
}

func envInt(key string, fallback int64) int64 {
	if s := os.Getenv(key); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			log.Fatalf("%s must be a positive integer", key)
		}
		return n
	}
	return fallback
}

func main() {
	addr := os.Getenv("SYNC_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if strings.HasPrefix(addr, ":") {
			addr = "127.0.0.1" + addr
		}
		client := http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://" + addr + "/healthz")
		if err != nil {
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	dir := os.Getenv("SYNC_DATA")
	if dir == "" {
		dir = "data"
	}
	if len(os.Args) == 2 && os.Args[1] == "admin-password" {
		password, err := os.ReadFile(filepath.Join(dir, "admin-password"))
		if err != nil {
			log.Fatal("initial password unavailable; ask an existing admin to reset your password")
		}
		fmt.Print(string(password))
		return
	}
	cfg := config{Dir: dir, Addr: addr, AdminUsername: os.Getenv("SYNC_ADMIN_USERNAME"), AdminPassword: os.Getenv("SYNC_ADMIN_PASSWORD"), MaxFile: envInt("SYNC_MAX_FILE_BYTES", 20<<30), MaxStorage: envInt("SYNC_MAX_STORAGE_BYTES", 50<<30)}
	a, err := newApp(cfg)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a.closing = ctx.Done()
	go a.cleanupLoop(ctx)
	srv := &http.Server{Addr: addr, Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			log.Print(err)
		}
	}()
	log.Printf("sync listening on %s; retention 24h; data %s", addr, dir)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-shutdownDone
}

func newApp(cfg config) (*app, error) {
	if err := os.MkdirAll(cfg.Dir, 0700); err != nil {
		return nil, err
	}
	a := &app{cfg: cfg, entries: make(map[string]*entry), subs: make(map[chan struct{}]struct{}), chunkSlots: make(chan struct{}, 16), now: time.Now}
	if err := a.initAuth(); err != nil {
		return nil, err
	}
	dirs, err := os.ReadDir(cfg.Dir)
	if err != nil {
		return nil, err
	}
	for _, d := range dirs {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		p := filepath.Join(cfg.Dir, d.Name())
		b, err := os.ReadFile(filepath.Join(p, "record.json"))
		var v item
		if err != nil || json.Unmarshal(b, &v) != nil || v.ID != d.Name() || v.Size < 0 || v.Expires.IsZero() {
			// An interrupted creation has no committed record and must not retain orphan data.
			if err := os.RemoveAll(p); err != nil {
				return nil, err
			}
			continue
		}
		if !v.Expires.After(a.now()) {
			if err := os.RemoveAll(p); err != nil {
				return nil, err
			}
			continue
		}
		st, err := os.Stat(filepath.Join(p, "data"))
		if err != nil || st.Size() != v.Size {
			return nil, fmt.Errorf("invalid stored data for %s", v.ID)
		}
		if int64(len(v.Chunks)) != (v.Size+chunkSize-1)/chunkSize && !v.Complete {
			return nil, fmt.Errorf("invalid upload record %s", v.ID)
		}
		a.entries[v.ID] = &entry{item: v}
		a.reserved += v.Size
	}
	return a, nil
}

func validID(s string) bool {
	if len(s) != 32 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
func (a *app) path(id string) string { return filepath.Join(a.cfg.Dir, id) }
func (a *app) persist(v item) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p := filepath.Join(a.path(v.ID), "record.json")
	f, err := os.OpenFile(p+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	jsonReply(w, status, map[string]string{"error": msg})
}
func decode(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		fail(w, 400, "Invalid request.")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		fail(w, 400, "Invalid request.")
		return false
	}
	return true
}

func (a *app) handler() http.Handler {
	m := http.NewServeMux()
	a.authRoutes(m)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	m.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		jsonReply(w, 200, map[string]any{"chunkSize": chunkSize, "parallel": 4, "maxFileSize": a.cfg.MaxFile, "maxNoteSize": maxNote})
	})
	m.HandleFunc("GET /api/items", a.list)
	m.HandleFunc("POST /api/uploads", a.createUpload)
	m.HandleFunc("GET /api/uploads/{id}", a.uploadStatus)
	m.HandleFunc("PUT /api/uploads/{id}/{index}", a.putChunk)
	m.HandleFunc("POST /api/uploads/{id}/complete", a.complete)
	m.HandleFunc("POST /api/notes", a.note)
	m.HandleFunc("DELETE /api/items/{id}", a.delete)
	m.HandleFunc("PATCH /api/items/{id}", a.setVisibility)
	m.HandleFunc("GET /api/items/{id}/download", a.download)
	m.HandleFunc("GET /api/items/{id}/preview", a.preview)
	m.HandleFunc("GET /api/events", a.events)
	web, _ := fs.Sub(assets, "web")
	m.Handle("GET /", http.FileServer(http.FS(web)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "GET" && r.Method != "HEAD" && !extensionRequest(r) {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				fail(w, 403, "Cross-site request blocked.")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
					fail(w, 403, "Cross-site request blocked.")
					return
				}
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/auth/login" && r.URL.Path != "/api/auth/extension/login" {
			u, ok := a.authenticate(r)
			publicRead := (r.Method == "GET" || r.Method == "HEAD") && (r.URL.Path == "/api/items" || r.URL.Path == "/api/events" || (strings.HasPrefix(r.URL.Path, "/api/items/") && (strings.HasSuffix(r.URL.Path, "/download") || strings.HasSuffix(r.URL.Path, "/preview"))))
			if !ok && !publicRead {
				fail(w, 401, "Sign in to sync.")
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/admin/") && u.Role != "admin" {
				fail(w, 403, "Admin access required.")
				return
			}
			if ok {
				r = r.WithContext(context.WithValue(r.Context(), userContextKey{}, u))
			}
		}
		m.ServeHTTP(w, r)
	})
}

func (a *app) get(id string) *entry { a.mu.Lock(); defer a.mu.Unlock(); return a.entries[id] }
func (a *app) live(e *entry) bool   { return !e.deleted && e.item.Expires.After(a.now()) }
func publicItem(v item) item        { v.Chunks = nil; v.ClientID = ""; return v }
func canManage(r *http.Request, v item) bool {
	u, ok := r.Context().Value(userContextKey{}).(user)
	return ok && (v.OwnerID == u.ID || (v.OwnerID == "" && u.Role == "admin"))
}
func canRead(r *http.Request, v item) bool { return v.Public || canManage(r, v) }
func (a *app) setVisibility(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Public *bool `json:"public"`
	}
	if !decode(w, r, 128, &req) {
		return
	}
	if req.Public == nil {
		fail(w, 400, "Public flag required.")
		return
	}
	e := a.get(r.PathValue("id"))
	if e == nil {
		fail(w, 404, "Item not found.")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !a.live(e) || !e.item.Complete || !canManage(r, e.item) {
		fail(w, 404, "Item not found.")
		return
	}
	v := e.item
	v.Public = *req.Public
	if v.OwnerID == "" {
		v.OwnerID = r.Context().Value(userContextKey{}).(user).ID
	}
	if err := a.persist(v); err != nil {
		fail(w, 500, "Could not save visibility.")
		return
	}
	e.item = v
	a.broadcast()
	v = publicItem(v)
	v.CanManage = true
	jsonReply(w, 200, v)
}
func (a *app) list(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	entries := make([]*entry, 0, len(a.entries))
	for _, e := range a.entries {
		entries = append(entries, e)
	}
	a.mu.Unlock()
	items := []item{}
	for _, e := range entries {
		e.mu.Lock()
		if a.live(e) && e.item.Complete && canRead(r, e.item) {
			v := publicItem(e.item)
			v.CanManage = canManage(r, e.item)
			items = append(items, v)
		}
		e.mu.Unlock()
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Created.After(items[j].Created) })
	jsonReply(w, 200, items)
}

func (a *app) allocate(name, typ, kind string, size int64, owner ...string) (*entry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if size > a.cfg.MaxStorage-a.reserved {
		return nil, errors.New("Storage is full. Delete an item or wait for expiry.")
	}
	if len(a.entries) >= 10000 {
		return nil, errors.New("Too many items. Delete an item or wait for expiry.")
	}
	idBytes := make([]byte, 16)
	// crypto/rand.Text is not needed; IDs use 128 random bits with path-safe hex.
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(idBytes)
	now := a.now().UTC()
	v := item{ID: id, Name: name, Type: typ, Kind: kind, Size: size, Created: now, Expires: now.Add(lifetime), Chunks: make([]string, (size+chunkSize-1)/chunkSize)}
	if len(owner) > 0 {
		v.OwnerID = owner[0]
	}
	if err := os.Mkdir(a.path(id), 0700); err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(a.path(id))
		}
	}()
	f, err := os.OpenFile(filepath.Join(a.path(id), "data"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	err = f.Truncate(size)
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := a.persist(v); err != nil {
		return nil, err
	}
	e := &entry{item: v}
	a.entries[id] = e
	a.reserved += size
	ok = true
	return e, nil
}

func (a *app) createUpload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Size     int64  `json:"size"`
		ClientID string `json:"clientId"`
	}
	if !decode(w, r, 4096, &req) {
		return
	}
	req.Name = strings.ReplaceAll(req.Name, "\\", "/")
	req.Name = filepath.Base(req.Name)
	if req.Name == "" || req.Name == "." || req.Name == "/" || len(req.Name) > 255 || strings.ContainsAny(req.Name, "\x00\r\n") || req.Size < 0 {
		fail(w, 400, "Invalid file.")
		return
	}
	if req.Size > a.cfg.MaxFile {
		fail(w, 413, "File exceeds the server size limit.")
		return
	}
	if len(req.Type) > 255 || strings.ContainsAny(req.Type, "\r\n\x00") {
		fail(w, 400, "Invalid file type.")
		return
	}
	if req.ClientID != "" {
		if !validClientID(req.ClientID) {
			fail(w, 400, "Invalid client ID.")
			return
		}
		a.uploadMu.Lock()
		defer a.uploadMu.Unlock()
		if a.existingUpload(w, r, req.ClientID, req.Name, req.Type, req.Size) {
			return
		}
	}
	e, err := a.allocate(req.Name, req.Type, "file", req.Size, r.Context().Value(userContextKey{}).(user).ID)
	if err != nil {
		fail(w, 507, err.Error())
		return
	}
	e.mu.Lock()
	if req.ClientID != "" {
		e.item.ClientID = req.ClientID
		if err := a.persist(e.item); err != nil {
			e.mu.Unlock()
			_ = a.remove(e)
			fail(w, 500, "Could not save upload.")
			return
		}
	}
	v := publicItem(e.item)
	e.mu.Unlock()
	jsonReply(w, 201, v)
}

func (a *app) putChunk(w http.ResponseWriter, r *http.Request) {
	select {
	case a.chunkSlots <- struct{}{}:
		defer func() { <-a.chunkSlots }()
	case <-r.Context().Done():
		return
	}
	e := a.get(r.PathValue("id"))
	if e == nil {
		fail(w, 404, "Upload not found.")
		return
	}
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		fail(w, 400, "Invalid chunk.")
		return
	}
	e.mu.Lock()
	if !canManage(r, e.item) {
		e.mu.Unlock()
		fail(w, 404, "Upload not found.")
		return
	}
	if !a.live(e) {
		e.mu.Unlock()
		fail(w, 410, "Upload expired.")
		return
	}
	if e.item.Complete || index < 0 || index >= len(e.item.Chunks) {
		e.mu.Unlock()
		fail(w, 409, "Invalid upload state.")
		return
	}
	wantSize := min(int64(chunkSize), e.item.Size-int64(index)*chunkSize)
	e.mu.Unlock()
	expected := strings.ToLower(r.Header.Get("X-Chunk-SHA256"))
	if !validHash(expected) {
		fail(w, 400, "Chunk checksum required.")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, wantSize))
	if err != nil || int64(len(b)) != wantSize {
		fail(w, 400, "Chunk size mismatch.")
		return
	}
	h := sha256.Sum256(b)
	if hex.EncodeToString(h[:]) != expected {
		fail(w, 422, "Chunk checksum mismatch.")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !a.live(e) || e.item.Complete {
		fail(w, 409, "Upload no longer writable.")
		return
	}
	if e.item.Chunks[index] == expected {
		w.WriteHeader(204)
		return
	}
	f, err := os.OpenFile(filepath.Join(a.path(e.item.ID), "data"), os.O_WRONLY, 0600)
	if err == nil {
		_, err = f.WriteAt(b, int64(index)*chunkSize)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		fail(w, 507, "Could not store chunk.")
		return
	}
	previous := e.item.Chunks[index]
	e.item.Chunks[index] = expected
	if err := a.persist(e.item); err != nil {
		e.item.Chunks[index] = previous
		fail(w, 500, "Could not save upload progress.")
		return
	}
	w.WriteHeader(204)
}

func validHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (a *app) complete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SHA256 string `json:"sha256"`
	}
	if !decode(w, r, 256, &req) {
		return
	}
	if !validHash(req.SHA256) {
		fail(w, 400, "File checksum required.")
		return
	}
	e := a.get(r.PathValue("id"))
	if e == nil {
		fail(w, 404, "Upload not found.")
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !canManage(r, e.item) {
		fail(w, 404, "Upload not found.")
		return
	}
	if !a.live(e) {
		fail(w, 410, "Upload expired.")
		return
	}
	if e.item.Complete {
		if e.item.SHA256 != req.SHA256 {
			fail(w, 409, "Checksum differs from completed upload.")
			return
		}
		jsonReply(w, 200, publicItem(e.item))
		return
	}
	for _, h := range e.item.Chunks {
		if h == "" {
			fail(w, 409, "Upload has missing chunks.")
			return
		}
	}
	h, err := fileHash(filepath.Join(a.path(e.item.ID), "data"))
	if err != nil {
		fail(w, 500, "Could not verify file.")
		return
	}
	if h != req.SHA256 {
		fail(w, 422, "File checksum mismatch. Send the file again.")
		return
	}
	if !a.live(e) {
		fail(w, 410, "Upload expired.")
		return
	}
	e.item.SHA256 = h
	e.item.Complete = true
	if err := a.persist(e.item); err != nil {
		e.item.Complete = false
		fail(w, 500, "Could not finalize file.")
		return
	}
	a.broadcast()
	jsonReply(w, 200, publicItem(e.item))
}

func (a *app) note(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text     string `json:"text"`
		SHA256   string `json:"sha256"`
		ClientID string `json:"clientId"`
	}
	if !decode(w, r, 6*maxNote+256, &req) {
		return
	}
	if len(req.Text) == 0 || len(req.Text) > maxNote {
		fail(w, 413, "Text must be between 1 byte and 1 MiB.")
		return
	}
	h := sha256.Sum256([]byte(req.Text))
	digest := hex.EncodeToString(h[:])
	if digest != req.SHA256 {
		fail(w, 422, "Text checksum mismatch.")
		return
	}
	if req.ClientID != "" {
		if !validClientID(req.ClientID) {
			fail(w, 400, "Invalid client ID.")
			return
		}
		a.noteMu.Lock()
		defer a.noteMu.Unlock()
		if a.existingNote(w, r, req.ClientID, digest) {
			return
		}
	}
	e, err := a.allocate("note.txt", "text/plain; charset=utf-8", "text", int64(len(req.Text)), r.Context().Value(userContextKey{}).(user).ID)
	if err != nil {
		fail(w, 507, err.Error())
		return
	}
	e.mu.Lock()
	f, err := os.OpenFile(filepath.Join(a.path(e.item.ID), "data"), os.O_WRONLY|os.O_TRUNC, 0600)
	if err == nil {
		_, err = f.Write([]byte(req.Text))
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err == nil {
		e.item.ClientID = req.ClientID
		e.item.Text = req.Text
		e.item.SHA256 = digest
		e.item.Complete = true
		err = a.persist(e.item)
	}
	v := publicItem(e.item)
	e.mu.Unlock()
	if err != nil {
		_ = a.remove(e)
		fail(w, 500, "Could not save text.")
		return
	}
	a.broadcast()
	jsonReply(w, 201, v)
}

func (a *app) remove(e *entry) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.deleted {
		return nil
	}
	if err := os.RemoveAll(a.path(e.item.ID)); err != nil {
		return err
	}
	e.deleted = true
	a.mu.Lock()
	delete(a.entries, e.item.ID)
	a.reserved -= e.item.Size
	a.mu.Unlock()
	return nil
}
func (a *app) delete(w http.ResponseWriter, r *http.Request) {
	e := a.get(r.PathValue("id"))
	if e == nil {
		w.WriteHeader(204)
		return
	}
	e.mu.Lock()
	allowed := canManage(r, e.item)
	e.mu.Unlock()
	if !allowed {
		fail(w, 404, "Item not found.")
		return
	}
	if err := a.remove(e); err != nil {
		fail(w, 500, "Could not delete item.")
		return
	}
	a.broadcast()
	w.WriteHeader(204)
}

func (a *app) serveData(w http.ResponseWriter, r *http.Request, inline bool) {
	e := a.get(r.PathValue("id"))
	if e == nil {
		fail(w, 404, "Item not found.")
		return
	}
	e.mu.Lock()
	if !a.live(e) || !e.item.Complete || !canRead(r, e.item) {
		e.mu.Unlock()
		fail(w, 404, "Item expired or unavailable.")
		return
	}
	f, err := os.Open(filepath.Join(a.path(e.item.ID), "data"))
	v := e.item
	e.mu.Unlock()
	if err != nil {
		fail(w, 404, "File unavailable.")
		return
	}
	defer f.Close()
	expiryTimer := time.AfterFunc(time.Until(v.Expires), func() { _ = f.Close() })
	defer expiryTimer.Stop()
	// Detect at-rest corruption before emitting bytes or supporting a range request.
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil || hex.EncodeToString(h.Sum(nil)) != v.SHA256 {
		fail(w, 500, "Stored file failed its integrity check.")
		return
	}
	if !v.Expires.After(a.now()) {
		fail(w, 410, "Item expired.")
		return
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		fail(w, 500, "Could not read file.")
		return
	}
	disposition := "attachment"
	typ := "application/octet-stream"
	if inline {
		b := make([]byte, 512)
		n, _ := f.Read(b)
		_, _ = f.Seek(0, io.SeekStart)
		typ = http.DetectContentType(b[:n])
		if typ != "image/png" && typ != "image/jpeg" && typ != "image/gif" && typ != "image/webp" {
			fail(w, 415, "Preview unavailable.")
			return
		}
		disposition = "inline"
	}
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": v.Name}))
	w.Header().Set("X-Content-SHA256", v.SHA256)
	// End long transfers at expiry, allowing cleanup to remove the bytes promptly.
	_ = http.NewResponseController(w).SetWriteDeadline(v.Expires)
	http.ServeContent(w, r, v.Name, v.Created, f)
}
func (a *app) download(w http.ResponseWriter, r *http.Request) { a.serveData(w, r, false) }
func (a *app) preview(w http.ResponseWriter, r *http.Request)  { a.serveData(w, r, true) }

func (a *app) broadcast() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := range a.subs {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}
func (a *app) events(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "Streaming unavailable.")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	c := make(chan struct{}, 1)
	a.mu.Lock()
	a.subs[c] = struct{}{}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.subs, c); a.mu.Unlock() }()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	send := func(s string) bool {
		if r.Context().Value(userContextKey{}) != nil {
			if _, ok := a.authenticate(r); !ok {
				return false
			}
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := fmt.Fprint(w, s)
		f.Flush()
		return err == nil
	}
	if !send("event: change\ndata: ready\n\n") {
		return
	}
	for {
		select {
		case <-a.closing:
			return
		case <-r.Context().Done():
			return
		case <-c:
			if !send("event: change\ndata: update\n\n") {
				return
			}
		case <-ping.C:
			if !send(": keepalive\n\n") {
				return
			}
		}
	}
}
func (a *app) cleanup() {
	a.mu.Lock()
	entries := make([]*entry, 0, len(a.entries))
	for _, e := range a.entries {
		entries = append(entries, e)
	}
	a.mu.Unlock()
	changed := false
	for _, e := range entries {
		e.mu.Lock()
		expired := !e.item.Expires.After(a.now())
		e.mu.Unlock()
		if expired {
			if err := a.remove(e); err != nil {
				log.Printf("expiry cleanup: %v", err)
			} else {
				changed = true
			}
		}
	}
	if changed {
		a.broadcast()
	}
}
func (a *app) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.cleanup()
		}
	}
}
