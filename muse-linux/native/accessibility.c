#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* One bounded request per process. Text input arrives on stdin, never argv.
   Semantic click prefers named AT-SPI click, then press, then toggle. Entry
   activate and slider jump are not a click stand-in; those names need
   perform_action. No matching recognized action prints semantic_unavailable
   with exit 0 so the parent may pointer-fallback. do_action false or error is
   a hard failure after attempt. */
enum {
  MAX_APPS = 80,
  MAX_WINDOWS = 40,
  MAX_DEPTH = 20,
  MAX_CHILDREN = 200,
  MAX_VISITED = 800,
  MAX_CONTROLS = 200,
  MAX_ACTIONS = 8,
  MAX_ACTION_SCAN = 16,
  WALK_BUDGET_US = 800000
};

static int count = 0, visited = 0, timed_out = 0;
static gint64 walk_deadline = 0;

static void string(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static int fail(const char *message) { fprintf(stderr, "%s\n", message); return 1; }

static int parse_int(const char *s, int *out) {
  char *end = NULL;
  long value;
  if (!s || !*s) return 0;
  value = strtol(s, &end, 10);
  if (!end || *end || value < -10000000 || value > 10000000) return 0;
  *out = (int)value;
  return 1;
}

static const char *optional_arg(int argc, char **argv, int index) {
  const char *value;
  if (index >= argc) return NULL;
  value = argv[index];
  return value && *value ? value : NULL;
}

static int action_allowed(const char *name) {
  static const char *allowed[] = {
    "click", "press", "toggle", "activate", "jump", "release",
    "edit", "expand", "collapse", "show", "menu", "select",
    "open", "close", "show-menu", NULL
  };
  size_t n;
  int i;
  if (!name || !*name) return 0;
  n = strlen(name);
  if (n > 40) return 0;
  if (strspn(name, "0123456789") == n) return 0;
  for (i = 0; name[i]; i++) {
    unsigned char c = (unsigned char)name[i];
    if (!(g_ascii_isalnum(c) || c == '-' || c == '_')) return 0;
  }
  for (i = 0; allowed[i]; i++) if (g_ascii_strcasecmp(name, allowed[i]) == 0) return 1;
  return 0;
}

/* 1=click, 2=press, 3=toggle. Lower wins for a plain click. */
static int click_rank(const char *name) {
  if (!name) return 0;
  if (g_ascii_strcasecmp(name, "click") == 0) return 1;
  if (g_ascii_strcasecmp(name, "press") == 0) return 2;
  if (g_ascii_strcasecmp(name, "toggle") == 0) return 3;
  return 0;
}

static int pick_plain_click(char **names, int n) {
  int best_i = -1, best = 99, i, rank;
  for (i = 0; i < n; i++) {
    rank = click_rank(names[i]);
    if (rank > 0 && rank < best) { best = rank; best_i = i; }
  }
  return best_i;
}

static int pick_named(char **names, int n, const char *want) {
  int i;
  if (!want || !*want || !action_allowed(want)) return -1;
  for (i = 0; i < n; i++) {
    if (names[i] && g_ascii_strcasecmp(names[i], want) == 0) return i;
  }
  return -1;
}

static int load_action_names(AtspiAction *action, char **names, int max) {
  int n, i;
  if (!action || max <= 0) return 0;
  n = atspi_action_get_n_actions(action, NULL);
  if (n < 0) n = 0;
  if (n > max) n = max;
  for (i = 0; i < n; i++) names[i] = atspi_action_get_action_name(action, i, NULL);
  return n;
}

static void free_action_names(char **names, int n) {
  int i;
  for (i = 0; i < n; i++) g_free(names[i]);
}

static void emit_actions(AtspiAction *action) {
  char *names[MAX_ACTION_SCAN];
  int n, i, emitted = 0;
  printf(",\"actions\":[");
  n = load_action_names(action, names, MAX_ACTION_SCAN);
  for (i = 0; i < n && emitted < MAX_ACTIONS; i++) {
    if (!action_allowed(names[i])) continue;
    if (emitted++) putchar(',');
    string(names[i]);
  }
  free_action_names(names, n);
  putchar(']');
}

static int semantic_unavailable(void) {
  puts("{\"dispatched\":false,\"semantic_unavailable\":true}");
  return 0;
}

static int semantic_success(const char *action_name) {
  printf("{\"dispatched\":true,\"route\":\"atspi\",\"action_name\":");
  string(action_name ? action_name : "");
  printf("}\n");
  return 0;
}

static int selftest(void) {
  char *prefer_click[] = { "activate", "toggle", "Click", "jump" };
  char *press_only[] = { "activate", "Press", "jump" };
  char *toggle_only[] = { "jump", "toggle" };
  char *unsafe_only[] = { "activate", "jump" };
  char *ordinal[] = { "0", "click" };
  if (!action_allowed("click") || !action_allowed("Press") || !action_allowed("TOGGLE")) return fail("selftest_allowlist");
  if (!action_allowed("activate") || !action_allowed("jump") || !action_allowed("show-menu")) return fail("selftest_allowlist");
  if (action_allowed("0") || action_allowed("1") || action_allowed("explode") || action_allowed("")) return fail("selftest_allowlist");
  if (action_allowed("click;rm") || action_allowed("do action")) return fail("selftest_allowlist");
  if (pick_plain_click(prefer_click, 4) != 2) return fail("selftest_click_prefers_named_click");
  if (pick_plain_click(press_only, 3) != 1) return fail("selftest_click_then_press");
  if (pick_plain_click(toggle_only, 2) != 1) return fail("selftest_click_then_toggle");
  if (pick_plain_click(unsafe_only, 2) != -1) return fail("selftest_rejects_activate_jump");
  if (pick_named(ordinal, 2, "0") != -1) return fail("selftest_rejects_ordinal");
  if (pick_named(prefer_click, 4, "click") != 2) return fail("selftest_named_click");
  if (pick_named(prefer_click, 4, "activate") != 0) return fail("selftest_named_activate");
  if (pick_named(prefer_click, 4, "explode") != -1) return fail("selftest_unknown_name");
  if (pick_named(prefer_click, 4, "") != -1 || pick_named(prefer_click, 4, NULL) != -1) return fail("selftest_empty_name");
  puts("{\"ok\":true,\"unavailable\":{\"dispatched\":false,\"semantic_unavailable\":true},\"attempt_fail\":\"action_unavailable_or_failed: no success receipt\"}");
  return 0;
}

static int window_role(AtspiRole role) {
  return role == ATSPI_ROLE_FRAME || role == ATSPI_ROLE_WINDOW || role == ATSPI_ROLE_DIALOG
      || role == ATSPI_ROLE_ALERT || role == ATSPI_ROLE_FILE_CHOOSER;
}

static int score_window(AtspiAccessible *child, const char *title, int x, int y, int w, int h) {
  int score = 0;
  char *name = atspi_accessible_get_name(child, NULL);
  AtspiRole role = atspi_accessible_get_role(child, NULL);
  AtspiComponent *component = atspi_accessible_get_component_iface(child);
  AtspiRect *r = component ? atspi_component_get_extents(component, ATSPI_COORD_TYPE_SCREEN, NULL) : NULL;
  if (window_role(role)) score += 5;
  if (title && *title && name && strcmp(name, title) == 0) score += 100;
  if (r && w > 0 && h > 0) {
    int dw = abs(r->width - w), dh = abs(r->height - h);
    int dx = abs(r->x - x), dy = abs(r->y - y);
    if (dw <= 2 && dh <= 2) score += 50;
    else if (dw <= 24 && dh <= 24) score += 15;
    if (dx <= 2 && dy <= 2) score += 20;
  }
  g_free(name);
  g_free(r);
  return score;
}

static AtspiAccessible *window_for(int pid, const char *title, int x, int y, int w, int h) {
  AtspiAccessible *desktop = atspi_get_desktop(0), *result = NULL;
  int best = 0, ties = 0;
  if (!desktop) return NULL;
  int apps = atspi_accessible_get_child_count(desktop, NULL);
  for (int i = 0; i < apps && i < MAX_APPS; i++) {
    AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, NULL);
    if (!app) continue;
    if ((int)atspi_accessible_get_process_id(app, NULL) == pid) {
      int n = atspi_accessible_get_child_count(app, NULL);
      for (int j = 0; j < n && j < MAX_WINDOWS; j++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(app, j, NULL);
        int score;
        if (!child) continue;
        score = score_window(child, title, x, y, w, h);
        if (score > best) { if (result) g_object_unref(result); result = g_object_ref(child); best = score; ties = 0; }
        else if (score == best && score > 0) ties++;
        g_object_unref(child);
      }
    }
    g_object_unref(app);
  }
  g_object_unref(desktop);
  if (ties > 0 && result) { g_object_unref(result); return NULL; }
  if (best < 50) { if (result) g_object_unref(result); return NULL; }
  return result;
}

