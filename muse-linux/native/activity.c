#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

/* muse-activity: physical input monitor for human takeover.
 * Root native-build.cjs compiles:
 *   cc -std=gnu11 -O2 -Wall -Wextra -Werror native/activity.c -o native/bin/muse-activity
 * No extra libraries. Opens /dev/input/event* O_RDONLY|O_NONBLOCK and never grabs a device.
 *
 * Stdout is only:
 *   {"event":"ready","available":true|false,"devices":n}
 *   {"event":"input","kind":"pointer"|"keyboard"}
 * Key codes, paths, names, and serials are never printed. Raw events are not stored.
 *
 * --self-test classifies static synthetic input_event records and never opens host devices.
 * MUSE_ACTIVITY_DISABLED=1 reports available:false without reading hardware.
 */

enum {
  MAX_DEVICES = 32,
  STDIN_MAX = 256,
  COALESCE_MS = 32,
  RESCAN_MS = 1000,
  ABS_SLACK = 8,
  KIND_POINTER = 1,
  KIND_KEYBOARD = 2,
  ABS_X_SLOT = 0,
  ABS_Y_SLOT = 1,
  ABS_MTX_SLOT = 2,
  ABS_MTY_SLOT = 3
};

struct device {
  int fd;
  int event_no;
  int32_t last_abs[4];
  unsigned have_abs;
};

static struct {
  struct device devices[MAX_DEVICES];
  int n_devices;
  char inbuf[STDIN_MAX];
  size_t inlen;
  uint32_t last_emit_ms[3];
} g;

static volatile sig_atomic_t stop_requested;

static void on_stop(int sig) {
  (void)sig;
  stop_requested = 1;
}

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000u + (uint32_t)(ts.tv_nsec / 1000000u));
}

static int emit_line(const char *line) {
  if (fputs(line, stdout) == EOF || fflush(stdout) == EOF) {
    stop_requested = 1;
    return -1;
  }
  return 0;
}

static int emit_ready(int available, int devices) {
  char line[96];
  int n = snprintf(line, sizeof line, "{\"event\":\"ready\",\"available\":%s,\"devices\":%d}\n",
                   available ? "true" : "false", devices);
  if (n < 0 || n >= (int)sizeof line) {
    stop_requested = 1;
    return -1;
  }
  return emit_line(line);
}

static int emit_input(int kind) {
  if (kind == KIND_POINTER) return emit_line("{\"event\":\"input\",\"kind\":\"pointer\"}\n");
  if (kind == KIND_KEYBOARD) return emit_line("{\"event\":\"input\",\"kind\":\"keyboard\"}\n");
  return 0;
}

static int device_allowed(const struct input_id *id) {
  if (!id) return 0;
  if (id->bustype == BUS_VIRTUAL) return 0;
  return 1;
}

static int pointer_button(unsigned code) {
  if (code >= BTN_MISC && code < BTN_JOYSTICK) return 1;
  if (code >= BTN_DIGI && code < BTN_WHEEL) return 1;
  return 0;
}

static int keyboard_key(unsigned code) {
  if (code == 0) return 0;
  if (code < BTN_MISC) return 1;
  if (code >= KEY_OK && code < BTN_TRIGGER_HAPPY) return 1;
  return 0;
}

static int abs_slot(unsigned code) {
  if (code == ABS_X) return ABS_X_SLOT;
  if (code == ABS_Y) return ABS_Y_SLOT;
  if (code == ABS_MT_POSITION_X) return ABS_MTX_SLOT;
  if (code == ABS_MT_POSITION_Y) return ABS_MTY_SLOT;
  return -1;
}

static int rel_motion(unsigned code) {
  return code == REL_X || code == REL_Y || code == REL_WHEEL || code == REL_HWHEEL
      || code == REL_DIAL || code == REL_WHEEL_HI_RES || code == REL_HWHEEL_HI_RES;
}

