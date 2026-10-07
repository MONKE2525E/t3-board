#define _GNU_SOURCE
#include <cairo.h>
#include <errno.h>
#include <fcntl.h>
#include <json-glib/json-glib.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "muse-logo.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#include "xdg-output-unstable-v1-client-protocol.h"

/* Build (scripts/native-build.cjs):
 *   wayland-scanner client-header native/protocols/overlay/<name>.xml
 *     native/generated/overlay/<name>-client-protocol.h
 *   wayland-scanner private-code native/protocols/overlay/<name>.xml
 *     native/generated/overlay/<name>-protocol.c
 *   cc -std=gnu11 -O2 -Wall -Wextra -Werror native/control-overlay.c
 *     -o native/bin/muse-control-overlay
 *     -Inative/generated/overlay native/generated/overlay/<name>-protocol.c
 *     $(pkg-config --cflags --libs wayland-client cairo json-glib-1.0) -lm
 *
 * argv: muse-control-overlay [--logo PATH] [--top-margin PX]
 *       muse-control-overlay [--logo PATH] [--top-margin PX]
 *           --render-demo PATH WIDTH HEIGHT [click|paused|hidden] [--demo-time MS]
 * --logo loads a PNG (packaged assets/icon.png); an embedded copy of the same
 * logo (native/muse-logo.h) is used when it is missing or unreadable.
 * MUSE_REDUCED_MOTION=1 disables every animation.
 *
 * stdin (JSON lines): {active,id?}, {action}, {ping}, {quit},
 *   {pointer:{x,y,visible,click},id?}, {paused,reason?,pause_until_ms?},
 *   {capture_hidden,id}
 * stdout: ready, active, pointer, stop, pause, resume, capture, error.
 * Never print logs on stdout.
 */

enum {
  MAX_LINE = 16384,
  HEARTBEAT_MS = 6000,
  MAP_TIMEOUT_MS = 2500,
  GLOW_PX = 12,
  /* Badge canvas: the pill plus room for its shadow. */
  BADGE_W = 392,
  BADGE_H = 64,
  PILL_X = 14,
  PILL_Y = 8,
  PILL_W = 364,
  PILL_H = 48,
  DEFAULT_TOP_MARGIN = 44,
  ACTION_MAX = 48,
  ANIM_FRAME_MS = 33,
  REVEAL_MS = 260,
  SWAP_MS = 200,
  ACTION_SWAP_MS = 180,
  RIPPLE_MS = 420,
  HALO_MS = 1800,
  TOGGLE_RETRY_MS = 1500,
  CAPTURE_MAX_MS = 4000
};

/* Overlay chrome is stable Muse blue #4185ff. */
#define MUSE_R (65.0 / 255.0)
#define MUSE_G (133.0 / 255.0)
#define MUSE_B (255.0 / 255.0)

#define NS_GLOW "muse-control-overlay"
#define NS_STOP "muse-control-stop"
static char glow_namespace[96] = NS_GLOW;
static char stop_namespace[96] = NS_STOP;

/* Only these labels are ever drawn; anything else becomes "Working". */
static const char *const ACTION_WHITELIST[] = {"Ready",    "Observing",       "Moving pointer", "Clicking",
                                               "Double clicking", "Dragging", "Scrolling",      "Typing",
                                               "Pressing a key",  "Focusing", "Opening app", "Moving window",
                                               "Switching workspace", "Working"};

struct App;
struct Output;

enum SurfKind { SURF_GLOW, SURF_BADGE };
enum Target { TARGET_NONE, TARGET_TOGGLE, TARGET_STOP };

struct Rect {
  int x, y, w, h;
};

struct Buffer {
  struct wl_buffer *wl;
  void *data;
  size_t size;
  int width, height, stride, scale;
  int busy;
  struct Surface *surface;
};

struct Surface {
  struct Output *output;
  enum SurfKind kind;
  struct wl_surface *wl;
  struct zwlr_layer_surface_v1 *layer;
  int width, height;
  uint32_t configure_serial;
  int configured;
  int mapped;
  struct Buffer bufs[2];
  int buf_i;
  struct Rect toggle, stop;
  int capture_epoch, capture_needed;
};

struct Output {
  struct App *app;
  struct Output *next;
  uint32_t registry_name;
  struct wl_output *wl;
  struct zxdg_output_v1 *xdg;
  int32_t x, y, logical_w, logical_h;
  int32_t phys_w, phys_h, scale, transform;
  char output_name[64];
  int have_xdg_size;
  int have_mode;
  struct Surface glow;
  struct Surface badge;
};

struct CapCb {
  struct App *app;
  int epoch;
};

struct App {
  struct wl_display *display;
  struct wl_registry *registry;
  struct wl_compositor *compositor;
  struct wl_shm *shm;
  struct wl_seat *seat;
  struct wl_pointer *pointer;
  struct zwlr_layer_shell_v1 *layer_shell;
  struct zxdg_output_manager_v1 *xdg_mgr;
  uint32_t layer_shell_version;
  uint32_t seat_version;
  struct Output *outputs;
  int output_count;
  int running;
  int session_active;
  int pending_active;
  int pending_has_id;
  int64_t pending_id;
  int64_t last_ping_ms;
  int64_t activate_ms;
  char action[ACTION_MAX + 1];
  char prev_action[ACTION_MAX + 1];
  int64_t action_ms;
  int pointer_visible;
  int pointer_click;
  double pointer_x, pointer_y;
  int64_t click_ms;
  struct Surface *pointer_focus;
  double local_x, local_y;
  char stdin_buf[MAX_LINE + 2];
  size_t stdin_len;
  int stop_sent;
  int top_margin;
  int reduced_motion;
  int paused;
  int pause_reason; /* 0 none, 1 human_input, 2 user_pause */
  int64_t pause_until_ms;
  int64_t state_ms;
  enum Target hover, press;
  int64_t toggle_sent_ms;
  int64_t last_anim_ms;
  /* capture_hidden handshake */
  int capture_hidden;
  int64_t capture_hidden_ms;
  int cap_pending, cap_has_id, cap_want_hidden, cap_sync_done, cap_frames, cap_epoch, cap_collect;
  int64_t cap_id;
};

static volatile sig_atomic_t g_stop;
static struct App *g_app;

static void surface_destroy(struct Surface *s);
static void surface_create(struct Output *o, enum SurfKind kind);
static int surface_render(struct Surface *s);
static void maybe_ack_active(struct App *app);
static int capture_watch_frame(struct Surface *s);
static void session_end(struct App *app, int has_id, int64_t id, int mapped_fail);
static void session_check_outputs(struct App *app);
static void destroy_all_surfaces(struct App *app);
static void outputs_sync_surfaces(struct App *app);

static int64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static uint32_t u32min(uint32_t a, uint32_t b) { return a < b ? a : b; }