static int over_budget(void) {
  if (visited >= MAX_VISITED || count >= MAX_CONTROLS) return 1;
  if (g_get_monotonic_time() > walk_deadline) { timed_out = 1; return 1; }
  return 0;
}

static void walk(AtspiAccessible *node, const char *path, int depth) {
  AtspiRole role;
  AtspiStateSet *states;
  gboolean visible, enabled, editable, showing;
  char *name, *value = NULL, *role_name;
  AtspiText *text;
  AtspiAction *action;
  AtspiValue *numeric;
  AtspiComponent *component;
  AtspiRect *r;
  int n, scrollable;
  if (!node || depth > MAX_DEPTH || over_budget()) return;
  role = atspi_accessible_get_role(node, NULL);
  if (role == ATSPI_ROLE_PASSWORD_TEXT) return;
  visited++;
  states = atspi_accessible_get_state_set(node);
  visible = states && atspi_state_set_contains(states, ATSPI_STATE_VISIBLE);
  enabled = states && atspi_state_set_contains(states, ATSPI_STATE_ENABLED);
  editable = states && atspi_state_set_contains(states, ATSPI_STATE_EDITABLE);
  showing = states && atspi_state_set_contains(states, ATSPI_STATE_SHOWING);
  if (states) g_object_unref(states);
  if (depth > 0 && !visible && !showing) return;
  name = atspi_accessible_get_name(node, NULL);
  text = atspi_accessible_get_text_iface(node);
  if (text) {
    int chars = atspi_text_get_character_count(text, NULL);
    value = atspi_text_get_text(text, 0, MIN(1000, chars < 0 ? 0 : chars), NULL);
  }
  action = atspi_accessible_get_action_iface(node);
  numeric = atspi_accessible_get_value_iface(node);
  scrollable = numeric || role == ATSPI_ROLE_SCROLL_BAR || role == ATSPI_ROLE_SCROLL_PANE;
  if ((name && *name) || (value && *value) || editable || action || scrollable) {
    if (count++) putchar(',');
    printf("{\"path\":"); string(path);
    printf(",\"role\":"); role_name = atspi_accessible_get_role_name(node, NULL); string(role_name); g_free(role_name);
    printf(",\"label\":"); string(name);
    printf(",\"value\":"); string(value);
    printf(",\"editable\":%s,\"disabled\":%s,\"showing\":%s,\"actionable\":%s,\"scrollable\":%s",
           editable ? "true" : "false", enabled ? "false" : "true", showing ? "true" : "false",
           action ? "true" : "false", scrollable ? "true" : "false");
    component = atspi_accessible_get_component_iface(node);
    r = component ? atspi_component_get_extents(component, ATSPI_COORD_TYPE_SCREEN, NULL) : NULL;
    if (r) { printf(",\"bounds\":[%d,%d,%d,%d]", r->x, r->y, r->width, r->height); g_free(r); }
    emit_actions(action);
    putchar('}');
  }
  if (action) g_object_unref(action);
  g_free(name); g_free(value);
  n = atspi_accessible_get_child_count(node, NULL);
  for (int i = 0; i < n && i < MAX_CHILDREN; i++) {
    AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, NULL);
    char next[512];
    snprintf(next, sizeof(next), "%s%s%d", path, *path ? ":" : "", i);
    walk(child, next, depth + 1);
    if (child) g_object_unref(child);
    if (over_budget()) break;
  }
}