static int classify(const struct input_event *ev, int32_t last_abs[4], unsigned *have_abs) {
  int slot;
  int32_t delta;
  if (!ev || !last_abs || !have_abs) return 0;
  if (ev->type == EV_REL) {
    if (rel_motion(ev->code) && ev->value != 0) return KIND_POINTER;
    return 0;
  }
  if (ev->type == EV_ABS) {
    slot = abs_slot(ev->code);
    if (slot < 0) return 0;
    if (!(*have_abs & (1u << slot))) {
      last_abs[slot] = ev->value;
      *have_abs |= 1u << slot;
      return 0;
    }
    delta = ev->value - last_abs[slot];
    if (delta < 0) delta = -delta;
    last_abs[slot] = ev->value;
    if (delta >= ABS_SLACK) return KIND_POINTER;
    return 0;
  }
  if (ev->type == EV_KEY && ev->value == 1) {
    if (pointer_button(ev->code)) return KIND_POINTER;
    if (keyboard_key(ev->code)) return KIND_KEYBOARD;
  }
  return 0;
}

static int should_emit(int kind, uint32_t now) {
  uint32_t last;
  if (kind != KIND_POINTER && kind != KIND_KEYBOARD) return 0;
  last = g.last_emit_ms[kind];
  if (last != 0 && now - last < COALESCE_MS) return 0;
  g.last_emit_ms[kind] = now;
  return 1;
}

static int bit_set(const unsigned long *bits, unsigned bit) {
  unsigned long word = bits[bit / (8u * sizeof(unsigned long))];
  return (word >> (bit % (8u * sizeof(unsigned long)))) & 1ul;
}

static int parse_event_no(const char *name) {
  const char *p;
  char *end = NULL;
  unsigned long value;
  if (!name || strncmp(name, "event", 5) != 0) return -1;
  p = name + 5;
  if (*p < '0' || *p > '9') return -1;
  value = strtoul(p, &end, 10);
  if (!end || *end || value > 4096ul) return -1;
  return (int)value;
}

static int has_event_no(int event_no) {
  int i;
  for (i = 0; i < g.n_devices; i++) {
    if (g.devices[i].event_no == event_no) return 1;
  }
  return 0;
}

static void close_device_at(int index) {
  if (index < 0 || index >= g.n_devices) return;
  if (g.devices[index].fd >= 0) close(g.devices[index].fd);
  g.devices[index] = g.devices[g.n_devices - 1];
  g.n_devices--;
}

static void close_all_devices(void) {
  while (g.n_devices > 0) close_device_at(0);
}

static int name_blocked(const char *name) {
  return name && strcmp(name, "uinput") == 0;
}

static void try_open_event(int event_no) {
  char path[64];
  int fd;
  struct input_id id;
  unsigned long evbit[(EV_MAX / (8u * sizeof(unsigned long))) + 1];
  char name[256];
  int n;
  struct device *dev;
  if (event_no < 0 || g.n_devices >= MAX_DEVICES || has_event_no(event_no)) return;
  n = snprintf(path, sizeof path, "/dev/input/event%d", event_no);
  if (n < 0 || n >= (int)sizeof path) return;
  fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return;
  memset(&id, 0, sizeof id);
  if (ioctl(fd, EVIOCGID, &id) < 0 || !device_allowed(&id)) {
    close(fd);
    return;
  }
  memset(name, 0, sizeof name);
  if (ioctl(fd, EVIOCGNAME(sizeof name - 1), name) >= 0 && name_blocked(name)) {
    close(fd);
    return;
  }
  memset(evbit, 0, sizeof evbit);
  if (ioctl(fd, EVIOCGBIT(0, sizeof evbit), evbit) < 0
      || (!bit_set(evbit, EV_KEY) && !bit_set(evbit, EV_REL) && !bit_set(evbit, EV_ABS))) {
    close(fd);
    return;
  }
  dev = &g.devices[g.n_devices++];
  memset(dev, 0, sizeof *dev);
  dev->fd = fd;
  dev->event_no = event_no;
}