static void emit_line(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void emit_ready(int outputs) {
  char buf[96];
  snprintf(buf, sizeof buf, "{\"event\":\"ready\",\"outputs\":%d}", outputs);
  emit_line(buf);
}

static void emit_error(const char *code) {
  char buf[96];
  snprintf(buf, sizeof buf, "{\"event\":\"error\",\"code\":\"%s\"}", code);
  emit_line(buf);
}

static void emit_stop(void) { emit_line("{\"event\":\"stop\"}"); }

static void emit_pointer_ack(int64_t id) {
  char buf[96];
  snprintf(buf, sizeof buf, "{\"event\":\"pointer\",\"id\":%lld}", (long long)id);
  emit_line(buf);
}

static void emit_active(struct App *app, int active, int outputs) {
  char buf[160];
  if (app->pending_has_id) {
    snprintf(buf, sizeof buf,
             "{\"event\":\"active\",\"id\":%lld,\"active\":%s,\"outputs\":%d}",
             (long long)app->pending_id, active ? "true" : "false", outputs);
  } else {
    snprintf(buf, sizeof buf, "{\"event\":\"active\",\"active\":%s,\"outputs\":%d}",
             active ? "true" : "false", outputs);
  }
  emit_line(buf);
}

static void on_signal(int sig) {
  (void)sig;
  g_stop = 1;
  if (g_app) g_app->running = 0;
}

static void path_round_rect(cairo_t *cr, double x, double y, double w, double h, double r) {
  if (r > w / 2.0) r = w / 2.0;
  if (r > h / 2.0) r = h / 2.0;
  cairo_new_sub_path(cr);
  cairo_arc(cr, x + w - r, y + r, r, -M_PI / 2.0, 0);
  cairo_arc(cr, x + w - r, y + h - r, r, 0, M_PI / 2.0);
  cairo_arc(cr, x + r, y + h - r, r, M_PI / 2.0, M_PI);
  cairo_arc(cr, x + r, y + r, r, M_PI, 3.0 * M_PI / 2.0);
  cairo_close_path(cr);
}

static double clamp01(double v) { return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v; }
static double ease_out(double t) {
  t = 1.0 - clamp01(t);
  return 1.0 - t * t * t;
}
static double lerp(double a, double b, double t) { return a + (b - a) * t; }

static void set_action(struct App *app, const char *text) {
  const char *next = "Working";
  if (!text) text = "";
  for (size_t i = 0; i < sizeof ACTION_WHITELIST / sizeof ACTION_WHITELIST[0]; i++) {
    if (strcmp(text, ACTION_WHITELIST[i]) == 0) {
      next = ACTION_WHITELIST[i];
      break;
    }
  }
  if (strcmp(next, app->action) == 0) return;
  memcpy(app->prev_action, app->action, sizeof app->prev_action);
  snprintf(app->action, sizeof app->action, "%s", next);
  app->action_ms = now_ms();
}

/* ---- Muse logo (genuine assets/icon.png, never a hand-drawn glyph) ---- */

static cairo_surface_t *g_logo;

struct PngMem {
  const unsigned char *p;
  size_t n, off;
};

static cairo_status_t png_mem_read(void *closure, unsigned char *data, unsigned int length) {
  struct PngMem *m = closure;
  if (m->off + length > m->n) return CAIRO_STATUS_READ_ERROR;
  memcpy(data, m->p + m->off, length);
  m->off += length;
  return CAIRO_STATUS_SUCCESS;
}

static void logo_load(const char *path) {
  cairo_surface_t *img = NULL;
  if (path && *path) {
    img = cairo_image_surface_create_from_png(path);
    if (cairo_surface_status(img) != CAIRO_STATUS_SUCCESS || cairo_image_surface_get_width(img) < 16) {
      cairo_surface_destroy(img);
      img = NULL;
    }
  }
  if (!img) {
    struct PngMem m = {muse_logo_png, (size_t)muse_logo_png_len, 0};
    img = cairo_image_surface_create_from_png_stream(png_mem_read, &m);
    if (cairo_surface_status(img) != CAIRO_STATUS_SUCCESS) {
      cairo_surface_destroy(img);
      img = NULL;
    }
  }
  g_logo = img;
}

/* Logo centered at (cx, cy), `size` logical px wide. Falls back to a plain brand dot. */
static void draw_logo(cairo_t *cr, double cx, double cy, double size, double alpha) {
  if (g_logo) {
    double w = (double)cairo_image_surface_get_width(g_logo);
    cairo_save(cr);
    cairo_translate(cr, cx - size / 2.0, cy - size / 2.0);
    cairo_scale(cr, size / w, size / w);
    cairo_set_source_surface(cr, g_logo, 0, 0);
    cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_BEST);
    cairo_paint_with_alpha(cr, alpha);
    cairo_restore(cr);
  } else {
    cairo_set_source_rgba(cr, MUSE_R, MUSE_G, MUSE_B, alpha);
    cairo_arc(cr, cx, cy, size * 0.32, 0, 2.0 * M_PI);
    cairo_fill(cr);
  }
}

static void muse_rgb(cairo_t *cr, double a) { cairo_set_source_rgba(cr, MUSE_R, MUSE_G, MUSE_B, a); }

static void glow_edge(cairo_t *cr, double x0, double y0, double x1, double y1, double rx, double ry, double rw,
                      double rh, double a) {
  cairo_pattern_t *p = cairo_pattern_create_linear(x0, y0, x1, y1);
  cairo_pattern_add_color_stop_rgba(p, 0.0, MUSE_R, MUSE_G, MUSE_B, a);
  cairo_pattern_add_color_stop_rgba(p, 1.0, MUSE_R, MUSE_G, MUSE_B, 0.0);
  cairo_set_source(cr, p);
  cairo_rectangle(cr, rx, ry, rw, rh);
  cairo_fill(cr);
  cairo_pattern_destroy(p);
}

/* `strength` scales the border: 1.0 while Muse acts, lower while paused. */
static void draw_glow(cairo_t *cr, int w, int h, double strength) {
  const double band = (double)GLOW_PX, a = 0.70 * strength;
  glow_edge(cr, 0, 0, 0, band, 0, 0, w, band, a);
  glow_edge(cr, 0, h, 0, h - band, 0, h - band, w, band, a);
  glow_edge(cr, 0, 0, band, 0, 0, 0, band, h, a);
  glow_edge(cr, w, 0, w - band, 0, w - band, 0, band, h, a);
  muse_rgb(cr, 0.95 * strength);
  cairo_set_line_width(cr, 2.0);
  cairo_rectangle(cr, 1.0, 1.0, (double)w - 2.0, (double)h - 2.0);
  cairo_stroke(cr);
}

/* Pointer feedback. The real system cursor is never redrawn: this is only a small Muse
 * brand badge offset down-right of the hotspot plus a thin click ripple centered on it.
 * `ripple` is 0..1 progress, or negative for none. */
static void draw_pointer_mark(cairo_t *cr, double x, double y, double ripple) {
  const double bx = x + 30.0, by = y + 28.0, size = 22.0;
  cairo_set_source_rgba(cr, 0, 0, 0, 0.22);
  cairo_arc(cr, bx, by + 1.2, size / 2.0 + 1.5, 0, 2.0 * M_PI);
  cairo_fill(cr);
  muse_rgb(cr, 0.9);
  cairo_set_line_width(cr, 1.6);
  cairo_arc(cr, bx, by, size / 2.0 + 1.0, 0, 2.0 * M_PI);
  cairo_stroke(cr);
  draw_logo(cr, bx, by, size, 0.97);
  if (ripple >= 0.0) {
    double t = ease_out(ripple);
    muse_rgb(cr, 0.16 * (1.0 - ripple));
    cairo_arc(cr, x, y, 7.0 + 19.0 * t, 0, 2.0 * M_PI);
    cairo_fill(cr);
    muse_rgb(cr, 0.9 * (1.0 - ripple));
    cairo_set_line_width(cr, 2.4 - 1.0 * ripple);
    cairo_arc(cr, x, y, 7.0 + 19.0 * t, 0, 2.0 * M_PI);
    cairo_stroke(cr);
  }
}

static void measure_text(cairo_t *cr, const char *text, double size, int bold, cairo_text_extents_t *ex) {
  cairo_select_font_face(cr, "sans-serif", CAIRO_FONT_SLANT_NORMAL, bold ? CAIRO_FONT_WEIGHT_BOLD : CAIRO_FONT_WEIGHT_NORMAL);
  cairo_set_font_size(cr, size);
  cairo_text_extents(cr, text, ex);
}

static void text_at(cairo_t *cr, const char *text, double x, double y, double size, int bold, double r, double g,
                    double b, double a) {
  if (a <= 0.01) return;
  cairo_text_extents_t ex;
  measure_text(cr, text, size, bold, &ex);
  cairo_set_source_rgba(cr, r, g, b, a);
  cairo_move_to(cr, x, y);
  cairo_show_text(cr, text);
}

/* Render state derived from time and App, so the demo can render fixed frames. */
struct Ui {
  int paused;
  double reveal;  /* 0..1 entrance */
  double swap;    /* 0..1 progress of the last Active/Paused switch */
  double action_t; /* 0..1 progress of the last action label change */
  double phase;   /* 0..1 halo cycle */
  int reduced;
  enum Target hover;
  int toggle_busy, stop_busy;
};

enum Icon { ICON_PAUSE, ICON_PLAY, ICON_STOP };

static void draw_icon(cairo_t *cr, enum Icon icon, double cx, double cy, double a) {
  cairo_set_source_rgba(cr, 1, 1, 1, a);
  if (icon == ICON_PAUSE) {
    path_round_rect(cr, cx - 5.0, cy - 5.5, 3.4, 11.0, 1.2);
    path_round_rect(cr, cx + 1.6, cy - 5.5, 3.4, 11.0, 1.2);
    cairo_fill(cr);
  } else if (icon == ICON_PLAY) {
    cairo_move_to(cr, cx - 3.6, cy - 6.0);
    cairo_line_to(cr, cx + 5.4, cy);
    cairo_line_to(cr, cx - 3.6, cy + 6.0);
    cairo_close_path(cr);
    cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
    cairo_set_line_width(cr, 1.4);
    cairo_fill_preserve(cr);
    cairo_stroke(cr);
  } else {
    path_round_rect(cr, cx - 4.5, cy - 4.5, 9.0, 9.0, 2.0);
    cairo_fill(cr);
  }
}

static void draw_button_content(cairo_t *cr, const struct Rect *r, enum Icon icon, const char *label, double a) {
  cairo_text_extents_t ex;
  if (a <= 0.01) return;
  measure_text(cr, label, 12.5, 1, &ex);
  double content = 11.0 + 6.0 + ex.x_advance;
  double x0 = r->x + (r->w - content) / 2.0;
  draw_icon(cr, icon, x0 + 5.5, r->y + r->h / 2.0, a);
  cairo_set_source_rgba(cr, 1, 1, 1, a);
  cairo_move_to(cr, x0 + 17.0, r->y + r->h / 2.0 + (ex.height / 2.0) * 0.98);
  cairo_show_text(cr, label);
}

