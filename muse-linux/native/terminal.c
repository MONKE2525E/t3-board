#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

/* Build (packaging / native-build):
 *   cc -std=gnu11 -O2 -Wall -Wextra -Werror native/terminal.c -o native/bin/muse-terminal
 * No extra libraries. Install next to muse-accessibility as muse-terminal.
 *
 * argv: muse-terminal <cols> <rows> -- <command> [args...]
 * cwd inherited. fd 0 -> PTY, fd 1 <- PTY, fd 2 JSON events, fd 3 "resize COLS ROWS\n".
 * Child calls setsid() so it is a fresh session leader. Stop kills that session only:
 * tcgetpgrp(master) plus every /proc entry whose SID matches the child session.
 */

static pid_t child_pid;
static pid_t child_sid;
static int master_fd = -1;
static volatile sig_atomic_t child_status;
static volatile sig_atomic_t child_dead;
static volatile sig_atomic_t stop_requested;

static const char *signal_name(int sig) {
  switch (sig) {
    case SIGHUP: return "SIGHUP";
    case SIGINT: return "SIGINT";
    case SIGQUIT: return "SIGQUIT";
    case SIGKILL: return "SIGKILL";
    case SIGTERM: return "SIGTERM";
    case SIGPIPE: return "SIGPIPE";
    case SIGUSR1: return "SIGUSR1";
    case SIGUSR2: return "SIGUSR2";
    default: return NULL;
  }
}

static void fail(const char *message) {
  fprintf(stderr, "{\"event\":\"error\",\"message\":\"%s\"}\n", message);
  fflush(stderr);
  _exit(1);
}

static int parse_size(const char *text, int fallback) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (!text || !*text || !end || *end || value < 2 || value > 1000) return fallback;
  return (int)value;
}

static void set_winsize(int fd, int cols, int rows) {
  struct winsize size;
  memset(&size, 0, sizeof size);
  size.ws_col = (unsigned short)cols;
  size.ws_row = (unsigned short)rows;
  ioctl(fd, TIOCSWINSZ, &size);
}

static void on_chld(int sig) {
  int status;
  pid_t pid;
  (void)sig;
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    if (pid == child_pid) {
      child_status = status;
      child_dead = 1;
    }
  }
}

static void on_stop(int sig) {
  stop_requested = sig == SIGINT ? SIGINT : SIGTERM;
}

static int write_all(int fd, const char *buf, ssize_t length) {
  ssize_t offset = 0;
  while (offset < length) {
    ssize_t wrote = write(fd, buf + offset, (size_t)(length - offset));
    if (wrote < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        struct pollfd wait = { .fd = fd, .events = POLLOUT };
        if (poll(&wait, 1, 1000) < 0 && errno != EINTR) return -1;
        continue;
      }
      return -1;
    }
    offset += wrote;
  }
  return 0;
}

static void apply_resize_line(char *line) {
  int cols = 0, rows = 0;
  if (sscanf(line, "resize %d %d", &cols, &rows) != 2) return;
  if (cols < 2 || cols > 1000 || rows < 2 || rows > 1000) return;
  if (master_fd >= 0) set_winsize(master_fd, cols, rows);
}

