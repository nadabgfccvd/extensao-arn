#!/usr/bin/env bash
f="$1"; name="$(basename "$f")"; url=""
if curl -fsS -m 20 -X POST -H "User-Agent: curl/8.5.0" -H "Content-Type: application/octet-stream" -H "cid: au" --data-binary @"$f" "https://filebin.net/AU_KIT_BIN/$name" >/dev/null 2>&1; then
  echo "[ARQUIVO_COMPARTILHADO] $name | Filebin.net | https://filebin.net/AU_KIT_BIN/$name [/ARQUIVO_COMPARTILHADO]"; exit 0; fi
url=$(curl -fsS -m 25 -F "reqtype=fileupload" -F "time=24h" -F "fileToUpload=@$f" https://litterbox.catbox.moe/resources/internals/api.php 2>/dev/null || true)
if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | Litterbox | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi
url=$(curl -fsS -m 25 -F "files[]=@$f" https://uguu.se/upload 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['files'][0]['url'])" 2>/dev/null || true)
if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | Uguu.se | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi
url=$(curl -fsS -m 25 -F "file=@$f" https://x0.at/ 2>/dev/null | tr -d "\r\n" || true)
if [[ "$url" == http* ]]; then echo "[ARQUIVO_COMPARTILHADO] $name | x0.at | $url [/ARQUIVO_COMPARTILHADO]"; exit 0; fi
