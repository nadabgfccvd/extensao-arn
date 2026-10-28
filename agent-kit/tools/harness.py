#!/usr/bin/env python3
"""Arena Ultra harness. Local evidence is observed here, not remotely attested."""
import sys, os, json, time, hashlib, subprocess, tempfile, fcntl
from pathlib import Path

def main():
    scope = os.environ.get('AU_HARNESS_SCOPE', 'solo')
    if not scope or len(scope) > 100 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in scope):
        raise ValueError('Invalid scope')
    root = Path(os.environ.get('AU_STATE_DIR', '/home/user/au_state')) / 'harness' / scope
    root.mkdir(parents=True, exist_ok=True)
    config_file = root / 'config.json'
    if not config_file.exists():
        raise ValueError('Install the scoped harness first')
    cfg = json.loads(config_file.read_text())
    state_file = root / 'checkpoint.json'
    args = sys.argv[1:]; cmd = args.pop(0) if args else 'status'
    # Serialize commands in this workspace. Never pretend this lock spans sandboxes.
    with open(root / 'state.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = json.loads(state_file.read_text()) if state_file.exists() else {
            'revision': 1, 'tasks': {}, 'next': '', 'blocker': '', 'tests': [], 'reviews': []}
        if cmd == 'bind':
            epoch = int(args[0])
            if epoch < 1 or epoch > 1000000000: raise ValueError('Invalid epoch')
            if epoch != cfg['epoch']:
                cfg['epoch'] = epoch
                config_file.write_text(json.dumps(cfg))
                st['revision'] += 1; st['tests'] = []; st['reviews'] = []
                for item in st['tasks'].values(): item['status'] = 'pending'
        elif cmd == 'task':
            key, description = args[0], ' '.join(args[1:])
            if not key or len(key) > 60: raise ValueError('Task id required, <=60 chars')
            if key not in st['tasks'] and len(st['tasks']) >= 20: raise ValueError('Task limit reached')
            st['tasks'][key] = {'description': description[:600], 'status': 'pending'}
            st['revision'] += 1; st['tests'] = []
        elif cmd == 'checkpoint':
            st['next'] = ' '.join(args)[:600]
            st['revision'] += 1; st['tests'] = []
        elif cmd == 'blocker':
            st['blocker'] = ' '.join(args)[:400]
        elif cmd == 'verify':
            # argv only: no shell interpolation; stdout goes to a temporary file, not prompts.
            key = args.pop(0)
            if args and args[0] == '--': args.pop(0)
            if key not in st['tasks'] or not args: raise ValueError('verify TASK -- command args')
            started = time.time()
            with tempfile.TemporaryFile() as log:
                try:
                    result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=120, check=False)
                    code = result.returncode
                except subprocess.TimeoutExpired: code = 124
                except OSError: code = 127
                log.seek(0); digest = hashlib.sha256()
                while True:
                    data = log.read(65536)
                    if not data: break
                    digest.update(data)
            evidence = {'task': key, 'exitCode': code, 'revision': st['revision'],
                        'digest': digest.hexdigest(), 'at': int(time.time()*1000),
                        'durationMs': int((time.time()-started)*1000)}
            st['tests'] = [t for t in st['tests'] if t['task'] != key] + [evidence]
            st['tests'] = st['tests'][-100:]
            st['tasks'][key]['status'] = 'passed' if code == 0 else 'failed'
            print('Verification exit code:', code, '| output SHA256:', evidence['digest'])
        elif cmd == 'review':
            target, revision, decision = args[:3]
            if target == cfg['slot'] or decision not in ('accept', 'reject'):
                raise ValueError('Independent reviewer required: review agN REV accept|reject')
            st['reviews'] = [v for v in st['reviews'] if v['target'] != target] + [
                {'target': target, 'revision': int(revision), 'decision': decision}]
            st['reviews'] = st['reviews'][-60:]
        elif cmd not in ('status', 'resume', 'report'):
            raise ValueError('Commands: task, checkpoint, blocker, verify, review, status, resume, report')
        st['updatedAt'] = int(time.time()*1000)
        fd, temporary = tempfile.mkstemp(dir=root, prefix='checkpoint-')
        with os.fdopen(fd, 'w') as f:
            json.dump(st, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, state_file)
        if cmd == 'report':
            evidence = [t for t in st['tests'] if t['revision'] == st['revision']]
            complete = bool(st['tasks']) and all(v['status'] == 'passed' for v in st['tasks'].values()) and len({t['task'] for t in evidence if t['exitCode'] == 0}) >= len(st['tasks'])
            # Bound summaries; no tokens, command lines, stdout, or environment values in report.
            report = {**cfg, 'revision': st['revision'], 'complete': complete,
                      'evidence': evidence[-20:], 'reviews': st['reviews'][-60:],
                      'blocker': bool(st['blocker']), 'taskCount': len(st['tasks'])}
            print('[HARNESS_REPORT]' + json.dumps(report, separators=(',', ':')) + '[/HARNESS_REPORT]')
        else:
            print(json.dumps(st, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try: main()
    except (ValueError, IndexError, KeyError, json.JSONDecodeError) as exc:
        print('Harness error:', str(exc), file=sys.stderr); sys.exit(2)
