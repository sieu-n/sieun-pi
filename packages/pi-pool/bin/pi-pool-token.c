/* pi-pool-token: the models.json token hook as a thin client of `pi-pool hookd` (pool/hookd.py).

   With token arguments, or `--cli <command>` (the /account extension's calls), and a stdout that is not a
   terminal, it hands its argv, environment, cwd, parent pid and fds 0, 1 and 2 to hookd on
   <pool dir>/hook.sock, so the output goes straight to the caller's pipe and no Python starts. Anything else
   (--status, `--cli token` and `--cli watch`, other arguments, a terminal), a socket that does not answer,
   or an "F" answer runs the Python hook, pi-pool-token.py next to this file, with the same argv.
   Once the whole request is sent hookd may have run it, so a connection that drops then exits 1 and
   never runs the Python path: one request never vends twice.

   install.py builds this file with cc into the release as bin/pi-pool-token. */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#define SEND_FLAGS MSG_NOSIGNAL
#else
#include <mach-o/dyld.h>
#define SEND_FLAGS 0
#endif

extern char **environ;

static int sock = -1;
static char script[PATH_MAX + 32];

struct buf {
    char *data;
    size_t len, cap;
};

static void put(struct buf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t cap = (b->len + n + 1) * 2;
        char *grown = realloc(b->data, cap);
        if (!grown) {
            perror("pi-pool-token");
            exit(1);
        }
        b->data = grown;
        b->cap = cap;
    }
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len++] = '\0';
}

static void put_str(struct buf *b, const char *s) { put(b, s, strlen(s)); }

static void put_num(struct buf *b, long n) {
    char text[32];
    snprintf(text, sizeof text, "%ld", n);
    put_str(b, text);
}

/* The Python hook: pi-pool-token.py in the folder this executable really lives in. */
static int find_script(void) {
    char exe[PATH_MAX], real[PATH_MAX];
#ifdef __linux__
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n <= 0) return -1;
    exe[n] = '\0';
#else
    uint32_t size = sizeof exe;
    if (_NSGetExecutablePath(exe, &size) != 0) return -1;
#endif
    if (!realpath(exe, real)) return -1;
    char *slash = strrchr(real, '/');
    if (!slash) return -1;
    *slash = '\0';
    snprintf(script, sizeof script, "%s/pi-pool-token.py", real);
    return 0;
}

static void run_python(char **argv) {
    if (sock >= 0) close(sock);
    argv[0] = script;
    execv(script, argv);
    fprintf(stderr, "pi-pool-token: cannot run %s: %s\n", script, strerror(errno));
    exit(127);
}

/* The same arguments bin/pi-pool-token.py's token path takes: none, or --provider <p> pairs. */
static int token_args(int argc, char **argv) {
    for (int i = 1; i < argc;) {
        if (strcmp(argv[i], "--provider") == 0 && i + 1 < argc && argv[i + 1][0] != '-')
            i += 2;
        else
            return 0;
    }
    return 1;
}

/* `--cli <command>` for a command hookd runs. token prints a credential and watch holds a terminal, so they
   stay on the Python hook; serve and hookd are servers of their own. */
static int cli_args(int argc, char **argv) {
    if (argc < 2 || strcmp(argv[1], "--cli") != 0) return 0;
    if (argc == 2) return 1;
    static const char *python_only[] = {"token", "watch", "serve", "hookd"};
    for (size_t i = 0; i < sizeof python_only / sizeof *python_only; i++)
        if (strcmp(argv[2], python_only[i]) == 0) return 0;
    return 1;
}

/* <pool dir>/hook.sock, with the pool dir as pool/base.py computes it. */
static int socket_path(char *out, size_t size) {
    const char *dir = getenv("PI_POOL_DIR");
    char home[PATH_MAX];
    if (dir && *dir) return snprintf(out, size, "%s/hook.sock", dir) < (int)size ? 0 : -1;
    const char *h = getenv("HOME");
    if (!h) {
        struct passwd *pw = getpwuid(getuid());
        if (!pw) return -1;
        h = pw->pw_dir;
    }
    snprintf(home, sizeof home, "%s", h);
    size_t n = strlen(home);
    while (n > 0 && home[n - 1] == '/') home[--n] = '\0';
    return snprintf(out, size, "%s/.config/pi-pool/hook.sock", home) < (int)size ? 0 : -1;
}