static void draw_badge(cairo_t *cr, const struct Ui *ui, const char *action, const char *prev_action,
                       struct Rect *toggle_out, struct Rect *stop_out) {
  const double px = PILL_X, py = PILL_Y, pw = PILL_W, ph = PILL_H;
  const double k = ui->paused ? ui->swap : 1.0 - ui->swap; /* 0 active look .. 1 paused look */
  struct Rect stop = {PILL_X + PILL_W - 8 - 64, PILL_Y + 8, 64, 32};
  struct Rect toggle = {stop.x - 6 - 86, stop.y, 86, 32};
  const double reveal = ease_out(ui->reveal);

  cairo_save(cr);
  cairo_translate(cr, 0, (reveal - 1.0) * 8.0);
  cairo_push_group(cr);

  /* soft shadow */
  for (int i = 6; i >= 1; i--) {
    path_round_rect(cr, px - i, py - i + 2.0, pw + 2.0 * i, ph + 2.0 * i, ph / 2.0 + i);
    cairo_set_source_rgba(cr, 0, 0, 0, 0.045);
    cairo_fill(cr);
  }
  /* solid pill */
  path_round_rect(cr, px, py, pw, ph, ph / 2.0);
  cairo_set_source_rgb(cr, 0.086, 0.094, 0.114);
  cairo_fill(cr);
  path_round_rect(cr, px + 0.5, py + 0.5, pw - 1.0, ph - 1.0, (ph - 1.0) / 2.0);
  cairo_set_source_rgba(cr, MUSE_R, MUSE_G, MUSE_B, lerp(0.55, 0.0, k));
  cairo_set_line_width(cr, 1.0);
  cairo_stroke_preserve(cr);
  cairo_set_source_rgba(cr, 1, 1, 1, lerp(0.0, 0.14, k));
  cairo_stroke(cr);

  /* logo with a slow halo while Muse is acting */
  const double lx = px + 10.0 + 18.0, ly = py + ph / 2.0;
  double halo = 1.0 - k;
  if (halo > 0.01) {
    double t = ui->reduced ? 0.0 : ui->phase;
    double rr = ui->reduced ? 21.0 : 18.0 + 8.0 * ease_out(t);
    double ha = ui->reduced ? 0.30 : 0.42 * (1.0 - t);
    muse_rgb(cr, ha * halo);
    cairo_set_line_width(cr, 2.0);
    cairo_arc(cr, lx, ly, rr, 0, 2.0 * M_PI);
    cairo_stroke(cr);
  }
  draw_logo(cr, lx, ly, 36.0, lerp(1.0, 0.55, k));

  /* text */
  const double tx = px + 10.0 + 36.0 + 12.0;
  text_at(cr, "Muse is working", tx, py + 21.0, 14.0, 1, 1, 1, 1, 0.97 * (1.0 - k));
  text_at(cr, "Paused", tx, py + 21.0, 14.0, 1, 1, 1, 1, 0.97 * k);
  const double sub_active = 1.0 - k;
  if (ui->action_t < 1.0) {
    double t = ease_out(ui->action_t);
    text_at(cr, prev_action, tx, py + 37.0 - 7.0 * t, 12.0, 0, 0.62, 0.78, 1.0, 0.9 * (1.0 - t) * sub_active);
    text_at(cr, action, tx, py + 37.0 + 7.0 * (1.0 - t), 12.0, 0, 0.62, 0.78, 1.0, 0.9 * t * sub_active);
  } else {
    text_at(cr, action, tx, py + 37.0, 12.0, 0, 0.62, 0.78, 1.0, 0.9 * sub_active);
  }
  text_at(cr, "You have control", tx, py + 37.0, 12.0, 0, 0.80, 0.83, 0.90, 0.85 * k);

  /* Pause/Resume */
  {
    double hov = ui->hover == TARGET_TOGGLE ? 1.0 : 0.0;
    double busy = ui->toggle_busy ? 0.55 : 1.0;
    double r = lerp(1.0, MUSE_R, k), g = lerp(1.0, MUSE_G, k), b = lerp(1.0, MUSE_B, k);
    double a = lerp(0.11 + 0.07 * hov, 0.96, k);
    path_round_rect(cr, toggle.x, toggle.y, toggle.w, toggle.h, 10.0);
    cairo_set_source_rgba(cr, r, g, b, a * busy);
    cairo_fill_preserve(cr);
    cairo_set_source_rgba(cr, 1, 1, 1, lerp(0.14, 0.0, k) * busy);
    cairo_set_line_width(cr, 1.0);
    cairo_stroke(cr);
    if (hov > 0.0 && k > 0.5) {
      path_round_rect(cr, toggle.x, toggle.y, toggle.w, toggle.h, 10.0);
      cairo_set_source_rgba(cr, 1, 1, 1, 0.14);
      cairo_fill(cr);
    }
    draw_button_content(cr, &toggle, ICON_PAUSE, "Pause", (1.0 - k) * busy);
    draw_button_content(cr, &toggle, ICON_PLAY, "Resume", k * busy);
  }
  /* Stop */
  {
    double hov = ui->hover == TARGET_STOP ? 1.0 : 0.0;
    double busy = ui->stop_busy ? 0.55 : 1.0;
    path_round_rect(cr, stop.x, stop.y, stop.w, stop.h, 10.0);
    cairo_set_source_rgba(cr, 0.90 + 0.06 * hov, 0.28 + 0.08 * hov, 0.30 + 0.08 * hov, busy);
    cairo_fill(cr);
    draw_button_content(cr, &stop, ICON_STOP, "Stop", busy);
  }

  cairo_pop_group_to_source(cr);
  cairo_paint_with_alpha(cr, reveal);
  cairo_restore(cr);

  if (toggle_out) *toggle_out = toggle;
  if (stop_out) *stop_out = stop;
}

static void draw_fixture_bg(cairo_t *cr, int w, int h) {
  cairo_set_source_rgb(cr, 0.204, 0.220, 0.247);
  cairo_paint(cr);
  cairo_set_source_rgb(cr, 0.247, 0.267, 0.298);
  cairo_rectangle(cr, 28, 28, (double)w - 56, (double)h - 56);
  cairo_fill(cr);
  /* stand-in for a desktop top bar: the badge must sit below it */
  cairo_set_source_rgb(cr, 0.07, 0.075, 0.09);
  cairo_rectangle(cr, 0, 0, w, 34);
  cairo_fill(cr);
  cairo_set_source_rgb(cr, 0.55, 0.58, 0.64);
  for (int i = 0; i < 5; i++) cairo_rectangle(cr, 14 + i * 26, 12, 16, 10), cairo_fill(cr);
}

