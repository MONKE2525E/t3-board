#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <glib.h>
#include <json-glib/json-glib.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "virtual-keyboard-unstable-v1-client-protocol.h"

/* muse-keyboard: one-shot zwp_virtual_keyboard_v1 helper.
 * Root native-build.cjs scans native/protocols/keyboard XML into
 * native/generated/keyboard/<basename>-client-protocol.h and
 * native/generated/keyboard/<basename>-protocol.c, compiles this file with
 * -I native/generated/keyboard plus those .c files, and links
 * wayland-client, xkbcommon, json-glib-1.0 as native/bin/muse-keyboard.
 *
 * Stdin is JSON lines, max 16KiB UTF-8. Text is never on argv or logs.
 * Stop, EOF, SIGTERM, and parent death release keys and modifiers.
 */

enum {
  MAX_LINE = 16384,
  MAX_TEXT = 4096,
  MAX_KEYS = 240,
  MAX_PRESSED = 32,
  KEY_HOLD_MS = 2,
  MOD_SHIFT = 1,
  MOD_CTRL = 4,
  MOD_ALT = 8,
  MOD_SUPER = 64
};

struct keymap_entry {
  xkb_keysym_t sym;
  uint32_t ch;
};

static struct {
  struct wl_display *display;
  struct wl_registry *registry;
  struct wl_seat *seat;
  struct zwp_virtual_keyboard_manager_v1 *manager;
  struct zwp_virtual_keyboard_v1 *keyboard;
  struct keymap_entry map[MAX_KEYS];
  size_t map_len;
  uint32_t pressed[MAX_PRESSED];
  int n_pressed;
  uint32_t mods;
  char inbuf[MAX_LINE];
  size_t inlen;
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

static void emit_builder(JsonBuilder *b) {
  JsonNode *root = json_builder_get_root(b);
  JsonGenerator *gen = json_generator_new();
  gsize len = 0;
  gchar *text;
  json_generator_set_root(gen, root);
  text = json_generator_to_data(gen, &len);
  fwrite(text, 1, len, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  g_free(text);
  g_object_unref(gen);
  json_node_unref(root);
  g_object_unref(b);
}

static void emit_error(const char *id, const char *error) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "error");
  if (id && *id) {
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, id);
  }
  json_builder_set_member_name(b, "error");
  json_builder_add_string_value(b, error ? error : "keyboard_helper_error");
  json_builder_end_object(b);
  emit_builder(b);
}

static void emit_ready(void) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "ready");
  json_builder_end_object(b);
  emit_builder(b);
}

static void emit_result(const char *id) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "result");
  json_builder_set_member_name(b, "id");
  json_builder_add_string_value(b, id);
  json_builder_set_member_name(b, "dispatched");
  json_builder_add_boolean_value(b, TRUE);
  json_builder_end_object(b);
  emit_builder(b);
}

static int parse_id(JsonObject *obj, char *buf, size_t n) {
  JsonNode *node;
  char tmp[32];
  const char *s;
  if (!json_object_has_member(obj, "id")) return 0;
  node = json_object_get_member(obj, "id");
  if (!node || !JSON_NODE_HOLDS_VALUE(node)) return 0;
  if (json_node_get_value_type(node) == G_TYPE_STRING) s = json_node_get_string(node);
  else if (json_node_get_value_type(node) == G_TYPE_INT64) {
    snprintf(tmp, sizeof tmp, "%" G_GINT64_FORMAT, json_node_get_int(node));
    s = tmp;
  } else return 0;
  if (!s || !*s || strlen(s) > 128) return 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) if (*p < 32) return 0;
  snprintf(buf, n, "%s", s);
  return 1;
}

static int read_stdin(void) {
  for (;;) {
    ssize_t n;
    if (g.inlen >= sizeof g.inbuf - 1) {
      emit_error(NULL, "invalid_request");
      g.inlen = 0;
      return 0;
    }
    n = read(STDIN_FILENO, g.inbuf + g.inlen, sizeof g.inbuf - 1 - g.inlen);
    if (n < 0) return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? 0 : -1;
    if (n == 0) { stop_requested = 1; return 0; }
    g.inlen += (size_t)n;
  }
}

