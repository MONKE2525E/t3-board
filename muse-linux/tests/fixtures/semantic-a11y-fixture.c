#include <gtk/gtk.h>
#include <stdio.h>
#include <unistd.h>

/* Owned AT-SPI fixture for muse-accessibility semantic tests.
   Compile: cc -std=gnu11 -O2 -Wall -Wextra -Werror tests/fixtures/semantic-a11y-fixture.c \
     -o semantic-a11y-fixture $(pkg-config --cflags --libs gtk4)
   GTK_A11Y=atspi. Parent may also compile this binary. */

#define TITLE "Muse Semantic A11y Fixture"

static GtkWidget *window;

static void ready(gpointer data) {
  (void)data;
  printf("{\"pid\":%d,\"title\":\"%s\"}\n", getpid(), TITLE);
  fflush(stdout);
}

static void activate(GtkApplication *app, gpointer user_data) {
  GtkWidget *box, *save, *disabled, *toggle, *entry, *scale, *label, *frame;
  (void)user_data;
  window = gtk_application_window_new(app);
  gtk_window_set_title(GTK_WINDOW(window), TITLE);
  gtk_window_set_default_size(GTK_WINDOW(window), 420, 280);
  gtk_window_set_focus_on_click(GTK_WINDOW(window), FALSE);
  box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  gtk_widget_set_margin_start(box, 12);
  gtk_widget_set_margin_end(box, 12);
  gtk_widget_set_margin_top(box, 12);
  gtk_widget_set_margin_bottom(box, 12);
  save = gtk_button_new_with_label("Save note");
  disabled = gtk_button_new_with_label("Disabled save");
  gtk_widget_set_sensitive(disabled, FALSE);
  toggle = gtk_toggle_button_new_with_label("Toggle me");
  entry = gtk_entry_new();
  gtk_entry_set_placeholder_text(GTK_ENTRY(entry), "Search");
  gtk_accessible_update_property(GTK_ACCESSIBLE(entry), GTK_ACCESSIBLE_PROPERTY_LABEL, "Search", -1);
  scale = gtk_scale_new_with_range(GTK_ORIENTATION_HORIZONTAL, 0, 100, 1);
  gtk_accessible_update_property(GTK_ACCESSIBLE(scale), GTK_ACCESSIBLE_PROPERTY_LABEL, "Volume", -1);
  label = gtk_label_new("Static text");
  frame = gtk_frame_new("Note");
  gtk_frame_set_child(GTK_FRAME(frame), gtk_label_new("body"));
  gtk_box_append(GTK_BOX(box), save);
  gtk_box_append(GTK_BOX(box), disabled);
  gtk_box_append(GTK_BOX(box), toggle);
  gtk_box_append(GTK_BOX(box), entry);
  gtk_box_append(GTK_BOX(box), scale);
  gtk_box_append(GTK_BOX(box), label);
  gtk_box_append(GTK_BOX(box), frame);
  gtk_window_set_child(GTK_WINDOW(window), box);
  gtk_window_present(GTK_WINDOW(window));
  g_timeout_add_once(250, ready, NULL);
}

int main(int argc, char **argv) {
  GtkApplication *app;
  int status;
  g_setenv("GTK_A11Y", "atspi", TRUE);
  app = gtk_application_new("io.muse.linux.semantic-a11y-fixture", G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect(app, "activate", G_CALLBACK(activate), NULL);
  status = g_application_run(G_APPLICATION(app), argc, argv);
  g_object_unref(app);
  return status;
}