static void draw_clear(cairo_t *cr) {
  cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
  cairo_set_source_rgba(cr, 0, 0, 0, 0);
  cairo_paint(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
}

static int output_contains(const struct Output *o, double x, double y) {
  return o->logical_w > 0 && o->logical_h > 0 && x >= o->x && y >= o->y && x < o->x + o->logical_w &&
         y < o->y + o->logical_h;
}

static void output_refresh_logical(struct Output *o) {
  if (o->have_xdg_size && o->logical_w > 0 && o->logical_h > 0) return;
  int w = o->phys_w, h = o->phys_h;
  if (o->transform == WL_OUTPUT_TRANSFORM_90 || o->transform == WL_OUTPUT_TRANSFORM_270 ||
      o->transform == WL_OUTPUT_TRANSFORM_FLIPPED_90 || o->transform == WL_OUTPUT_TRANSFORM_FLIPPED_270) {
    int t = w;
    w = h;
    h = t;
  }
  int scale = o->scale > 0 ? o->scale : 1;
  if (w > 0 && h > 0) {
    o->logical_w = w / scale;
    o->logical_h = h / scale;
  }
}

static void buffer_release(void *data, struct wl_buffer *buffer) {
  struct Buffer *b = data;
  (void)buffer;
  if (b) b->busy = 0;
}

static const struct wl_buffer_listener buffer_listener = {.release = buffer_release};

static void buffer_destroy(struct Buffer *b) {
  if (!b) return;
  if (b->wl) {
    wl_buffer_destroy(b->wl);
    b->wl = NULL;
  }
  if (b->data && b->size) {
    munmap(b->data, b->size);
    b->data = NULL;
  }
  b->size = 0;
  b->busy = 0;
}

static int buffer_init(struct App *app, struct Buffer *b, struct Surface *s, int width, int height, int scale) {
  int stride = cairo_format_stride_for_width(CAIRO_FORMAT_ARGB32, width);
  size_t size = (size_t)stride * (size_t)height;
  int fd = memfd_create("muse-control-overlay", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (fd < 0) return -1;
  if (ftruncate(fd, (off_t)size) < 0) {
    close(fd);
    return -1;
  }
  void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (data == MAP_FAILED) {
    close(fd);
    return -1;
  }
  struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, (int32_t)size);
  close(fd);
  if (!pool) {
    munmap(data, size);
    return -1;
  }
  struct wl_buffer *wl = wl_shm_pool_create_buffer(pool, 0, width, height, stride, WL_SHM_FORMAT_ARGB8888);
  wl_shm_pool_destroy(pool);
  if (!wl) {
    munmap(data, size);
    return -1;
  }
  buffer_destroy(b);
  b->wl = wl;
  b->data = data;
  b->size = size;
  b->width = width;
  b->height = height;
  b->stride = stride;
  b->scale = scale;
  b->busy = 0;
  b->surface = s;
  wl_buffer_add_listener(wl, &buffer_listener, b);
  return 0;
}

static struct Buffer *surface_buffer(struct Surface *s, int width, int height, int scale) {
  struct Buffer *b = &s->bufs[s->buf_i];
  if (b->busy) {
    s->buf_i = 1 - s->buf_i;
    b = &s->bufs[s->buf_i];
  }
  if (b->busy) return NULL;
  if (!b->wl || b->width != width || b->height != height || b->scale != scale) {
    if (buffer_init(s->output->app, b, s, width, height, scale) != 0) return NULL;
  }
  return b;
}

static void ui_from_app(const struct App *app, struct Ui *ui) {
  int64_t now = now_ms();
  memset(ui, 0, sizeof *ui);
  ui->paused = app->paused;
  ui->reduced = app->reduced_motion;
  ui->reveal = ui->swap = ui->action_t = 1.0;
  if (!app->reduced_motion) {
    ui->reveal = clamp01((double)(now - app->activate_ms) / REVEAL_MS);
    ui->swap = clamp01((double)(now - app->state_ms) / SWAP_MS);
    ui->action_t = clamp01((double)(now - app->action_ms) / ACTION_SWAP_MS);
    ui->phase = (double)(now % HALO_MS) / HALO_MS;
  }
  ui->hover = app->hover;
  ui->toggle_busy = app->toggle_sent_ms != 0;
  ui->stop_busy = app->stop_sent;
}

static int animating(const struct App *app) {
  int64_t now = now_ms();
  if (app->reduced_motion || !(app->session_active || app->pending_active) || app->capture_hidden) return 0;
  return !app->paused || now - app->activate_ms < REVEAL_MS + 50 || now - app->state_ms < SWAP_MS + 50 ||
         now - app->action_ms < ACTION_SWAP_MS + 50;
}

static double ripple_progress(const struct App *app) {
  if (!app->pointer_click) return -1.0;
  if (app->reduced_motion) return 0.3;
  double t = (double)(now_ms() - app->click_ms) / RIPPLE_MS;
  return t >= 1.0 ? -1.0 : clamp01(t);
}

static int ripple_running(const struct App *app) {
  return !app->reduced_motion && app->pointer_visible && app->pointer_click && !app->paused &&
         now_ms() - app->click_ms < RIPPLE_MS + 50;
}

/* Shared by the live surfaces and --render-demo. `hidden` paints nothing at all. */
static void paint_glow_surface(cairo_t *cr, int w, int h, int hidden, int paused, int show_pointer, double px, double py,
                               double ripple) {
  if (hidden) return;
  draw_glow(cr, w, h, paused ? 0.40 : 1.0);
  if (show_pointer && !paused) draw_pointer_mark(cr, px, py, ripple);
}

static void paint_badge_surface(cairo_t *cr, int w, int hidden, const struct Ui *ui, const char *action,
                                const char *prev_action, struct Rect *toggle, struct Rect *stop) {
  int ox = w > BADGE_W ? (w - BADGE_W) / 2 : 0;
  if (hidden) {
    memset(toggle, 0, sizeof *toggle);
    memset(stop, 0, sizeof *stop);
    return;
  }
  cairo_save(cr);
  cairo_translate(cr, ox, 0);
  draw_badge(cr, ui, action, prev_action, toggle, stop);
  cairo_restore(cr);
  toggle->x += ox;
  stop->x += ox;
}

static void rect_add(struct wl_region *region, const struct Rect *r) {
  if (r->w > 0 && r->h > 0) wl_region_add(region, r->x, r->y, r->w, r->h);
}

static void surface_set_input(struct Surface *s) {
  struct App *app = s->output->app;
  struct wl_region *region = wl_compositor_create_region(app->compositor);
  if (!region) return;
  /* Only the Pause/Resume and Stop buttons take input, and none while hidden for capture. */
  if (s->kind == SURF_BADGE && !app->capture_hidden) {
    rect_add(region, &s->toggle);
    rect_add(region, &s->stop);
  }
  wl_surface_set_input_region(s->wl, region);
  wl_region_destroy(region);
}

static int surface_render(struct Surface *s) {
  if (!s->wl || !s->configured || s->width <= 0 || s->height <= 0) return 0;
  struct Output *o = s->output;
  struct App *app = o->app;
  int scale = o->scale > 0 ? o->scale : 1;
  int bw = s->width * scale;
  int bh = s->height * scale;
  struct Buffer *b = surface_buffer(s, bw, bh, scale);
  if (!b) return -1;
  cairo_surface_t *img =
      cairo_image_surface_create_for_data(b->data, CAIRO_FORMAT_ARGB32, b->width, b->height, b->stride);
  cairo_t *cr = cairo_create(img);
  draw_clear(cr);
  cairo_scale(cr, scale, scale);
  if (s->kind == SURF_GLOW) {
    int show = app->pointer_visible && output_contains(o, app->pointer_x, app->pointer_y);
    paint_glow_surface(cr, s->width, s->height, app->capture_hidden, app->paused, show, app->pointer_x - o->x,
                       app->pointer_y - o->y, ripple_progress(app));
  } else {
    struct Ui ui;
    ui_from_app(app, &ui);
    paint_badge_surface(cr, s->width, app->capture_hidden, &ui, app->action, app->prev_action, &s->toggle, &s->stop);
  }
  cairo_destroy(cr);
  cairo_surface_destroy(img);
  wl_surface_set_buffer_scale(s->wl, scale);
  wl_surface_attach(s->wl, b->wl, 0, 0);
  wl_surface_damage_buffer(s->wl, 0, 0, b->width, b->height);
  surface_set_input(s);
  if (s->capture_needed && s->capture_epoch == app->cap_epoch) {
    if (!capture_watch_frame(s)) return -1;
    s->capture_needed = 0;
  }
  wl_surface_commit(s->wl);
  b->busy = 1;
  s->mapped = 1;
  return 0;
}

static void layer_configure(void *data, struct zwlr_layer_surface_v1 *layer, uint32_t serial, uint32_t width,
                            uint32_t height) {
  struct Surface *s = data;
  (void)layer;
  s->configure_serial = serial;
  s->configured = 1;
  if (width > 0) s->width = (int)width;
  if (height > 0) s->height = (int)height;
  if (s->kind == SURF_BADGE) {
    if (s->width <= 0) s->width = BADGE_W;
    if (s->height <= 0) s->height = BADGE_H;
  }
  zwlr_layer_surface_v1_ack_configure(s->layer, serial);
  if (surface_render(s) != 0) {
    emit_error("shm");
    return;
  }
  maybe_ack_active(s->output->app);
}

static void layer_closed(void *data, struct zwlr_layer_surface_v1 *layer) {
  struct Surface *s = data;
  struct App *app;
  enum SurfKind kind;
  struct Output *o;
  (void)layer;
  if (!s || !s->output) return;
  o = s->output;
  app = o->app;
  kind = s->kind;
  surface_destroy(s);
  if (app->pending_active) {
    session_end(app, app->pending_has_id, app->pending_id, 1);
    return;
  }
  if (app->session_active && o->logical_w > 0 && o->logical_h > 0) surface_create(o, kind);
  session_check_outputs(app);
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
    .configure = layer_configure,
    .closed = layer_closed,
};

static void surface_destroy(struct Surface *s) {
  if (!s) return;
  buffer_destroy(&s->bufs[0]);
  buffer_destroy(&s->bufs[1]);
  if (s->layer) {
    zwlr_layer_surface_v1_destroy(s->layer);
    s->layer = NULL;
  }
  if (s->wl) {
    wl_surface_destroy(s->wl);
    s->wl = NULL;
  }
  s->configured = 0;
  s->mapped = 0;
  s->width = 0;
  s->height = 0;
}

static void surface_create(struct Output *o, enum SurfKind kind) {
  struct App *app = o->app;
  struct Surface *s = kind == SURF_GLOW ? &o->glow : &o->badge;
  uint32_t anchor;
  surface_destroy(s);
  s->output = o;
  s->kind = kind;
  s->wl = wl_compositor_create_surface(app->compositor);
  if (!s->wl) return;
  s->layer = zwlr_layer_shell_v1_get_layer_surface(app->layer_shell, s->wl, o->wl,
                                                   ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY,
                                                   kind == SURF_GLOW ? glow_namespace : stop_namespace);
  if (!s->layer) {
    wl_surface_destroy(s->wl);
    s->wl = NULL;
    return;
  }
  zwlr_layer_surface_v1_add_listener(s->layer, &layer_listener, s);
  zwlr_layer_surface_v1_set_exclusive_zone(s->layer, -1);
  zwlr_layer_surface_v1_set_keyboard_interactivity(s->layer, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
  if (kind == SURF_GLOW) {
    anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
             ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;
    zwlr_layer_surface_v1_set_anchor(s->layer, anchor);
    zwlr_layer_surface_v1_set_size(s->layer, 0, 0);
    s->width = o->logical_w;
    s->height = o->logical_h;
  } else {
    /* Anchored to the top edge only: centered, pill-sized, placed top_margin px below the edge. */
    anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP;
    zwlr_layer_surface_v1_set_anchor(s->layer, anchor);
    zwlr_layer_surface_v1_set_margin(s->layer, app->top_margin > PILL_Y ? app->top_margin - PILL_Y : 0, 0, 0, 0);
    zwlr_layer_surface_v1_set_size(s->layer, BADGE_W, BADGE_H);
    s->width = BADGE_W;
    s->height = BADGE_H;
  }
  surface_set_input(s);
  wl_surface_commit(s->wl);
}

static int mapped_output_count(const struct App *app) {
  int n = 0;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->glow.mapped && o->badge.mapped) n++;
  }
  return n;
}

