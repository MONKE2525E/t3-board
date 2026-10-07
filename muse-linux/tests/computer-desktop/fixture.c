/* Owned GTK3 synthetic fixture. Independent file readback; no host input/clipboard. */
#include <gtk/gtk.h>
#include <json-glib/json-glib.h>
#include <stdio.h>
#include <glib/gstdio.h>
static gchar *directory;
static GtkWidget *window, *entry, *view, *row_box, *row_a, *row_b;
static guint clicks, row_clicks, command_serial;
static void named(GtkWidget *w, const gchar *name) { atk_object_set_name(gtk_widget_get_accessible(w), name); }
static void save(void) {
  gchar *path = g_build_filename(directory, "entry.txt", NULL);
  g_file_set_contents(path, gtk_entry_get_text(GTK_ENTRY(entry)), -1, NULL); g_free(path);
  GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(view)); GtkTextIter begin, end;
  gtk_text_buffer_get_bounds(buffer, &begin, &end); gchar *text = gtk_text_buffer_get_text(buffer, &begin, &end, FALSE);
  path = g_build_filename(directory, "view.txt", NULL); g_file_set_contents(path, text, -1, NULL); g_free(text); g_free(path);
  text = g_strdup_printf("{\"clicks\":%u,\"rowClicks\":%u,\"commandSerial\":%u}", clicks, row_clicks, command_serial);
  path = g_build_filename(directory, "state.json", NULL); g_file_set_contents(path, text, -1, NULL); g_free(text); g_free(path);
}
static void changed(gpointer a, gpointer data) { (void)a; (void)data; save(); }
static void click(GtkWidget *w, gpointer data) { (void)w; (void)data; clicks++; save(); }
static void row_click(GtkWidget *w, gpointer data) { (void)w; (void)data; row_clicks++; save(); }
static GtkWidget *row(void) { GtkWidget *w = gtk_button_new_with_label("Identical row"); named(w, "Identical row"); g_signal_connect(w, "clicked", G_CALLBACK(row_click), NULL); return w; }
static void closed(GtkDialog *dialog, gint response, gpointer data) { (void)response; (void)data; gtk_widget_destroy(GTK_WIDGET(dialog)); }
static void open_menu(GtkWidget *w, gpointer data) {
  (void)data; GtkWidget *menu = gtk_menu_new(), *item = gtk_menu_item_new_with_label("Named menu item");
  gtk_menu_shell_append(GTK_MENU_SHELL(menu), item); named(item, "Named menu item"); g_signal_connect(item, "activate", G_CALLBACK(click), NULL);
  gtk_widget_show_all(menu); gtk_menu_popup_at_widget(GTK_MENU(menu), w, GDK_GRAVITY_SOUTH_WEST, GDK_GRAVITY_NORTH_WEST, NULL);
}
static gboolean controls(gpointer data) {
  (void)data; gchar *path = g_build_filename(directory, "control.json", NULL), *contents = NULL;
  if (!g_file_get_contents(path, &contents, NULL, NULL)) { g_free(path); return G_SOURCE_CONTINUE; }
  g_remove(path); g_free(path);
  JsonParser *parser = json_parser_new();
  if (json_parser_load_from_data(parser, contents, -1, NULL)) {
    JsonObject *o = json_node_get_object(json_parser_get_root(parser)); const gchar *op = json_object_get_string_member(o, "op");
    if (!g_strcmp0(op, "caret")) gtk_editable_set_position(GTK_EDITABLE(entry), (gint)json_object_get_int_member(o, "position"));
    else if (!g_strcmp0(op, "selection")) gtk_editable_select_region(GTK_EDITABLE(entry), (gint)json_object_get_int_member(o, "start"), (gint)json_object_get_int_member(o, "end"));
    else if (!g_strcmp0(op, "reorder")) gtk_box_reorder_child(GTK_BOX(row_box), row_b, 0);
    else if (!g_strcmp0(op, "replaceRow")) {
      gtk_widget_destroy(row_a); row_a = row(); gtk_box_pack_start(GTK_BOX(row_box), row_a, FALSE, FALSE, 0); gtk_widget_show_all(row_box);
    } else if (!g_strcmp0(op, "cover")) {
      GtkWidget *cover = gtk_window_new(GTK_WINDOW_TOPLEVEL); gtk_window_set_title(GTK_WINDOW(cover), "Desktop covered fixture");
      gtk_container_add(GTK_CONTAINER(cover), gtk_label_new("Owned cover window")); gtk_widget_show_all(cover);
    } else if (!g_strcmp0(op, "dialog")) {
      GtkWidget *dialog = gtk_dialog_new_with_buttons("Desktop dialog fixture", GTK_WINDOW(window), GTK_DIALOG_MODAL, "Close", GTK_RESPONSE_CLOSE, NULL);
      g_signal_connect(dialog, "response", G_CALLBACK(closed), NULL); gtk_widget_show_all(dialog);
    }
    command_serial++; save();
  }
  g_object_unref(parser); g_free(contents); return G_SOURCE_CONTINUE;
}
int main(int argc, char **argv) {
  if (argc != 2 || !g_path_is_absolute(argv[1])) return 2;
  directory = g_strdup(argv[1]); gtk_init(&argc, &argv);
  g_object_set(gtk_settings_get_default(), "gtk-cursor-blink", FALSE, "gtk-enable-animations", FALSE, NULL);
  window = gtk_window_new(GTK_WINDOW_TOPLEVEL); gtk_window_set_title(GTK_WINDOW(window), "Muse Desktop Contract Fixture");
  gtk_window_set_default_size(GTK_WINDOW(window), 960, 640);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8); gtk_container_add(GTK_CONTAINER(window), box);
  entry = gtk_entry_new(); named(entry, "Plain entry"); gtk_box_pack_start(GTK_BOX(box), entry, FALSE, FALSE, 0);
  view = gtk_text_view_new(); named(view, "Plain multiline"); gtk_widget_set_size_request(view, -1, 160); gtk_box_pack_start(GTK_BOX(box), view, TRUE, TRUE, 0);
  GtkWidget *secret = gtk_entry_new(); gtk_entry_set_visibility(GTK_ENTRY(secret), FALSE); named(secret, "Password"); gtk_box_pack_start(GTK_BOX(box), secret, FALSE, FALSE, 0);
  GtkWidget *readonly = gtk_entry_new(); gtk_editable_set_editable(GTK_EDITABLE(readonly), FALSE); named(readonly, "Readonly"); gtk_box_pack_start(GTK_BOX(box), readonly, FALSE, FALSE, 0);
  GtkWidget *button = gtk_button_new_with_label("Increment"); named(button, "Increment"); g_signal_connect(button, "clicked", G_CALLBACK(click), NULL); gtk_box_pack_start(GTK_BOX(box), button, FALSE, FALSE, 0);
  GtkWidget *menu = gtk_button_new_with_label("Open menu"); named(menu, "Open menu"); g_signal_connect(menu, "clicked", G_CALLBACK(open_menu), NULL); gtk_box_pack_start(GTK_BOX(box), menu, FALSE, FALSE, 0);
  GtkWidget *slider = gtk_scale_new_with_range(GTK_ORIENTATION_HORIZONTAL, 0, 100, 1); named(slider, "Slider is not scroll"); gtk_box_pack_start(GTK_BOX(box), slider, FALSE, FALSE, 0);
  row_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2); row_a = row(); row_b = row(); gtk_box_pack_start(GTK_BOX(row_box), row_a, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(row_box), row_b, FALSE, FALSE, 0); gtk_box_pack_start(GTK_BOX(box), row_box, FALSE, FALSE, 0);
  g_signal_connect(entry, "changed", G_CALLBACK(changed), NULL); g_signal_connect(gtk_text_view_get_buffer(GTK_TEXT_VIEW(view)), "changed", G_CALLBACK(changed), NULL);
  g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL); gtk_widget_show_all(window); save(); g_timeout_add(20, controls, NULL);
  puts("fixture-ready"); fflush(stdout); gtk_main(); g_free(directory); return 0;
}
