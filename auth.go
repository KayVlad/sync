package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const sessionLifetime = 30 * 24 * time.Hour
const sessionCookie = "sync_session"
const passwordIterations = 600000

type userContextKey struct{}
type user struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Role         string    `json:"role"`
	Created      time.Time `json:"created"`
	PasswordHash string    `json:"passwordHash,omitempty"`
	PasswordSet  bool      `json:"passwordSet"`
	TokenHash    string    `json:"tokenHash,omitempty"` // Read only for migration from the earlier token prototype.
}

func (u user) public() user {
	u.PasswordSet = u.PasswordHash != ""
	u.PasswordHash = ""
	u.TokenHash = ""
	return u
}

type session struct {
	UserID  string    `json:"userId"`
	Expires time.Time `json:"expires"`
	Created time.Time `json:"created"`
}
type authData struct {
	Version  int                `json:"version"`
	Users    map[string]user    `json:"users"`
	Sessions map[string]session `json:"sessions"`
}
type loginAttempts struct {
	Count int
	Until time.Time
}
type authStore struct {
	mu            sync.Mutex
	data          authData
	attempts      map[string]loginAttempts
	passwordSlots chan struct{}
}

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
func newSessionToken() string { return rand.Text() + rand.Text() }
func validPassword(password string) bool {
	return len(password) > 0 && len(password) <= 1024 && utf8.ValidString(password)
}
func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", passwordIterations, hex.EncodeToString(salt), hex.EncodeToString(key)), nil
}
func passwordParts(encoded string) (int, []byte, []byte, bool) {
	p := strings.Split(encoded, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" {
		return 0, nil, nil, false
	}
	iterations, err := strconv.Atoi(p[1])
	if err != nil || iterations < passwordIterations || iterations > 2000000 {
		return 0, nil, nil, false
	}
	salt, err := hex.DecodeString(p[2])
	if err != nil || len(salt) != 16 {
		return 0, nil, nil, false
	}
	hash, err := hex.DecodeString(p[3])
	return iterations, salt, hash, err == nil && len(hash) == 32
}
func checkPassword(encoded, password string) bool {
	iterations, salt, want, ok := passwordParts(encoded)
	if !ok {
		iterations = passwordIterations
		salt = make([]byte, 16)
		want = make([]byte, 32)
	}
	// Unknown usernames incur the same KDF cost as wrong passwords.
	got, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1 && ok
}
func (a *app) authPath() string { return filepath.Join(a.cfg.Dir, "accounts.json") }
func (a *app) saveAuth(d authData) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	p := a.authPath()
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
func (a *app) bootstrapPassword() (string, error) {
	password := a.cfg.AdminPassword
	if password != "" {
		if !validPassword(password) {
			return "", errors.New("SYNC_ADMIN_PASSWORD must be non-empty and at most 1024 bytes")
		}
		return password, nil
	}
	path := filepath.Join(a.cfg.Dir, "admin-password")
	if b, err := os.ReadFile(path); err == nil {
		password = strings.TrimSuffix(string(b), "\n")
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if password == "" {
		password = rand.Text()
		if err := os.WriteFile(path, []byte(password+"\n"), 0600); err != nil {
			return "", err
		}
	}
	if !validPassword(password) {
		return "", errors.New("invalid bootstrap password file")
	}
	log.Print("initial admin password available with: sync admin-password (same SYNC_DATA directory)")
	return password, nil
}
func (a *app) initAuth() error {
	a.auth = &authStore{attempts: make(map[string]loginAttempts), passwordSlots: make(chan struct{}, 4)}
	b, err := os.ReadFile(a.authPath())
	if err == nil {
		if json.Unmarshal(b, &a.auth.data) != nil {
			return errors.New("invalid accounts.json; refusing to reset accounts")
		}
		d := a.auth.data
		if len(d.Users) == 0 || d.Version > 2 {
			return errors.New("invalid accounts database")
		}
		var admins []user
		for id, u := range d.Users {
			if id != u.ID || !validUser(u.Name, u.Role) {
				return errors.New("invalid account record")
			}
			if u.PasswordHash != "" {
				if _, _, _, ok := passwordParts(u.PasswordHash); !ok {
					return errors.New("invalid password hash")
				}
			}
			if u.Role == "admin" {
				admins = append(admins, u)
			}
		}
		if len(admins) == 0 {
			return errors.New("accounts.json has no admin")
		}
		if d.Version < 2 {
			sort.Slice(admins, func(i, j int) bool { return admins[i].Created.Before(admins[j].Created) })
			admin := admins[0]
			for _, u := range admins {
				if strings.EqualFold(u.Name, "admin") {
					admin = u
					break
				}
			}
			password, err := a.bootstrapPassword()
			if err != nil {
				return err
			}
			hash, err := hashPassword(password)
			if err != nil {
				return err
			}
			for id, u := range d.Users {
				u.TokenHash = ""
				d.Users[id] = u
			}
			admin.TokenHash = ""
			admin.PasswordHash = hash
			d.Users[admin.ID] = admin
			d.Sessions = make(map[string]session)
			d.Version = 2
			if err := a.saveAuth(d); err != nil {
				return err
			}
			_ = os.Remove(filepath.Join(a.cfg.Dir, "admin-token"))
			log.Print("migrated token accounts to password login; other users need a password set by an admin")
		}
		if d.Sessions == nil {
			d.Sessions = make(map[string]session)
		}
		a.auth.data = d
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	name := strings.TrimSpace(a.cfg.AdminUsername)
	if name == "" {
		name = "admin"
	}
	if !validUser(name, "admin") {
		return errors.New("invalid SYNC_ADMIN_USERNAME")
	}
	password, err := a.bootstrapPassword()
	if err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	id := rand.Text()
	u := user{ID: id, Name: name, Role: "admin", Created: a.now().UTC(), PasswordHash: hash}
	a.auth.data = authData{Version: 2, Users: map[string]user{id: u}, Sessions: make(map[string]session)}
	return a.saveAuth(a.auth.data)
}
func cloneAuth(d authData) authData {
	return authData{Version: d.Version, Users: maps.Clone(d.Users), Sessions: maps.Clone(d.Sessions)}
}
func (a *app) commitAuth(d authData) error {
	if err := a.saveAuth(d); err != nil {
		return err
	}
	a.auth.data = d
	return nil
}
func requestSessionToken(r *http.Request) string {
	if authorization := r.Header.Get("Authorization"); authorization != "" {
		if !strings.HasPrefix(authorization, "Bearer ") {
			return ""
		}
		return strings.TrimPrefix(authorization, "Bearer ")
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}
func extensionRequest(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "chrome-extension" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || len(u.Host) != 32 || r.Header.Get("X-Sync-Client") != "extension" || r.Header.Get("Cookie") != "" {
		return false
	}
	for _, c := range u.Host {
		if c < 'a' || c > 'p' {
			return false
		}
	}
	return r.URL.Path == "/api/auth/extension/login" || strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}
func (a *app) authenticate(r *http.Request) (user, bool) {
	token := requestSessionToken(r)
	if token == "" || len(token) > 128 {
		return user{}, false
	}
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	s, ok := a.auth.data.Sessions[tokenHash(token)]
	if !ok || !s.Expires.After(a.now()) {
		return user{}, false
	}
	u, ok := a.auth.data.Users[s.UserID]
	return u.public(), ok && u.PasswordHash != ""
}
func (a *app) authRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/auth/login", a.login)
	m.HandleFunc("POST /api/auth/extension/login", a.login)
	m.HandleFunc("POST /api/auth/logout", a.logout)
	m.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) { jsonReply(w, 200, r.Context().Value(userContextKey{})) })
	m.HandleFunc("GET /api/admin/users", a.listUsers)
	m.HandleFunc("POST /api/admin/users", a.createUser)
	m.HandleFunc("PATCH /api/admin/users/{id}", a.updateUser)
	m.HandleFunc("DELETE /api/admin/users/{id}", a.deleteUser)
	m.HandleFunc("POST /api/admin/users/{id}/password", a.resetPassword)
}
func cookieFor(r *http.Request, value string, expiry time.Time) *http.Cookie {
	secure := r.TLS != nil || strings.HasPrefix(r.Header.Get("Origin"), "https://")
	return &http.Cookie{Name: sessionCookie, Value: value, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, Expires: expiry, MaxAge: int(sessionLifetime.Seconds())}
}
func (a *app) allowLogin(r *http.Request) bool {
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	now := a.now()
	for ip, b := range a.auth.attempts {
		if !b.Until.After(now) {
			delete(a.auth.attempts, ip)
		}
	}
	b := a.auth.attempts[host]
	if b.Count >= 12 {
		return false
	}
	if b.Count == 0 {
		if len(a.auth.attempts) >= 4096 {
			return false
		}
		b.Until = now.Add(time.Minute)
	}
	b.Count++
	a.auth.attempts[host] = b
	return true
}
func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, 8192, &req) {
		return
	}
	if !a.allowLogin(r) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "Too many attempts. Try again in a minute.")
		return
	}
	if len(req.Username) > 80 || len(req.Password) > 1024 {
		fail(w, 401, "Incorrect username or password.")
		return
	}
	select {
	case a.auth.passwordSlots <- struct{}{}:
		defer func() { <-a.auth.passwordSlots }()
	case <-r.Context().Done():
		return
	}
	a.auth.mu.Lock()
	var found user
	for _, u := range a.auth.data.Users {
		if strings.EqualFold(u.Name, strings.TrimSpace(req.Username)) {
			found = u
			break
		}
	}
	a.auth.mu.Unlock()
	valid := checkPassword(found.PasswordHash, req.Password)
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	current, exists := a.auth.data.Users[found.ID]
	if !valid || !exists || current.PasswordHash != found.PasswordHash {
		fail(w, 401, "Incorrect username or password.")
		return
	}
	found = current
	d := cloneAuth(a.auth.data)
	now := a.now()
	for h, s := range d.Sessions {
		if !s.Expires.After(now) {
			delete(d.Sessions, h)
		}
	}
	type keyedSession struct {
		Hash    string
		Session session
	}
	var own []keyedSession
	for h, s := range d.Sessions {
		if s.UserID == found.ID {
			own = append(own, keyedSession{h, s})
		}
	}
	sort.Slice(own, func(i, j int) bool { return own[i].Session.Created.Before(own[j].Session.Created) })
	for len(own) >= 20 {
		delete(d.Sessions, own[0].Hash)
		own = own[1:]
	}
	token := newSessionToken()
	expiry := now.Add(sessionLifetime)
	d.Sessions[tokenHash(token)] = session{UserID: found.ID, Expires: expiry, Created: now}
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not save session.")
		return
	}
	if b, e := os.ReadFile(filepath.Join(a.cfg.Dir, "admin-password")); e == nil && strings.TrimSuffix(string(b), "\n") == req.Password && found.Role == "admin" {
		_ = os.Remove(filepath.Join(a.cfg.Dir, "admin-password"))
	}
	if r.URL.Path == "/api/auth/extension/login" {
		jsonReply(w, 200, map[string]any{"user": found.public(), "token": token, "expires": expiry})
	} else {
		http.SetCookie(w, cookieFor(r, token, expiry))
		jsonReply(w, 200, found.public())
	}
}
func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	d := cloneAuth(a.auth.data)
	delete(d.Sessions, tokenHash(requestSessionToken(r)))
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not sign out.")
		return
	}
	c := cookieFor(r, "", time.Unix(1, 0))
	c.MaxAge = -1
	http.SetCookie(w, c)
	w.WriteHeader(204)
}
func validUser(name, role string) bool {
	return len(name) > 0 && len(name) <= 80 && !strings.ContainsAny(name, "\x00\r\n") && (role == "admin" || role == "user")
}
func uniqueName(d authData, name, id string) bool {
	for _, u := range d.Users {
		if u.ID != id && strings.EqualFold(u.Name, name) {
			return false
		}
	}
	return true
}
func adminCount(d authData) int {
	n := 0
	for _, u := range d.Users {
		if u.Role == "admin" && u.PasswordHash != "" {
			n++
		}
	}
	return n
}
func revokeSessions(d authData, id string) {
	for h, s := range d.Sessions {
		if s.UserID == id {
			delete(d.Sessions, h)
		}
	}
}
func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	users := []user{}
	for _, u := range a.auth.data.Users {
		users = append(users, u.public())
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Created.Before(users[j].Created) })
	jsonReply(w, 200, users)
}
func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if !decode(w, r, 8192, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !validUser(req.Name, req.Role) {
		fail(w, 400, "Enter a username and a valid role.")
		return
	}
	if !validPassword(req.Password) {
		fail(w, 400, "Enter a password (up to 1024 bytes).")
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		fail(w, 500, "Could not secure password.")
		return
	}
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	d := cloneAuth(a.auth.data)
	if len(d.Users) >= 500 {
		fail(w, 409, "User limit reached.")
		return
	}
	if !uniqueName(d, req.Name, "") {
		fail(w, 409, "That username is already taken.")
		return
	}
	u := user{ID: rand.Text(), Name: req.Name, Role: req.Role, Created: a.now().UTC(), PasswordHash: hash}
	d.Users[u.ID] = u
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not create user.")
		return
	}
	jsonReply(w, 201, u.public())
}
func (a *app) updateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		Role string `json:"role"`
	}
	if !decode(w, r, 1024, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !validUser(req.Name, req.Role) {
		fail(w, 400, "Enter a username and a valid role.")
		return
	}
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	d := cloneAuth(a.auth.data)
	u, ok := d.Users[r.PathValue("id")]
	if !ok {
		fail(w, 404, "User not found.")
		return
	}
	if u.Role == "admin" && u.PasswordHash != "" && req.Role != "admin" && adminCount(d) == 1 {
		fail(w, 409, "Keep at least one admin with a password.")
		return
	}
	if !uniqueName(d, req.Name, u.ID) {
		fail(w, 409, "That username is already taken.")
		return
	}
	u.Name = req.Name
	u.Role = req.Role
	d.Users[u.ID] = u
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not update user.")
		return
	}
	a.broadcast()
	jsonReply(w, 200, u.public())
}
func (a *app) deleteUser(w http.ResponseWriter, r *http.Request) {
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	d := cloneAuth(a.auth.data)
	u, ok := d.Users[r.PathValue("id")]
	if !ok {
		fail(w, 404, "User not found.")
		return
	}
	if u.Role == "admin" && u.PasswordHash != "" && adminCount(d) == 1 {
		fail(w, 409, "Keep at least one admin with a password.")
		return
	}
	delete(d.Users, u.ID)
	revokeSessions(d, u.ID)
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not delete user.")
		return
	}
	a.broadcast()
	w.WriteHeader(204)
}
func (a *app) resetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !decode(w, r, 8192, &req) {
		return
	}
	if !validPassword(req.Password) {
		fail(w, 400, "Enter a password (up to 1024 bytes).")
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		fail(w, 500, "Could not secure password.")
		return
	}
	a.auth.mu.Lock()
	defer a.auth.mu.Unlock()
	d := cloneAuth(a.auth.data)
	u, ok := d.Users[r.PathValue("id")]
	if !ok {
		fail(w, 404, "User not found.")
		return
	}
	u.PasswordHash = hash
	u.TokenHash = ""
	d.Users[u.ID] = u
	revokeSessions(d, u.ID)
	if a.commitAuth(d) != nil {
		fail(w, 500, "Could not reset password.")
		return
	}
	a.broadcast()
	jsonReply(w, 200, u.public())
}
