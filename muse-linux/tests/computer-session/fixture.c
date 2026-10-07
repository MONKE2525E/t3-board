/* Synthetic GTK client, owned exclusively by computer-session verification. */
#include <gtk/gtk.h>
#include <stdio.h>
#include <unistd.h>
static GtkWidget *entry, *primary;
static const char *sentinel;
static int clicks, submits;
static void write_state(void) {
 char *file=g_build_filename(g_get_home_dir(),"state.txt",NULL);
 FILE *f=fopen(file,"w");if(f){fprintf(f,"%d\n%d\n%s",clicks,submits,gtk_entry_get_text(GTK_ENTRY(entry)));fclose(f);}g_free(file);
}
static void changed(GtkEditable *e,gpointer data){(void)e;(void)data;write_state();}
static void activate(GtkEntry *e,gpointer data){(void)e;(void)data;submits++;write_state();}
static void increment(GtkButton *b,gpointer data){(void)b;(void)data;clicks++;write_state();}
static void copy(GtkButton *b,gpointer data){(void)b;(void)data;gtk_clipboard_set_text(gtk_clipboard_get(GDK_SELECTION_CLIPBOARD),sentinel,-1);}
static void pasted(GtkClipboard *c,const gchar *text,gpointer data){(void)c;(void)data;char *file=g_build_filename(g_get_home_dir(),"clipboard.txt",NULL);g_file_set_contents(file,text?text:"EMPTY",-1,NULL);g_free(file);}
static void paste(GtkButton *b,gpointer data){(void)b;(void)data;gtk_clipboard_request_text(gtk_clipboard_get(GDK_SELECTION_CLIPBOARD),pasted,NULL);}
static void second(GtkButton *b,gpointer data){(void)b;(void)data;GtkWidget *w=gtk_window_new(GTK_WINDOW_TOPLEVEL);gtk_window_set_title(GTK_WINDOW(w),"Session second fixture");gtk_container_add(GTK_CONTAINER(w),gtk_label_new("Private second window"));gtk_widget_show_all(w);}
static void dialog(GtkButton *b,gpointer data){(void)b;(void)data;GtkWidget *w=gtk_dialog_new_with_buttons("Session dialog fixture",GTK_WINDOW(primary),GTK_DIALOG_MODAL,"Close",GTK_RESPONSE_CLOSE,NULL);gtk_container_add(GTK_CONTAINER(gtk_dialog_get_content_area(GTK_DIALOG(w))),gtk_label_new("Private modal dialog"));g_signal_connect_swapped(w,"response",G_CALLBACK(gtk_widget_destroy),w);gtk_widget_show_all(w);}
static void button(GtkWidget *box,const char *label,GCallback callback){GtkWidget *b=gtk_button_new_with_label(label);atk_object_set_name(gtk_widget_get_accessible(b),label);g_signal_connect(b,"clicked",callback,NULL);gtk_box_pack_start(GTK_BOX(box),b,FALSE,FALSE,0);}
int main(int argc,char **argv){
 if(argc!=2)return 2;
 sentinel=argv[1];g_set_prgname("muse-session-fixture");gtk_init(&argc,&argv);
 primary=gtk_window_new(GTK_WINDOW_TOPLEVEL);gtk_window_set_title(GTK_WINDOW(primary),"Session primary fixture");gtk_window_set_default_size(GTK_WINDOW(primary),640,480);
 GtkWidget *box=gtk_box_new(GTK_ORIENTATION_VERTICAL,20);gtk_container_set_border_width(GTK_CONTAINER(primary),36);gtk_container_add(GTK_CONTAINER(primary),box);
 gtk_box_pack_start(GTK_BOX(box),gtk_label_new(sentinel),FALSE,FALSE,0);
 entry=gtk_entry_new();atk_object_set_name(gtk_widget_get_accessible(entry),"Synthetic editor");g_signal_connect(entry,"changed",G_CALLBACK(changed),NULL);g_signal_connect(entry,"activate",G_CALLBACK(activate),NULL);gtk_box_pack_start(GTK_BOX(box),entry,FALSE,FALSE,0);
 button(box,"Synthetic increment",G_CALLBACK(increment));button(box,"Synthetic copy",G_CALLBACK(copy));button(box,"Synthetic paste",G_CALLBACK(paste));button(box,"Synthetic second",G_CALLBACK(second));button(box,"Synthetic dialog",G_CALLBACK(dialog));
 g_signal_connect(primary,"destroy",G_CALLBACK(gtk_main_quit),NULL);gtk_widget_show_all(primary);write_state();gtk_main();return 0;
}
