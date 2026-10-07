/* Original Muse implementation using public libatspi, GLib and JSON-GLib APIs.
 * Dynamically links system LGPL libatspi; no upstream implementation copied.
 * Private framed stdio protocol. Never open a host bus when explicit addresses are absent.
 */
#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <json-glib/json-glib.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <signal.h>

#define FRAME_MAX (256U * 1024U)
#define TEXT_MAX (1024U * 1024U)
#define HANDLE_MAX 8192U
#define NODE_MAX 2000
#define DEPTH_MAX 12

typedef struct { AtspiAccessible *object; gint index; } Link;
typedef struct {
  gchar *id, *root_id, *bus, *path, *start, *name;
  AtspiAccessible *object, *root;
  GPtrArray *chain;
  guint pid;
  AtspiRole role;
  guint64 epoch, structure_epoch;
} Handle;
static GHashTable *handles, *epochs, *structure_epochs;
static GQueue handle_order = G_QUEUE_INIT;
static GDBusConnection *bus;
static GMainLoop *loop;
static GByteArray *input;
static gchar *session_id, *request_id;
static gint64 generation, deadline;
static const gchar *failure;
static gboolean attempted;
static GError *rpc_error;
static guint node_count;
static gboolean omitted;
static gsize tree_bytes;

static const gchar *str(JsonObject *o, const gchar *key) {
  if (!o || !json_object_has_member(o, key)) return NULL;
  JsonNode *n = json_object_get_member(o, key);
  return JSON_NODE_HOLDS_VALUE(n) && json_node_get_value_type(n) == G_TYPE_STRING ? json_node_get_string(n) : NULL;
}
static gint64 num(JsonObject *o, const gchar *key, gint64 fallback) {
  if (!o || !json_object_has_member(o, key)) return fallback;
  JsonNode *n = json_object_get_member(o, key);
  return JSON_NODE_HOLDS_VALUE(n) && json_node_get_value_type(n) == G_TYPE_INT64 ? json_node_get_int(n) : fallback;
}
static JsonObject *obj(JsonObject *o, const gchar *key) {
  if (!o || !json_object_has_member(o, key)) return NULL;
  JsonNode *n = json_object_get_member(o, key);
  return JSON_NODE_HOLDS_OBJECT(n) ? json_node_get_object(n) : NULL;
}
static void s(JsonObject *o, const gchar *k, const gchar *v) { json_object_set_string_member(o, k, v ? v : ""); }
static void b(JsonObject *o, const gchar *k, gboolean v) { json_object_set_boolean_member(o, k, v); }
static void i(JsonObject *o, const gchar *k, gint64 v) { json_object_set_int_member(o, k, v); }
static guint64 epoch(const gchar *name) {
  guint64 *n = g_hash_table_lookup(epochs, name);
  return n ? *n : 0;
}
static guint64 object_epoch(AtspiAccessible *a) {
  AtspiObject *o = ATSPI_OBJECT(a);
  if (!o->app || !o->app->bus_name || !o->path) return G_MAXUINT64;
  gchar *key = g_strconcat(o->app->bus_name, o->path, NULL);
  guint64 n = epoch(key); g_free(key); return n;
}
static guint64 structure_epoch(const gchar *name) {
  guint64 *n = g_hash_table_lookup(structure_epochs, name); return n ? *n : 0;
}
static void link_free(gpointer data) { Link *l = data; g_object_unref(l->object); g_free(l); }
static void handle_free(gpointer data) {
  Handle *h = data;
  g_free(h->id); g_free(h->root_id); g_free(h->bus); g_free(h->path); g_free(h->start); g_free(h->name);
  g_object_unref(h->object); g_object_unref(h->root); g_ptr_array_unref(h->chain); g_free(h);
}
static gboolean guard(void) {
  if (failure) return FALSE;
  gint64 ms = (deadline - g_get_monotonic_time()) / 1000;
  if (ms <= 0) { failure = "deadline"; return FALSE; }
  atspi_set_timeout((gint)MIN(ms, 750), (gint)MIN(ms, 750));
  return TRUE;
}
static gboolean rpc_ok(void) {
  if (rpc_error) { g_clear_error(&rpc_error); failure = "provider_error"; return FALSE; }
  return guard();
}
static gboolean equal(AtspiAccessible *a, AtspiAccessible *c) {
  if (!a || !c) return FALSE;
  AtspiObject *x = ATSPI_OBJECT(a), *y = ATSPI_OBJECT(c);
  return x->app && y->app && !g_strcmp0(x->app->bus_name, y->app->bus_name) && !g_strcmp0(x->path, y->path);
}
/* Linux /proc start ticks distinguish PID reuse. No command line or environment reads. */
static gchar *start_token(guint pid) {
  gchar *path = g_strdup_printf("/proc/%u/stat", pid), *data = NULL, *result = NULL;
  if (g_file_get_contents(path, &data, NULL, NULL)) {
    gchar *end = strrchr(data, ')');
    if (end && end[1] == ' ') {
      gchar **parts = g_strsplit(end + 2, " ", -1);
      if (g_strv_length(parts) > 19) result = g_strdup(parts[19]);
      g_strfreev(parts);
    }
  }
  g_free(path); g_free(data); return result;
}
static guint owner_pid(const gchar *name) {
  if (!guard() || !name || name[0] != ':') { failure = "unknown_owner"; return 0; }
  gint timeout = (gint)MIN((deadline - g_get_monotonic_time()) / 1000, 750);
  GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
    "org.freedesktop.DBus", "GetConnectionUnixProcessID", g_variant_new("(s)", name), G_VARIANT_TYPE("(u)"),
    G_DBUS_CALL_FLAGS_NONE, MAX(timeout, 1), NULL, &rpc_error);
  if (!reply) { rpc_ok(); failure = "owner_lost"; return 0; }
  guint pid = 0; g_variant_get(reply, "(u)", &pid); g_variant_unref(reply); return pid;
}
static gboolean owner_valid(Handle *h) {
  guint pid = owner_pid(h->bus);
  gchar *token = start_token(pid);
  gboolean ok = pid == h->pid && token && !g_strcmp0(token, h->start);
  g_free(token);
  if (!ok) failure = "owner_lost";
  return ok;
}
static gboolean has_state(AtspiAccessible *a, AtspiStateType type) {
  if (!guard()) return FALSE;
  AtspiStateSet *states = atspi_accessible_get_state_set(a);
  gboolean value = states && atspi_state_set_contains(states, type);
  if (states) g_object_unref(states);
  return value;
}
static gboolean live(Handle *h, gboolean mutation) {
  if (!h) { failure = "stale_ref"; return FALSE; }
  if (h->epoch != object_epoch(h->object) || h->structure_epoch != structure_epoch(h->bus)) { failure = "dirty_ref"; return FALSE; }
  if (!owner_valid(h) || !guard()) return FALSE;
  atspi_accessible_clear_cache(h->object);
  if (has_state(h->object, ATSPI_STATE_DEFUNCT)) { failure = "defunct_ref"; return FALSE; }
  if (!guard()) return FALSE;
  AtspiRole role = atspi_accessible_get_role(h->object, &rpc_error);
  if (!rpc_ok()) return FALSE;
  gchar *name = atspi_accessible_get_name(h->object, &rpc_error);
  gboolean ok = rpc_ok() && role == h->role && !g_strcmp0(name, h->name);
  g_free(name);
  if (!ok) { failure = "identity_changed"; return FALSE; }
  // Each retained ancestor is checked against its live child at the originally issued index.
  // Indices validate retained objects, never resolve an old ref by position.
  AtspiAccessible *child = h->object;
  for (guint n = 0; n < h->chain->len; n++) {
    Link *l = g_ptr_array_index(h->chain, n);
    if (!guard()) return FALSE;
    atspi_accessible_clear_cache(l->object);
    AtspiAccessible *parent = atspi_accessible_get_parent(child, &rpc_error);
    ok = rpc_ok() && equal(parent, l->object);
    if (parent) g_object_unref(parent);
    if (!ok) { failure = "ancestry_changed"; return FALSE; }
    AtspiAccessible *current = atspi_accessible_get_child_at_index(l->object, l->index, &rpc_error);
    ok = rpc_ok() && equal(current, child);
    if (current) g_object_unref(current);
    if (!ok) { failure = "identity_changed"; return FALSE; }
    child = l->object;
  }
  if (!equal(child, h->root)) { failure = "root_changed"; return FALSE; }
  if (mutation && (!has_state(h->object, ATSPI_STATE_ENABLED) || !has_state(h->object, ATSPI_STATE_SENSITIVE))) {
    failure = "disabled_control"; return FALSE;
  }
  if ((h->epoch != object_epoch(h->object) || h->structure_epoch != structure_epoch(h->bus))) { failure = "dirty_ref"; return FALSE; }
  return guard();
}
static Handle *issue(AtspiAccessible *a, AtspiAccessible *root, const gchar *root_id, guint pid, const gchar *token) {
  if (!guard() || g_hash_table_size(handles) >= HANDLE_MAX) { failure = "handle_limit"; return NULL; }
  AtspiObject *o = ATSPI_OBJECT(a);
  if (!o->app || !o->app->bus_name || o->app->bus_name[0] != ':' || !o->path) { failure = "unknown_owner"; return NULL; }
  Handle *h = g_new0(Handle, 1);
  h->id = g_uuid_string_random(); h->root_id = g_strdup(root_id ? root_id : h->id);
  h->bus = g_strdup(o->app->bus_name); h->path = g_strdup(o->path); h->pid = pid; h->start = g_strdup(token);
  h->object = g_object_ref(a); h->root = g_object_ref(root); h->chain = g_ptr_array_new_with_free_func(link_free);
  h->role = atspi_accessible_get_role(a, &rpc_error);
  if (!rpc_ok()) { handle_free(h); return NULL; }
  h->name = atspi_accessible_get_name(a, &rpc_error);
  if (!rpc_ok()) { handle_free(h); return NULL; }
  h->epoch = object_epoch(h->object); h->structure_epoch = structure_epoch(h->bus);
  AtspiAccessible *current = g_object_ref(a);
  for (guint depth = 0; !equal(current, root) && depth < DEPTH_MAX + 2; depth++) {
    if (!guard()) break;
    AtspiAccessible *parent = atspi_accessible_get_parent(current, &rpc_error);
    if (!rpc_ok() || !parent) { if (parent) g_object_unref(parent); break; }
    atspi_accessible_clear_cache(parent);
    gint count = atspi_accessible_get_child_count(parent, &rpc_error), index = -1;
    if (!rpc_ok() || count > NODE_MAX) { g_object_unref(parent); break; }
    for (gint k = 0; k < count && guard(); k++) {
      AtspiAccessible *candidate = atspi_accessible_get_child_at_index(parent, k, &rpc_error);
      gboolean matched = rpc_ok() && equal(candidate, current);
      if (candidate) g_object_unref(candidate);
      if (matched) { if (index >= 0) { failure = "ambiguous_ancestry"; break; } index = k; }
    }
    if (index < 0 || failure) { g_object_unref(parent); break; }
    Link *l = g_new0(Link, 1); l->object = g_object_ref(parent); l->index = index;
    g_ptr_array_add(h->chain, l); g_object_unref(current); current = parent;
  }
  gboolean reached = equal(current, root); g_object_unref(current);
  if (!reached || failure) { handle_free(h); if (!failure) failure = "ancestry_unknown"; return NULL; }
  g_hash_table_insert(handles, g_strdup(h->id), h); g_queue_push_tail(&handle_order, g_strdup(h->id)); return h;
}
static JsonObject *metadata(Handle *h) {
  JsonObject *o = json_object_new();
  s(o, "handle", h->id); s(o, "rootHandle", h->root_id); s(o, "busUniqueName", h->bus); s(o, "objectPath", h->path);
  s(o, "ownerStartToken", h->start); i(o, "pid", h->pid); i(o, "roleCode", h->role); i(o, "epoch", (gint64)MIN(h->epoch, (guint64)G_MAXINT64));
  gchar *name = g_utf8_substring(h->name ? h->name : "", 0, MIN(g_utf8_strlen(h->name ? h->name : "", -1), 512));
  s(o, "name", name); g_free(name);
  gchar *role_name = guard() ? atspi_accessible_get_role_name(h->object, &rpc_error) : NULL;
  s(o, "role", role_name); g_free(role_name); rpc_ok();
  JsonArray *states = json_array_new();
  const AtspiStateType types[] = { ATSPI_STATE_ENABLED, ATSPI_STATE_SENSITIVE, ATSPI_STATE_EDITABLE, ATSPI_STATE_READ_ONLY,
    ATSPI_STATE_SHOWING, ATSPI_STATE_VISIBLE, ATSPI_STATE_CHECKED, ATSPI_STATE_INDETERMINATE, ATSPI_STATE_SELECTED,
    ATSPI_STATE_FOCUSED, ATSPI_STATE_MULTI_LINE, ATSPI_STATE_SINGLE_LINE };
  const gchar *names[] = { "enabled", "sensitive", "editable", "readOnly", "showing", "visible", "checked", "indeterminate",
    "selected", "focused", "multiline", "singleline" };
  for (guint n = 0; n < G_N_ELEMENTS(types); n++) if (has_state(h->object, types[n])) json_array_add_string_element(states, names[n]);
  json_object_set_array_member(o, "states", states);
  JsonArray *caps = json_array_new();
  AtspiAction *action = atspi_accessible_get_action_iface(h->object);
  JsonArray *actions = json_array_new();
  if (action) {
    json_array_add_string_element(caps, "invoke");
    gint count = guard() ? atspi_action_get_n_actions(action, &rpc_error) : 0; rpc_ok();
    for (gint n = 0; n < MIN(count, 32) && guard(); n++) {
      gchar *name_action = atspi_action_get_action_name(action, n, &rpc_error);
      if (rpc_ok() && name_action && strlen(name_action) <= 128) json_array_add_string_element(actions, name_action);
      g_free(name_action);
    }
    g_object_unref(action);
  }
  json_object_set_array_member(o, "actions", actions);
  AtspiText *text = atspi_accessible_get_text_iface(h->object);
  if (text) {
    if (h->role != ATSPI_ROLE_PASSWORD_TEXT) {
      json_array_add_string_element(caps, "readText");
      gint count = guard() ? atspi_text_get_character_count(text, &rpc_error) : -1; rpc_ok();
      i(o, "characterCount", count);
    }
    g_object_unref(text);
  }
  AtspiEditableText *edit = atspi_accessible_get_editable_text_iface(h->object);
  if (edit) { if (h->role != ATSPI_ROLE_PASSWORD_TEXT) json_array_add_string_element(caps, "editText"); g_object_unref(edit); }
  AtspiSelection *selection = atspi_accessible_get_selection_iface(h->object);
  if (selection) { json_array_add_string_element(caps, "select"); g_object_unref(selection); }
  AtspiComponent *component = atspi_accessible_get_component_iface(h->object);
  if (component) {
    json_array_add_string_element(caps, "reveal"); json_array_add_string_element(caps, "focus");
    AtspiRect *rect = guard() ? atspi_component_get_extents(component, ATSPI_COORD_TYPE_WINDOW, &rpc_error) : NULL;
    if (rpc_ok() && rect) {
      JsonObject *bounds = json_object_new(); s(bounds, "space", "atspi_window_local"); b(bounds, "physicalTransformVerified", FALSE);
      i(bounds, "x", rect->x); i(bounds, "y", rect->y); i(bounds, "width", rect->width); i(bounds, "height", rect->height);
      json_object_set_object_member(o, "bounds", bounds);
    }
    g_free(rect); g_object_unref(component);
  }
  json_object_set_array_member(o, "capabilities", caps); return o;
}
static void emit(JsonObject *message) {
  s(message, "schema", "muse.atspi.v1"); s(message, "sessionId", session_id); i(message, "generation", generation);
  JsonNode *root = json_node_new(JSON_NODE_OBJECT); json_node_set_object(root, message);
  JsonGenerator *generator = json_generator_new(); json_generator_set_root(generator, root);
  gsize length; gchar *data = json_generator_to_data(generator, &length);
  if (length > FRAME_MAX) {
    g_free(data); json_node_free(root); g_object_unref(generator);
    JsonObject *small = json_object_new(); s(small, "requestId", request_id); b(small, "ok", FALSE); s(small, "code", "response_limit");
    b(small, "attempted", attempted); s(small, "effect", attempted ? "unknown" : "none_proven"); emit(small); json_object_unref(small); return;
  }
  guint32 header = GUINT32_TO_BE((guint32)length);
  if (fwrite(&header, 4, 1, stdout) != 1 || fwrite(data, 1, length, stdout) != length || fflush(stdout) != 0) g_main_loop_quit(loop);
  g_free(data); json_node_free(root); g_object_unref(generator);
}
static void dirty(AtspiEvent *event, void *data) {
  (void)data;
  AtspiObject *source = event->source ? ATSPI_OBJECT(event->source) : NULL;
  if (!source || !source->app || !source->app->bus_name) { g_boxed_free(ATSPI_TYPE_EVENT, event); return; }
  const gchar *name = source->app->bus_name;
  guint64 *value = g_hash_table_lookup(epochs, name);
  if (!value) { value = g_new0(guint64, 1); g_hash_table_insert(epochs, g_strdup(name), value); }
  (*value)++;
  gchar *object_key = g_strconcat(name, source->path, NULL);
  guint64 *object_value = g_hash_table_lookup(epochs, object_key);
  if (!object_value) { object_value = g_new0(guint64, 1); g_hash_table_insert(epochs, g_strdup(object_key), object_value); }
  (*object_value)++; g_free(object_key);
  if (g_str_has_prefix(event->type, "object:children-changed") || g_str_has_prefix(event->type, "window:destroy")) {
    guint64 *structure = g_hash_table_lookup(structure_epochs, name);
    if (!structure) { structure = g_new0(guint64, 1); g_hash_table_insert(structure_epochs, g_strdup(name), structure); }
    (*structure)++;
  }
  if (session_id) {
    JsonObject *o = json_object_new(); s(o, "event", "invalidation"); s(o, "busUniqueName", name); i(o, "semanticEpoch", (gint64)MIN(*value, (guint64)G_MAXINT64));
    s(o, "reason", "semantic_dirty"); emit(o); json_object_unref(o);
  }
  g_boxed_free(ATSPI_TYPE_EVENT, event);
}
static gboolean top_role(AtspiRole role) { return role == ATSPI_ROLE_FRAME || role == ATSPI_ROLE_DIALOG || role == ATSPI_ROLE_WINDOW; }
static JsonArray *discover(JsonObject *p) {
  guint wanted = (guint)num(p, "pid", 0);
  const gchar *wanted_start = str(p, "startToken");
  gchar *token = start_token(wanted);
  if (!wanted || !token || !wanted_start || g_strcmp0(token, wanted_start)) { failure = "unknown_owner"; g_free(token); return NULL; }
  g_free(token);
  JsonArray *out = json_array_new();
  AtspiAccessible *desktop = atspi_get_desktop(0);
  if (!desktop) { failure = "registry_unavailable"; return out; }
  gint count = guard() ? atspi_accessible_get_child_count(desktop, &rpc_error) : 0; rpc_ok();
  for (gint n = 0; n < MIN(count, 128) && guard(); n++) {
    AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, n, &rpc_error);
    if (!rpc_ok() || !app) { if (app) g_object_unref(app); break; }
    AtspiObject *o = ATSPI_OBJECT(app);
    // Inspect only bus credential PID first. Other applications' names/text are never acquired.
    if (o->app && o->app->bus_name && owner_pid(o->app->bus_name) == wanted) {
      gint children = guard() ? atspi_accessible_get_child_count(app, &rpc_error) : 0; rpc_ok();
      for (gint k = 0; k < MIN(children, 128) && guard(); k++) {
        AtspiAccessible *root = atspi_accessible_get_child_at_index(app, k, &rpc_error);
        if (!rpc_ok() || !root) { if (root) g_object_unref(root); break; }
        AtspiRole role = atspi_accessible_get_role(root, &rpc_error);
        if (rpc_ok() && top_role(role)) {
          JsonObject *candidate = json_object_new(); AtspiObject *r = ATSPI_OBJECT(root);
          s(candidate, "busUniqueName", r->app->bus_name); s(candidate, "objectPath", r->path); i(candidate, "pid", wanted);
          s(candidate, "ownerStartToken", wanted_start); i(candidate, "roleCode", role);
          gchar *name = atspi_accessible_get_name(root, &rpc_error); if (rpc_ok()) s(candidate, "name", name); g_free(name);
          json_array_add_object_element(out, candidate);
        }
        g_object_unref(root);
      }
    }
    // An unrelated disappearing application cannot convert incomplete discovery to an exact match.
    if (failure) { g_object_unref(app); break; }
    g_object_unref(app);
  }
  if (count > 128) failure = "discovery_incomplete";
  g_object_unref(desktop); return out;
}
static AtspiAccessible *bound_root(JsonObject *p) {
  const gchar *name = str(p, "busUniqueName"), *path = str(p, "objectPath");
  if (!name || name[0] != ':' || !path || path[0] != '/') { failure = "root_mapping_required"; return NULL; }
  JsonArray *candidates = discover(p); AtspiAccessible *result = NULL;
  if (!failure && candidates) {
    gboolean found = FALSE;
    for (guint n = 0; n < json_array_get_length(candidates); n++) {
      JsonObject *c = json_array_get_object_element(candidates, n);
      if (!g_strcmp0(str(c, "busUniqueName"), name) && !g_strcmp0(str(c, "objectPath"), path)) found = TRUE;
    }
    if (found) {
      AtspiAccessible *desktop = atspi_get_desktop(0);
      gint count = guard() ? atspi_accessible_get_child_count(desktop, &rpc_error) : 0; rpc_ok();
      for (gint n = 0; n < MIN(count, 128) && guard() && !result; n++) {
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, n, &rpc_error);
        if (!rpc_ok() || !app) { if (app) g_object_unref(app); break; }
        AtspiObject *o = ATSPI_OBJECT(app);
        if (o->app && !g_strcmp0(o->app->bus_name, name)) {
          gint children = atspi_accessible_get_child_count(app, &rpc_error); rpc_ok();
          for (gint k = 0; k < MIN(children, 128) && guard(); k++) {
            AtspiAccessible *c = atspi_accessible_get_child_at_index(app, k, &rpc_error);
            if (!rpc_ok() || !c) { if (c) g_object_unref(c); break; }
            if (!g_strcmp0(ATSPI_OBJECT(c)->path, path)) result = g_object_ref(c);
            g_object_unref(c); if (result) break;
          }
        }
        g_object_unref(app);
      }
      g_object_unref(desktop);
    }
  }
  if (candidates) json_array_unref(candidates);
  if (!result && !failure) failure = "root_not_found";
  return result;
}
static void walk(AtspiAccessible *a, AtspiAccessible *root, const gchar *root_id, guint pid, const gchar *token,
                 gint depth, gint max_depth, gint max_nodes, gboolean visible, const gchar *parent, JsonArray *out) {
  if (!guard() || node_count >= (guint)max_nodes || tree_bytes >= 180000) { omitted = TRUE; return; }
  atspi_accessible_clear_cache(a);
  if (has_state(a, ATSPI_STATE_DEFUNCT)) { omitted = TRUE; return; }
  Handle *h = issue(a, root, root_id, pid, token);
  if (!h) { if (failure && !strcmp(failure, "ancestry_unknown")) { failure = NULL; omitted = TRUE; } return; }
  node_count++;
  // Structural traversal does not prune hidden ancestors. Visible scope only filters publication.
  if (!visible || equal(a, root) || (has_state(a, ATSPI_STATE_VISIBLE) && has_state(a, ATSPI_STATE_SHOWING))) {
    JsonObject *m = metadata(h); s(m, "parentHandle", parent);
    tree_bytes += 1200 + strlen(h->name ? h->name : ""); json_array_add_object_element(out, m);
  }
  gint count = guard() ? atspi_accessible_get_child_count(a, &rpc_error) : 0; rpc_ok();
  if (depth >= max_depth) { if (count > 0) omitted = TRUE; return; }
  if (count > NODE_MAX || has_state(a, ATSPI_STATE_MANAGES_DESCENDANTS)) omitted = TRUE;
  for (gint n = 0; n < MIN(count, NODE_MAX) && guard(); n++) {
    if (node_count >= (guint)max_nodes || tree_bytes >= 180000) { omitted = TRUE; break; }
    AtspiAccessible *child = atspi_accessible_get_child_at_index(a, n, &rpc_error);
    if (!rpc_ok() || !child) { if (child) g_object_unref(child); omitted = TRUE; break; }
    walk(child, root, h->root_id, pid, token, depth + 1, max_depth, max_nodes, visible, h->id, out);
    g_object_unref(child);
  }
}
static gchar *full_text(Handle *h, gint *count_out) {
  if (h->role == ATSPI_ROLE_PASSWORD_TEXT) { failure = "secret_control"; return NULL; }
  AtspiText *text = atspi_accessible_get_text_iface(h->object);
  if (!text) { failure = "text_unavailable"; return NULL; }
  gint count = guard() ? atspi_text_get_character_count(text, &rpc_error) : -1;
  if (!rpc_ok() || count < 0 || count > (gint)TEXT_MAX) { failure = "verification_unavailable"; g_object_unref(text); return NULL; }
  GString *all = g_string_sized_new((gsize)MIN(count, 16384));
  for (gint offset = 0; offset < count && guard(); offset += 16384) {
    gint end = MIN(count, offset + 16384);
    gchar *part = atspi_text_get_text(text, offset, end, &rpc_error);
    if (!rpc_ok() || !part || !g_utf8_validate(part, -1, NULL) || g_utf8_strlen(part, -1) != end - offset) {
      g_free(part); failure = "verification_unavailable"; break;
    }
    if (all->len + strlen(part) > TEXT_MAX) { g_free(part); failure = "verification_limit"; break; }
    g_string_append(all, part); g_free(part);
  }
  gint after = guard() ? atspi_text_get_character_count(text, &rpc_error) : -1; rpc_ok();
  g_object_unref(text);
  if (after != count || (h->epoch != object_epoch(h->object) || h->structure_epoch != structure_epoch(h->bus))) failure = "read_changed";
  if (failure) { g_string_free(all, TRUE); return NULL; }
  *count_out = count; return g_string_free(all, FALSE);
}
static JsonObject *read_text(Handle *h, JsonObject *p) {
  gint count = 0; gchar *text = full_text(h, &count);
  if (!text) return NULL;
  gint offset = (gint)num(p, "offset", 0), limit = (gint)num(p, "limitScalars", 16384);
  if (offset < 0 || offset > count || limit < 1 || limit > 16384) { failure = "invalid_range"; g_free(text); return NULL; }
  gint end = MIN(count, offset + limit);
  gchar *part = g_utf8_substring(text, offset, end), *hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, text, -1);
  JsonObject *o = json_object_new(); s(o, "text", part); s(o, "privateReadHash", hash);
  i(o, "totalScalars", count); i(o, "totalUtf8Bytes", (gint64)strlen(text)); i(o, "start", offset); i(o, "end", end);
  b(o, "complete", offset == 0 && end == count); b(o, "truncated", offset > 0 || end < count);
  AtspiText *iface = atspi_accessible_get_text_iface(h->object);
  gint caret = guard() ? atspi_text_get_caret_offset(iface, &rpc_error) : -1; rpc_ok(); i(o, "caret", caret);
  gint selections = guard() ? atspi_text_get_n_selections(iface, &rpc_error) : 0; rpc_ok();
  JsonArray *ranges = json_array_new();
  for (gint n = 0; n < MIN(selections, 2) && guard(); n++) {
    AtspiRange *range = atspi_text_get_selection(iface, n, &rpc_error);
    if (rpc_ok() && range) { JsonArray *pair = json_array_new(); json_array_add_int_element(pair, range->start_offset); json_array_add_int_element(pair, range->end_offset); json_array_add_array_element(ranges, pair); }
    g_free(range);
  }
  json_object_set_array_member(o, "selections", ranges); g_object_unref(iface);
  if (!failure) live(h, FALSE);
  g_free(part); g_free(hash); g_free(text); return o;
}
static gboolean safe_edit(Handle *h, JsonObject *p) {
  const gchar *text = str(p, "text"), *plain = str(p, "semantics");
  if (h->role == ATSPI_ROLE_PASSWORD_TEXT) { failure = "secret_control"; return FALSE; }
  if ((h->role == ATSPI_ROLE_TEXT && num(p, "plainTextAuthorized", 0) != 1) || !plain || strcmp(plain, "plain_text") || (h->role != ATSPI_ROLE_ENTRY && h->role != ATSPI_ROLE_TEXT)) {
    failure = "rich_text_unsupported"; return FALSE;
  }
  if (!text || !g_utf8_validate(text, -1, NULL) || strlen(text) > 65536 || g_utf8_strlen(text, -1) > 4096) {
    failure = "invalid_unicode"; return FALSE;
  }
  if (!has_state(h->object, ATSPI_STATE_EDITABLE) || has_state(h->object, ATSPI_STATE_READ_ONLY)) { failure = "read_only"; return FALSE; }
  if (has_state(h->object, ATSPI_STATE_SINGLE_LINE) && (strchr(text, '\n') || strchr(text, '\r'))) { failure = "singleline_newline"; return FALSE; }
  // Generic rich editors are unsupported even if their role is text.
  GHashTable *attrs = guard() ? atspi_accessible_get_attributes(h->object, &rpc_error) : NULL;
  if (!rpc_ok()) { if (attrs) g_hash_table_unref(attrs); return FALSE; }
  if (attrs) {
    const gchar *content = g_hash_table_lookup(attrs, "text-format");
    if (content && strcmp(content, "plain")) failure = "rich_text_unsupported";
    g_hash_table_unref(attrs);
  }
  return !failure;
}
static JsonObject *mutate(Handle *h, const gchar *op, JsonObject *p) {
  JsonObject *out = json_object_new(); gboolean accepted = FALSE;
  if (!live(h, TRUE)) return out;
  if (!strcmp(op, "invoke")) {
    const gchar *name = str(p, "actionName");
    if (!name || !*name || strlen(name) > 128) { failure = "invalid_action"; return out; }
    AtspiAction *action = atspi_accessible_get_action_iface(h->object);
    if (!action) { failure = "semantic_unavailable"; return out; }
    gint count = guard() ? atspi_action_get_n_actions(action, &rpc_error) : 0, index = -1; rpc_ok();
    for (gint n = 0; n < MIN(count, 32) && guard(); n++) {
      gchar *current = atspi_action_get_action_name(action, n, &rpc_error);
      if (rpc_ok() && !g_strcmp0(current, name)) { if (index >= 0) failure = "ambiguous_action"; index = n; }
      g_free(current);
    }
    if (count > 32) failure = "actions_incomplete";
    if (index < 0 && !failure) failure = "semantic_unavailable";
    if (guard() && live(h, TRUE)) { attempted = TRUE; accepted = atspi_action_do_action(action, index, &rpc_error); rpc_ok(); }
    g_object_unref(action);
  } else if (!strcmp(op, "replace") || !strcmp(op, "insert") || !strcmp(op, "delete")) {
    if (!safe_edit(h, p)) return out;
    AtspiEditableText *edit = atspi_accessible_get_editable_text_iface(h->object);
    if (!edit) { failure = "semantic_unavailable"; return out; }
    gint count = 0; gchar *before = full_text(h, &count);
    const gchar *expected = str(p, "beforeHash");
    gchar *hash = before ? g_compute_checksum_for_string(G_CHECKSUM_SHA256, before, -1) : NULL;
    if (!failure && (!expected || g_strcmp0(hash, expected))) failure = "text_conflict";
    g_free(hash); g_free(before);
    gint position = (gint)num(p, "position", -1), end = (gint)num(p, "end", -1);
    if (!strcmp(op, "insert") && (position < 0 || position > count)) failure = "invalid_range";
    if (!strcmp(op, "delete") && (position < 0 || end < position || end > count)) failure = "invalid_range";
    if (guard() && live(h, TRUE)) {
      attempted = TRUE;
      if (!strcmp(op, "replace")) accepted = atspi_editable_text_set_text_contents(edit, str(p, "text"), &rpc_error);
      else if (!strcmp(op, "insert")) accepted = atspi_editable_text_insert_text(edit, position, str(p, "text"), (gint)strlen(str(p, "text")), &rpc_error);
      else accepted = atspi_editable_text_delete_text(edit, position, end, &rpc_error);
      rpc_ok();
    }
    g_object_unref(edit);
  } else if (!strcmp(op, "focus") || !strcmp(op, "reveal")) {
    AtspiComponent *component = atspi_accessible_get_component_iface(h->object);
    if (!component) { failure = "semantic_unavailable"; return out; }
    const gchar *edge = str(p, "edge");
    AtspiScrollType type = ATSPI_SCROLL_ANYWHERE;
    if (!strcmp(op, "reveal")) {
      if (!g_strcmp0(edge, "start")) type = ATSPI_SCROLL_TOP_EDGE;
      else if (!g_strcmp0(edge, "end")) type = ATSPI_SCROLL_BOTTOM_EDGE;
      else if (g_strcmp0(edge, "nearest")) failure = "invalid_edge";
    }
    if (guard()) {
      attempted = TRUE;
      accepted = !strcmp(op, "focus") ? atspi_component_grab_focus(component, &rpc_error) : atspi_component_scroll_to(component, type, &rpc_error);
      rpc_ok();
    }
    g_object_unref(component);
  } else if (!strcmp(op, "clearSelection") || !strcmp(op, "selectChild") || !strcmp(op, "deselectChild")) {
    AtspiSelection *selection = atspi_accessible_get_selection_iface(h->object);
    if (!selection) { failure = "semantic_unavailable"; return out; }
    gint index = -1;
    if (strcmp(op, "clearSelection")) {
      Handle *child = g_hash_table_lookup(handles, str(p, "childHandle") ? str(p, "childHandle") : "");
      if (live(child, TRUE) && child->chain->len && equal(((Link *)g_ptr_array_index(child->chain, 0))->object, h->object)) {
        index = ((Link *)g_ptr_array_index(child->chain, 0))->index;
      } else if (!failure) failure = "not_direct_child";
    }
    if (guard()) {
      attempted = TRUE;
      if (!strcmp(op, "clearSelection")) accepted = atspi_selection_clear_selection(selection, &rpc_error);
      else if (!strcmp(op, "selectChild")) accepted = atspi_selection_select_child(selection, index, &rpc_error);
      else accepted = atspi_selection_deselect_child(selection, index, &rpc_error);
      rpc_ok();
    }
    g_object_unref(selection);
  } else failure = "unsupported_operation";
  if (attempted && !accepted && !failure) failure = "semantic_rejected";
  b(out, "accepted", accepted); i(out, "primitiveDispatches", attempted ? 1 : 0);
  s(out, "primitive", op); s(out, "effect", "unknown");
  return out;
}
static JsonObject *execute(const gchar *op, JsonObject *p) {
  /* Evict only between requests, leaving room for one maximal observation.
   * Evicted IDs fail stale_ref; retained objects are never reinterpreted.
   */
  while (g_queue_get_length(&handle_order) > HANDLE_MAX - NODE_MAX - 1U) {
    gchar *id = g_queue_pop_head(&handle_order); g_hash_table_remove(handles, id); g_free(id);
  }
  JsonObject *out = json_object_new();
  if (!strcmp(op, "hello")) { b(out, "ready", TRUE); i(out, "requestMaxBytes", FRAME_MAX); i(out, "verificationMaxBytes", TEXT_MAX); return out; }
  if (!strcmp(op, "discover")) {
    JsonArray *candidates = discover(p); if (candidates) json_object_set_array_member(out, "candidates", candidates);
    b(out, "actionable", FALSE); return out;
  }
  if (!strcmp(op, "observe")) {
    AtspiAccessible *root = bound_root(p); if (!root) return out;
    AtspiAccessible *subtree = root; const gchar *root_id = NULL;
    const gchar *subtree_id = str(p, "subtreeHandle");
    if (subtree_id) {
      Handle *selected = g_hash_table_lookup(handles, subtree_id);
      if (!live(selected, FALSE) || !equal(selected->root, root)) {
        if (!failure) failure = "root_changed";
        g_object_unref(root); return out;
      }
      subtree = selected->object; root_id = selected->root_id;
    }
    guint64 before = epoch(ATSPI_OBJECT(root)->app->bus_name);
    JsonArray *nodes = json_array_new(); node_count = 0; omitted = FALSE; tree_bytes = 0;
    const gchar *scope = str(p, "scope");
    if (g_strcmp0(scope, "visible") && g_strcmp0(scope, "structural")) failure = "invalid_scope";
    gint max_nodes = (gint)num(p, "maxNodes", 200), max_depth = (gint)num(p, "maxDepth", 12);
    if (max_nodes < 1 || max_nodes > NODE_MAX || max_depth < 0 || max_depth > DEPTH_MAX) failure = "invalid_tree_limit";
    if (!failure) walk(subtree, root, root_id, (guint)num(p, "pid", 0), str(p, "startToken"), 0, max_depth, max_nodes,
      !g_strcmp0(scope, "visible"), NULL, nodes);
    if (before != epoch(ATSPI_OBJECT(root)->app->bus_name)) failure = "read_changed";
    json_object_set_array_member(out, "nodes", nodes); b(out, "truncated", omitted); b(out, "complete", !omitted);
    s(out, "rootConfidence", "explicit_bus_object_process"); g_object_unref(root); return out;
  }
  Handle *h = g_hash_table_lookup(handles, str(p, "handle") ? str(p, "handle") : "");
  if (!strcmp(op, "renew")) {
    if (!h || h->structure_epoch != structure_epoch(h->bus)) { failure = "structure_changed"; return out; }
    /* A queued text/state event can arrive during a synchronous identity RPC.
     * Retry only this read-only validation, never an input primitive. The old
     * handle stays dirty; successful renewal issues a separate capability.
     */
    for (guint retry = 0; retry < 3; retry++) {
      guint64 old_epoch = h->epoch; h->epoch = object_epoch(h->object);
      gboolean valid = live(h, FALSE); h->epoch = old_epoch;
      Handle *fresh = valid ? issue(h->object, h->root, h->root_id, h->pid, h->start) : NULL;
      JsonObject *meta = fresh ? metadata(fresh) : NULL;
      if (fresh && !failure) valid = live(fresh, FALSE);
      if (fresh && valid && !failure) { json_object_unref(out); return meta; }
      if (meta) json_object_unref(meta);
      if (fresh) g_hash_table_remove(handles, fresh->id);
      if (!failure || strcmp(failure, "dirty_ref")) return out;
      if (retry < 2) failure = NULL;
    }
    return out;
  }
  if (!live(h, FALSE)) return out;
  json_object_unref(out);
  if (!strcmp(op, "resolve")) return metadata(h);
  if (!strcmp(op, "readText")) return read_text(h, p);
  return mutate(h, op, p);
}
static void request(const gchar *bytes, gsize length) {
  JsonParser *parser = json_parser_new(); failure = NULL; attempted = FALSE;
  g_clear_error(&rpc_error);
  JsonObject *response = json_object_new(); JsonObject *request_o = NULL;
  if (!json_parser_load_from_data(parser, bytes, (gssize)length, NULL) || !JSON_NODE_HOLDS_OBJECT(json_parser_get_root(parser))) failure = "invalid_json";
  else request_o = json_node_get_object(json_parser_get_root(parser));
  const gchar *schema = str(request_o, "schema"), *op = str(request_o, "operation"), *rid = str(request_o, "requestId"), *sid = str(request_o, "sessionId");
  gint64 gen = num(request_o, "generation", 0), remaining = num(request_o, "remainingMs", 0);
  if (!failure && (!schema || strcmp(schema, "muse.atspi.v1") || !op || !rid || strlen(rid) > 128 || !sid || strlen(sid) > 128 || gen < 1 || remaining < 1 || remaining > 180000)) failure = "invalid_request";
  if (!failure && !session_id) { if (strcmp(op, "hello")) failure = "hello_required"; else { session_id = g_strdup(sid); generation = gen; } }
  if (!failure && (g_strcmp0(session_id, sid) || gen != generation)) failure = "worker_scope_invalid";
  g_free(request_id); request_id = g_strdup(rid ? rid : "");
  deadline = g_get_monotonic_time() + MIN(MAX(remaining, 1), 180000) * 1000;
  gint64 start = g_get_monotonic_time();
  JsonObject *result = failure ? NULL : execute(op, obj(request_o, "params"));
  s(response, "requestId", request_id); b(response, "ok", !failure); b(response, "attempted", attempted);
  i(response, "startMonoUs", start); i(response, "endMonoUs", g_get_monotonic_time());
  if (failure) { s(response, "code", failure); s(response, "effect", attempted ? "unknown" : "none_proven"); }
  else if (result) json_object_set_object_member(response, "result", json_object_ref(result));
  emit(response); if (result) json_object_unref(result); json_object_unref(response); g_object_unref(parser);
}
static gboolean stdin_ready(gint fd, GIOCondition condition, gpointer data) {
  (void)data; guint8 block[8192];
  if (condition & G_IO_ERR) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  ssize_t count;
  while ((count = read(fd, block, sizeof(block))) > 0) {
    g_byte_array_append(input, block, (guint)count);
    while (input->len >= 4) {
      guint32 prefix; memcpy(&prefix, input->data, 4); guint32 size = GUINT32_FROM_BE(prefix);
      if (size < 2 || size > FRAME_MAX) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
      if (input->len < size + 4) break;
      gchar *frame = g_strndup((gchar *)input->data + 4, size); g_byte_array_remove_range(input, 0, size + 4);
      // Reject embedded NUL rather than permit C-string truncation in JSON text.
      if (strlen(frame) != size) { g_free(frame); g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
      request(frame, size); g_free(frame);
    }
    if (input->len > FRAME_MAX + 4) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  }
  if (count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)) { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  return G_SOURCE_CONTINUE;
}
int main(void) {
  const gchar *address = g_getenv("AT_SPI_BUS_ADDRESS"), *session = g_getenv("DBUS_SESSION_BUS_ADDRESS");
  if (!address || !*address || !session || !*session) { fputs("explicit_bus_required\n", stderr); return 2; }
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0) return 2;
  bus = g_dbus_connection_new_for_address_sync(address, G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
    G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION, NULL, NULL, NULL);
  if (!bus || atspi_init() != 0) { fputs("accessibility_bus_unavailable\n", stderr); if (bus) g_object_unref(bus); return 2; }
  handles = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, handle_free);
  structure_epochs = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  epochs = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  loop = g_main_loop_new(NULL, FALSE); input = g_byte_array_new();
  AtspiEventListener *listener = atspi_event_listener_new(dirty, NULL, NULL);
  const gchar *events[] = { "object:children-changed", "object:property-change", "object:state-changed", "object:text-changed", "object:text-selection-changed", "object:text-caret-moved", "object:selection-changed", "window:destroy" };
  for (guint n = 0; n < G_N_ELEMENTS(events); n++) {
    if (!atspi_event_listener_register(listener, events[n], NULL)) { fputs("event_registration_failed\n", stderr); return 2; }
  }
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  g_unix_fd_add(STDIN_FILENO, G_IO_IN | G_IO_HUP | G_IO_ERR, stdin_ready, NULL);
  g_main_loop_run(loop);
  for (guint n = 0; n < G_N_ELEMENTS(events); n++) atspi_event_listener_deregister(listener, events[n], NULL);
  g_object_unref(listener); g_hash_table_unref(handles); g_hash_table_unref(epochs); g_hash_table_unref(structure_epochs); g_byte_array_unref(input);
  g_queue_clear_full(&handle_order, g_free);
  g_main_loop_unref(loop); g_object_unref(bus); g_free(session_id); g_free(request_id); g_clear_error(&rpc_error); atspi_exit(); return 0;
}
