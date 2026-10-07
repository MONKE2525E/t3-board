#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <json-glib/json-glib.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

/* muse-pointer: persistent zwlr_virtual_pointer_v1 helper.
 * Root native-build.cjs scans native/protocols/pointer XML files into
 * native/generated/pointer/<basename>-client-protocol.h and
 * native/generated/pointer/<basename>-protocol.c, compiles this file with
 * -I native/generated/pointer plus those .c files, and links
 * wayland-client, json-glib-1.0, and -lm as native/bin/muse-pointer.
 */

enum {
  MAX_OUTPUTS = 16,
  MAX_LINE = 4096,
  COORD_MIN = -100000,
  COORD_MAX = 100000,
  STEP_MS = 16,
  CLICK_MS = 25,
  DOUBLE_MS = 40
};

struct point {
  int x, y, local_x, local_y, width, height;
  char output[64];
};

struct output {
  uint32_t global;
  struct wl_output *wl;
  char name[64];
  int32_t x, y, phys_width, phys_height, scale, transform;
};

static struct {
  struct wl_display *display;
  struct wl_registry *registry;
  struct zwlr_virtual_pointer_manager_v1 *manager;
  uint32_t manager_version;
  struct zwlr_virtual_pointer_v1 *pointer;
  char pointer_output[64];
  struct output outputs[MAX_OUTPUTS];
  int n_outputs;
  unsigned pressed;
  int has_last;
  struct point last;
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

static int valid_output(const char *s) {
  size_t n;
  if (!s || !*s) return 0;
  n = strlen(s);
  if (n < 1 || n > 63) return 0;
  for (; *s; s++) {
    if (!(isalnum((unsigned char)*s) || *s == '.' || *s == '_' || *s == '-' || *s == ':')) return 0;
  }
  return 1;
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
  json_builder_add_string_value(b, error ? error : "pointer_helper_error");
  json_builder_end_object(b);
  emit_builder(b);
}

static void emit_ack(const char *id, int x, int y, int click) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "ack");
  json_builder_set_member_name(b, "id");
  json_builder_add_string_value(b, id);
  json_builder_set_member_name(b, "x");
  json_builder_add_int_value(b, x);
  json_builder_set_member_name(b, "y");
  json_builder_add_int_value(b, y);
  if (click) {
    json_builder_set_member_name(b, "click");
    json_builder_add_boolean_value(b, TRUE);
  }
  json_builder_end_object(b);
  emit_builder(b);
}

static void emit_result(const char *id, int x, int y) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "result");
  json_builder_set_member_name(b, "id");
  json_builder_add_string_value(b, id);
  json_builder_set_member_name(b, "x");
  json_builder_add_int_value(b, x);
  json_builder_set_member_name(b, "y");
  json_builder_add_int_value(b, y);
  json_builder_end_object(b);
  emit_builder(b);
}

static void emit_ready(void) {
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "event");
  json_builder_add_string_value(b, "ready");
  json_builder_set_member_name(b, "outputs");
  json_builder_begin_array(b);
  for (int i = 0; i < g.n_outputs; i++) {
    int width, height, scale;
    if (!g.outputs[i].name[0]) continue;
    scale = g.outputs[i].scale > 0 ? g.outputs[i].scale : 1;
    width = g.outputs[i].phys_width / scale;
    height = g.outputs[i].phys_height / scale;
    if (g.outputs[i].transform % 2) {
      int swap = width;
      width = height;
      height = swap;
    }
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, g.outputs[i].name);
    json_builder_set_member_name(b, "x");
    json_builder_add_int_value(b, g.outputs[i].x);
    json_builder_set_member_name(b, "y");
    json_builder_add_int_value(b, g.outputs[i].y);
    json_builder_set_member_name(b, "width");
    json_builder_add_int_value(b, width);
    json_builder_set_member_name(b, "height");
    json_builder_add_int_value(b, height);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  json_builder_end_object(b);
  emit_builder(b);
}