static int surfaces_waiting(const struct App *app) {
  int waiting = 0;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->glow.wl && !o->glow.mapped) waiting++;
    if (o->badge.wl && !o->badge.mapped) waiting++;
  }
  return waiting;
}

static int created_surface_count(const struct App *app) {
  int n = 0;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->glow.wl) n++;
    if (o->badge.wl) n++;
  }
  return n;
}

static void maybe_ack_active(struct App *app) {
  int mapped;
  if (!app->pending_active) return;
  if (surfaces_waiting(app) > 0) return;
  mapped = mapped_output_count(app);
  if (created_surface_count(app) == 0) {
    emit_active(app, 1, 0);
    app->pending_active = 0;
    app->session_active = 0;
    return;
  }
  if (mapped < 1) return;
  emit_active(app, 1, mapped);
  app->pending_active = 0;
  app->session_active = 1;
  app->last_ping_ms = now_ms();
  app->stop_sent = 0;
}

static void session_check_outputs(struct App *app) {
  if (!app->running) return;
  if (app->pending_active) {
    maybe_ack_active(app);
    return;
  }
  if (!app->session_active) return;
  if (mapped_output_count(app) > 0 || surfaces_waiting(app) > 0) return;
  emit_error("no_outputs");
  destroy_all_surfaces(app);
  app->session_active = 0;
  app->running = 0;
}

static void destroy_all_surfaces(struct App *app) {
  for (struct Output *o = app->outputs; o; o = o->next) {
    surface_destroy(&o->glow);
    surface_destroy(&o->badge);
  }
}

static void outputs_sync_surfaces(struct App *app) {
  for (struct Output *o = app->outputs; o; o = o->next) {
    output_refresh_logical(o);
    if (o->logical_w <= 0 || o->logical_h <= 0) {
      surface_destroy(&o->glow);
      surface_destroy(&o->badge);
      continue;
    }
    if (!o->glow.wl) surface_create(o, SURF_GLOW);
    if (!o->badge.wl) surface_create(o, SURF_BADGE);
  }
}

static void session_begin(struct App *app, int has_id, int64_t id) {
  app->pending_has_id = has_id;
  app->pending_id = id;
  app->pending_active = 1;
  app->activate_ms = now_ms();
  app->last_ping_ms = app->activate_ms;
  app->stop_sent = 0;
  app->toggle_sent_ms = 0;
  if (!app->action[0]) memcpy(app->action, "Ready", 6);
  if (app->session_active && mapped_output_count(app) > 0 && surfaces_waiting(app) == 0) {
    emit_active(app, 1, mapped_output_count(app));
    app->pending_active = 0;
    return;
  }
  outputs_sync_surfaces(app);
  if (created_surface_count(app) == 0) maybe_ack_active(app);
}

static void session_end(struct App *app, int has_id, int64_t id, int mapped_fail) {
  (void)mapped_fail;
  app->pending_has_id = has_id;
  app->pending_id = id;
  destroy_all_surfaces(app);
  emit_active(app, 0, 0);
  app->pending_active = 0;
  app->session_active = 0;
  app->pointer_visible = 0;
  app->pointer_click = 0;
  app->paused = 0;
  app->pause_reason = 0;
  app->capture_hidden = 0;
  app->cap_pending = 0;
  app->cap_epoch++;
  app->toggle_sent_ms = 0;
  app->hover = app->press = TARGET_NONE;
}

static void render_glows(struct App *app) {
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->glow.mapped) surface_render(&o->glow);
  }
}

static void render_badges(struct App *app) {
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->badge.mapped) surface_render(&o->badge);
  }
}

static void render_all(struct App *app) {
  render_glows(app);
  render_badges(app);
}

static struct Surface *surface_from_wl(struct App *app, struct wl_surface *wl) {
  if (!wl) return NULL;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->glow.wl == wl) return &o->glow;
    if (o->badge.wl == wl) return &o->badge;
  }
  return NULL;
}

static void output_destroy(struct App *app, struct Output *target) {
  struct Output **slot = &app->outputs;
  while (*slot && *slot != target) slot = &(*slot)->next;
  if (*slot != target) return;
  *slot = target->next;
  surface_destroy(&target->glow);
  surface_destroy(&target->badge);
  if (target->xdg) zxdg_output_v1_destroy(target->xdg);
  if (target->wl) {
    if (wl_output_get_version(target->wl) >= 3) wl_output_release(target->wl);
    else wl_output_destroy(target->wl);
  }
  free(target);
  app->output_count--;
  if (app->output_count < 0) app->output_count = 0;
  session_check_outputs(app);
}

static void xdg_logical_position(void *data, struct zxdg_output_v1 *xdg, int32_t x, int32_t y) {
  struct Output *o = data;
  (void)xdg;
  o->x = x;
  o->y = y;
}

static void xdg_logical_size(void *data, struct zxdg_output_v1 *xdg, int32_t width, int32_t height) {
  struct Output *o = data;
  (void)xdg;
  if (width < 0) width = -width;
  if (height < 0) height = -height;
  o->logical_w = width;
  o->logical_h = height;
  o->have_xdg_size = width > 0 && height > 0;
}

static void xdg_done(void *data, struct zxdg_output_v1 *xdg) {
  struct Output *o = data;
  struct App *app = o->app;
  (void)xdg;
  output_refresh_logical(o);
  if ((app->session_active || app->pending_active) && o->logical_w > 0 && o->logical_h > 0) {
    int need = !o->glow.wl || !o->badge.wl || o->glow.width != o->logical_w || o->glow.height != o->logical_h;
    if (need) {
      surface_destroy(&o->glow);
      surface_destroy(&o->badge);
      surface_create(o, SURF_GLOW);
      surface_create(o, SURF_BADGE);
    }
  }
}

static void xdg_name(void *data, struct zxdg_output_v1 *xdg, const char *name) {
  struct Output *o = data;
  (void)xdg;
  if (!name) return;
  snprintf(o->output_name, sizeof o->output_name, "%s", name);
}

static void xdg_description(void *data, struct zxdg_output_v1 *xdg, const char *description) {
  (void)data;
  (void)xdg;
  (void)description;
}

static const struct zxdg_output_v1_listener xdg_listener = {
    .logical_position = xdg_logical_position,
    .logical_size = xdg_logical_size,
    .done = xdg_done,
    .name = xdg_name,
    .description = xdg_description,
};

static void output_geometry(void *data, struct wl_output *wl, int32_t x, int32_t y, int32_t phys_w, int32_t phys_h,
                            int32_t subpixel, const char *make, const char *model, int32_t transform) {
  struct Output *o = data;
  (void)wl;
  (void)phys_w;
  (void)phys_h;
  (void)subpixel;
  (void)make;
  (void)model;
  o->transform = transform;
  if (!o->have_xdg_size) {
    o->x = x;
    o->y = y;
  }
}

static void output_mode(void *data, struct wl_output *wl, uint32_t flags, int32_t width, int32_t height, int32_t refresh) {
  struct Output *o = data;
  (void)wl;
  (void)refresh;
  if (flags & WL_OUTPUT_MODE_CURRENT) {
    o->phys_w = width;
    o->phys_h = height;
    o->have_mode = 1;
    output_refresh_logical(o);
  }
}

static void output_done(void *data, struct wl_output *wl) {
  struct Output *o = data;
  (void)wl;
  output_refresh_logical(o);
}

static void output_scale(void *data, struct wl_output *wl, int32_t factor) {
  struct Output *o = data;
  (void)wl;
  o->scale = factor > 0 ? factor : 1;
  output_refresh_logical(o);
}

static void output_name(void *data, struct wl_output *wl, const char *name) {
  struct Output *o = data;
  (void)wl;
  if (!name || o->output_name[0]) return;
  snprintf(o->output_name, sizeof o->output_name, "%s", name);
}

static void output_description(void *data, struct wl_output *wl, const char *description) {
  (void)data;
  (void)wl;
  (void)description;
}

static const struct wl_output_listener output_listener = {
    .geometry = output_geometry,
    .mode = output_mode,
    .done = output_done,
    .scale = output_scale,
    .name = output_name,
    .description = output_description,
};

static void output_bind_xdg(struct Output *o) {
  struct App *app = o->app;
  if (!app->xdg_mgr || !o->wl || o->xdg) return;
  o->xdg = zxdg_output_manager_v1_get_xdg_output(app->xdg_mgr, o->wl);
  if (o->xdg) zxdg_output_v1_add_listener(o->xdg, &xdg_listener, o);
}