static volatile sig_atomic_t termed = 0;

static void on_term(int signum) {
    (void)signum;
    termed = 1;
    if (sock >= 0) send(sock, "T", 1, SEND_FLAGS);
}

/* The run ended with no answer. After a SIGTERM that is the kill the Python path would have died of. */
static int dropped(void) {
    if (termed) {
        signal(SIGTERM, SIG_DFL);
        raise(SIGTERM);
    }
    return 1;
}

static int send_all(const char *data, size_t len, int with_fds) {
    while (len > 0) {
        struct iovec iov = {(void *)data, len};
        struct msghdr msg = {0};
        union {
            char space[CMSG_SPACE(3 * sizeof(int))];
            struct cmsghdr align;
        } control;
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        if (with_fds) {
            int fds[3] = {0, 1, 2};
            memset(&control, 0, sizeof control);
            msg.msg_control = control.space;
            msg.msg_controllen = sizeof control.space;
            struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
            c->cmsg_level = SOL_SOCKET;
            c->cmsg_type = SCM_RIGHTS;
            c->cmsg_len = CMSG_LEN(sizeof fds);
            memcpy(CMSG_DATA(c), fds, sizeof fds);
        }
        ssize_t sent = sendmsg(sock, &msg, SEND_FLAGS);
        if (sent < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        data += sent;
        len -= (size_t)sent;
        with_fds = 0;
    }
    return 0;
}

int main(int argc, char **argv) {
#ifdef __linux__
    /* Linux's /bin/sh (dash) runs the hook as a child, so Prime's timeout SIGTERM reaches only the shell. */
    prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0);
#endif
    if (find_script() != 0) {
        fprintf(stderr, "pi-pool-token: cannot find its own folder\n");
        return 127;
    }
    if (!(token_args(argc, argv) || cli_args(argc, argv)) || isatty(1)) run_python(argv);

    char path[sizeof(((struct sockaddr_un *)0)->sun_path)], cwd[PATH_MAX];
    if (socket_path(path, sizeof path) != 0 || !getcwd(cwd, sizeof cwd)) run_python(argv);
    sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) run_python(argv);
#ifndef __linux__
    int one = 1;
    setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    struct sockaddr_un addr = {0};
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, path, strlen(path) + 1);
    if (connect(sock, (struct sockaddr *)&addr, sizeof addr) != 0) run_python(argv);

    struct buf req = {0};
    put(&req, "PPH1", 4);
    put_str(&req, "fd");
    put_num(&req, (long)getppid());
    put_str(&req, cwd);
    put_str(&req, script);
    put_num(&req, argc - 1);
    for (int i = 1; i < argc; i++) put_str(&req, argv[i]);
    long envc = 0;
    for (char **e = environ; *e; e++) envc++;
    put_num(&req, envc);
    for (char **e = environ; *e; e++) put_str(&req, *e);
    if (send_all(req.data, req.len, 1) != 0) run_python(argv);

    /* From here hookd may be running the request. */
    struct sigaction term = {0};
    term.sa_handler = on_term;
    sigemptyset(&term.sa_mask);
    sigaction(SIGTERM, &term, NULL);

    char answer[64];
    size_t got = 0;
    while (got < sizeof answer - 1) {
        ssize_t n = recv(sock, answer + got, sizeof answer - 1 - got, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return dropped();
        got += (size_t)n;
        answer[got] = '\0';
        if (strchr(answer, '\n')) break;
    }
    if (strncmp(answer, "F\n", 2) == 0) run_python(argv);
    if (strncmp(answer, "X ", 2) == 0) return atoi(answer + 2);
    return dropped();
}