static struct output *find_output(const char *name) {
  if (!valid_output(name)) return NULL;
  for (int i = 0; i < g.n_outputs; i++) {
    if (g.outputs[i].wl && strcmp(g.outputs[i].name, name) == 0) return &g.outputs[i];
  }
  return NULL;
}

static void output_geometry(void *data, struct wl_output *wl, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t subpixel, const char *make, const char *model, int32_t transform) {
  struct output *out = data;
  (void)wl; (void)pw; (void)ph; (void)subpixel; (void)make; (void)model;
  out->x = x;
  out->y = y;
  out->transform = transform;
}

static void output_mode(void *data, struct wl_output *wl, uint32_t flags, int32_t width, int32_t height, int32_t refresh) {
  struct output *out = data;
  (void)wl; (void)refresh;
  if (flags & WL_OUTPUT_MODE_CURRENT) {
    out->phys_width = width;
    out->phys_height = height;
  }
}

static void output_done(void *data, struct wl_output *wl) {
  (void)data; (void)wl;
}

static void output_scale(void *data, struct wl_output *wl, int32_t scale) {
  struct output *out = data;
  (void)wl;
  out->scale = scale > 0 ? scale : 1;
}

static void output_name(void *data, struct wl_output *wl, const char *name) {
  struct output *out = data;
  (void)wl;
  if (valid_output(name)) snprintf(out->name, sizeof out->name, "%s", name);
}

static void output_description(void *data, struct wl_output *wl, const char *description) {
  (void)data; (void)wl; (void)description;
}

static const struct wl_output_listener output_listener = {
  .geometry = output_geometry,
  .mode = output_mode,
  .done = output_done,
  .scale = output_scale,
  .name = output_name,
  .description = output_description,
};

static void destroy_pointer(void) {
  if (!g.pointer) return;
  zwlr_virtual_pointer_v1_destroy(g.pointer);
  g.pointer = NULL;
  g.pointer_output[0] = 0;
  if (g.display) wl_display_flush(g.display);
}

