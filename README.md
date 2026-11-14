# QJSBrowser

> A web browser built from scratch, in the terminal, written mostly in JavaScript on top of QuickJS. Minimal C host, ncurses UI with a desktop-like layout, non-blocking network I/O via `epoll`, native HTTP/HTTPS with certificate validation.

![QJSBrowser screenshot](docs/screenshot.png)

---

## ✨ Features

- **Embedded JS engine** — [QuickJS](https://bellard.org/quickjs/) (Bellard), compiled into the `qjsbrowser` binary.
- **Desktop-style TUI** — ncurses (wide) with 256-color palette, Unicode box-drawing, window chrome, tab bar, toolbar, status bar.
- **Non-blocking network** — `AF_INET` sockets + `epoll`, all driven from a **JavaScript** event loop.
- **HTTP/1.0** with headers, `Content-Length`, redirects (301/302/303/307/308, limit 10, loop detection).
- **HTTPS** via OpenSSL with Memory BIOs — non-blocking handshake, SNI, **certificate + hostname validation** against the system CA bundle.
- **Cookies** — in-memory jar with domain/path matching, `Secure`, `Max-Age`/`Expires`, RFC 6265 ordering. Survives redirects.
- **Charset-aware decoding** — honors `Content-Type: charset=...`, sniffs UTF-8 vs Latin-1 when absent.
- **HTML entities** — numeric (`&#39;`, `&#x27;`) and named (`&amp;`, `&copy;`, `&mdash;`, etc.).
- **Rich links** — rendered in bright blue, clickable over their entire extent (not just the `[N]` marker).
- **Tabs** — new/close/switch via keyboard (`Ctrl+T`, `Ctrl+W`) or mouse. Each tab keeps its own history, scroll, mode, status.
- **Mouse** — click tabs, toolbar buttons, address bar, links; wheel to scroll.
- **History** — per-tab back/forward (`[`, `]`).
- **Everything else is JS** — the C code only exposes primitives: syscalls, ncurses, OpenSSL.

---

## 🚀 Quick start

### Requirements

- `gcc`, `make`, `curl`, `tar`, `pkg-config`
- `libncursesw5-dev` (or equivalent; **`ncursesw`, not `ncurses`**)
- `libssl-dev` (OpenSSL ≥ 1.1.1)
- `ca-certificates` (for TLS verification)
- A UTF-8 locale (glibc ≥ 2.35 ships `C.UTF-8` built-in)

```bash
# Debian / Ubuntu
apt install build-essential pkg-config libncursesw5-dev libssl-dev ca-certificates curl

# Alpine
apk add build-base ncurses-dev openssl-dev ca-certificates curl
```

### Build

```bash
make
```

On first run, `make` automatically downloads and builds:

- **QuickJS** `2025-09-13-2` from `bellard.org`
- **qjsNetworkSockets** from GitHub (`StringManolo/qjsNetworkSockets`)

Both are vendored into the project tree. Subsequent builds only recompile what changed.

### Run

```bash
./qjsbrowser ./lib/network_sockets.so ./lib/tui.so ./lib/tls.so ./main.js
```

All four arguments are optional (defaults are provided). Add a `make run` target if you prefer:

```makefile
run: all
	./qjsbrowser ./lib/network_sockets.so ./lib/tui.so ./lib/tls.so ./main.js

.PHONY: run
```

### Cleanup

| Command | Effect |
|---|---|
| `make clean` | Removes binaries (`.so`, `.o`, `qjsbrowser`), keeps downloaded sources |
| `make clean-src` | Removes downloaded sources, keeps binaries |
| `make distclean` | Everything — back to "freshly cloned" state |

---

## ⌨️ Keybindings

### Global

| Key | Action |
|---|---|
| `Ctrl+C` | Quit |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close current tab (in page mode) |
| `Tab` | Toggle between address bar and page |

### Omnibox mode (address bar)

| Key | Action |
|---|---|
| `Enter` | Navigate to URL |
| `Esc` | Back to page mode |
| `←` / `→` / `Home` / `End` | Move cursor |
| `Backspace` / `Delete` | Delete character |
| `Ctrl+U` / `Ctrl+L` | Clear line |
| `Ctrl+W` | Delete word |

### Page mode

| Key | Action |
|---|---|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Space` | Page down |
| `b` | Page up |
| `1`–`9` | Follow link N |
| `[` / `]` | Back / forward |
| `r` | Reload |
| `g` / `:` | Edit URL (returns to omnibox) |
| `q` | Quit |

### Mouse

| Action | Result |
|---|---|
| Click tab | Activate it |
| Click `×` on a tab | Close it |
| Click `+` | New tab |
| Click `◀` `▶` `⟳` `⌂` | Toolbar actions |
| Click address bar | Focus omnibox |
| Click anywhere on a blue link | Follow it |
| Wheel up/down | Scroll page |

---

## 🏛️ Architecture

Four strict layers. Only the top one is touched to add features.

```
┌──────────────────────────────────────────────────────────────┐
│  main.js + src/**/*.js                                       │
│  ▸ Event loop (while + net.epoll_wait)                       │
│  ▸ HTTP client (fetch, TLS handshake, redirects, cookies)    │
│  ▸ Charset-aware decoding, HTML → segments                   │
│  ▸ Widgets (tab bar, toolbar, omnibox, page view, status)    │
│  ▸ Tab manager + per-tab state                               │
│  ▸ Controller (input routing, mouse, modes)                  │
├──────────────────────────────────────────────────────────────┤
│  lib/network_sockets.so   lib/tui.so   lib/tls.so            │
│  ▸ syscalls + epoll       ▸ ncursesw   ▸ OpenSSL BIOs        │
│  ▸ C modules loaded via dlopen; JS_* symbols resolved        │
│    from the host executable (linked with -rdynamic)          │
├──────────────────────────────────────────────────────────────┤
│  qjsbrowser (C host, ~100 lines)                             │
│  ▸ setlocale + ensure_utf8_locale                            │
│  ▸ JSRuntime / JSContext                                     │
│  ▸ JS_SetModuleLoaderFunc → loads .so and .js               │
│  ▸ Runs main.js, drains jobs, exits                          │
└──────────────────────────────────────────────────────────────┘
```

### Why this split

- **`-rdynamic`** exports the `JS_*` symbols from the executable. The `.so` modules are loaded with `dlopen` and resolve `JS_NewObject`, `JS_ToCString`, etc. from the host. **They never link QuickJS themselves**, avoiding duplicate runtimes in memory.
- **The event loop lives in JS.** `net.epoll_wait` is a syscall exposed as a function; the `while (running) { ... }` is in `main.js`. Adding a new fd (tab, parallel request, timer) is one line of JS.
- **Binary safety across the JS/C boundary.** TLS ciphertext, socket reads/writes, and `Uint8Array` interop use `JS_NewArrayBufferCopy` / `JS_GetArrayBuffer` (not `JS_NewStringLen`), so multibyte sequences survive round-trips.
- **Per-tab state.** Each tab owns its omnibox, page view, history, mode, status. The HTTP client tags every connection with `options.tabId`; callbacks route responses back to the right tab even after redirects.

---

## 📁 Project layout

```
QJSBrowser/
├── main.js                         # entry point: wires everything + event loop
├── Makefile
├── c/
│   ├── main.c                      # host: dlopen + QuickJS init + loader
│   ├── tui.c                       # ncursesw wrapper + color + mouse
│   └── tls.c                       # OpenSSL wrapper (Memory BIOs)
├── lib/                            # artifacts (git-ignored)
│   ├── network_sockets.so
│   ├── tui.so
│   └── tls.so
├── scripts/                        # install & helper scripts
├── src/
│   ├── base/
│   │   ├── url.js                  # parseUrl, resolveUrl, normalizeUrl
│   │   └── keys.js                 # key map (ASCII + ncurses)
│   ├── net/
│   │   ├── http-parser.js          # parseHttpResponse, isRedirect
│   │   ├── http-client.js          # non-blocking fetch + TLS + redirects + cookies
│   │   └── cookies.js              # RFC 6265 cookie jar
│   ├── content/
│   │   └── html-to-text.js         # HTML → rich segments + links + entities
│   ├── ui/
│   │   ├── theme.js                # 256-color palette definition
│   │   ├── window.js               # window chrome helper
│   │   ├── tab-bar.js              # tab bar widget (clickable)
│   │   ├── toolbar.js              # toolbar widget (clickable)
│   │   ├── omnibox.js              # address bar state machine
│   │   └── page-view.js            # rich-segment rendering with scroll
│   └── browser/
│       ├── tab.js                  # per-tab state factory
│       ├── tab-manager.js          # tabs collection + active index
│       ├── history.js              # back/forward stack
│       └── controller.js           # input routing, mouse, orchestration
└── quickjs-2025-09-13/             # vendored (auto-downloaded)
└── qjsNetworkSockets-main/         # vendored (auto-downloaded)
```

No JS file exceeds ~350 lines. To add a feature (e.g. find-in-page), create `src/ui/find-bar.js` + wire it in `controller.js`.

---

## 🛠️ Development

### Modifying a JS module

Just edit the file. No C rebuild needed.

```bash
./qjsbrowser ./lib/network_sockets.so ./lib/tui.so ./lib/tls.so ./main.js
```

If a module fails to load, you'll see on `stderr`:

```
[loader] src/net/http-client.js: SyntaxError: unexpected token
```

To debug without corrupting the ncurses UI, redirect `stderr` to a file:

```bash
./qjsbrowser ... 2>debug.log &   # in another terminal: tail -f debug.log
```

### Adding a new syscall / primitive

1. Add the C function to the relevant `.so` (`c/tui.c`, `c/tls.c`, etc.).
2. Register it in the module's `JSCFunctionListEntry` array.
3. `make lib/tui.so` (only that `.so` is recompiled).
4. Call it from JS: `tui.newFunction(...)`.

### Adding a new UI widget

1. Create `src/ui/my-widget.js` exporting a factory function.
2. It receives `(tui, theme)` and returns an object with `render(...)` and optionally `hitTest(x, y)`.
3. Instantiate it in `controller.js` and call its `render` from the main `render()`.
4. For click support, call its `hitTest` from `handleMouse` before falling through to page click.

---

## ⚠️ Known limitations

| Area | Status | Notes |
|---|---|---|
| **HTTP/1.0 only** | ✅ | No keep-alive, no chunked encoding. `Connection: close` terminates after the response. |
| **HTTP/1.1 chunked** | ❌ | Some servers require it. Would need an incremental parser. |
| **`<script>` execution** | ❌ | HTML is stripped, scripts don't run. No DOM, no CSS. |
| **Images** | ❌ | Text only. Kitty/Sixel would be the next jump. |
| **Forms / POST** | ❌ | GET only. |
| **Cookies persistence** | ❌ | In-memory only. Cleared on exit. |
| **TLS 1.3** | ⚠️ | Capped to TLS 1.2 to avoid `key_share` issues over Memory BIOs. |
| **ALPN / HTTP/2** | ❌ | Always negotiates HTTP/1.x. |
| **Certificate pinning** | ❌ | System CA bundle only. |
| **Visited links** | ❌ | No per-URL state yet. `theme.js` has the color pair ready. |
| **Underlined links** | ❌ | Bright blue only. Underline needs an `A_UNDERLINE` extension to `printPair`. |
| **Tab overflow** | ⚠️ | Tabs beyond the width limit are simply not drawn. Close some with `×`. |
| **Binary body content** | ⚠️ | Body is decoded as text. Images/PDFs would need `Uint8Array` downstream of the decoder. |

---

## 🗺️ Roadmap

In impact order (highest first):

1. **`<script>` execution** — mini-DOM in JS + isolate page context from browser context. Enables SPAs.
2. **Forms + POST** — submit `<form>` on Enter.
3. **gzip / deflate** — small `zlib.so` for servers that ignore `Accept-Encoding: identity`.
4. **Chunked transfer encoding** — incremental response parser.
5. **Persistent cookies** — write the jar to disk between sessions.
6. **Images (Kitty graphics)** — `tui.image(x, y, w, h, png)` in `c/tui.c`, render `<img>` inline.
7. **Find in page** — `Ctrl+F` opens a find-bar widget, highlights matches.
8. **Visited link colors** — remember which URLs were visited, use `theme.pairs.visited`.
9. **TLS 1.3** — switch `tls.so` to a different handshake strategy (or wait for OpenSSL to fix the `key_share` issue).
10. **Bookmarks** — persistent list, `Ctrl+D` to add, `:bookmarks` to open.