static int pump(int timeout_ms) {
  struct pollfd fds[2];
  int n;
  while (wl_display_prepare_read(g.display) != 0) {
    if (wl_display_dispatch_pending(g.display) < 0) return -1;
  }
  if (wl_display_flush(g.display) < 0 && errno != EAGAIN) {
    wl_display_cancel_read(g.display);
    return -1;
  }
  fds[0].fd = wl_display_get_fd(g.display);
  fds[0].events = POLLIN;
  fds[1].fd = STDIN_FILENO;
  fds[1].events = POLLIN;
  n = poll(fds, 2, timeout_ms);
  if (n < 0) {
    wl_display_cancel_read(g.display);
    return errno == EINTR ? 0 : -1;
  }
  if (fds[0].revents & (POLLIN | POLLERR | POLLHUP)) {
    if (wl_display_read_events(g.display) < 0) return -1;
  } else {
    wl_display_cancel_read(g.display);
  }
  if (wl_display_dispatch_pending(g.display) < 0) return -1;
  if (fds[1].revents & POLLIN) {
    if (read_stdin() < 0) return -1;
  }
  if ((fds[1].revents & (POLLHUP | POLLERR)) && !(fds[1].revents & POLLIN)) stop_requested = 1;
  return 0;
}

static int wait_ms(int ms) {
  struct timespec start, now;
  if (ms <= 0) return 0;
  clock_gettime(CLOCK_MONOTONIC, &start);
  while (!stop_requested) {
    long elapsed;
    clock_gettime(CLOCK_MONOTONIC, &now);
    elapsed = (now.tv_sec - start.tv_sec) * 1000L + (now.tv_nsec - start.tv_nsec) / 1000000L;
    if (elapsed >= ms) return 0;
    if (pump((int)(ms - elapsed)) < 0) return -1;
  }
  return 1;
}

