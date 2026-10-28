import ast, base64, importlib.util, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('kit',ROOT/'__main__.py');kit=importlib.util.module_from_spec(spec);spec.loader.exec_module(kit)

class KitTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.home=Path(self.tmp.name);(self.home/'repo').mkdir()
        self.env={**os.environ,'AU_AGENT_HOME':str(self.home)}
        self.cfg={'protocol':1,'roomId':'testkit','agentIndex':2,'epoch':1,'profile':'specialists','timerMinutes':60,
                  'agentName':'Agent Name [QA]','roleTitle':'Reviewer','filebinId':'','roomHmacKey':'','projectPath':str(self.home/'repo')}
        self.install()
    def tearDown(self): self.tmp.cleanup()
    def run_cli(self,*args,check=True):
        return subprocess.run([sys.executable,str(ROOT/'__main__.py'),*args],env=self.env,text=True,capture_output=True,check=check)
    def install(self,cfg=None):
        return self.run_cli('install','--session-b64',base64.b64encode(json.dumps(cfg or self.cfg).encode()).decode())
    def test_discovery_and_redacted_doctor(self):
        out=self.run_cli('doctor').stdout
        self.assertIn('[AU_AGENT_READY]',out);self.assertNotIn('roomHmacKey',out)
        self.assertIn('Time',self.run_cli('guide','start').stdout.replace('time','Time'))
        self.assertNotEqual(self.run_cli('guide','../../secret',check=False).returncode,0)
    def test_session_unknown_tokens_fail_closed(self):
        bad={**self.cfg,'githubToken':'ghp_SENTINEL_MUST_NOT_LOG'}
        out=self.run_cli('install','--session-b64',base64.b64encode(json.dumps(bad).encode()).decode(),check=False)
        self.assertEqual(out.returncode,2);self.assertNotIn('ghp_',out.stdout+out.stderr)
    def test_protocol_and_paths(self):
        for cfg in [{**self.cfg,'protocol':2},{**self.cfg,'roomId':'../../bad'},{**self.cfg,'projectPath':'/etc'}]:
            data=base64.b64encode(json.dumps(cfg).encode()).decode()
            self.assertNotEqual(self.run_cli('install','--session-b64',data,check=False).returncode,0)
    def test_fingerprint_invalidates_actual_evidence(self):
        (self.home/'repo'/'code.txt').write_text('version 1')
        self.run_cli('harness','task','core','real acceptance')
        self.run_cli('verify','core','--',sys.executable,'-c','assert 2+2 == 4')
        report=self.run_cli('report').stdout
        obj=json.loads(report.split('[HARNESS_REPORT]')[1].split('[/HARNESS_REPORT]')[0])
        self.assertTrue(obj['complete'])
        (self.home/'repo'/'code.txt').write_text('version 2')
        report=self.run_cli('report').stdout
        obj=json.loads(report.split('[HARNESS_REPORT]')[1].split('[/HARNESS_REPORT]')[0])
        self.assertFalse(obj['complete']);self.assertEqual(obj['evidence'],[])
    def test_epoch_reinstall_invalidates_but_keeps_plan(self):
        self.run_cli('harness','task','core','acceptance');self.run_cli('verify','core','--',sys.executable,'-c','pass')
        self.install({**self.cfg,'epoch':2})
        state=json.loads(self.run_cli('harness','resume').stdout)
        self.assertIn('core',state['tasks']);self.assertEqual(state['tests'],[])
        self.assertEqual(state['tasks']['core']['status'],'pending')
    def test_boundaries_and_legacy_wrappers(self):
        tool=self.home/'au_state'/'agent-tools'/'testkit_ag2'/'chat.py'
        self.assertIn("MY_HANDLE = '@Agente2'",tool.read_text())
        self.assertEqual(self.run_cli('chat','inbox',check=False).returncode,2)
        blocked=subprocess.run([str(self.home/'au_state'/'au_upload'),'no-file'],capture_output=True)
        self.assertEqual(blocked.returncode,3)
        self.assertEqual((self.home/'au_state'/'agent-session.json').stat().st_mode & 0o777,0o600)
        tick=self.run_cli('tick').stdout
        self.assertIn('CAN_FINISH=NO',tick);self.assertLess(len(tick),4000)
        inbox=self.home/'au_state'/'agent-inbox'/'testkit_ag2.json';inbox.parent.mkdir(parents=True,exist_ok=True)
        inbox.write_text(json.dumps('a'*3000+'IMPORTANT_MENTION'))
        self.assertNotIn('IMPORTANT_MENTION',self.run_cli('inbox','0').stdout)
        self.assertIn('IMPORTANT_MENTION',self.run_cli('inbox','2400').stdout)
        self.run_cli('inbox','ack');self.assertEqual(json.loads(inbox.read_text()),'')
    def test_signed_transport_and_named_mentions(self):
        source=(ROOT/'tools'/'chat.py').read_text(); tree=ast.parse(source)
        nodes=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.Assign,ast.FunctionDef))]
        namespace={};exec(compile(ast.Module(body=nodes,type_ignores=[]),'chat-functions','exec'),namespace)
        msg={'roomId':'AU_KIT_ROOM','id':'m1','tag':'ag2','ts':123,'text':'@[AU_KIT_NAME] confirme'}
        msg['hmacSig']=namespace['sign_payload'](msg['roomId'],msg['id'],msg['tag'],msg['ts'],msg['text'])
        self.assertTrue(namespace['verify_payload'](msg))
        self.assertFalse(namespace['verify_payload']({**msg,'text':'tampered'}))
        self.assertFalse(namespace['verify_payload']({**msg,'hmacSig':''}))
        self.assertTrue(namespace['mentions_me'](msg['text']))
        self.assertIn('if not m["_verified"]:',source)

    def test_rebind_updates_ready(self):
        self.run_cli('harness','bind','7')
        self.assertIn('"epoch": 7',self.run_cli('doctor').stdout)

if __name__=='__main__': unittest.main()
