import ctypes as c
import sys,time
w,h=map(int,sys.argv[1].split('x'))
x=c.CDLL('libX11.so.6');x.XOpenDisplay.restype=c.c_void_p;d=c.c_void_p(x.XOpenDisplay(None));x.XDefaultRootWindow.restype=c.c_ulong;root=c.c_ulong(x.XDefaultRootWindow(d))
W=c.c_ulong
class Attr(c.Structure):
 _fields_=[('x',c.c_int),('y',c.c_int),('width',c.c_int),('height',c.c_int),('rest',c.c_byte*220)]
for attempt in range(50):
 rr=W();pp=W();arr=c.POINTER(W)();n=c.c_uint()
 x.XQueryTree(d,root,c.byref(rr),c.byref(pp),c.byref(arr),c.byref(n))
 wins=[]
 for i in range(n.value):
  win=W(arr[i]);a=Attr();x.XGetWindowAttributes(d,win,c.byref(a))
  if a.width>250 and a.height>200:wins.append((a.width*a.height,win))
 if wins:break
 time.sleep(.2)
assert wins
win=max(wins,key=lambda a:a[0])[1]
x.XMapRaised(d,win);x.XMoveResizeWindow(d,win,0,0,w,h);x.XSetInputFocus(d,win,2,0);x.XSync(d,False);time.sleep(.5)
