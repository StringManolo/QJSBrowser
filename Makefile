CC ?= gcc

QJS_VER := 2025-09-13-2
QJS_TAR := quickjs-$(QJS_VER).tar.xz
QJS_URL := https://bellard.org/quickjs/$(QJS_TAR)
QJS     := quickjs-2025-09-13

NET_REF ?= main
NET_TAR := qjsNetworkSockets-$(NET_REF).tar.gz
NET_URL := https://github.com/StringManolo/qjsNetworkSockets/archive/refs/heads/$(NET_REF).tar.gz
NET_DIR := qjsNetworkSockets-$(NET_REF)

APP_CFLAGS := -Wall -Wextra -Wno-unused-parameter -O2 -fPIC -I$(QJS)

all: qjsbrowser lib/tui.so lib/network_sockets.so

# ---------------- QuickJS ----------------
$(QJS)/quickjs.c:
	@echo ">> Descargando QuickJS $(QJS_VER)..."
	@test -f "$(QJS_TAR)" || curl -L --fail --silent --show-error -o "$(QJS_TAR)" "$(QJS_URL)"
	@tar -xf "$(QJS_TAR)"
	@test -f "$(QJS)/quickjs.c" || { echo "ERROR: extracción de QuickJS falló"; exit 1; }

$(QJS)/libquickjs.a: $(QJS)/quickjs.c
	$(MAKE) -C $(QJS) libquickjs.a

# ---------------- qjsNetworkSockets ----------------
$(NET_DIR)/src/qjs_sockets.c:
	@echo ">> Descargando qjsNetworkSockets (ref: $(NET_REF))..."
	@test -f "$(NET_TAR)" || curl -L --fail --silent --show-error -o "$(NET_TAR)" "$(NET_URL)"
	@tar -xzf "$(NET_TAR)"
	@test -f "$(NET_DIR)/src/qjs_sockets.c" || { echo "ERROR: qjs_sockets.c no encontrado"; exit 1; }

lib/network_sockets.so: $(NET_DIR)/src/qjs_sockets.c $(QJS)/quickjs.c
	@mkdir -p lib
	$(CC) -shared -fPIC -O2 -I$(QJS) -Wno-unused-parameter \
	      -o $@ $(NET_DIR)/src/qjs_sockets.c

# ---------------- app ----------------
qjsbrowser: c/main.c $(QJS)/libquickjs.a
	$(CC) $(APP_CFLAGS) -rdynamic -o $@ c/main.c $(QJS)/libquickjs.a -lm -lpthread -ldl

lib/tui.so: c/tui.c
	@mkdir -p lib
	$(CC) $(APP_CFLAGS) -shared -o $@ c/tui.c -lncursesw

# ---------------- limpieza ----------------
# clean: solo artefactos de compilación (deja las fuentes descargadas)
clean:
	rm -f qjsbrowser lib/tui.so lib/network_sockets.so
	-$(MAKE) -C $(QJS) clean >/dev/null 2>&1 || true
	-rm -f $(QJS)/*.o $(QJS)/libquickjs.a

# clean-src: solo las fuentes descargadas (conserva binarios)
clean-src:
	rm -rf $(QJS) $(QJS_TAR) $(NET_DIR) $(NET_TAR)

# distclean: vuelta al estado original del repo
distclean: clean clean-src

.PHONY: all clean clean-src distclean
