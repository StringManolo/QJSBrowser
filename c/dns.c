/*
 * dns.so — asynchronous DNS for the epoll event loop.
 *
 * getaddrinfo() is blocking and has no portable async variant, so each
 * lookup runs in a short-lived detached worker thread. Worker threads never
 * touch QuickJS: they only push a result into a mutex-protected list and
 * write one byte to a pipe. The JS side adds dns.fd() to epoll, and when it
 * becomes readable calls dns.poll() to collect finished lookups.
 *
 *   dns.resolve(host) -> id      start a lookup (never blocks)
 *   dns.fd()          -> fd      read end of the wakeup pipe (add to epoll)
 *   dns.poll()        -> [{id, ip, error}]   drain finished lookups
 *
 * IPv4 only, to match the AF_INET sockets used by http-client.js.
 *
 * Build with -DDNS_TEST to exclude the QuickJS glue and test the core.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

#ifndef DNS_TEST
#include "quickjs.h"
#endif

/* ------------------------------------------------------------------ */
/* Core (no QuickJS)                                                   */
/* ------------------------------------------------------------------ */

typedef struct dns_result {
    int id;
    char ip[INET_ADDRSTRLEN];   /* empty string on failure */
    char err[128];              /* empty string on success */
    struct dns_result *next;
} dns_result;

typedef struct {
    int id;
    char host[256];
} dns_request;

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t  g_once = PTHREAD_ONCE_INIT;
static int g_pipe[2] = { -1, -1 };
static int g_next_id = 1;
static dns_result *g_head = NULL, *g_tail = NULL;

static void set_nonblock_cloexec(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    int fdfl = fcntl(fd, F_GETFD, 0);
    if (fdfl >= 0) fcntl(fd, F_SETFD, fdfl | FD_CLOEXEC);
}

static void core_init_once(void) {
    if (pipe(g_pipe) != 0) { g_pipe[0] = g_pipe[1] = -1; return; }
    set_nonblock_cloexec(g_pipe[0]);
    set_nonblock_cloexec(g_pipe[1]);
}

static int core_fd(void) {
    pthread_once(&g_once, core_init_once);
    return g_pipe[0];
}

static void *worker(void *arg) {
    dns_request *rq = arg;
    dns_result *res = calloc(1, sizeof(*res));
    if (!res) { free(rq); return NULL; }
    res->id = rq->id;

    struct addrinfo hints, *ai = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int rc = getaddrinfo(rq->host, NULL, &hints, &ai);
    if (rc != 0 || !ai) {
        snprintf(res->err, sizeof(res->err), "%s", rc ? gai_strerror(rc) : "no address");
    } else {
        struct sockaddr_in *sa = (struct sockaddr_in *)ai->ai_addr;
        if (!inet_ntop(AF_INET, &sa->sin_addr, res->ip, sizeof(res->ip)))
            snprintf(res->err, sizeof(res->err), "inet_ntop failed");
    }
    if (ai) freeaddrinfo(ai);
    free(rq);

    /* Publish the result BEFORE waking the main thread. */
    pthread_mutex_lock(&g_lock);
    if (g_tail) g_tail->next = res; else g_head = res;
    g_tail = res;
    pthread_mutex_unlock(&g_lock);

    char b = 1;
    ssize_t w = write(g_pipe[1], &b, 1);   /* EAGAIN = a wakeup is already pending */
    (void)w;
    return NULL;
}

/* Returns request id (>0), or -1 with errno set. */
static int core_resolve(const char *host) {
    if (core_fd() < 0) return -1;
    if (!host || !*host || strlen(host) >= sizeof(((dns_request *)0)->host)) {
        errno = EINVAL;
        return -1;
    }
    dns_request *rq = calloc(1, sizeof(*rq));
    if (!rq) return -1;
    strcpy(rq->host, host);

    pthread_mutex_lock(&g_lock);
    rq->id = g_next_id++;
    pthread_mutex_unlock(&g_lock);
    int id = rq->id;

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&attr, 256 * 1024);
    pthread_t th;
    int rc = pthread_create(&th, &attr, worker, rq);
    pthread_attr_destroy(&attr);
    if (rc != 0) { free(rq); errno = rc; return -1; }
    return id;
}