static void send_key(uint32_t code, int pressed) {
  if (!g.keyboard) return;
  zwp_virtual_keyboard_v1_key(g.keyboard, now_ms(), code, pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
  wl_display_flush(g.display);
}

static void send_mods(uint32_t mask) {
  if (!g.keyboard) return;
  g.mods = mask;
  zwp_virtual_keyboard_v1_modifiers(g.keyboard, mask, 0, 0, 0);
  wl_display_flush(g.display);
}

static void track_press(uint32_t code) {
  if (g.n_pressed < MAX_PRESSED) g.pressed[g.n_pressed++] = code;
}

static void untrack(uint32_t code) {
  for (int i = 0; i < g.n_pressed; i++) {
    if (g.pressed[i] != code) continue;
    g.pressed[i] = g.pressed[g.n_pressed - 1];
    g.n_pressed--;
    return;
  }
}

static void release_keys(void) {
  for (int i = g.n_pressed - 1; i >= 0; i--) send_key(g.pressed[i], 0);
  g.n_pressed = 0;
  if (g.mods) send_mods(0);
}

static unsigned int add_sym(xkb_keysym_t sym, uint32_t ch) {
  size_t i;
  if (sym == XKB_KEY_NoSymbol) return 0;
  for (i = 0; i < g.map_len; i++) {
    if (g.map[i].sym == sym && g.map[i].ch == ch) return (unsigned int)(i + 1);
  }
  if (g.map_len >= MAX_KEYS) return 0;
  g.map[g.map_len].sym = sym;
  g.map[g.map_len].ch = ch;
  g.map_len++;
  return (unsigned int)g.map_len;
}

static xkb_keysym_t named_sym(const char *name) {
  xkb_keysym_t ks;
  if (!name || !*name) return XKB_KEY_NoSymbol;
  if (!g_ascii_strcasecmp(name, "Enter") || !g_ascii_strcasecmp(name, "Return")) return XKB_KEY_Return;
  if (!g_ascii_strcasecmp(name, "Tab")) return XKB_KEY_Tab;
  if (!g_ascii_strcasecmp(name, "Escape") || !g_ascii_strcasecmp(name, "Esc")) return XKB_KEY_Escape;
  if (!g_ascii_strcasecmp(name, "Space") || !g_ascii_strcasecmp(name, "space")) return XKB_KEY_space;
  if (!g_ascii_strcasecmp(name, "Backspace") || !g_ascii_strcasecmp(name, "BackSpace")) return XKB_KEY_BackSpace;
  if (!g_ascii_strcasecmp(name, "Delete") || !g_ascii_strcasecmp(name, "Del")) return XKB_KEY_Delete;
  if (!g_ascii_strcasecmp(name, "Left")) return XKB_KEY_Left;
  if (!g_ascii_strcasecmp(name, "Right")) return XKB_KEY_Right;
  if (!g_ascii_strcasecmp(name, "Up")) return XKB_KEY_Up;
  if (!g_ascii_strcasecmp(name, "Down")) return XKB_KEY_Down;
  if (!g_ascii_strcasecmp(name, "Home")) return XKB_KEY_Home;
  if (!g_ascii_strcasecmp(name, "End")) return XKB_KEY_End;
  if (!g_ascii_strcasecmp(name, "PageUp") || !g_ascii_strcasecmp(name, "Prior")) return XKB_KEY_Prior;
  if (!g_ascii_strcasecmp(name, "PageDown") || !g_ascii_strcasecmp(name, "Next")) return XKB_KEY_Next;
  if (!g_ascii_strcasecmp(name, "Insert")) return XKB_KEY_Insert;
  if (!g_ascii_strcasecmp(name, "Super") || !g_ascii_strcasecmp(name, "Meta") || !g_ascii_strcasecmp(name, "Win")
      || !g_ascii_strcasecmp(name, "Windows") || !g_ascii_strcasecmp(name, "Super_L") || !g_ascii_strcasecmp(name, "Meta_L"))
    return XKB_KEY_Super_L;
  if (!g_ascii_strcasecmp(name, "Control") || !g_ascii_strcasecmp(name, "Ctrl") || !g_ascii_strcasecmp(name, "Control_L"))
    return XKB_KEY_Control_L;
  if (!g_ascii_strcasecmp(name, "Shift") || !g_ascii_strcasecmp(name, "Shift_L")) return XKB_KEY_Shift_L;
  if (!g_ascii_strcasecmp(name, "Alt") || !g_ascii_strcasecmp(name, "Alt_L") || !g_ascii_strcasecmp(name, "Option"))
    return XKB_KEY_Alt_L;
  ks = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
  if (ks != XKB_KEY_NoSymbol) return ks;
  if (g_utf8_validate(name, -1, NULL) && g_utf8_strlen(name, -1) == 1) return xkb_utf32_to_keysym(g_utf8_get_char(name));
  return XKB_KEY_NoSymbol;
}

static int write_sym_name(FILE *f, xkb_keysym_t sym) {
  char name[256];
  size_t i;
  if (xkb_keysym_get_name(sym, name, sizeof name) <= 0) {
    fprintf(f, "U%04X", (unsigned)sym);
    return 1;
  }
  for (i = 0; name[i]; i++) {
    unsigned char c = (unsigned char)name[i];
    if (!(isalnum(c) || c == '_')) return 0;
  }
  fputs(name, f);
  return 1;
}

static int upload_keymap(void) {
  char *buf = NULL;
  size_t cap = 0;
  FILE *mem;
  int fd;
  size_t i;
  ssize_t wrote;
  if (!g.keyboard) return 0;
  mem = open_memstream(&buf, &cap);
  if (!mem) return 0;
  fprintf(mem, "xkb_keymap {\n");
  fprintf(mem, "xkb_keycodes \"(unnamed)\" {\nminimum = 8;\nmaximum = %zu;\n", g.map_len + 9);
  for (i = 0; i < g.map_len; i++) fprintf(mem, "<K%zu> = %zu;\n", i + 1, i + 9);
  fprintf(mem, "};\n");
  fprintf(mem, "xkb_types \"(unnamed)\" { include \"complete\" };\n");
  fprintf(mem, "xkb_compatibility \"(unnamed)\" { include \"complete\" };\n");
  fprintf(mem, "xkb_symbols \"(unnamed)\" {\n");
  for (i = 0; i < g.map_len; i++) {
    fprintf(mem, "key <K%zu> {[", i + 1);
    if (!write_sym_name(mem, g.map[i].sym)) {
      fclose(mem);
      free(buf);
      return 0;
    }
    fprintf(mem, "]};\n");
  }
  fprintf(mem, "};\n};\n");
  fputc('\0', mem);
  if (fclose(mem) != 0) {
    free(buf);
    return 0;
  }
  fd = memfd_create("muse-keymap", MFD_CLOEXEC);
  if (fd < 0) {
    char path[160];
    const char *dir = getenv("XDG_RUNTIME_DIR");
    if (!dir || !*dir || strchr(dir, '\n')) dir = "/tmp";
    snprintf(path, sizeof path, "%s/muse-keymap-XXXXXX", dir);
    fd = mkostemp(path, O_CLOEXEC);
    if (fd >= 0) unlink(path);
  }
  if (fd < 0) {
    free(buf);
    return 0;
  }
  wrote = write(fd, buf, cap);
  free(buf);
  if (wrote < 0 || (size_t)wrote != cap || lseek(fd, 0, SEEK_SET) < 0) {
    close(fd);
    return 0;
  }
  zwp_virtual_keyboard_v1_keymap(g.keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)cap);
  close(fd);
  wl_display_roundtrip(g.display);
  return 1;
}

