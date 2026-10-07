/* Original Muse session protocol adapter. Generated protocol bindings are a
 * separate build input; preserve the upstream XML's license when packaging. */
#include <wayland-client.h>
#include <json-glib/json-glib.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "wlr-foreign-toplevel-management-unstable-v1-client-protocol.h"

struct view { struct zwlr_foreign_toplevel_handle_v1 *handle; unsigned id; char *title, *app_id; int active, closed; struct view *next; };
static struct wl_display *display;
static struct wl_seat *seat;
static struct zwlr_foreign_toplevel_manager_v1 *manager;
static struct view *views;
static unsigned next_id;
static JsonArray *protocols;
static void title(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, const char *s) { (void)h; struct view *v=data; free(v->title); v->title=strdup(s); }
static void app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, const char *s) { (void)h; struct view *v=data; free(v->app_id); v->app_id=strdup(s); }
static void output_enter(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_output *o) { (void)data;(void)h;(void)o; }
static void output_leave(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_output *o) { (void)data;(void)h;(void)o; }
static void state(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_array *states) {
 (void)h; struct view *v=data; v->active=0; uint32_t *s;
 wl_array_for_each(s,states) if(*s==ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_ACTIVATED) v->active=1;
}
static void done(void *data, struct zwlr_foreign_toplevel_handle_v1 *h) { (void)data;(void)h; }
static void closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *h) { struct view *v=data; v->closed=1; zwlr_foreign_toplevel_handle_v1_destroy(h); v->handle=NULL; }
static void parent(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct zwlr_foreign_toplevel_handle_v1 *p) { (void)data;(void)h;(void)p; }
static const struct zwlr_foreign_toplevel_handle_v1_listener handle_listener={title,app_id,output_enter,output_leave,state,done,closed,parent};
static void toplevel(void *data, struct zwlr_foreign_toplevel_manager_v1 *m, struct zwlr_foreign_toplevel_handle_v1 *h) {
 (void)data;(void)m; struct view *v=calloc(1,sizeof(*v)); if(!v)exit(2);
 v->id=++next_id;v->handle=h;v->next=views;views=v;zwlr_foreign_toplevel_handle_v1_add_listener(h,&handle_listener,v);
}
static void finished(void *data, struct zwlr_foreign_toplevel_manager_v1 *m) { (void)data;(void)m; }
static const struct zwlr_foreign_toplevel_manager_v1_listener manager_listener={toplevel,finished};
static void global(void *data, struct wl_registry *r, uint32_t name, const char *interface, uint32_t version) {
 (void)data; json_array_add_string_element(protocols,interface);
 if(!strcmp(interface,"wl_seat")&&!seat)seat=wl_registry_bind(r,name,&wl_seat_interface,version<1?version:1);
 if(!strcmp(interface,"zwlr_foreign_toplevel_manager_v1")) { manager=wl_registry_bind(r,name,&zwlr_foreign_toplevel_manager_v1_interface,version<3?version:3);zwlr_foreign_toplevel_manager_v1_add_listener(manager,&manager_listener,NULL); }
}
static void removed(void *data, struct wl_registry *r, uint32_t name) { (void)data;(void)r;(void)name; }
static void emit(const char *id,const char *event,const char *code) {
 JsonBuilder *b=json_builder_new();json_builder_begin_object(b);
 json_builder_set_member_name(b,"id");json_builder_add_string_value(b,id);
 json_builder_set_member_name(b,"event");json_builder_add_string_value(b,event);
 if(code){json_builder_set_member_name(b,"code");json_builder_add_string_value(b,code);}
 json_builder_set_member_name(b,"protocols");json_builder_begin_array(b);
 for(guint i=0;i<json_array_get_length(protocols);i++)json_builder_add_string_value(b,json_array_get_string_element(protocols,i));
 json_builder_end_array(b);json_builder_set_member_name(b,"windows");json_builder_begin_array(b);
 for(struct view *v=views;v;v=v->next)if(!v->closed){char key[32];snprintf(key,sizeof(key),"w%u",v->id);json_builder_begin_object(b);
  json_builder_set_member_name(b,"targetId");json_builder_add_string_value(b,key);
  json_builder_set_member_name(b,"title");json_builder_add_string_value(b,v->title?v->title:"");
  json_builder_set_member_name(b,"appId");json_builder_add_string_value(b,v->app_id?v->app_id:"");
  json_builder_set_member_name(b,"active");json_builder_add_boolean_value(b,v->active);json_builder_end_object(b);}
 json_builder_end_array(b);json_builder_end_object(b);
 JsonNode *node=json_builder_get_root(b);JsonGenerator *g=json_generator_new();json_generator_set_root(g,node);
 gchar *raw=json_generator_to_data(g,NULL);puts(raw);fflush(stdout);g_free(raw);json_node_free(node);g_object_unref(g);g_object_unref(b);
}
static const char *string_member(JsonObject *o,const char *name) {
 if(!json_object_has_member(o,name))return NULL;
 JsonNode *n=json_object_get_member(o,name);
 return JSON_NODE_HOLDS_VALUE(n)&&json_node_get_value_type(n)==G_TYPE_STRING?json_node_get_string(n):NULL;
}
static void request(char *line) {
 JsonParser *p=json_parser_new();GError *error=NULL;
 if(!json_parser_load_from_data(p,line,-1,&error)||!JSON_NODE_HOLDS_OBJECT(json_parser_get_root(p))){emit("","error","invalid_request");g_clear_error(&error);g_object_unref(p);return;}
 JsonObject *o=json_node_get_object(json_parser_get_root(p));const char *id=string_member(o,"id"),*op=string_member(o,"op"),*target=string_member(o,"targetId");
 if(!id||strlen(id)>128||!op){emit("","error","invalid_request");g_object_unref(p);return;}
 if(!strcmp(op,"list")){if(wl_display_roundtrip(display)<0)exit(1);
   emit(id,"result",NULL);}
 else if(!strcmp(op,"activate")||!strcmp(op,"close")){
  struct view *v;for(v=views;v;v=v->next){char key[32];snprintf(key,sizeof(key),"w%u",v->id);if(target&&!strcmp(target,key)&&!v->closed)break;}
  if(!v)emit(id,"error","target_gone");
  else if(!strcmp(op,"activate")&&!seat)emit(id,"error","seat_unavailable");
  else {if(!strcmp(op,"activate"))zwlr_foreign_toplevel_handle_v1_activate(v->handle,seat);else zwlr_foreign_toplevel_handle_v1_close(v->handle);
   if(wl_display_roundtrip(display)<0)exit(1);
   emit(id,"result",NULL);}
 }else emit(id,"error","operation_unsupported");
 g_object_unref(p);
}
int main(int argc,char **argv) {
 if(argc!=2||(strcmp(argv[1],"--probe")&&strcmp(argv[1],"--serve")))return 2;
 /* Never let wl_display_connect resolve an absent scope from ambient defaults. */
 if(!getenv("WAYLAND_DISPLAY")||!getenv("XDG_RUNTIME_DIR")||!getenv("DBUS_SESSION_BUS_ADDRESS")||!getenv("AT_SPI_BUS_ADDRESS"))return 2;
 protocols=json_array_new();display=wl_display_connect(NULL);if(!display)return 1;
 struct wl_registry *registry=wl_display_get_registry(display);const struct wl_registry_listener l={global,removed};wl_registry_add_listener(registry,&l,NULL);
 if(wl_display_roundtrip(display)<0||wl_display_roundtrip(display)<0)return 1;
 if(!strcmp(argv[1],"--probe")){emit("probe","result",NULL);return 0;}
 if(!manager||!seat)return 1;
 emit("ready","ready",NULL);
 char line[4098];size_t used=0;
 for(;;){while(wl_display_prepare_read(display)!=0)if(wl_display_dispatch_pending(display)<0)return 1;
  wl_display_flush(display);struct pollfd fds[2]={{wl_display_get_fd(display),POLLIN,0},{STDIN_FILENO,POLLIN,0}};
  int n=poll(fds,2,-1);if(n<0){wl_display_cancel_read(display);return 1;}
  if(fds[0].revents&(POLLERR|POLLHUP)){wl_display_cancel_read(display);return 1;}
  if(fds[0].revents&POLLIN){if(wl_display_read_events(display)<0)return 1;}else wl_display_cancel_read(display);
  if(wl_display_dispatch_pending(display)<0)return 1;
  if(fds[1].revents&(POLLERR|POLLHUP))return 0;
  if(fds[1].revents&POLLIN){char buf[512];ssize_t count=read(STDIN_FILENO,buf,sizeof(buf));if(count<=0)return 0;
   for(ssize_t i=0;i<count;i++){if(buf[i]=='\n'){line[used]='\0';request(line);used=0;}else{if(used>=sizeof(line)-1)return 2;line[used++]=buf[i];}}}
 }
}
