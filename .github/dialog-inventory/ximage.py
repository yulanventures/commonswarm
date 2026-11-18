"""Capture the private Xvfb display without depending on a desktop screenshot tool."""
import binascii
import ctypes as c
import struct
import sys
import zlib
from pathlib import Path
width,height=map(int,sys.argv[1].split('x'))
x=c.CDLL('libX11.so.6')
x.XOpenDisplay.restype=c.c_void_p
display=c.c_void_p(x.XOpenDisplay(None))
x.XDefaultRootWindow.restype=c.c_ulong
root=c.c_ulong(x.XDefaultRootWindow(display))
x.XGetImage.restype=c.c_void_p
pic=c.c_void_p(x.XGetImage(display,root,0,0,width,height,c.c_ulong(-1),2))
x.XGetPixel.restype=c.c_ulong
assert pic
data=bytearray()
for y in range(height):
 data.append(0)
 for col in range(width):
  pixel=x.XGetPixel(pic,col,y)
  data.extend(((pixel>>16)&255,(pixel>>8)&255,pixel&255))
def chunk(t,p):
 return struct.pack('>I',len(p))+t+p+struct.pack('>I',binascii.crc32(t+p))
Path('shots/prompt-'+sys.argv[1]+'.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(data))+chunk(b'IEND',b''))
