# QJSBrowser

> A web browser built from scratch, in the terminal, written mostly in JavaScript on top of QuickJS. Minimal C host, ncurses UI, non-blocking network I/O via `epoll`, native HTTP/HTTPS.

```
 QJSBrowser                                                       Ctrl+C = quit
 URL> https://example.com
─────────────────────────────────────────────────────────────────────────────
Example Domain

This domain is for use in documentation examples without needing
permission. This is not a service; avoid relying on it for testing
and monitoring purposes.

HTTP 200 OK — 170 chars, 0 links  [j/k:scroll 1-9:link [:back ]:fwd ...]
```

---

## ✨ Features

- **Embedded JS engine** — [QuickJS](https://bellard.org/quickjs/) (Bellard), compiled into the `qjsbrowser` binary.
- **ncurses (wide) UI** — UTF-8, colors, full keyboard support (arrows, Home/End, Ctrl+U/W/L).
- **Non-blocking network** — `AF_INET` sockets + `epoll`, all driven from a **JavaScript** event loop.
- **HTTP/1.0** with headers, `Content-Length`, redirects (301/302/303/307/308, limit 10).
- **HTTPS** via OpenSSL with Memory BIOs — non-blocking handshake, correct SNI.
- **History** back/forward with `[` / `]`.
- **Numbered links** — `1`–`9` to follow link N on the page.
- **HTML → text** — strips `<script>`, `<style>`, extracts `<a href>`, resolves relative URLs.
- **The whole "browser" is JS.** The C code only exposes primitives: syscalls, ncurses, OpenSSL.

---

## 🚀 Quick start

### Requirements

- `gcc`, `make`, `curl`, `tar`
- `libncursesw5-dev` (or equivalent; **`ncursesw`, not `ncurses`**)
- `libssl-dev` (OpenSSL ≥ 1.1.1)
- A UTF-8 locale available (glibc ≥ 2.35 ships `C.UTF-8` built-in)

```bash
# Debian / Ubuntu
apt install build-essential pkg-config libncursesw5-dev libssl-dev curl

# Alpine
apk add build-base ncurses-dev openssl-dev curl
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

All four arguments are optional (defaults are provided). You can add a `make run` target if you prefer.

### Cleanup

| Command | Effect |
|---|---|
| `make clean` | Removes binaries (`.so`, `.o`, `qjsbrowser`), keeps downloaded sources |
| `make clean-src` | Removes downloaded sources, keeps binaries |
| `make distclean` | Everything — back to "freshly cloned" state |

---

## ⌨️ Keybindings

### Omnibox mode (URL editing)

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
| `g` / `:` | Edit URL |
| `q` | Quit |
| `Ctrl+C` | Quit (from any mode) |

---

## 🏛️ Architecture

Three strict layers. Only the top one is touched to add features.

```
┌──────────────────────────────────────────────────────────────┐
│  main.js + src/**/*.js                                       │
│  ▸ Event loop (while + net.epoll_wait)                       │
│  ▸ HTTP client (fetch, redirects, receive loop)              │
│  ▸ HTML → text                                               │
│  ▸ Widgets (omnibox, page-view, status-bar)                  │
│  ▸ Controller (key routing, modes, history)                  │
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
- **The `.so` modules are stateless where possible.** `tls.so` does hold per-connection state (required by OpenSSL) but identifies it by an opaque handle that JS owns. `network_sockets.so` is 100% pure syscalls.

---

## 📁 Project layout

```
QJSBrowser/
├── main.js                         # entry point: wires everything + event loop
├── Makefile
├── c/
│   ├── main.c                      # host: dlopen + QuickJS init + loader
│   ├── tui.c                       # ncursesw wrapper
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
│   │   └── http-client.js          # non-blocking fetch + TLS + redirects
│   ├── content/
│   │   └── html-to-text.js         # HTML strip + numbered links
│   ├── ui/
│   │   ├── omnibox.js
│   │   ├── page-view.js
│   │   └── status-bar.js
│   └── browser/
│       ├── history.js
│       └── controller.js           # modes, routing, orchestration
└── quickjs-2025-09-13/             # vendored (auto-downloaded)
└── qjsNetworkSockets-main/         # vendored (auto-downloaded)
```

No JS file exceeds ~200 lines. To add a feature (e.g. tabs), create `src/ui/tab-bar.js` + `src/browser/tabs.js` and wire them in `main.js`. `controller.js` only grows with high-level routing logic.

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

1. Add the C function to the relevant `.so` (`c/tui.c`, etc.).
2. Register it in the module's `JSCFunctionListEntry` array.
3. `make` (only that `.so` is recompiled).
4. Call it from JS: `tui.newFunction(...)`.

### Example: exposing `fstat` from `network_sockets`

If you ever need a file's size before reading it, it's a ~10-line C function + one array entry. No changes to `main.c` or the rest of the architecture.

---

## ⚠️ Known limitations

| Area | Status | Notes |
|---|---|---|
| **TLS certificate validation** | ❌ Disabled | `SSL_VERIFY_NONE` in `c/tls.c`. Accepts expired, self-signed, mismatched certs. Fix: 3 lines when you want hardening. |
| **HTTP/1.0** | ✅ | No keep-alive, no chunked encoding. `Connection: close` terminates after the response. |
| **HTTP/1.1 chunked** | ❌ | Would need an incremental parser. Some modern servers require it. |
| **`<script>` execution** | ❌ | HTML is stripped, scripts don't run. No DOM, no CSS. |
| **Images** | ❌ | Text only. Kitty/Sixel would be the next jump. |
| **Cookies** | ❌ | No `Set-Cookie` / `Cookie` handling. |
| **Forms / POST** | ❌ | GET only. |
| **Tabs** | ❌ | One active connection at a time. |
| **TLS 1.3 / ALPN** | ✅ automatic | OpenSSL negotiates it; no HTTP/2. |
| **Binary safety** | ⚠️ | Binary data travels as `JSValue` strings. QuickJS preserves bytes, but if corruption appears with non-ASCII content, migrate to `Uint8Array` in the `.so` modules. |

---

## 🗺️ Roadmap

In impact order (highest first):

1. **TLS certificate validation** — load `ca-certificates.crt` from the system, `SSL_VERIFY_PEER`, surface errors.
2. **Cookies + session** — in-memory persistence across navigations.
3. **`<script>` execution** — mini-DOM in JS + isolate page context from browser context.
4. **Chunked transfer encoding** — incremental response parser.
5. **POST + forms** — submit `<form>` on submit.
6. **Images (Kitty graphics)** — `tui.image(x, y, w, h, png)` in `c/tui.c`, render `<img>` as placeholders first, then real.
7. **Tabs** — multiple live connections, `Ctrl+T` / `Ctrl+W`.
8. **Basic CSS** — bold, italic, underline, colors. Requires a minimal layout engine.

---

## 🙏 Credits

- **[QuickJS](https://bellard.org/quickjs/)** — Fabrice Bellard. The JS engine.
- **[qjsNetworkSockets](https://github.com/StringManolo/qjsNetworkSockets)** — StringManolo. The sockets module.
- **[OpenSSL](https://www.openssl.org/)** — TLS.
- **[ncursesw](https://invisible-island.net/ncurses/)** — the UI.