/* Drain the wakeup pipe, then detach and return the finished list. */
static dns_result *core_take(void) {
    char buf[64];
    while (read(g_pipe[0], buf, sizeof(buf)) > 0) { /* drain */ }
    pthread_mutex_lock(&g_lock);
    dns_result *h = g_head;
    g_head = g_tail = NULL;
    pthread_mutex_unlock(&g_lock);
    return h;
}

/* ------------------------------------------------------------------ */
/* QuickJS glue                                                        */
/* ------------------------------------------------------------------ */
#ifndef DNS_TEST

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSValue js_dns_resolve(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "dns.resolve(host)");
    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host) return JS_EXCEPTION;
    int id = core_resolve(host);
    int e = errno;
    JS_FreeCString(ctx, host);
    if (id < 0) return JS_ThrowInternalError(ctx, "dns.resolve failed: %s", strerror(e));
    return JS_NewInt32(ctx, id);
}

static JSValue js_dns_fd(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int fd = core_fd();
    if (fd < 0) return JS_ThrowInternalError(ctx, "dns: cannot create wakeup pipe");
    return JS_NewInt32(ctx, fd);
}

static JSValue js_dns_poll(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue arr = JS_NewArray(ctx);
    if (core_fd() < 0) return arr;

    dns_result *r = core_take();
    uint32_t i = 0;
    while (r) {
        dns_result *next = r->next;
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "id", JS_NewInt32(ctx, r->id));
        JS_SetPropertyStr(ctx, o, "ip",
            r->ip[0] ? JS_NewString(ctx, r->ip) : JS_NULL);
        JS_SetPropertyStr(ctx, o, "error",
            r->err[0] ? JS_NewString(ctx, r->err) : JS_NULL);
        JS_SetPropertyUint32(ctx, arr, i++, o);
        free(r);
        r = next;
    }
    return arr;
}

static const JSCFunctionListEntry dns_funcs[] = {
    JS_CFUNC_DEF("resolve", 1, js_dns_resolve),
    JS_CFUNC_DEF("fd",      0, js_dns_fd),
    JS_CFUNC_DEF("poll",    0, js_dns_poll),
};

static int dns_mod_init(JSContext *ctx, JSModuleDef *m) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, obj, dns_funcs, countof(dns_funcs));
    JS_SetModuleExport(ctx, m, "default", obj);
    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name) {
    JSModuleDef *m = JS_NewCModule(ctx, module_name, dns_mod_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}

#else /* DNS_TEST: standalone driver for the core */

#include <poll.h>
#include <time.h>

static double now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(void) {
    const char *hosts[] = { "localhost", "this-host-does-not-exist.invalid", "127.0.0.1", "localhost" };
    int n = (int)(sizeof(hosts) / sizeof(hosts[0]));
    int fd = core_fd();
    double t0 = now_ms();
    int ids[8];
    for (int i = 0; i < n; i++) {
        ids[i] = core_resolve(hosts[i]);
        printf("started #%d -> %s   (+%.2f ms, call returned immediately)\n",
               ids[i], hosts[i], now_ms() - t0);
    }
    int done = 0;
    while (done < n) {
        struct pollfd p = { fd, POLLIN, 0 };
        if (poll(&p, 1, 5000) <= 0) { printf("TIMEOUT waiting for DNS\n"); return 1; }
        dns_result *r = core_take();
        while (r) {
            printf("  done #%d  ip=%-15s err=%s\n", r->id, r->ip[0] ? r->ip : "-", r->err[0] ? r->err : "-");
            dns_result *nx = r->next; free(r); r = nx; done++;
        }
    }
    /* stress: many lookups at once, none may be lost */
    int N = 200, got = 0;
    for (int i = 0; i < N; i++) core_resolve("localhost");
    double t1 = now_ms();
    while (got < N && now_ms() - t1 < 5000) {
        struct pollfd p = { fd, POLLIN, 0 };
        if (poll(&p, 1, 1000) <= 0) continue;
        dns_result *r = core_take();
        while (r) { dns_result *nx = r->next; free(r); r = nx; got++; }
    }
    printf("stress: %d/%d results received\n", got, N);
    return got == N ? 0 : 1;
}
#endif
