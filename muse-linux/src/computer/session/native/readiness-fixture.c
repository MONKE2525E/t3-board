/* Original private startup calibration client. It accepts no user content. */
#include <gtk/gtk.h>
#include <stdio.h>
static GtkWidget *entry;
static char *state_path;
static const char *nonce;
static unsigned clicks, submissions;
static void save(void) {
 char *value=g_strdup_printf("%s\n%u\n%u\n%s",nonce,clicks,submissions,gtk_entry_get_text(GTK_ENTRY(entry)));
 g_file_set_contents(state_path,value,-1,NULL);g_free(value);
}
static void changed(GtkEditable *w,gpointer data){(void)w;(void)data;save();}
static void submitted(GtkEntry *w,gpointer data){(void)w;(void)data;submissions++;save();}
static gboolean clicked(GtkWidget *w,GdkEventButton *e,gpointer data){(void)w;(void)data;if(e->button==1){clicks++;save();}return TRUE;}
static gboolean draw(GtkWidget *w,cairo_t *cr,gpointer data){(void)w;(void)data;cairo_set_source_rgb(cr,32.0/255,128.0/255,191.0/255);cairo_paint(cr);return FALSE;}
int main(int argc,char **argv) {
 if(argc!=2||strlen(argv[1])!=36)return 2;
 for(const char *p=argv[1];*p;p++)if(!g_ascii_isxdigit(*p)&&*p!='-')return 2;
 nonce=argv[1];char *name=g_strdup_printf("readiness-%s.txt",nonce);state_path=g_build_filename(g_get_home_dir(),name,NULL);g_free(name);
 g_set_prgname("muse-readiness-fixture");gtk_init(&argc,&argv);
 GtkWidget *window=gtk_window_new(GTK_WINDOW_TOPLEVEL);gtk_window_set_title(GTK_WINDOW(window),"Muse readiness fixture");gtk_window_set_decorated(GTK_WINDOW(window),FALSE);
 gtk_window_set_default_size(GTK_WINDOW(window),1280,720);GtkWidget *fixed=gtk_fixed_new();gtk_container_add(GTK_CONTAINER(window),fixed);
 entry=gtk_entry_new();atk_object_set_name(gtk_widget_get_accessible(entry),"Muse readiness editor");gtk_widget_set_size_request(entry,640,64);gtk_fixed_put(GTK_FIXED(fixed),entry,0,0);
 g_signal_connect(entry,"changed",G_CALLBACK(changed),NULL);g_signal_connect(entry,"activate",G_CALLBACK(submitted),NULL);
 GtkWidget *marker=gtk_drawing_area_new();gtk_widget_set_size_request(marker,1280,128);gtk_fixed_put(GTK_FIXED(fixed),marker,0,128);
 atk_object_set_name(gtk_widget_get_accessible(marker),"Muse readiness pointer marker");gtk_widget_add_events(marker,GDK_BUTTON_PRESS_MASK);
 g_signal_connect(marker,"draw",G_CALLBACK(draw),NULL);g_signal_connect(marker,"button-press-event",G_CALLBACK(clicked),NULL);
 g_signal_connect(window,"destroy",G_CALLBACK(gtk_main_quit),NULL);gtk_widget_show_all(window);save();gtk_main();g_free(state_path);return 0;
}
