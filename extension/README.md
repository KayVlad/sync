# sync. for Chrome

Connect to your self-hosted sync server, retrieve your items, and right-click selected text, links, images or direct videos to **Sync it**. No build step or external dependencies. Chrome 123 or newer.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `extension` directory (the folder containing `manifest.json`). If using the ZIP, extract it first and select the extracted directory.
3. Pin **sync.**, open its popup, and enter your server URL, username, and password. For this machine use `http://localhost:8080`; on another device use the homelab's LAN address.

This follows Chrome's [unpacked-extension workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked). After updating these files, click the extension's **Reload** button on `chrome://extensions`. Update the server alongside the extension: version 1.2 uses extension login, owner-only upload receipts, and idempotent send requests.

## Use

Type or paste into the composer and press **Ctrl/⌘ + Enter** to send. Pasted images/files attach to the draft; removing an attachment leaves the text intact. Pick files or drop them into the popup to queue them immediately. Folder uploads use the main app. Starting to type focuses the composer automatically.

The popup has a scrollable stack of your private items and all public items. **Copy** handles text and supported images; **Download** retrieves original bytes using Chrome's download manager. Links open a new tab. The popup refreshes every five seconds while open. **Sync URL** sends the current tab's URL in one click. The header also offers refresh, open the main app, and sign out. Search names and snippet text with **Ctrl/⌘ + F**; use **Text**, **Images**, or **Files** to filter, and click the selected filter again to show everything. Public cards offer **Link** to copy an anonymous download URL, without publishing private items. Turning off Public or reaching expiry invalidates future reads through that link.

Select text and right-click **Sync it** to send immediately. Right-click a hyperlink to send its URL, or an image to send its original source bytes. Right-click a video to send its original file; links ending in `.mp4`, `.m4v`, `.webm`, `.mov`, `.ogv`, `.mkv` or `.avi` also send the video file. Selected text takes precedence over a video-file link.

**Alt + Shift + S** sends selected text from the current page, or its URL when nothing is selected. Change the binding in `chrome://extensions/shortcuts` if Chrome reserves it or another extension uses it. Password-field selections are excluded. Selection capture is from the main frame; inaccessible iframe selections fall back to the current URL.

In the address bar, type `sync`, press Space or Tab, enter/paste an HTTP(S) URL, and press Enter to send it. Chrome's [omnibox API](https://developer.chrome.com/docs/extensions/reference/api/omnibox) supports this keyword. The [context-menu API](https://developer.chrome.com/docs/extensions/reference/api/contextMenus) does not offer the native address-bar right-click menu; use the keyword or **Sync URL** instead. URLs retain their query and fragment. Browser-internal pages and URLs containing embedded usernames/passwords are rejected.

All sends default to private and keep the server's normal 24-hour expiry. The toolbar badge shows progress, a check on success, or `!` on failure; open the popup for the result or error. Closing the popup does not stop sends. One transfer runs at a time, with four parallel file chunks. The queue offers **Pause**, **Resume**, **Retry**, and **Cancel**. Restarting Chrome pauses interrupted transfers; reopen the popup and resume them. Retries reuse the same server item instead of duplicating uploads or notes.

Files and text awaiting transfer are staged in the browser profile's IndexedDB, bound to the server and signed-in account. The queue holds at most 200 items and is also subject to browser disk quota. Signing out pauses that account's transfers; signing back into the same account restores access to them. Successful sends and cancellations remove local staged data; failed/paused jobs expire 24 hours after staging. Cleanup runs while the extension is active and on its next startup if Chrome was closed. Cancel attempts to delete the partial server upload; if the server cannot be reached, its normal 24-hour expiry removes it.

Direct HTTP(S) video files stream through four concurrent checksum-verified chunks without buffering the entire video. They use the server's file-size limit, rather than the 32 MiB image cap. The source must return a video content type (or a generic binary type with a recognized video filename) and a known, uncompressed size (`Content-Length` or a valid range response). Unsupported sources fail with an explanation. HLS/DASH playlists, MediaSource/blob playback and DRM streams cannot be captured as a single original file. Source sites can also restrict access. Transfers run in an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen), with no fixed four-minute total deadline. Network requests still have timeouts and retry limits. Range-capable sources with a strong ETag resume from verified checkpoints; other sources may need to re-read earlier bytes to verify integrity. Changes detected in the source fail the transfer rather than combining different versions. For unsupported sources, download normally and send the resulting file.

Image capture is limited to 32 MiB to bound extension memory. For bigger images, use the web app. PNG, JPEG, GIF, WebP, AVIF, BMP and SVG sources can be sent, depending on the site's response. Copy writes a still PNG; downloads preserve originals and animation. The popup only shows small previews for supported raster images. Text uses the exact selection text supplied by Chrome; it does not reconstruct rich HTML formatting.

## Access and sessions

The extension requests access to the configured server when you sign in. Context-menu activation grants temporary access to the page; cross-origin images may require an additional host-permission prompt. Video capture requests source-host permission so the queue can fetch it after the originating page closes. Access is requested per host, rather than granted to all websites at install time. See Chrome's [host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) documentation. Blob images are read from the selected frame without canvas conversion. Some protected, cross-origin iframe, anti-hotlink or browser-restricted sources cannot be fetched; failures are shown rather than silently converting the media.

Your password is sent only during sign-in and is never stored. The server issues a revocable 30-day session stored in Chrome's local extension storage, restricted to trusted extension contexts and never synced to a Google account. Restarting Chrome retains it. Sign out revokes that session; a server-side password reset or account deletion also revokes it. Website sessions remain separate. Server tokens are never attached to source-media requests, placed in link URLs, or exposed to content scripts. HTTP is supported for a trusted LAN; use HTTPS when you need encrypted transport.

Sessions and permissions are local to the browser profile. Host permissions remain in Chrome after sign-out and can be revoked from the extension's site-access settings. The extension has no analytics or third-party service.