static struct Output *output_add(struct App *app, uint32_t name, uint32_t version) {
  struct Output *o = calloc(1, sizeof *o);
  if (!o) return NULL;
  o->app = app;
  o->registry_name = name;
  o->scale = 1;
  o->wl = wl_registry_bind(app->registry, name, &wl_output_interface, u32min(version, 4));
  o->glow.output = o;
  o->glow.kind = SURF_GLOW;
  o->badge.output = o;
  o->badge.kind = SURF_BADGE;
  wl_output_add_listener(o->wl, &output_listener, o);
  output_bind_xdg(o);
  o->next = app->outputs;
  app->outputs = o;
  app->output_count++;
  return o;
}

static int rect_has(const struct Rect *r, double x, double y) {
  return r->w > 0 && r->h > 0 && x >= r->x && y >= r->y && x < r->x + r->w && y < r->y + r->h;
}

static enum Target hit_target(const struct Surface *s, double x, double y) {
  if (!s || s->kind != SURF_BADGE || s->output->app->capture_hidden) return TARGET_NONE;
  if (rect_has(&s->stop, x, y)) return TARGET_STOP;
  if (rect_has(&s->toggle, x, y)) return TARGET_TOGGLE;
  return TARGET_NONE;
}

static void set_hover(struct App *app, enum Target t) {
  if (app->hover == t) return;
  app->hover = t;
  render_badges(app);
}

static void pointer_enter(void *data, struct wl_pointer *pointer, uint32_t serial, struct wl_surface *surface,
                          wl_fixed_t x, wl_fixed_t y) {
  struct App *app = data;
  (void)pointer;
  (void)serial;
  app->pointer_focus = surface_from_wl(app, surface);
  app->local_x = wl_fixed_to_double(x);
  app->local_y = wl_fixed_to_double(y);
  set_hover(app, hit_target(app->pointer_focus, app->local_x, app->local_y));
}

static void pointer_leave(void *data, struct wl_pointer *pointer, uint32_t serial, struct wl_surface *surface) {
  struct App *app = data;
  (void)pointer;
  (void)serial;
  (void)surface;
  app->pointer_focus = NULL;
  app->press = TARGET_NONE;
  set_hover(app, TARGET_NONE);
}

static void pointer_motion(void *data, struct wl_pointer *pointer, uint32_t time, wl_fixed_t x, wl_fixed_t y) {
  struct App *app = data;
  (void)pointer;
  (void)time;
  app->local_x = wl_fixed_to_double(x);
  app->local_y = wl_fixed_to_double(y);
  set_hover(app, hit_target(app->pointer_focus, app->local_x, app->local_y));
}

static void pointer_button(void *data, struct wl_pointer *pointer, uint32_t serial, uint32_t time, uint32_t button,
                           uint32_t state) {
  struct App *app = data;
  enum Target t = hit_target(app->pointer_focus, app->local_x, app->local_y);
  (void)pointer;
  (void)serial;
  (void)time;
  if (button != BTN_LEFT) return;
  if (state == WL_POINTER_BUTTON_STATE_PRESSED) {
    app->press = t;
    return;
  }
  /* A click needs press and release on the same button. */
  if (t == TARGET_NONE || t != app->press) {
    app->press = TARGET_NONE;
    return;
  }
  app->press = TARGET_NONE;
  if (t == TARGET_STOP) {
    if (!app->stop_sent) {
      app->stop_sent = 1;
      emit_stop();
      render_badges(app);
    }
  } else if (app->toggle_sent_ms == 0) {
    /* Root owns the state; the button stays dim until it answers or TOGGLE_RETRY_MS passes. */
    app->toggle_sent_ms = now_ms();
    emit_line(app->paused ? "{\"event\":\"resume\"}" : "{\"event\":\"pause\"}");
    render_badges(app);
  }
}

static void pointer_axis(void *data, struct wl_pointer *pointer, uint32_t time, uint32_t axis, wl_fixed_t value) {
  (void)data;
  (void)pointer;
  (void)time;
  (void)axis;
  (void)value;
}

static void pointer_frame(void *data, struct wl_pointer *pointer) {
  (void)data;
  (void)pointer;
}

static void pointer_axis_source(void *data, struct wl_pointer *pointer, uint32_t source) {
  (void)data;
  (void)pointer;
  (void)source;
}

static void pointer_axis_stop(void *data, struct wl_pointer *pointer, uint32_t time, uint32_t axis) {
  (void)data;
  (void)pointer;
  (void)time;
  (void)axis;
}

static void pointer_axis_discrete(void *data, struct wl_pointer *pointer, uint32_t axis, int32_t discrete) {
  (void)data;
  (void)pointer;
  (void)axis;
  (void)discrete;
}

static const struct wl_pointer_listener pointer_listener = {
    .enter = pointer_enter,
    .leave = pointer_leave,
    .motion = pointer_motion,
    .button = pointer_button,
    .axis = pointer_axis,
    .frame = pointer_frame,
    .axis_source = pointer_axis_source,
    .axis_stop = pointer_axis_stop,
    .axis_discrete = pointer_axis_discrete,
};

static void seat_bind_pointer(struct App *app, uint32_t caps) {
  if ((caps & WL_SEAT_CAPABILITY_POINTER) && !app->pointer && app->seat) {
    app->pointer = wl_seat_get_pointer(app->seat);
    if (app->pointer) wl_pointer_add_listener(app->pointer, &pointer_listener, app);
  } else if (!(caps & WL_SEAT_CAPABILITY_POINTER) && app->pointer) {
    if (app->seat_version >= 3) wl_pointer_release(app->pointer);
    else wl_pointer_destroy(app->pointer);
    app->pointer = NULL;
    app->pointer_focus = NULL;
  }
}

static void seat_capabilities(void *data, struct wl_seat *seat, uint32_t capabilities) {
  struct App *app = data;
  (void)seat;
  seat_bind_pointer(app, capabilities);
}

static void seat_name(void *data, struct wl_seat *seat, const char *name) {
  (void)data;
  (void)seat;
  (void)name;
}

static const struct wl_seat_listener seat_listener = {
    .capabilities = seat_capabilities,
    .name = seat_name,
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface,
                            uint32_t version) {
  struct App *app = data;
  if (strcmp(interface, wl_compositor_interface.name) == 0) {
    app->compositor = wl_registry_bind(registry, name, &wl_compositor_interface, u32min(version, 4));
  } else if (strcmp(interface, wl_shm_interface.name) == 0) {
    app->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
  } else if (strcmp(interface, wl_seat_interface.name) == 0 && !app->seat) {
    app->seat_version = u32min(version, 5);
    app->seat = wl_registry_bind(registry, name, &wl_seat_interface, app->seat_version);
    wl_seat_add_listener(app->seat, &seat_listener, app);
  } else if (strcmp(interface, wl_output_interface.name) == 0) {
    output_add(app, name, version);
  } else if (strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
    app->layer_shell_version = u32min(version, 5);
    app->layer_shell = wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, app->layer_shell_version);
  } else if (strcmp(interface, zxdg_output_manager_v1_interface.name) == 0) {
    app->xdg_mgr = wl_registry_bind(registry, name, &zxdg_output_manager_v1_interface, u32min(version, 3));
    for (struct Output *o = app->outputs; o; o = o->next) output_bind_xdg(o);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  struct App *app = data;
  (void)registry;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if (o->registry_name == name) {
      output_destroy(app, o);
      return;
    }
  }
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

static JsonNode *obj_member(JsonObject *obj, const char *key) {
  return json_object_has_member(obj, key) ? json_object_get_member(obj, key) : NULL;
}

static int obj_bool(JsonObject *obj, const char *key, int *out) {
  JsonNode *n = obj_member(obj, key);
  if (!n || !JSON_NODE_HOLDS_VALUE(n) || json_node_get_value_type(n) != G_TYPE_BOOLEAN) return 0;
  *out = json_node_get_boolean(n) ? 1 : 0;
  return 1;
}

static int obj_int(JsonObject *obj, const char *key, int64_t *out) {
  JsonNode *n = obj_member(obj, key);
  GType t;
  if (!n || !JSON_NODE_HOLDS_VALUE(n)) return 0;
  t = json_node_get_value_type(n);
  if (t != G_TYPE_INT64 && t != G_TYPE_INT && t != G_TYPE_UINT64 && t != G_TYPE_DOUBLE && t != G_TYPE_UINT) return 0;
  *out = json_node_get_int(n);
  return 1;
}

static int obj_double(JsonObject *obj, const char *key, double *out) {
  JsonNode *n = obj_member(obj, key);
  GType t;
  if (!n || !JSON_NODE_HOLDS_VALUE(n)) return 0;
  t = json_node_get_value_type(n);
  if (t != G_TYPE_DOUBLE && t != G_TYPE_INT64 && t != G_TYPE_INT && t != G_TYPE_UINT64 && t != G_TYPE_UINT) return 0;
  *out = json_node_get_double(n);
  return 1;
}

static const char *obj_string(JsonObject *obj, const char *key) {
  JsonNode *n = obj_member(obj, key);
  if (!n || json_node_get_value_type(n) != G_TYPE_STRING) return NULL;
  return json_node_get_string(n);
}

