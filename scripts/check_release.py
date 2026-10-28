#!/usr/bin/env python3
"""Check bundled release, extension pin and source parity without dependencies."""
from pathlib import Path
import hashlib, json, re, zipfile
ROOT=Path(__file__).resolve().parents[1]
kit=ROOT/'agent-kit'
source=(ROOT/'extension/shared/agent-kit.js').read_text()
version=re.search(r"const VERSION = '([^']+)'",source)[1]
expected=re.search(r"const SHA256 = '([a-f0-9]{64})'",source)[1]
archive=kit/'releases'/f'arena-ultra-agent-{version}.pyz'
actual=hashlib.sha256(archive.read_bytes()).hexdigest()
assert actual==expected,'Extension pin differs from release: do not publish mismatched files'
assert expected in (kit/'releases/SHA256SUMS').read_text()
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    manifest=json.loads(z.read('FILES.json'))
    for name,digest in manifest.items():
        rel=Path(name)
        assert not rel.is_absolute() and '..' not in rel.parts
        data=z.read(name)
        assert hashlib.sha256(data).hexdigest()==digest, f'Corrupt member: {name}'
        assert (kit/rel).read_bytes()==data, f'Source changed after release: {name}; bump version/rebuild and repin explicitly'
manifest=json.loads((ROOT/'extension/manifest.json').read_text())
for cs in manifest['content_scripts']:
    for ref in cs.get('js',[]): assert (ROOT/'extension'/ref).is_file(),ref
print(f'OK: extension {manifest["version"]}, Agent Kit {version}, SHA256 {actual}, source parity and archive CRC verified')