static int tap(unsigned int code) {
  if (!code) return 0;
  send_key(code, 1);
  track_press(code);
  if (wait_ms(KEY_HOLD_MS) != 0) return 0;
  send_key(code, 0);
  untrack(code);
  if (wait_ms(KEY_HOLD_MS) != 0) return 0;
  return 1;
}

/* Shortcut input uses real evdev positions. Custom text keymaps deliberately
 * assign arbitrary codes and cannot fire code-based compositor bindings. */
static unsigned int standard_keymap(xkb_keysym_t sym, unsigned int requested) {
  struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  struct xkb_rule_names names = {.rules = "evdev", .model = "pc105", .layout = "us"};
  struct xkb_keymap *map = ctx ? xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
  unsigned int code = requested;
  if (!map) { if (ctx) xkb_context_unref(ctx); return 0; }
  if (!code) {
    for (xkb_keycode_t k = xkb_keymap_min_keycode(map); k <= xkb_keymap_max_keycode(map); k++) {
      const xkb_keysym_t *syms;
      int count = xkb_keymap_key_get_syms_by_level(map, k, 0, 0, &syms);
      if (count == 1 && xkb_keysym_to_lower(syms[0]) == xkb_keysym_to_lower(sym)) { code = k - 8; break; }
    }
  }
  char *buf = xkb_keymap_get_as_string(map, XKB_KEYMAP_FORMAT_TEXT_V1);
  xkb_keymap_unref(map); xkb_context_unref(ctx);
  if (!buf || !code) { free(buf); return 0; }
  size_t size = strlen(buf) + 1;
  int fd = memfd_create("muse-shortcut-keymap", MFD_CLOEXEC);
  if (fd < 0) { free(buf); return 0; }
  ssize_t wrote = write(fd, buf, size); free(buf);
  if (wrote != (ssize_t)size || lseek(fd, 0, SEEK_SET) < 0) { close(fd); return 0; }
  zwp_virtual_keyboard_v1_keymap(g.keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
  close(fd);
  if (wl_display_roundtrip(g.display) < 0) return 0;
  send_mods(0);
  return code;
}

static uint32_t mod_mask(const char *name) {
  if (!name) return 0;
  if (!g_ascii_strcasecmp(name, "control") || !g_ascii_strcasecmp(name, "ctrl")) return MOD_CTRL;
  if (!g_ascii_strcasecmp(name, "shift")) return MOD_SHIFT;
  if (!g_ascii_strcasecmp(name, "alt")) return MOD_ALT;
  if (!g_ascii_strcasecmp(name, "super") || !g_ascii_strcasecmp(name, "meta") || !g_ascii_strcasecmp(name, "win")) return MOD_SUPER;
  return 0;
}

/* Left Super is evdev KEY_LEFTMETA 125. Virtual-keyboard clients must set the
 * SUPER mask themselves; Hyprland bindr SUPER+Super_L matches only while that
 * mask is still set on the Super_L key-up. Clearing the mask in the same
 * frame as key-up misses the release bind. */
static uint32_t key_mod_bit(xkb_keysym_t sym, unsigned int code) {
  if (sym == XKB_KEY_Control_L || sym == XKB_KEY_Control_R || code == 29 || code == 97) return MOD_CTRL;
  if (sym == XKB_KEY_Shift_L || sym == XKB_KEY_Shift_R || code == 42 || code == 54) return MOD_SHIFT;
  if (sym == XKB_KEY_Alt_L || sym == XKB_KEY_Alt_R || code == 56 || code == 100) return MOD_ALT;
  if (sym == XKB_KEY_Super_L || sym == XKB_KEY_Super_R || sym == XKB_KEY_Meta_L || sym == XKB_KEY_Meta_R
      || code == 125 || code == 126)
    return MOD_SUPER;
  return 0;
}

static int parse_mods(JsonObject *obj, uint32_t *mask) {
  JsonNode *node;
  JsonArray *arr;
  guint n, i;
  *mask = 0;
  if (!json_object_has_member(obj, "mods")) return 1;
  node = json_object_get_member(obj, "mods");
  if (!node) return 1;
  if (JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING) {
    const char *s = json_node_get_string(node);
    uint32_t bit;
    if (!s || !*s) return 1;
    bit = mod_mask(s);
    if (!bit) return 0;
    *mask = bit;
    return 1;
  }
  if (!JSON_NODE_HOLDS_ARRAY(node)) return 0;
  arr = json_node_get_array(node);
  n = json_array_get_length(arr);
  for (i = 0; i < n; i++) {
    const char *name = json_array_get_string_element(arr, i);
    uint32_t bit = mod_mask(name);
    if (!bit) return 0;
    *mask |= bit;
  }
  return 1;
}

static int handle_type(const char *id, JsonObject *obj) {
  const char *text;
  const gchar *p, *end;
  unsigned int codes[MAX_TEXT];
  size_t n = 0;
  glong len;
  g.map_len = 0;
  if (!json_object_has_member(obj, "text")) return emit_error(id, "invalid_text"), 0;
  text = json_object_get_string_member_with_default(obj, "text", NULL);
  if (!text || !g_utf8_validate(text, -1, NULL)) return emit_error(id, "invalid_text"), 0;
  len = g_utf8_strlen(text, -1);
  if (len < 1 || len > MAX_TEXT || strlen(text) > MAX_TEXT * 4) return emit_error(id, "invalid_text"), 0;
  p = text;
  end = text + strlen(text);
  while (p < end) {
    gunichar ch = g_utf8_get_char(p);
    p = g_utf8_next_char(p);
    if (ch > 0xFFFF) {
      emit_error(id, "native_text_unsupported: use Muse Local Browser type or an accessibility element type");
      return 0;
    }
  }
  p = text;
  while (p < end) {
    gunichar ch = g_utf8_get_char(p);
    xkb_keysym_t sym;
    unsigned int code;
    p = g_utf8_next_char(p);
    if (ch == 13) {
      if (p < end && g_utf8_get_char(p) == 10) p = g_utf8_next_char(p);
      ch = 10;
    }
    if (ch < 32 && ch != 9 && ch != 10) return emit_error(id, "invalid_text"), 0;
    if (ch == 0x7f) return emit_error(id, "invalid_text"), 0;
    if (ch == 10) sym = XKB_KEY_Return;
    else if (ch == 9) sym = XKB_KEY_Tab;
    else sym = xkb_utf32_to_keysym(ch);
    code = add_sym(sym, ch);
    if (!code) return emit_error(id, "invalid_text"), 0;
    if (n >= MAX_TEXT) return emit_error(id, "invalid_text"), 0;
    codes[n++] = code;
  }
  if (!n) return emit_error(id, "invalid_text"), 0;
  if (!upload_keymap()) return emit_error(id, "keymap_failed"), 0;
  send_mods(0);
  if (wl_display_roundtrip(g.display) < 0) return 0;
  for (size_t i = 0; i < n; i++) {
    if (stop_requested) return 0;
    if (!tap(codes[i])) return 0;
  }
  emit_result(id);
  return 1;
}

static int handle_key(const char *id, JsonObject *obj) {
  const char *key;
  xkb_keysym_t sym;
  unsigned int code;
  uint32_t mask = 0;
  uint32_t down;
  release_keys();
  g.map_len = 0;
  key = json_object_get_string_member_with_default(obj, "key", NULL);
  if (!key || !*key) return emit_error(id, "invalid_key"), 0;
  if (!parse_mods(obj, &mask)) return emit_error(id, "invalid_key"), 0;
  sym = named_sym(key);
  unsigned int requested = 0;
  if (json_object_has_member(obj, "code")) {
    JsonNode *node = json_object_get_member(obj, "code");
    if (!JSON_NODE_HOLDS_VALUE(node) || json_node_get_value_type(node) != G_TYPE_INT64) return emit_error(id, "invalid_key"), 0;
    gint64 value = json_node_get_int(node);
    if (value < 1 || value > 767) return emit_error(id, "invalid_key"), 0;
    requested = (unsigned int)value;
  }
  if (sym == XKB_KEY_NoSymbol) return emit_error(id, "invalid_key"), 0;
  code = standard_keymap(sym, requested);
  if (!code) return emit_error(id, "keymap_failed"), 0;
  /* Include the action key's own modifier bit so Super-alone is SUPER mask plus
   * KEY_LEFTMETA 125. Hyprland bindr SUPER+Super_L matches only if that mask is
   * still set when Super_L goes up; roundtrip the key-up before clearing. */
  down = mask | key_mod_bit(sym, code);
  if (down) send_mods(down);
  if (!tap(code)) {
    release_keys();
    return 0;
  }
  if (wl_display_roundtrip(g.display) < 0) {
    release_keys();
    return 0;
  }
  send_mods(0);
  if (wl_display_roundtrip(g.display) < 0) return 0;
  emit_result(id);
  return 1;
}

static void handle_request(JsonObject *obj) {
  char id[129];
  const char *action;
  if (!parse_id(obj, id, sizeof id)) { emit_error(NULL, "invalid_request"); return; }
  action = json_object_get_string_member_with_default(obj, "action", "");
  if (!g.keyboard) { emit_error(id, "keyboard_unavailable"); return; }
  if (strcmp(action, "type") == 0) handle_type(id, obj);
  else if (strcmp(action, "key") == 0) handle_key(id, obj);
  else emit_error(id, "action_unsupported");
}

static char *next_line(void) {
  static char line[MAX_LINE];
  char *nl = memchr(g.inbuf, '\n', g.inlen);
  size_t len;
  if (!nl) return NULL;
  len = (size_t)(nl - g.inbuf);
  if (len >= sizeof line) len = sizeof line - 1;
  memcpy(line, g.inbuf, len);
  line[len] = 0;
  if (len && line[len - 1] == '\r') line[len - 1] = 0;
  memmove(g.inbuf, nl + 1, g.inlen - len - 1);
  g.inlen -= len + 1;
  return line;
}

static void process_line(const char *line) {
  JsonParser *parser;
  JsonNode *root;
  JsonObject *obj;
  GError *error = NULL;
  if (!line || !*line) return;
  parser = json_parser_new();
  if (!json_parser_load_from_data(parser, line, -1, &error)) {
    if (error) g_error_free(error);
    emit_error(NULL, "invalid_request");
    g_object_unref(parser);
    return;
  }
  root = json_parser_get_root(parser);
  if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
    emit_error(NULL, "invalid_request");
    g_object_unref(parser);
    return;
  }
  obj = json_node_get_object(root);
  if (json_object_get_boolean_member_with_default(obj, "quit", FALSE)) {
    stop_requested = 1;
    g_object_unref(parser);
    return;
  }
  handle_request(obj);
  g_object_unref(parser);
}