static AtspiAccessible *child_at_path(AtspiAccessible *node, const char *path) {
  char *parts, *save = NULL, *part;
  if (!path || !*path) return node;
  parts = g_strdup(path);
  part = strtok_r(parts, ":", &save);
  while (part && node) {
    int index;
    AtspiAccessible *child;
    if (!parse_int(part, &index) || index < 0) { g_object_unref(node); g_free(parts); return NULL; }
    child = atspi_accessible_get_child_at_index(node, index, NULL);
    g_object_unref(node);
    node = child;
    part = strtok_r(NULL, ":", &save);
  }
  g_free(parts);
  return node;
}

static int vertical_direction(const char *direction) {
  return strcmp(direction, "up") == 0 || strcmp(direction, "down") == 0;
}

static int try_value_scroll(AtspiAccessible *node, const char *direction, int amount) {
  AtspiValue *value = atspi_accessible_get_value_iface(node);
  AtspiComponent *component;
  AtspiRect *r;
  double cur, min, max, inc, delta;
  int vertical;
  GError *error = NULL;
  gboolean ok;
  if (!value) return 0;
  component = atspi_accessible_get_component_iface(node);
  r = component ? atspi_component_get_extents(component, ATSPI_COORD_TYPE_WINDOW, NULL) : NULL;
  vertical = !r || r->height >= r->width;
  g_free(r);
  if (vertical != vertical_direction(direction)) return 0;
  cur = atspi_value_get_current_value(value, NULL);
  min = atspi_value_get_minimum_value(value, NULL);
  max = atspi_value_get_maximum_value(value, NULL);
  inc = atspi_value_get_minimum_increment(value, NULL);
  if (inc <= 0) inc = (max - min) / 20.0;
  if (inc <= 0) inc = 1;
  delta = inc * amount;
  if (max > min && delta < (max - min) / 40.0) delta = (max - min) / 20.0 * amount;
  if (strcmp(direction, "up") == 0 || strcmp(direction, "left") == 0) delta = -delta;
  ok = atspi_value_set_current_value(value, CLAMP(cur + delta, min, max), &error);
  if (error) g_error_free(error);
  return ok;
}

