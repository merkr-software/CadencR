// Node-API addon for the AppKit window flags Electron does not expose.
// Built by `electron/mac-native-addon.ts` into resources/native/mac-window.node.
//
// Electron's `type: "panel"` window is an NSWindow whose `styleMask` getter
// adds NSWindowStyleMaskNonactivatingPanel, but AppKit only reads that bit at
// NSPanel init: the window never gets `_preventsActivation`, so a click on it
// still activates the app — and macOS raises Cadencr's main window with it.

#import <AppKit/AppKit.h>
#import <objc/message.h>

// Node-API is an ABI-stable C interface; declaring the handful of calls used
// here spares the build a Node/Electron headers download.
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
#define NAPI_AUTO_LENGTH SIZE_MAX

extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t *argc,
                                    napi_value *argv, napi_value *this_arg, void **data);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data,
                                        size_t *length);
extern napi_status napi_throw_error(napi_env env, const char *code, const char *msg);
extern napi_status napi_create_function(napi_env env, const char *name, size_t length,
                                        napi_callback cb, void *data, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char *name,
                                           napi_value value);

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, "CADENCR_MAC_WINDOW", message);
  return NULL;
}

/** preventActivation(handle: Buffer) — `handle` is `BrowserWindow.getNativeWindowHandle()`. */
static napi_value PreventActivation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  void *data = NULL;
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1 ||
      napi_get_buffer_info(env, argv[0], &data, &length) != 0 || length < sizeof(void *)) {
    return fail(env, "preventActivation expects a native window handle buffer.");
  }
  NSView *view = (__bridge NSView *)(*(void **)data);
  NSWindow *window = view.window;
  if (window == nil) return fail(env, "The native window handle has no NSWindow.");

  // Private, as NSPanel's own init uses it; checked first so a removal throws
  // a JS error instead of an uncaught NSException.
  SEL setter = NSSelectorFromString(@"_setPreventsActivation:");
  if (![window respondsToSelector:setter]) {
    return fail(env, "AppKit no longer provides the prevents-activation window flag.");
  }
  ((void (*)(id, SEL, BOOL))objc_msgSend)(window, setter, YES);
  return NULL;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "preventActivation", NAPI_AUTO_LENGTH, PreventActivation,
                           NULL, &fn) != 0 ||
      napi_set_named_property(env, exports, "preventActivation", fn) != 0) {
    return fail(env, "Could not register the mac-window addon.");
  }
  return exports;
}
