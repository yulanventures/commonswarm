set -eu
size=$1
google-chrome --no-sandbox --disable-dev-shm-usage --user-data-dir="/tmp/dialog-fixture-$size" --no-first-run --no-default-browser-check --disable-background-networking --window-position=0,0 --window-size=900,800 --app="http://127.0.0.1:8888/index.html" >/tmp/dialog-chrome.log 2>&1 &
browser_pid=$!
trap 'kill "$browser_pid" 2>/dev/null || true' EXIT
sleep 5
python3 .github/dialog-inventory/place.py "$size"
python3 - <<'PY'
import ctypes,time
x=ctypes.CDLL('libX11.so.6')
xt=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
display=ctypes.c_void_p(x.XOpenDisplay(None))
for down in [True,False]:
 xt.XTestFakeKeyEvent(display,36,down,0)
 x.XSync(display,False)
 time.sleep(.1)
PY
sleep 1
kill -0 "$browser_pid" || { cat /tmp/dialog-chrome.log; exit 1; }
python3 .github/dialog-inventory/ximage.py "$size"