static int try_action_scroll(AtspiAccessible *node, const char *direction) {
  AtspiAction *action = atspi_accessible_get_action_iface(node);
  int n, i;
  if (!action) return 0;
  n = atspi_action_get_n_actions(action, NULL);
  for (i = 0; i < n; i++) {
    char *name = atspi_action_get_action_name(action, i, NULL);
    int match = 0;
    if (name) {
      if (strcasestr(name, "scroll") && strcasestr(name, direction)) match = 1;
      else if (strcmp(direction, "down") == 0 && strcasestr(name, "page down")) match = 1;
      else if (strcmp(direction, "up") == 0 && strcasestr(name, "page up")) match = 1;
    }
    g_free(name);
    if (match) {
      GError *error = NULL;
      gboolean ok = atspi_action_do_action(action, i, &error);
      if (error) g_error_free(error);
      return ok;
    }
  }
  return 0;
}

static int try_component_scroll(AtspiAccessible *node, const char *direction) {
  AtspiComponent *component = atspi_accessible_get_component_iface(node);
  AtspiScrollType type;
  GError *error = NULL;
  gboolean ok;
  if (!component) return 0;
  if (strcmp(direction, "up") == 0) type = ATSPI_SCROLL_TOP_EDGE;
  else if (strcmp(direction, "down") == 0) type = ATSPI_SCROLL_BOTTOM_EDGE;
  else if (strcmp(direction, "left") == 0) type = ATSPI_SCROLL_LEFT_EDGE;
  else type = ATSPI_SCROLL_RIGHT_EDGE;
  ok = atspi_component_scroll_to(component, type, &error);
  if (error) g_error_free(error);
  return ok;
}

static int scroll_search(AtspiAccessible *node, const char *direction, int amount, int depth, int *looked) {
  AtspiRole role;
  if (!node || depth > MAX_DEPTH || *looked >= MAX_VISITED) return 0;
  role = atspi_accessible_get_role(node, NULL);
  if (role == ATSPI_ROLE_PASSWORD_TEXT) return 0;
  (*looked)++;
  if (try_value_scroll(node, direction, amount) || try_action_scroll(node, direction)) return 1;
  int n = atspi_accessible_get_child_count(node, NULL);
  for (int i = 0; i < n && i < MAX_CHILDREN; i++) {
    AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, NULL);
    int ok = scroll_search(child, direction, amount, depth + 1, looked);
    if (child) g_object_unref(child);
    if (ok) return 1;
  }
  return 0;
}

