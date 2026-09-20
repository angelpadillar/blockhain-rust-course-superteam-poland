"""Run only inside an isolated synthetic fixture container; never on the live desktop."""
import ctypes as c
import os
import time

if os.environ.get('BUENA_CLIPBOARD_FIXTURE') != '1' or os.environ.get('DISPLAY') not in (':99', ':100'):
    raise RuntimeError('Fixture-only clipboard check')
x = c.CDLL('libX11.so.6')
P, U = c.c_void_p, c.c_ulong
for name, result, args in [
    ('XOpenDisplay', P, [c.c_char_p]), ('XDefaultRootWindow', U, [P]),
    ('XCreateSimpleWindow', U, [P,U,c.c_int,c.c_int,c.c_uint,c.c_uint,c.c_uint,U,U]),
    ('XInternAtom', U, [P,c.c_char_p,c.c_int]), ('XConvertSelection', c.c_int, [P,U,U,U,U,U]),
    ('XFlush', c.c_int,[P]), ('XPending',c.c_int,[P]), ('XNextEvent',c.c_int,[P,P]),
    ('XGetWindowProperty',c.c_int,[P,U,U,c.c_long,c.c_long,c.c_int,U,c.POINTER(U),c.POINTER(c.c_int),c.POINTER(U),c.POINTER(U),c.POINTER(P)]),
    ('XFree',c.c_int,[P]), ('XCloseDisplay',c.c_int,[P]),
]:
    f=getattr(x,name);f.restype=result;f.argtypes=args
selection=os.environ.get('BUENA_FIXTURE_SELECTION','CLIPBOARD')
if selection not in ('CLIPBOARD','PRIMARY'): raise RuntimeError('Unsupported fixture selection')
display=x.XOpenDisplay(None)
if not display: raise RuntimeError('Fixture display unavailable')
window=x.XCreateSimpleWindow(display,x.XDefaultRootWindow(display),0,0,1,1,0,0,0)
atom=lambda name:x.XInternAtom(display,name.encode(),0)
class Notify(c.Structure):
    _fields_=[('type',c.c_int),('serial',U),('send_event',c.c_int),('display',P),('requestor',U),('selection',U),('target',U),('property',U),('time',U)]
try:
    for kind in ('UTF8_STRING','STRING'):
        x.XConvertSelection(display,atom(selection),atom(kind),atom('BUENA_TEST'),window,0);x.XFlush(display)
        until=time.monotonic()+3
        while time.monotonic()<until:
            if not x.XPending(display): time.sleep(.01);continue
            event=(c.c_long*24)();x.XNextEvent(display,c.byref(event));notice=c.cast(event,c.POINTER(Notify)).contents
            if notice.type!=31: continue
            if not notice.property: break
            actual,fmt,count,after,data=U(),c.c_int(),U(),U(),P()
            x.XGetWindowProperty(display,window,notice.property,0,65536,0,0,c.byref(actual),c.byref(fmt),c.byref(count),c.byref(after),c.byref(data))
            value=c.string_at(data,count.value);x.XFree(data)
            print(value.decode('utf-8' if kind=='UTF8_STRING' else 'latin-1'),end='');raise SystemExit(0)
    raise RuntimeError('No fixture clipboard text received')
finally:x.XCloseDisplay(display)