static void handle_pointer_obj(struct App *app, JsonObject *pointer, int has_id, int64_t id) {
  double x = 0, y = 0;
  int visible = 1, click = 0;
  if (!obj_double(pointer, "x", &x) || !obj_double(pointer, "y", &y)) return;
  obj_bool(pointer, "visible", &visible);
  obj_bool(pointer, "click", &click);
  /* The human owns the pointer while paused: no mark, no feedback. */
  if (app->paused) visible = click = 0;
  if (click && !app->pointer_click) app->click_ms = now_ms();
  app->pointer_x = x;
  app->pointer_y = y;
  app->pointer_visible = visible;
  app->pointer_click = click;
  if (app->session_active || app->pending_active) render_glows(app);
  if (has_id) emit_pointer_ack(id);
}

static void set_paused(struct App *app, int paused, const char *reason, int has_until, int64_t until) {
  int changed = app->paused != paused;
  app->pause_reason = !paused ? 0 : (reason && strcmp(reason, "human_input") == 0) ? 1 : 2;
  app->pause_until_ms = paused && has_until ? until : 0;
  if (!changed) return;
  app->paused = paused;
  app->state_ms = now_ms();
  app->toggle_sent_ms = 0;
  if (paused) app->pointer_visible = app->pointer_click = 0;
  if (app->session_active || app->pending_active) render_all(app);
}

/* ---- capture_hidden: hide every owned pixel, ack after the compositor applied it ---- */

static void capture_emit(struct App *app, int hidden, int expired) {
  char buf[160];
  int n = snprintf(buf, sizeof buf, "{\"event\":\"capture\"");
  if (app->cap_has_id) n += snprintf(buf + n, sizeof buf - (size_t)n, ",\"id\":%lld", (long long)app->cap_id);
  n += snprintf(buf + n, sizeof buf - (size_t)n, ",\"hidden\":%s", hidden ? "true" : "false");
  if (expired) n += snprintf(buf + n, sizeof buf - (size_t)n, ",\"expired\":true");
  snprintf(buf + n, sizeof buf - (size_t)n, "}");
  emit_line(buf);
}

static void capture_try_ack(struct App *app) {
  if (!app->cap_pending || !app->cap_sync_done) return;
  /* Never claim exclusion if a cleared surface has not been presented. Root
   * times out and discards the screenshot if a display stops rendering. */
  if (app->cap_frames > 0) return;
  for (struct Output *o = app->outputs; o; o = o->next) {
    if ((o->glow.capture_epoch == app->cap_epoch && o->glow.capture_needed)
        || (o->badge.capture_epoch == app->cap_epoch && o->badge.capture_needed)) return;
  }
  app->cap_pending = 0;
  capture_emit(app, app->cap_want_hidden, 0);
}

static void cap_sync_done(void *data, struct wl_callback *cb, uint32_t t) {
  struct CapCb *c = data;
  (void)t;
  wl_callback_destroy(cb);
  if (c->epoch == c->app->cap_epoch) {
    c->app->cap_sync_done = 1;
    capture_try_ack(c->app);
  }
  free(c);
}

static void cap_frame_done(void *data, struct wl_callback *cb, uint32_t t) {
  struct CapCb *c = data;
  (void)t;
  wl_callback_destroy(cb);
  if (c->epoch == c->app->cap_epoch) {
    if (c->app->cap_frames > 0) c->app->cap_frames--;
    capture_try_ack(c->app);
  }
  free(c);
}

static const struct wl_callback_listener cap_sync_listener = {.done = cap_sync_done};
static const struct wl_callback_listener cap_frame_listener = {.done = cap_frame_done};

/* Called from surface_render while hiding: a frame callback proves the cleared buffer was presented. */
static int capture_watch_frame(struct Surface *s) {
  struct App *app = s->output->app;
  struct CapCb *c = malloc(sizeof *c);
  struct wl_callback *cb;
  if (!c) return 0;
  cb = wl_surface_frame(s->wl);
  if (!cb) {
    free(c);
    return 0;
  }
  c->app = app;
  c->epoch = app->cap_epoch;
  app->cap_frames++;
  wl_callback_add_listener(cb, &cap_frame_listener, c);
  return 1;
}

static void handle_capture(struct App *app, int hidden, int has_id, int64_t id) {
  struct CapCb *c;
  struct wl_callback *cb;
  app->cap_epoch++; /* a superseded request is never acked */
  app->cap_has_id = has_id;
  app->cap_id = id;
  app->cap_want_hidden = hidden;
  app->cap_frames = 0;
  app->cap_sync_done = 0;
  app->capture_hidden = hidden;
  if (hidden) app->capture_hidden_ms = now_ms();
  app->hover = app->press = TARGET_NONE;
  if (!app->session_active && !app->pending_active) {
    app->cap_pending = 0;
    capture_emit(app, hidden, 0);
    return;
  }
  for (struct Output *o = app->outputs; o; o = o->next) {
    o->glow.capture_epoch = o->badge.capture_epoch = app->cap_epoch;
    o->glow.capture_needed = o->glow.mapped;
    o->badge.capture_needed = o->badge.mapped;
  }
  render_all(app);
  c = malloc(sizeof *c);
  cb = c ? wl_display_sync(app->display) : NULL;
  if (!cb) {
    free(c);
    app->cap_pending = 0;
    emit_error("wayland");
    return;
  }
  c->app = app;
  c->epoch = app->cap_epoch;
  app->cap_pending = 1;
  wl_callback_add_listener(cb, &cap_sync_listener, c);
  wl_display_flush(app->display);
}

static void handle_line(struct App *app, const char *line, size_t len) {
  JsonParser *parser = json_parser_new();
  GError *err = NULL;
  JsonNode *root;
  JsonObject *obj;
  int has_id = 0, active = 0, quit = 0, ping = 0, paused = 0, hidden = 0;
  int64_t id = 0, until = 0;
  const char *action;
  if (!json_parser_load_from_data(parser, line, (gssize)len, &err)) {
    g_clear_error(&err);
    g_object_unref(parser);
    emit_error("invalid");
    return;
  }
  root = json_parser_get_root(parser);
  if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
    g_object_unref(parser);
    emit_error("invalid");
    return;
  }
  obj = json_node_get_object(root);
  has_id = obj_int(obj, "id", &id);
  if (obj_bool(obj, "quit", &quit) && quit) {
    app->running = 0;
    g_object_unref(parser);
    return;
  }
  if (obj_bool(obj, "ping", &ping) && ping) {
    app->last_ping_ms = now_ms();
    g_object_unref(parser);
    return;
  }
  if (json_object_has_member(obj, "pointer") && JSON_NODE_HOLDS_OBJECT(obj_member(obj, "pointer"))) {
    handle_pointer_obj(app, json_object_get_object_member(obj, "pointer"), has_id, id);
    g_object_unref(parser);
    return;
  }
  if (obj_bool(obj, "capture_hidden", &hidden)) {
    handle_capture(app, hidden, has_id, id);
    g_object_unref(parser);
    return;
  }
  if (obj_bool(obj, "paused", &paused)) {
    int has_until = obj_int(obj, "pause_until_ms", &until);
    set_paused(app, paused, obj_string(obj, "reason"), has_until, until);
    g_object_unref(parser);
    return;
  }
  action = obj_string(obj, "action");
  if (action) set_action(app, action);
  if (obj_bool(obj, "active", &active)) {
    if (active) session_begin(app, has_id, id);
    else session_end(app, has_id, id, 0);
    g_object_unref(parser);
    return;
  }
  if (action && (app->session_active || app->pending_active)) render_badges(app);
  g_object_unref(parser);
}

static int read_stdin(struct App *app) {
  for (;;) {
    ssize_t n;
    if (app->stdin_len >= MAX_LINE) {
      emit_error("line_too_long");
      return -1;
    }
    n = read(STDIN_FILENO, app->stdin_buf + app->stdin_len, MAX_LINE - app->stdin_len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
      return -1;
    }
    if (n == 0) return -1;
    app->stdin_len += (size_t)n;
    for (;;) {
      char *nl = memchr(app->stdin_buf, '\n', app->stdin_len);
      size_t linelen;
      if (!nl) break;
      linelen = (size_t)(nl - app->stdin_buf);
      if (linelen && app->stdin_buf[linelen - 1] == '\r') linelen--;
      app->stdin_buf[linelen] = 0;
      handle_line(app, app->stdin_buf, linelen);
      app->stdin_len -= (size_t)(nl - app->stdin_buf + 1);
      memmove(app->stdin_buf, nl + 1, app->stdin_len);
    }
  }
}