static void rescan_devices(void) {
  DIR *dir;
  struct dirent *entry;
  unsigned seen[MAX_DEVICES];
  int n_seen = 0;
  int i;
  dir = opendir("/dev/input");
  if (!dir) return;
  while ((entry = readdir(dir))) {
    int event_no = parse_event_no(entry->d_name);
    if (event_no < 0) continue;
    if (n_seen < MAX_DEVICES) seen[n_seen++] = (unsigned)event_no;
    try_open_event(event_no);
  }
  closedir(dir);
  for (i = g.n_devices - 1; i >= 0; i--) {
    int keep = 0;
    int s;
    for (s = 0; s < n_seen; s++) {
      if ((int)seen[s] == g.devices[i].event_no) { keep = 1; break; }
    }
    if (!keep) close_device_at(i);
  }
}

static int stdin_should_stop(void) {
  ssize_t n;
  for (;;) {
    if (g.inlen >= STDIN_MAX - 1) return 1;
    n = read(STDIN_FILENO, g.inbuf + g.inlen, STDIN_MAX - 1 - g.inlen);
    if (n == 0) return 1;
    if (n < 0) return errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR;
    g.inlen += (size_t)n;
    g.inbuf[g.inlen] = 0;
    while (g.inlen) {
      char *nl = memchr(g.inbuf, '\n', g.inlen);
      size_t len = nl ? (size_t)(nl - g.inbuf) : g.inlen;
      if (len >= 6 && memmem(g.inbuf, len, "\"quit\"", 6)) return 1;
      if (!nl) {
        if (g.inlen >= STDIN_MAX - 1) return 1;
        break;
      }
      len++;
      memmove(g.inbuf, g.inbuf + len, g.inlen - len);
      g.inlen -= len;
    }
  }
}

static void read_device(int index) {
  struct input_event ev[32];
  ssize_t n;
  int i;
  uint32_t now;
  if (index < 0 || index >= g.n_devices) return;
  n = read(g.devices[index].fd, ev, sizeof ev);
  if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
    close_device_at(index);
    return;
  }
  if (n < 0) return;
  n /= (ssize_t)sizeof(struct input_event);
  now = now_ms();
  for (i = 0; i < (int)n; i++) {
    int kind = classify(&ev[i], g.devices[index].last_abs, &g.devices[index].have_abs);
    if (kind && should_emit(kind, now)) emit_input(kind);
  }
}

static int self_test(void) {
  struct {
    uint16_t type;
    uint16_t code;
    int32_t value;
    int expect;
  } cases[] = {
    { EV_REL, REL_X, 0, 0 },
    { EV_REL, REL_X, 3, KIND_POINTER },
    { EV_REL, REL_Y, -2, KIND_POINTER },
    { EV_KEY, KEY_A, 0, 0 },
    { EV_KEY, KEY_A, 2, 0 },
    { EV_KEY, KEY_A, 1, KIND_KEYBOARD },
    { EV_KEY, KEY_ENTER, 1, KIND_KEYBOARD },
    { EV_KEY, BTN_LEFT, 1, KIND_POINTER },
    { EV_KEY, BTN_RIGHT, 1, KIND_POINTER },
    { EV_KEY, BTN_TOUCH, 1, KIND_POINTER },
    { EV_KEY, BTN_SOUTH, 1, 0 },
    { EV_SYN, SYN_REPORT, 0, 0 },
    { EV_MSC, MSC_SCAN, 30, 0 },
    { EV_ABS, ABS_X, 100, 0 },
    { EV_ABS, ABS_X, 101, 0 },
    { EV_ABS, ABS_X, 120, KIND_POINTER },
    { EV_ABS, ABS_Y, 50, 0 },
    { EV_ABS, ABS_Y, 80, KIND_POINTER }
  };
  struct input_id usb = { .bustype = BUS_USB };
  struct input_id i8042 = { .bustype = BUS_I8042 };
  struct input_id virt = { .bustype = BUS_VIRTUAL };
  int32_t last_abs[4];
  unsigned have_abs = 0;
  int kinds[32];
  int n_kinds = 0;
  size_t i;
  memset(last_abs, 0, sizeof last_abs);
  if (!device_allowed(&usb) || !device_allowed(&i8042) || device_allowed(&virt)) return 1;
  if (!name_blocked("uinput") || name_blocked("AT Translated Set 2 keyboard")) return 1;
  for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    struct input_event ev;
    int kind;
    memset(&ev, 0, sizeof ev);
    ev.type = cases[i].type;
    ev.code = cases[i].code;
    ev.value = cases[i].value;
    kind = classify(&ev, last_abs, &have_abs);
    if (kind != cases[i].expect) return 1;
    if (kind) {
      if (n_kinds >= (int)(sizeof kinds / sizeof kinds[0])) return 1;
      kinds[n_kinds++] = kind;
    }
  }
  for (i = 0; i < (size_t)n_kinds; i++) {
    if (emit_input(kinds[i]) < 0) return 1;
  }
  return 0;
}

