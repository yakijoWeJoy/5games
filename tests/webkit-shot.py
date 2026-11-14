#!/usr/bin/python3.12
"""Screenshot a page with the real WebKit engine (the engine behind every iPhone browser).

Needs: apt-get install gir1.2-webkit2-4.1 gir1.2-gtk-3.0 python3-gi xvfb
Run:   xvfb-run -a python3.12 tests/webkit-shot.py OUT.png URL [WIDTH HEIGHT] [--js "code to run before the shot"] [--wait SECONDS]
Prints the result of the JS expression (if any) on stdout.
"""
import sys
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

args = sys.argv[1:]
js = None
wait = 2.5
if '--js' in args:
    i = args.index('--js'); js = args[i + 1]; del args[i:i + 2]
if '--wait' in args:
    i = args.index('--wait'); wait = float(args[i + 1]); del args[i:i + 2]
out, url = args[0], args[1]
w, h = (int(args[2]), int(args[3])) if len(args) >= 4 else (390, 844)

win = Gtk.Window()
win.set_default_size(w, h)
view = WebKit2.WebView()
s = view.get_settings()
s.set_enable_developer_extras(False)
s.set_user_agent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
win.add(view)
win.show_all()
state = {'code': 0}

def snap():
    def done(v, res):
        try:
            surface = v.get_snapshot_finish(res)
            surface.write_to_png(out)
        except Exception as e:  # noqa
            print('SNAPSHOT-ERROR', e); state['code'] = 1
        Gtk.main_quit()
    view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, done)
    return False

def after_js(v, res):
    try:
        r = v.evaluate_javascript_finish(res)
        print('JS:', r.to_string() if r is not None else None)
    except Exception as e:  # noqa
        print('JS-ERROR', e); state['code'] = 1
    GLib.timeout_add(int(wait * 1000), snap)

def loaded(v, ev):
    if ev != WebKit2.LoadEvent.FINISHED:
        return
    def go():
        if js:
            view.evaluate_javascript(js, -1, None, None, None, after_js)
        else:
            snap()
        return False
    GLib.timeout_add(int(wait * 1000), go)

view.connect('load-changed', loaded)
view.load_uri(url)
GLib.timeout_add(60000, Gtk.main_quit)
Gtk.main()
sys.exit(state['code'])
