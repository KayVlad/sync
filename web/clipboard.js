// Clipboard state is separate from the editor: suggestions never become typed text.
class ClipboardDraft {
  constructor() { this.suggestion = null; this.dismissed = null; this.version = 0; }
  fingerprint(value) {
    return JSON.stringify([value.text || '', (value.files || []).map((f, i) => [f.name, f.size, f.type, f.lastModified, value.hashes?.[i]])]);
  }
  offer(value, { explicit = false, hasText = false } = {}) {
    if (hasText) return false;
    if (!value.text && !value.files?.length) {
      this.dismissed = null;
      if (!this.suggestion) return false;
      this.suggestion = null;
      this.version++;
      return true;
    }
    const fingerprint = this.fingerprint(value);
    if (!explicit && fingerprint === this.dismissed) return false;
    this.dismissed = null;
    if (fingerprint === this.suggestion?.fingerprint) return false;
    this.suggestion = { text: value.text || '', files: value.files || [], fingerprint };
    this.version++;
    return true;
  }
  dismiss() {
    if (this.suggestion) this.dismissed = this.suggestion.fingerprint;
    this.suggestion = null;
    this.version++;
  }
  take() { const value = this.suggestion; this.dismiss(); return value; }
}
globalThis.ClipboardDraft = ClipboardDraft;

function shouldRoutePageTyping(event, state) {
  return state.signedIn && !state.dialogOpen && !state.editable && !state.selection &&
    !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !event.isComposing && event.key.length === 1 &&
    !(state.interactive && event.key === ' ');
}
globalThis.shouldRoutePageTyping = shouldRoutePageTyping;