static int env_disabled(void) {
  const char *value = getenv("MUSE_ACTIVITY_DISABLED");
  return value && strcmp(value, "1") == 0;
}

static void install_signals(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_stop;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGPIPE, &sa, NULL);
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  if (getppid() == 1) stop_requested = 1;
}

static void make_stdin_nonblock(void) {
  int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
}

int main(int argc, char **argv) {
  uint32_t next_rescan = 0;
  int disabled;
  int reported_devices;
  int i;
  memset(&g, 0, sizeof g);
  for (i = 0; i < MAX_DEVICES; i++) g.devices[i].fd = -1;
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc >= 2 && strcmp(argv[1], "--self-test") == 0) return self_test() == 0 ? 0 : 1;
  install_signals();
  make_stdin_nonblock();
  disabled = env_disabled();
  if (stop_requested) return 0;
  if (!disabled) rescan_devices();
  if (emit_ready(!disabled && g.n_devices > 0, g.n_devices) < 0) {
    close_all_devices();
    return 1;
  }
  next_rescan = now_ms() + RESCAN_MS;
  reported_devices = g.n_devices;
  while (!stop_requested) {
    struct pollfd fds[MAX_DEVICES + 1];
    int nfds = 0;
    int timeout = 250;
    uint32_t now = now_ms();
    int n;
    fds[nfds].fd = STDIN_FILENO;
    fds[nfds].events = POLLIN | POLLHUP;
    fds[nfds].revents = 0;
    nfds++;
    for (i = 0; i < g.n_devices; i++) {
      fds[nfds].fd = g.devices[i].fd;
      fds[nfds].events = POLLIN | POLLHUP;
      fds[nfds].revents = 0;
      nfds++;
    }
    if (!disabled) {
      int until = (int)(next_rescan - now);
      if (until < 0) until = 0;
      if (until < timeout) timeout = until;
    }
    n = poll(fds, (nfds_t)nfds, timeout);
    if (stop_requested) break;
    if (n < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
    if (fds[0].revents & POLLIN) {
      if (stdin_should_stop()) break;
    }
    for (i = g.n_devices - 1; i >= 0; i--) {
      int slot = i + 1;
      if (slot >= nfds) continue;
      if (fds[slot].revents & (POLLHUP | POLLERR | POLLNVAL)) {
        close_device_at(i);
        continue;
      }
      if (fds[slot].revents & POLLIN) read_device(i);
    }
    now = now_ms();
    if (!disabled && (int32_t)(now - next_rescan) >= 0) {
      rescan_devices();
      next_rescan = now + RESCAN_MS;
    }
    if (!disabled && reported_devices != g.n_devices) {
      reported_devices = g.n_devices;
      if (emit_ready(g.n_devices > 0, g.n_devices) < 0) break;
    }
  }
  close_all_devices();
  return 0;
}
