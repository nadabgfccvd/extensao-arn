#!/usr/bin/env python3
import sys, os, json, time, subprocess
from datetime import datetime, timezone
TAG = "AU_KIT_ROOM_ag1"
DEFAULT_MIN = 60
STATE_DIR = os.environ.get("AU_STATE_DIR", "/home/user/au_state")
try: os.makedirs(STATE_DIR, exist_ok=True)
except Exception: STATE_DIR = "/tmp"
TIMER_FILE = os.path.join(STATE_DIR, f"au_timer_{TAG}.json")
def fmt_clock(epoch):
    return datetime.fromtimestamp(epoch).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
def fmt_dur(sec):
    sec = max(0, int(round(sec)))
    h, rem = divmod(sec, 3600); m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m {s:02d}s" if h > 0 else f"{m}m {s:02d}s"
def load_timer():
    if os.path.exists(TIMER_FILE):
        try:
            with open(TIMER_FILE, "r", encoding="utf-8") as f: return json.load(f)
        except Exception: pass
    return None
def save_timer(st):
    tmp = TIMER_FILE + f".tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(st, f)
    os.replace(tmp, TIMER_FILE)
def start_or_reset(mins, force_reset=False):
    now = time.time(); cur = load_timer()
    if not force_reset and cur and (float(cur.get("startedAt", 0)) + float(cur.get("targetSec", mins*60)) > now):
        return cur
    st = {"startedAt": now, "targetSec": max(60, int(float(mins) * 60)), "checks": 0, "lastCheckAt": now}
    save_timer(st); return st
def do_check():
    now = time.time()
    st = load_timer() or start_or_reset(DEFAULT_MIN, False)
    st["checks"] = int(st.get("checks", 0)) + 1
    st["lastCheckAt"] = now; save_timer(st)
    started = float(st["startedAt"]); target = float(st["targetSec"])
    elapsed = max(0.0, now - started); rem = (started + target) - now
    if rem > 0:
        print(f"⏳ [HORÁRIO REAL: {fmt_clock(now)}] Decorrido: {fmt_dur(elapsed)} / {fmt_dur(target)} | Liberação às: {fmt_clock(started + target)} | FALTAM: {fmt_dur(rem)} | Checagem #{st['checks']} | CAN_FINISH=NO")
        print("🚫 BLOQUEADO PELA REGRA DO TIMER: AINDA NÃO PASSOU O TEMPO! Continue trabalhando, testando e interagindo no chat, e confira `/tmp/au_timer check` novamente!")
        return False
    print(f"✅ [HORÁRIO REAL: {fmt_clock(now)}] Decorrido: {fmt_dur(elapsed)} / {fmt_dur(target)} | Checagem #{st['checks']} | CAN_FINISH=YES")
    print("🟢 TIMER REAL CUMPRIDO! Você já cumpriu o tempo mínimo obrigatório desta sessão.")
    return True
cmd = (sys.argv[1] if len(sys.argv) > 1 else "check").lower()
if cmd in ("start", "init"):
    mins = float(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MIN
    start_or_reset(mins, False); do_check()
elif cmd == "reset":
    mins = float(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MIN
    start_or_reset(mins, False); do_check()
elif cmd in ("pulse", "cycle", "wait"):
    w_sec = min(22, max(3, int(float(sys.argv[2])) if len(sys.argv) > 2 else 18))
    chat_bin = "/tmp/au_chat" if os.path.exists("/tmp/au_chat") else "/home/user/au_state/au_chat"
    if os.path.exists(chat_bin):
        subprocess.run(["python3", chat_bin, "wait", str(w_sec)], check=False)
    else:
        time.sleep(w_sec)
    do_check()
else:
    do_check()