static void place_caret_end(AtspiAccessible *node) {
  AtspiText *text = atspi_accessible_get_text_iface(node);
  gint n, i, selections;
  if (!text) return;
  n = atspi_text_get_character_count(text, NULL);
  if (n < 0) n = 0;
  selections = atspi_text_get_n_selections(text, NULL);
  for (i = selections - 1; i >= 0; i--) atspi_text_remove_selection(text, i, NULL);
  atspi_text_set_selection(text, 0, n, n, NULL);
  atspi_text_set_caret_offset(text, n, NULL);
}

static int do_scroll(AtspiAccessible *node, AtspiAccessible *window, const char *direction, int amount) {
  int looked = 0;
  if (try_value_scroll(node, direction, amount) || try_action_scroll(node, direction) || try_component_scroll(node, direction)) return 1;
  if (node != window && (try_value_scroll(window, direction, amount) || scroll_search(window, direction, amount, 0, &looked))) return 1;
  if (node == window) return scroll_search(window, direction, amount, 0, &looked);
  return 0;
}

static int revalidate_node(AtspiAccessible *node, int pid, const char *label, const char *expected_role) {
  char *name, *role_name;
  AtspiStateSet *states;
  gboolean enabled, defunct;
  gint node_pid;
  name = atspi_accessible_get_name(node, NULL);
  if (strcmp(name ? name : "", label) != 0) {
    g_free(name);
    return fail("element_changed: observe again");
  }
  g_free(name);
  if (expected_role && *expected_role) {
    role_name = atspi_accessible_get_role_name(node, NULL);
    if (strcmp(role_name ? role_name : "", expected_role) != 0) {
      g_free(role_name);
      return fail("element_changed: observe again");
    }
    g_free(role_name);
  }
  states = atspi_accessible_get_state_set(node);
  enabled = states && atspi_state_set_contains(states, ATSPI_STATE_ENABLED);
  defunct = states && atspi_state_set_contains(states, ATSPI_STATE_DEFUNCT);
  if (states) g_object_unref(states);
  if (!enabled || defunct) return fail("element_unavailable");
  node_pid = atspi_accessible_get_process_id(node, NULL);
  if (node_pid != 0 && (int)node_pid != pid) return fail("element_unavailable");
  return 0;
}

static int do_semantic_action(AtspiAccessible *node, const char *command, const char *requested_name) {
  AtspiAction *action;
  char *names[MAX_ACTION_SCAN];
  int n, index;
  GError *error = NULL;
  gboolean ok;
  action = atspi_accessible_get_action_iface(node);
  n = load_action_names(action, names, MAX_ACTION_SCAN);
  if (strcmp(command, "click") == 0) index = pick_plain_click(names, n);
  else if (strcmp(command, "press") == 0) index = pick_named(names, n, "press");
  else if (strcmp(command, "toggle") == 0) index = pick_named(names, n, "toggle");
  else index = pick_named(names, n, requested_name);
  if (index < 0) {
    free_action_names(names, n);
    if (action) g_object_unref(action);
    return semantic_unavailable();
  }
  ok = atspi_action_do_action(action, index, &error);
  if (!ok || error) {
    if (error) g_error_free(error);
    free_action_names(names, n);
    if (action) g_object_unref(action);
    return fail("action_unavailable_or_failed: no success receipt");
  }
  semantic_success(names[index]);
  free_action_names(names, n);
  if (action) g_object_unref(action);
  return 0;
}