static int read_proc_stat(pid_t pid, pid_t *pgrp, pid_t *sid) {
  char path[64], buf[4096];
  snprintf(path, sizeof path, "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return -1;
  buf[n] = 0;
  char *rparen = strrchr(buf, ')');
  if (!rparen) return -1;
  char state = 0;
  pid_t ppid = 0, pg = 0, sess = 0;
  if (sscanf(rparen + 1, " %c %d %d %d", &state, &ppid, &pg, &sess) != 4) return -1;
  if (pgrp) *pgrp = pg;
  if (sid) *sid = sess;
  return 0;
}

static void send_sig(pid_t pid, int sig) {
  if (pid <= 1 || pid == getpid()) return;
  kill(pid, sig);
}

static void send_group(pid_t pgid, int sig) {
  if (pgid <= 1 || pgid == getpid()) return;
  if (kill(-pgid, sig) < 0) send_sig(pgid, sig);
}

static void kill_owned_session(int sig) {
  pid_t sid = child_sid > 0 ? child_sid : 0;
  pid_t pgrp = 0;
  if (child_pid > 0 && read_proc_stat(child_pid, &pgrp, &sid) == 0 && child_sid <= 0) child_sid = sid;
  if (sid <= 0 && child_pid > 0) sid = child_pid;
  if (master_fd >= 0) {
    pid_t fg = tcgetpgrp(master_fd);
    if (fg > 1) send_group(fg, sig);
  }
  DIR *dir = opendir("/proc");
  if (dir && sid > 0) {
    struct dirent *ent;
    pid_t seen[256];
    int nseen = 0;
    while ((ent = readdir(dir))) {
      if (!isdigit((unsigned char)ent->d_name[0])) continue;
      pid_t pid = (pid_t)atoi(ent->d_name);
      if (pid <= 1 || pid == getpid()) continue;
      pid_t pg = 0, sess = 0;
      if (read_proc_stat(pid, &pg, &sess) < 0 || sess != sid) continue;
      send_sig(pid, sig);
      int dup = 0;
      for (int i = 0; i < nseen; i++) if (seen[i] == pg) dup = 1;
      if (!dup && nseen < 256) seen[nseen++] = pg;
      if (pg > 1) send_group(pg, sig);
    }
    closedir(dir);
  }
  if (pgrp > 1) send_group(pgrp, sig);
  if (child_pid > 1) {
    send_group(child_pid, sig);
    send_sig(child_pid, sig);
  }
}

static void wipe_owned(void) {
  kill_owned_session(SIGTERM);
  kill_owned_session(SIGKILL);
}

int main(int argc, char **argv) {
  if (argc < 5 || strcmp(argv[3], "--") != 0 || !argv[4] || !argv[4][0]) fail("usage");
  int cols = parse_size(argv[1], 80);
  int rows = parse_size(argv[2], 24);
  char **command = argv + 4;

  signal(SIGPIPE, SIG_IGN);
  struct sigaction child_action;
  memset(&child_action, 0, sizeof child_action);
  child_action.sa_handler = on_chld;
  sigemptyset(&child_action.sa_mask);
  child_action.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGCHLD, &child_action, NULL);
  struct sigaction stop_action;
  memset(&stop_action, 0, sizeof stop_action);
  stop_action.sa_handler = on_stop;
  sigemptyset(&stop_action.sa_mask);
  stop_action.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &stop_action, NULL);
  sigaction(SIGINT, &stop_action, NULL);
  sigaction(SIGHUP, &stop_action, NULL);
  atexit(wipe_owned);

  master_fd = posix_openpt(O_RDWR | O_NOCTTY);
  if (master_fd < 0) fail("pty_open_failed");
  if (grantpt(master_fd) < 0 || unlockpt(master_fd) < 0) fail("pty_grant_failed");
  set_winsize(master_fd, cols, rows);
  char slave_name[128];
  if (ptsname_r(master_fd, slave_name, sizeof slave_name) != 0) fail("ptsname_failed");

  pid_t pid = fork();
  if (pid < 0) fail("fork_failed");
  if (pid == 0) {
    if (setsid() < 0) _exit(127);
    int slave = open(slave_name, O_RDWR);
    if (slave < 0) _exit(127);
    if (ioctl(slave, TIOCSCTTY, 0) < 0) { /* already controlling in some kernels */ }
    dup2(slave, 0);
    dup2(slave, 1);
    dup2(slave, 2);
    if (slave > 2) close(slave);
    if (master_fd > 2) close(master_fd);
    for (int fd = 3; fd < 256; fd++) close(fd);
    setenv("TERM", "xterm-256color", 1);
    execvp(command[0], command);
    _exit(127);
  }

  child_pid = pid;
  child_sid = pid;
  setvbuf(stderr, NULL, _IOLBF, 0);
  fprintf(stderr, "{\"event\":\"ready\",\"pid\":%d,\"sid\":%d}\n", pid, pid);
  fflush(stderr);

  int flags = fcntl(master_fd, F_GETFL, 0);
  if (flags >= 0) fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
  flags = fcntl(0, F_GETFL, 0);
  if (flags >= 0) fcntl(0, F_SETFL, flags | O_NONBLOCK);
  int control_open = fcntl(3, F_GETFD) >= 0;
  if (control_open) {
    flags = fcntl(3, F_GETFL, 0);
    if (flags >= 0) fcntl(3, F_SETFL, flags | O_NONBLOCK);
  }

  char inbuf[8192], outbuf[8192], ctlbuf[1024];
  size_t ctl_len = 0;
  int stdin_open = 1;
  int master_open = 1;
  int drained = 0;
  int wiped = 0;

  while (!drained) {
    if (child_dead && !master_open) break;
    if (stop_requested && !wiped) {
      wipe_owned();
      wiped = 1;
    }
    struct pollfd fds[3];
    nfds_t n = 0;
    int i_stdin = -1, i_master = -1, i_ctl = -1;
    if (stdin_open) { i_stdin = (int)n; fds[n].fd = 0; fds[n].events = POLLIN; n++; }
    if (master_open) { i_master = (int)n; fds[n].fd = master_fd; fds[n].events = POLLIN; n++; }
    if (control_open) { i_ctl = (int)n; fds[n].fd = 3; fds[n].events = POLLIN; n++; }
    int ready = poll(fds, n, 200);
    if (ready < 0 && errno != EINTR) break;

    if (i_stdin >= 0 && (fds[i_stdin].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t got = read(0, inbuf, sizeof inbuf);
      if (got > 0) {
        if (write_all(master_fd, inbuf, got) < 0 && errno != EIO && errno != EAGAIN) master_open = 0;
      } else if (got == 0 || (got < 0 && errno != EAGAIN && errno != EINTR && errno != EWOULDBLOCK)) {
        stdin_open = 0;
      }
    }

    if (i_master >= 0 && (fds[i_master].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t got = read(master_fd, outbuf, sizeof outbuf);
      if (got > 0) {
        if (write_all(1, outbuf, got) < 0) master_open = 0;
      } else if (got == 0 || (got < 0 && (errno == EIO || errno == ENODEV))) {
        master_open = 0;
      } else if (got < 0 && errno != EAGAIN && errno != EINTR && errno != EWOULDBLOCK) {
        master_open = 0;
      }
    }

    if (i_ctl >= 0 && (fds[i_ctl].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t got = read(3, ctlbuf + ctl_len, sizeof(ctlbuf) - ctl_len - 1);
      if (got > 0) {
        ctl_len += (size_t)got;
        ctlbuf[ctl_len] = 0;
        char *start = ctlbuf, *newline;
        while ((newline = memchr(start, '\n', ctl_len - (size_t)(start - ctlbuf)))) {
          *newline = 0;
          apply_resize_line(start);
          start = newline + 1;
        }
        size_t remain = ctl_len - (size_t)(start - ctlbuf);
        memmove(ctlbuf, start, remain);
        ctl_len = remain;
        if (ctl_len > 768) ctl_len = 0;
      } else if (got == 0 || (got < 0 && errno != EAGAIN && errno != EINTR && errno != EWOULDBLOCK)) {
        control_open = 0;
      }
    }

    if (child_dead && !master_open) drained = 1;
    if (wiped && child_dead) drained = 1;
  }

  if (!wiped) wipe_owned();
  int status = child_status;
  if (!child_dead) {
    pid_t waited = waitpid(child_pid, &status, 0);
    if (waited == child_pid) {
      child_status = status;
      child_dead = 1;
    } else {
      status = child_status;
    }
  }
  if (WIFEXITED(status)) {
    fprintf(stderr, "{\"event\":\"exit\",\"exit_code\":%d,\"signal\":null}\n", WEXITSTATUS(status));
  } else if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    const char *name = signal_name(sig);
    if (name) fprintf(stderr, "{\"event\":\"exit\",\"exit_code\":null,\"signal\":\"%s\"}\n", name);
    else fprintf(stderr, "{\"event\":\"exit\",\"exit_code\":null,\"signal\":\"SIG%d\"}\n", sig);
  } else {
    fprintf(stderr, "{\"event\":\"exit\",\"exit_code\":1,\"signal\":null}\n");
  }
  fflush(stderr);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