static void check_timeouts(struct App *app) {
  int64_t now = now_ms();
  if (app->pending_active && now - app->activate_ms >= MAP_TIMEOUT_MS) {
    session_end(app, app->pending_has_id, app->pending_id, 1);
  }
  if (app->session_active && now - app->last_ping_ms >= HEARTBEAT_MS) {
    destroy_all_surfaces(app);
    emit_error("timeout");
    app->session_active = 0;
    app->running = 0;
  }
  /* Animation can occupy both buffers. Retry the required capture frame when
   * the compositor releases one; never ACK only the surfaces that succeeded. */
  if (app->cap_pending) {
    for (struct Output *o = app->outputs; o; o = o->next) {
      if (o->glow.capture_epoch == app->cap_epoch && o->glow.capture_needed) surface_render(&o->glow);
      if (o->badge.capture_epoch == app->cap_epoch && o->badge.capture_needed) surface_render(&o->badge);
    }
  }
  capture_try_ack(app);
  /* Fail open: never leave the indicator hidden if the capturer vanished. */
  if (app->capture_hidden && now - app->capture_hidden_ms >= CAPTURE_MAX_MS) {
    app->capture_hidden = 0;
    app->cap_epoch++;
    app->cap_pending = 0;
    if (app->session_active) render_all(app);
    capture_emit(app, 0, 1);
  }
  if (app->toggle_sent_ms && now - app->toggle_sent_ms >= TOGGLE_RETRY_MS) {
    app->toggle_sent_ms = 0;
    if (app->session_active) render_badges(app);
  }
}

static void tick_animation(struct App *app) {
  int64_t now = now_ms();
  if (now - app->last_anim_ms < ANIM_FRAME_MS) return;
  if (!(app->session_active || app->pending_active) || app->capture_hidden) return;
  if (animating(app)) {
    app->last_anim_ms = now;
    render_badges(app);
  }
  if (ripple_running(app)) {
    app->last_anim_ms = now;
    render_glows(app);
  }
}

static void app_cleanup(struct App *app) {
  app->running = 0;
  app->session_active = 0;
  app->pending_active = 0;
  destroy_all_surfaces(app);
  while (app->outputs) output_destroy(app, app->outputs);
  if (app->pointer) {
    if (app->seat_version >= 3) wl_pointer_release(app->pointer);
    else wl_pointer_destroy(app->pointer);
    app->pointer = NULL;
  }
  if (app->seat) {
    if (app->seat_version >= 5) wl_seat_release(app->seat);
    else wl_seat_destroy(app->seat);
    app->seat = NULL;
  }
  if (app->xdg_mgr) {
    zxdg_output_manager_v1_destroy(app->xdg_mgr);
    app->xdg_mgr = NULL;
  }
  if (app->layer_shell) {
    if (app->layer_shell_version >= 3) zwlr_layer_shell_v1_destroy(app->layer_shell);
    app->layer_shell = NULL;
  }
  if (app->compositor) wl_compositor_destroy(app->compositor);
  if (app->shm) wl_shm_destroy(app->shm);
  if (app->registry) wl_registry_destroy(app->registry);
  if (app->display) {
    wl_display_flush(app->display);
    wl_display_disconnect(app->display);
    app->display = NULL;
  }
}

static int wayland_loop(struct App *app) {
  int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
  app->running = 1;
  memcpy(app->action, "Ready", 6);
  while (app->running && !g_stop) {
    struct pollfd fds[2];
    int nfd = 0, timeout = (animating(app) || ripple_running(app)) ? ANIM_FRAME_MS : 200, ret;
    while (wl_display_prepare_read(app->display) != 0) {
      if (wl_display_dispatch_pending(app->display) < 0) {
        emit_error("wayland");
        return 1;
      }
    }
    wl_display_flush(app->display);
    fds[nfd].fd = wl_display_get_fd(app->display);
    fds[nfd].events = POLLIN;
    nfd++;
    fds[nfd].fd = STDIN_FILENO;
    fds[nfd].events = POLLIN;
    nfd++;
    ret = poll(fds, (nfds_t)nfd, timeout);
    if (ret < 0) {
      wl_display_cancel_read(app->display);
      if (errno == EINTR) continue;
      emit_error("wayland");
      return 1;
    }
    if (fds[0].revents & POLLIN) {
      if (wl_display_read_events(app->display) < 0) {
        emit_error("wayland");
        return 1;
      }
    } else {
      wl_display_cancel_read(app->display);
    }
    if (wl_display_dispatch_pending(app->display) < 0) {
      emit_error("wayland");
      return 1;
    }
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      if (read_stdin(app) < 0) app->running = 0;
    }
    check_timeouts(app);
    tick_animation(app);
  }
  return 0;
}

static int run_wayland(int top_margin, int reduced) {
  struct App app;
  memset(&app, 0, sizeof app);
  app.top_margin = top_margin;
  app.reduced_motion = reduced;
  g_app = &app;
  memcpy(app.action, "Ready", 6);
  app.display = wl_display_connect(NULL);
  if (!app.display) {
    emit_error("wayland");
    return 1;
  }
  app.registry = wl_display_get_registry(app.display);
  wl_registry_add_listener(app.registry, &registry_listener, &app);
  if (wl_display_roundtrip(app.display) < 0) {
    emit_error("wayland");
    app_cleanup(&app);
    return 1;
  }
  if (!app.compositor || !app.shm || !app.layer_shell || !app.xdg_mgr) {
    emit_error("protocol");
    app_cleanup(&app);
    return 1;
  }
  if (wl_display_roundtrip(app.display) < 0) {
    emit_error("wayland");
    app_cleanup(&app);
    return 1;
  }
  emit_ready(app.output_count);
  wayland_loop(&app);
  app_cleanup(&app);
  g_app = NULL;
  return 0;
}

/* state: NULL (active), "click", "paused" or "hidden". time_ms < 0 picks a fixed halo phase. */
static int run_render_demo(const char *path, int width, int height, const char *state, int64_t time_ms, int top_margin,
                           int reduced) {
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
  cairo_t *cr;
  cairo_status_t st;
  struct Ui ui;
  struct Rect toggle, stop;
  int click = state && strcmp(state, "click") == 0;
  int paused = state && strcmp(state, "paused") == 0;
  int hidden = state && strcmp(state, "hidden") == 0;
  if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
    cairo_surface_destroy(surface);
    return 1;
  }
  memset(&ui, 0, sizeof ui);
  ui.paused = paused;
  ui.reduced = reduced;
  ui.reveal = ui.swap = ui.action_t = 1.0;
  ui.phase = time_ms >= 0 ? (double)(time_ms % HALO_MS) / HALO_MS : 0.35;
  cr = cairo_create(surface);
  draw_fixture_bg(cr, width, height);
  paint_glow_surface(cr, width, height, hidden, paused, 1, width * 0.58, height * 0.42, click ? 0.3 : -1.0);
  cairo_save(cr);
  cairo_translate(cr, ((double)width - BADGE_W) / 2.0, top_margin > PILL_Y ? top_margin - PILL_Y : 0);
  paint_badge_surface(cr, BADGE_W, hidden, &ui, click ? "Clicking" : "Moving pointer", "Ready", &toggle, &stop);
  cairo_restore(cr);
  cairo_destroy(cr);
  st = cairo_surface_write_to_png(surface, path);
  cairo_surface_destroy(surface);
  return st == CAIRO_STATUS_SUCCESS ? 0 : 1;
}

static int parse_int(const char *text, long lo, long hi, long *out) {
  char *end = NULL;
  long v;
  if (!text || !*text) return 0;
  v = strtol(text, &end, 10);
  if (!end || *end || v < lo || v > hi) return 0;
  *out = v;
  return 1;
}

int main(int argc, char **argv) {
  struct sigaction sa;
  const char *logo = NULL, *demo_path = NULL, *demo_state = NULL;
  int width = 0, height = 0, top_margin = DEFAULT_TOP_MARGIN, demo = 0, rc;
  long demo_time = -1, v;
  const char *env = getenv("MUSE_REDUCED_MOTION");
  int reduced = env && *env && strcmp(env, "0") != 0;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--logo") == 0 && i + 1 < argc) {
      logo = argv[++i];
    } else if (strcmp(argv[i], "--session-key") == 0 && i + 1 < argc) {
      const char *key = argv[++i];
      if (strlen(key) != 32 || strspn(key, "0123456789abcdef") != 32) return 2;
      snprintf(glow_namespace, sizeof glow_namespace, NS_GLOW "-%s", key);
      snprintf(stop_namespace, sizeof stop_namespace, NS_STOP "-%s", key);
    } else if (strcmp(argv[i], "--top-margin") == 0 && i + 1 < argc) {
      if (!parse_int(argv[++i], 0, 400, &v)) return 2;
      top_margin = (int)v;
    } else if (strcmp(argv[i], "--demo-time") == 0 && i + 1 < argc) {
      if (!parse_int(argv[++i], 0, 3600000, &demo_time)) return 2;
    } else if (strcmp(argv[i], "--render-demo") == 0 && i + 3 < argc && !demo) {
      demo = 1;
      demo_path = argv[++i];
      if (!parse_int(argv[++i], 16, 8192, &v)) return 2;
      width = (int)v;
      if (!parse_int(argv[++i], 16, 8192, &v)) return 2;
      height = (int)v;
      if (i + 1 < argc && argv[i + 1][0] != '-') {
        demo_state = argv[++i];
        if (strcmp(demo_state, "click") && strcmp(demo_state, "paused") && strcmp(demo_state, "hidden")) return 2;
      }
    } else {
      return 2;
    }
  }
  logo_load(logo);
  if (demo) {
    rc = run_render_demo(demo_path, width, height, demo_state, demo_time, top_margin, reduced);
    if (g_logo) cairo_surface_destroy(g_logo);
    return rc;
  }
  return run_wayland(top_margin, reduced);
}