static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
    g.manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  } else if (strcmp(interface, wl_seat_interface.name) == 0 && !g.seat) {
    uint32_t bind = version < 7 ? version : 7;
    g.seat = wl_registry_bind(registry, name, &wl_seat_interface, bind);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener registry_listener = {
  .global = registry_global,
  .global_remove = registry_global_remove,
};

static void cleanup(void) {
  release_keys();
  if (g.keyboard) {
    zwp_virtual_keyboard_v1_destroy(g.keyboard);
    g.keyboard = NULL;
  }
  if (g.manager) {
    zwp_virtual_keyboard_manager_v1_destroy(g.manager);
    g.manager = NULL;
  }
  if (g.seat) {
    wl_seat_destroy(g.seat);
    g.seat = NULL;
  }
  if (g.registry) {
    wl_registry_destroy(g.registry);
    g.registry = NULL;
  }
  if (g.display) {
    wl_display_flush(g.display);
    wl_display_disconnect(g.display);
    g.display = NULL;
  }
}

int main(void) {
  struct sigaction sa;
  memset(&g, 0, sizeof g);
  setvbuf(stdout, NULL, _IOLBF, 0);
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  if (getppid() == 1) stop_requested = 1;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_stop;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
  g.display = wl_display_connect(NULL);
  if (!g.display) {
    emit_error(NULL, "wayland_unavailable");
    return 1;
  }
  g.registry = wl_display_get_registry(g.display);
  wl_registry_add_listener(g.registry, &registry_listener, NULL);
  if (wl_display_roundtrip(g.display) < 0 || wl_display_roundtrip(g.display) < 0) {
    emit_error(NULL, "wayland_unavailable");
    cleanup();
    return 1;
  }
  if (!g.manager) {
    emit_error(NULL, "virtual_keyboard_unsupported");
    cleanup();
    return 1;
  }
  if (!g.seat) {
    emit_error(NULL, "seat_unavailable");
    cleanup();
    return 1;
  }
  g.keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(g.manager, g.seat);
  if (!g.keyboard) {
    emit_error(NULL, "virtual_keyboard_unsupported");
    cleanup();
    return 1;
  }
  emit_ready();
  while (!stop_requested) {
    char *line;
    if (pump(g.inlen ? 0 : -1) < 0) break;
    while (!stop_requested && (line = next_line())) process_line(line);
  }
  cleanup();
  return 0;
}