int main(int argc, char **argv) {
  int pid, x, y, w, h, amount = 3, semantic;
  AtspiAccessible *window, *node;
  const char *command, *title, *path, *label, *direction, *expected_role, *action_name;
  if (argc == 2 && strcmp(argv[1], "selftest") == 0) return selftest();
  if (argc < 8) return fail("usage: accessibility command pid window-title x y w h [element-path] [expected-label] [action-name|scroll-direction|expected-role] [amount|expected-role]");
  command = argv[1];
  title = argv[3];
  if (!parse_int(argv[2], &pid) || !parse_int(argv[4], &x) || !parse_int(argv[5], &y) || !parse_int(argv[6], &w) || !parse_int(argv[7], &h))
    return fail("invalid_window_geometry");
  if (atspi_init() != 0) return fail("accessibility_unavailable");
  atspi_set_timeout(800, 1500);
  window = window_for(pid, title, x, y, w, h);
  if (!window) return fail("window_not_accessible: this app has no matching accessibility window");
  if (strcmp(command, "observe") == 0) {
    AtspiComponent *window_component = atspi_accessible_get_component_iface(window);
    AtspiRect *window_bounds = window_component ? atspi_component_get_extents(window_component, ATSPI_COORD_TYPE_SCREEN, NULL) : NULL;
    walk_deadline = g_get_monotonic_time() + WALK_BUDGET_US;
    printf("{\"controls\":[");
    walk(window, "", 0);
    printf("],\"truncated\":%s", (visited >= MAX_VISITED || count >= MAX_CONTROLS || timed_out) ? "true" : "false");
    if (window_bounds) {
      printf(",\"window_bounds\":[%d,%d,%d,%d]", window_bounds->x, window_bounds->y, window_bounds->width, window_bounds->height);
      g_free(window_bounds);
    }
    printf("}\n");
    g_object_unref(window); return 0;
  }
  if (argc < 10) { g_object_unref(window); return fail("element_required"); }
  path = argv[8];
  label = argv[9];
  node = child_at_path(g_object_ref(window), path);
  if (!node || atspi_accessible_get_role(node, NULL) == ATSPI_ROLE_PASSWORD_TEXT) {
    if (node) g_object_unref(node);
    g_object_unref(window);
    return fail("element_unavailable");
  }
  semantic = !strcmp(command, "click") || !strcmp(command, "press") || !strcmp(command, "toggle") || !strcmp(command, "perform_action");
  if (semantic) {
    int status;
    if (strcmp(command, "perform_action") == 0) {
      if (argc < 11) { g_object_unref(node); g_object_unref(window); return fail("action_required"); }
      action_name = optional_arg(argc, argv, 10);
      expected_role = optional_arg(argc, argv, 11);
    } else {
      action_name = NULL;
      expected_role = optional_arg(argc, argv, 10);
    }
    if (revalidate_node(node, pid, label, expected_role) != 0) {
      g_object_unref(node);
      g_object_unref(window);
      return 1;
    }
    status = do_semantic_action(node, command, action_name);
    g_object_unref(node);
    g_object_unref(window);
    return status;
  }
  char *name = atspi_accessible_get_name(node, NULL);
  if (strcmp(name ? name : "", label) != 0) {
    g_free(name); g_object_unref(node); g_object_unref(window);
    return fail("element_changed: observe again");
  }
  g_free(name);
  GError *error = NULL; gboolean ok = FALSE;
  if (strcmp(command, "type") == 0) {
    char input[16385]; size_t n = fread(input, 1, sizeof(input) - 1, stdin); input[n] = 0;
    if (n >= sizeof(input) - 1 || !g_utf8_validate(input, n, NULL)) { g_object_unref(node); g_object_unref(window); return fail("invalid_text"); }
    AtspiEditableText *edit = atspi_accessible_get_editable_text_iface(node);
    if (edit) ok = atspi_editable_text_set_text_contents(edit, input, &error);
    if (ok) place_caret_end(node);
  } else if (strcmp(command, "focus") == 0) {
    AtspiComponent *component = atspi_accessible_get_component_iface(node);
    if (component) ok = atspi_component_grab_focus(component, &error);
    if (ok) place_caret_end(node);
  } else if (strcmp(command, "scroll") == 0) {
    if (argc < 11) { g_object_unref(node); g_object_unref(window); return fail("invalid_scroll"); }
    direction = argv[10];
    if (strcmp(direction, "up") && strcmp(direction, "down") && strcmp(direction, "left") && strcmp(direction, "right")) {
      g_object_unref(node); g_object_unref(window); return fail("invalid_scroll");
    }
    if (argc >= 12 && !parse_int(argv[11], &amount)) { g_object_unref(node); g_object_unref(window); return fail("invalid_scroll"); }
    amount = CLAMP(amount, 1, 100);
    ok = do_scroll(node, window, direction, amount);
  } else {
    g_object_unref(node); g_object_unref(window); return fail("action_unsupported");
  }
  g_object_unref(node);
  g_object_unref(window);
  if (error) g_error_free(error);
  if (!ok) return fail(strcmp(command, "scroll") == 0 ? "scroll_unavailable" : "action_unavailable_or_failed: no success receipt");
  puts("{\"dispatched\":true}"); return 0;
}