static void send_button(uint32_t code, unsigned bit, int pressed) {
  if (!g.pointer) return;
  zwlr_virtual_pointer_v1_button(g.pointer, now_ms(), code, pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
  zwlr_virtual_pointer_v1_frame(g.pointer);
  if (g.display) wl_display_flush(g.display);
  if (pressed) g.pressed |= bit;
  else g.pressed &= ~bit;
}

static void release_buttons(void) {
  if (g.pressed & 1u) send_button(BTN_LEFT, 1u, 0);
  if (g.pressed & 2u) send_button(BTN_RIGHT, 2u, 0);
  if (g.pressed & 4u) send_button(BTN_MIDDLE, 4u, 0);
}

static int bind_output(const char *name) {
  struct output *out = find_output(name);
  if (!out || !g.manager || g.manager_version < 2) return 0;
  if (g.pointer && strcmp(g.pointer_output, name) == 0) return 1;
  if (g.pressed) return -1;
  destroy_pointer();
  g.pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(g.manager, NULL, out->wl);
  if (!g.pointer) return 0;
  snprintf(g.pointer_output, sizeof g.pointer_output, "%s", name);
  wl_display_flush(g.display);
  return 1;
}

static int send_motion(const char *id, const struct point *p, int click) {
  int bound;
  if (p->width < 1 || p->height < 1 || p->local_x < 0 || p->local_y < 0 || p->local_x > p->width || p->local_y > p->height) {
    emit_error(id, "invalid_point");
    return 0;
  }
  bound = bind_output(p->output);
  if (bound < 0) { emit_error(id, "output_rebind_busy"); return 0; }
  if (!bound || !g.pointer) { emit_error(id, "unknown_output"); return 0; }
  zwlr_virtual_pointer_v1_motion_absolute(g.pointer, now_ms(), (uint32_t)p->local_x, (uint32_t)p->local_y, (uint32_t)p->width, (uint32_t)p->height);
  zwlr_virtual_pointer_v1_frame(g.pointer);
  wl_display_flush(g.display);
  g.last = *p;
  g.has_last = 1;
  emit_ack(id, p->x, p->y, click);
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

static int lerp(int a, int b, int i, int n) {
  if (n <= 1 || i >= n) return b;
  if (i <= 0) return a;
  return a + (int)llround((double)(b - a) * (double)i / (double)n);
}

static int move_duration(const struct point *from, const struct point *to, int requested) {
  double dist;
  int duration;
  if (requested >= 0) {
    if (requested < 80) return 80;
    if (requested > 400) return 400;
    return requested;
  }
  dist = hypot((double)(to->x - from->x), (double)(to->y - from->y));
  if (dist < 1) return 0;
  duration = (int)llround(80.0 + dist * 0.4);
  if (duration > 400) duration = 400;
  if (duration < 80) duration = 80;
  return duration;
}

static int smooth_move(const char *id, struct point from, struct point to, int requested) {
  int duration, steps, i;
  if (strcmp(from.output, to.output) != 0) return send_motion(id, &to, 0);
  duration = move_duration(&from, &to, requested);
  steps = duration <= 0 ? 1 : duration / STEP_MS;
  if (steps < 1) steps = 1;
  if (steps > 30) steps = 30;
  for (i = 1; i <= steps; i++) {
    struct point p = to;
    if (stop_requested) return 0;
    p.x = lerp(from.x, to.x, i, steps);
    p.y = lerp(from.y, to.y, i, steps);
    p.local_x = lerp(from.local_x, to.local_x, i, steps);
    p.local_y = lerp(from.local_y, to.local_y, i, steps);
    if (!send_motion(id, &p, 0)) return 0;
    if (i < steps && wait_ms(STEP_MS) != 0) return 0;
  }
  return 1;
}

static int start_point(struct point *from, const struct point *to) {
  if (g.has_last && strcmp(g.last.output, to->output) == 0) {
    *from = g.last;
    return 1;
  }
  *from = *to;
  return 0;
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

static int parse_int_member(JsonObject *obj, const char *key, int *out, int required) {
  JsonNode *node;
  double d;
  GType type;
  if (!json_object_has_member(obj, key)) return required ? 0 : 1;
  node = json_object_get_member(obj, key);
  if (!node || !JSON_NODE_HOLDS_VALUE(node)) return 0;
  type = json_node_get_value_type(node);
  if (type == G_TYPE_STRING) {
    char *end = NULL;
    const char *s = json_node_get_string(node);
    if (!s || !*s) return 0;
    d = strtod(s, &end);
    if (!end || *end) return 0;
  } else if (type == G_TYPE_DOUBLE || type == G_TYPE_FLOAT) d = json_node_get_double(node);
  else if (type == G_TYPE_INT64 || type == G_TYPE_INT) d = (double)json_node_get_int(node);
  else return 0;
  if (!isfinite(d) || d != floor(d) || d < COORD_MIN || d > COORD_MAX) return 0;
  *out = (int)d;
  return 1;
}

static int parse_point(JsonObject *root, const char *nested, struct point *out, int required) {
  JsonObject *obj = root;
  memset(out, 0, sizeof *out);
  if (nested) {
    if (!json_object_has_member(root, nested)) return required ? 0 : 1;
    JsonNode *node = json_object_get_member(root, nested);
    if (!node || !JSON_NODE_HOLDS_OBJECT(node)) return 0;
    obj = json_node_get_object(node);
  }
  if (!parse_int_member(obj, "x", &out->x, 1) || !parse_int_member(obj, "y", &out->y, 1)) return 0;
  if (!parse_int_member(obj, "localX", &out->local_x, 1) || !parse_int_member(obj, "localY", &out->local_y, 1)) return 0;
  if (!parse_int_member(obj, "width", &out->width, 1) || !parse_int_member(obj, "height", &out->height, 1)) return 0;
  if (out->width < 1 || out->height < 1) return 0;
  {
    const char *name = json_object_get_string_member_with_default(obj, "output", NULL);
    if (!valid_output(name)) return 0;
    snprintf(out->output, sizeof out->output, "%s", name);
  }
  return 1;
}

static int button_from(const char *name, uint32_t *code, unsigned *bit) {
  if (!name || !*name || strcmp(name, "left") == 0) { *code = BTN_LEFT; *bit = 1u; return 1; }
  if (strcmp(name, "right") == 0) { *code = BTN_RIGHT; *bit = 2u; return 1; }
  if (strcmp(name, "middle") == 0) { *code = BTN_MIDDLE; *bit = 4u; return 1; }
  return 0;
}

static int click_once(const char *id, const struct point *at, uint32_t code, unsigned bit) {
  /* A new layer under a stationary cursor may retain stale pointer focus.
   * Move one logical pixel, then return before sending any button event. */
  struct point nearby = *at;
  if (at->width > 1) {
    int dx = at->local_x + 1 < at->width ? 1 : -1;
    nearby.local_x += dx;
    nearby.x += dx;
  } else if (at->height > 1) {
    int dy = at->local_y + 1 < at->height ? 1 : -1;
    nearby.local_y += dy;
    nearby.y += dy;
  }
  if (!send_motion(id, &nearby, 0) || wait_ms(STEP_MS) != 0) return 0;
  if (!send_motion(id, at, 0)) return 0;
  send_button(code, bit, 1);
  emit_ack(id, at->x, at->y, 1);
  if (wait_ms(CLICK_MS) != 0) return 0;
  send_button(code, bit, 0);
  return 1;
}

static void handle_request(JsonObject *obj) {
  char id[129];
  const char *action;
  struct point dest, from;
  int have_from, duration = -1, amount = 1;
  uint32_t code = BTN_LEFT;
  unsigned bit = 1u;
  if (!parse_id(obj, id, sizeof id)) { emit_error(NULL, "invalid_request"); return; }
  action = json_object_get_string_member_with_default(obj, "action", "");
  if (!parse_point(obj, json_object_has_member(obj, "point") ? "point" : NULL, &dest, 1)) {
    emit_error(id, "invalid_point");
    return;
  }
  have_from = 0;
  if (json_object_has_member(obj, "from")) {
    if (!parse_point(obj, "from", &from, 1)) { emit_error(id, "invalid_from"); return; }
    have_from = 1;
  }
  if (json_object_has_member(obj, "duration") && !parse_int_member(obj, "duration", &duration, 1)) {
    emit_error(id, "invalid_duration");
    return;
  }
  if (!have_from) have_from = start_point(&from, &dest);
  if (strcmp(action, "move") == 0) {
    if (!(have_from ? smooth_move(id, from, dest, duration) : send_motion(id, &dest, 0))) return;
    emit_result(id, dest.x, dest.y);
    return;
  }
  if (strcmp(action, "click") == 0 || strcmp(action, "double_click") == 0 || strcmp(action, "drag") == 0) {
    if (!button_from(json_object_get_string_member_with_default(obj, "button", "left"), &code, &bit)) {
      emit_error(id, "invalid_button");
      return;
    }
  }
  if (strcmp(action, "click") == 0) {
    if (have_from && !smooth_move(id, from, dest, duration)) return;
    if (!click_once(id, &dest, code, bit)) return;
    emit_result(id, dest.x, dest.y);
    return;
  }
  if (strcmp(action, "double_click") == 0) {
    if (have_from && !smooth_move(id, from, dest, duration)) return;
    if (!click_once(id, &dest, code, bit)) return;
    if (wait_ms(DOUBLE_MS) != 0) return;
    if (!click_once(id, &dest, code, bit)) return;
    emit_result(id, dest.x, dest.y);
    return;
  }
  if (strcmp(action, "drag") == 0) {
    if (!have_from) { emit_error(id, "invalid_from"); return; }
    if (strcmp(from.output, dest.output) != 0) { emit_error(id, "cross_output_drag_unsupported"); return; }
    if (!smooth_move(id, from, from, 0)) return;
    send_button(code, bit, 1);
    emit_ack(id, from.x, from.y, 1);
    if (!smooth_move(id, from, dest, duration)) { release_buttons(); return; }
    send_button(code, bit, 0);
    emit_result(id, dest.x, dest.y);
    return;
  }
  if (strcmp(action, "scroll") == 0) {
    const char *direction = json_object_get_string_member_with_default(obj, "direction", "down");
    int axis, steps;
    if (json_object_has_member(obj, "amount") && !parse_int_member(obj, "amount", &amount, 1)) {
      emit_error(id, "invalid_scroll");
      return;
    }
    if (amount < 1 || amount > 100) { emit_error(id, "invalid_scroll"); return; }
    if (strcmp(direction, "up") == 0) { axis = WL_POINTER_AXIS_VERTICAL_SCROLL; steps = -amount; }
    else if (strcmp(direction, "down") == 0) { axis = WL_POINTER_AXIS_VERTICAL_SCROLL; steps = amount; }
    else if (strcmp(direction, "left") == 0) { axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL; steps = -amount; }
    else if (strcmp(direction, "right") == 0) { axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL; steps = amount; }
    else { emit_error(id, "invalid_scroll"); return; }
    if (have_from && !smooth_move(id, from, dest, duration)) return;
    if (!send_motion(id, &dest, 0)) return;
    zwlr_virtual_pointer_v1_axis_source(g.pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
    zwlr_virtual_pointer_v1_axis_discrete(g.pointer, now_ms(), (uint32_t)axis, wl_fixed_from_double(15.0 * steps), steps);
    zwlr_virtual_pointer_v1_frame(g.pointer);
    wl_display_flush(g.display);
    emit_result(id, dest.x, dest.y);
    return;
  }
  emit_error(id, "action_unsupported");
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
  if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    uint32_t bind = version < 2 ? version : 2;
    g.manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, bind);
    g.manager_version = bind;
  } else if (strcmp(interface, wl_output_interface.name) == 0 && g.n_outputs < MAX_OUTPUTS) {
    struct output *out = &g.outputs[g.n_outputs++];
    uint32_t bind = version < 4 ? version : 4;
    memset(out, 0, sizeof *out);
    out->global = name;
    out->scale = 1;
    out->wl = wl_registry_bind(registry, name, &wl_output_interface, bind);
    wl_output_add_listener(out->wl, &output_listener, out);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data; (void)registry;
  for (int i = 0; i < g.n_outputs; i++) {
    if (g.outputs[i].global != name) continue;
    if (g.pointer && strcmp(g.pointer_output, g.outputs[i].name) == 0) {
      release_buttons();
      destroy_pointer();
    }
    if (g.outputs[i].wl) {
      if (wl_proxy_get_version((struct wl_proxy *)g.outputs[i].wl) >= WL_OUTPUT_RELEASE_SINCE_VERSION) wl_output_release(g.outputs[i].wl);
      else wl_output_destroy(g.outputs[i].wl);
    }
    g.outputs[i] = g.outputs[g.n_outputs - 1];
    g.n_outputs--;
    return;
  }
}

static const struct wl_registry_listener registry_listener = {
  .global = registry_global,
  .global_remove = registry_global_remove,
};

static void cleanup(void) {
  release_buttons();
  destroy_pointer();
  if (g.manager) {
    zwlr_virtual_pointer_manager_v1_destroy(g.manager);
    g.manager = NULL;
  }
  for (int i = 0; i < g.n_outputs; i++) {
    if (!g.outputs[i].wl) continue;
    if (wl_proxy_get_version((struct wl_proxy *)g.outputs[i].wl) >= WL_OUTPUT_RELEASE_SINCE_VERSION) wl_output_release(g.outputs[i].wl);
    else wl_output_destroy(g.outputs[i].wl);
    g.outputs[i].wl = NULL;
  }
  g.n_outputs = 0;
  if (g.registry) { wl_registry_destroy(g.registry); g.registry = NULL; }
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
    emit_error(NULL, "virtual_pointer_unsupported");
    cleanup();
    return 1;
  }
  if (g.manager_version < 2) {
    emit_error(NULL, "virtual_pointer_output_unsupported");
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
