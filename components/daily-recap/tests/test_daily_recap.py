from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tree_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


class IsolatedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="daily-recap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.source = self.root / "review source"
        self.source.mkdir()
        for path in SOURCE.iterdir():
            if path.is_file():
                shutil.copyfile(path, self.source / path.name)
        self.runtime = self.root / "runtime 'quotes & spaces'"
        self.plist = self.root / "LaunchAgents" / "recap & daily.plist"
        self.environment = {
            "HOME": str(self.home), "PATH": os.environ["PATH"],
            "PYTHONDONTWRITEBYTECODE": "1", "TZ": "UTC",
        }
        self.environment_patch = patch.dict(os.environ, self.environment, clear=True)
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)

    def command(self, args, **kwargs):
        return subprocess.run(args, cwd=self.root, env=dict(os.environ), text=True, capture_output=True, timeout=20, **kwargs)

    def install(self, *extra):
        return self.command([
            sys.executable, str(self.source / "install.py"),
            "--runtime", str(self.runtime), "--plist", str(self.plist), *extra,
        ])

    def stage(self):
        result = self.install("--write")
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.runtime

    def recap(self):
        return load_module(self.runtime / "bin/daily_recap.py", "recap_fixture")

    def deny_commands(self):
        directory = self.root / "deny-bin"
        directory.mkdir()
        record = self.root / "unexpected-command"
        for name in ("git", "prime-agent", "security", "curl", "sleep", "launchctl", "tmux", "npm"):
            path = directory / name
            path.write_text(f"#!/bin/bash\nprintf '%s\\n' {name} >> '{record}'\nexit 91\n")
            path.chmod(0o755)
        os.environ["PATH"] = str(directory) + ":" + os.environ["PATH"]
        return record

    def test_installer_preview_writes_nothing_and_does_not_run_commands(self):
        record = self.deny_commands()
        before = tree_bytes(self.root)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["mode"], "dry-run")
        self.assertEqual(plan["schedule"], {"hour": 21, "minute": 0, "timezone": "system local time"})
        self.assertFalse(plan["services_loaded"])
        self.assertFalse(plan["dependencies_installed"])
        self.assertEqual(before, tree_bytes(self.root))
        self.assertFalse(record.exists())

    def test_write_preserves_private_bytes_and_modes_and_stages_local_dependencies(self):
        record = self.deny_commands()
        self.runtime.mkdir()
        private = {
            "config.env": b"# fixture private config\nSENTINEL='not executed'\n\xff",
            "state/last_run.json": b'{"date":"2030-01-02"}\n',
            "reports/report.md": b"private report\n", "logs/old.log": b"private log\n",
            "bin/unslop.md": b"private writing rules\n", "node_modules/existing.txt": b"keep me\n",
        }
        for rel, data in private.items():
            path = self.runtime / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o640)
        result = self.install("--write", "--hour", "22", "--minute", "7")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["config"], "preserved without reading")
        for rel, data in private.items():
            self.assertEqual((self.runtime / rel).read_bytes(), data)
            self.assertEqual((self.runtime / rel).stat().st_mode & 0o777, 0o640)
        for name in ("daily_recap.py", "drifty_focus_export.py", "sunsama_fetch.mjs", "run.sh", "launchd_entry.sh"):
            self.assertEqual((self.runtime / "bin" / name).read_bytes(), (self.source / name).read_bytes())
        self.assertEqual((self.runtime / "package-lock.json").read_bytes(), (SOURCE / "package-lock.json").read_bytes())
        plist = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(plist["ProgramArguments"], ["/bin/bash", str(self.runtime / "bin/launchd_entry.sh")])
        self.assertEqual(plist["StartCalendarInterval"], {"Hour": 22, "Minute": 7})
        self.assertFalse(plist["RunAtLoad"])
        self.assertFalse(record.exists())

    def test_installer_rejects_arguments_and_reports_write_failures(self):
        for arguments in (("--hour", "24"), ("--minute", "-1"), ("--hour",), ("--unknown",)):
            result = self.install(*arguments)
            self.assertEqual(result.returncode, 2, (arguments, result.stderr))
        self.runtime.write_text("this is a file")
        result = self.install("--write")
        self.assertEqual(result.returncode, 1)
        self.assertIn("daily-recap install failed", result.stderr)
        self.assertFalse(self.plist.exists())

    def test_installer_rejects_source_documents_symlinks_and_private_plist_targets(self):
        for path in (self.source, self.home / "Documents/runtime"):
            result = self.install("--runtime", str(path), "--write")
            self.assertEqual(result.returncode, 1, result.stdout)
        self.runtime.symlink_to(self.home, target_is_directory=True)
        result = self.install("--write")
        self.assertEqual(result.returncode, 1)
        self.runtime.unlink()
        result = self.install("--plist", str(self.runtime / "state/last_run.json"), "--write")
        self.assertEqual(result.returncode, 1)

    def test_real_source_help_and_parsers_do_not_read_services(self):
        record = self.deny_commands()
        commands = [
            [sys.executable, str(SOURCE / "daily_recap.py"), "--help"],
            [sys.executable, str(SOURCE / "drifty_focus_export.py"), "--help"],
            ["/bin/bash", str(SOURCE / "run.sh"), "--help"],
            ["/bin/bash", str(SOURCE / "launchd_entry.sh"), "--help"],
            ["/bin/bash", str(SOURCE / "install_daily_recap_agent.sh"), "--help"],
            [NODE, str(SOURCE / "sunsama_fetch.mjs"), "--help"],
        ]
        for command in commands:
            result = self.command(command)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("usage:", result.stdout.lower())
        result = self.command([sys.executable, str(SOURCE / "daily_recap.py"), "--today", "invalid"])
        self.assertEqual(result.returncode, 2)
        result = self.command([sys.executable, str(SOURCE / "drifty_focus_export.py")])
        self.assertEqual(result.returncode, 2)
        self.assertIn("--db", result.stderr)
        for extra in ([], ["--invalid"]):
            result = self.command([NODE, str(SOURCE / "sunsama_fetch.mjs"), *extra])
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("ERR_MODULE_NOT_FOUND", result.stderr)
        self.assertFalse(record.exists())

    def test_generated_runtime_without_source_is_disabled_and_preview_preserves_all_files(self):
        self.stage()
        shutil.rmtree(self.source)
        record = self.deny_commands()
        before = tree_bytes(self.runtime)
        result = self.command(["/bin/bash", str(self.runtime / "bin/run.sh"), "--force"])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Posting disabled", result.stderr)
        for _ in range(2):
            result = self.command(["/bin/bash", str(self.runtime / "bin/run.sh"), "--dry-run", "--today", "2030-01-02"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Product not configured", result.stdout)
            self.assertIn("Sunsama not configured", result.stdout)
        self.assertEqual(before, tree_bytes(self.runtime))
        self.assertFalse(record.exists())

    def test_preview_uses_state_copies_and_never_posts(self):
        self.stage()
        module = self.recap()
        module.RUNTIME = self.runtime
        module.STATE, module.REPORTS = self.runtime / "state", self.runtime / "reports"
        (module.STATE / "features.json").write_text('{"features":[{"name":"fixture"}]}')
        (module.STATE / "last_run.json").write_text('{"at":"2030-01-01T21:00:00+00:00"}')
        before = tree_bytes(self.runtime)
        original_state, original_reports = module.STATE, module.REPORTS
        def section(*args):
            self.assertNotEqual(module.STATE, original_state)
            self.assertTrue((module.STATE / "features.json").is_file())
            (module.STATE / "features.json").write_text("modified only in preview")
            return module.SectionResult("Fixture")
        with patch.object(module, "section_product", section), patch.object(module, "section_personal", section), patch.object(module, "section_sunsama", section), patch.object(module, "slack_post_thread", side_effect=AssertionError("no Slack")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(["--dry-run", "--today", "2030-01-02"]), 0)
        self.assertEqual((module.STATE, module.REPORTS), (original_state, original_reports))
        self.assertEqual(before, tree_bytes(self.runtime))

    def test_sections_and_slack_failures_are_reported_without_advancing_post_marker(self):
        self.stage()
        module = self.recap()
        module.RUNTIME = self.runtime
        module.STATE, module.REPORTS = self.runtime / "state", self.runtime / "reports"
        marker = module.STATE / "last_run.json"
        marker.write_bytes(b'{"date":"2029-01-01"}\n')
        os.environ["SLACK_BOT_TOKEN"] = "fixture-token"
        section = module.SectionResult("Personal")
        section.summary = "Tokens present"
        section.error = "fixture Drifty failure"
        self.assertIn("fixture Drifty failure", section.summary_text())
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(module, "section_product", side_effect=RuntimeError("fixture git failure")), patch.object(module, "section_personal", return_value=section), patch.object(module, "section_sunsama", return_value=module.SectionResult("Sunsama")), patch.object(module, "slack_post_thread", side_effect=RuntimeError("fixture Slack unavailable")) as post, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(module.main(["--force", "--today", "2030-01-02", "--channel", "fixture-channel"]), 1)
        self.assertIn("fixture Slack unavailable", stderr.getvalue())
        self.assertIn("fixture git failure", post.call_args.args[3])
        self.assertIn("fixture Drifty failure", post.call_args.args[3])
        self.assertEqual(marker.read_bytes(), b'{"date":"2029-01-01"}\n')

    def test_midnight_posting_window_and_duplicate_rules(self):
        self.stage()
        module = self.recap()
        module.STATE, module.REPORTS = self.runtime / "state", self.runtime / "reports"
        os.environ["SLACK_BOT_TOKEN"] = "fixture-token"
        result = module.SectionResult("Fixture")
        with patch.object(module, "now_local", return_value=dt.datetime(2030, 1, 3, 1, 0, tzinfo=dt.timezone.utc)), patch.object(module, "section_product", return_value=result), patch.object(module, "section_personal", return_value=result) as personal, patch.object(module, "section_sunsama", return_value=result), patch.object(module, "slack_post_thread", return_value={"ts":"1","channel":"fixture","replies":[]}) as post, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(["--channel", "fixture"]), 0)
            self.assertEqual(personal.call_args.args[0], dt.date(2030, 1, 2))
            self.assertEqual(module.main(["--channel", "fixture"]), 0)
            self.assertEqual(post.call_count, 1)
        with patch.object(module, "now_local", return_value=dt.datetime(2030, 1, 3, 12, 0, tzinfo=dt.timezone.utc)), patch.object(module, "section_product", side_effect=AssertionError("must skip daytime")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(module.main(["--channel", "fixture"]), 0)
            self.assertIn("outside the posting window", output.getvalue())

    def test_shell_arguments_tmux_dispatch_and_direct_failure(self):
        self.stage()
        directory = self.root / "stubs"
        directory.mkdir()
        captured = self.root / "captured.json"
        run = self.runtime / "bin/run.sh"
        run.write_text("#!/bin/bash\nexec \"$TEST_PYTHON\" \"$TEST_CAPTURE_SCRIPT\" \"$@\"\n")
        capture = self.root / "capture.py"
        capture.write_text("import json, os, sys\nfrom pathlib import Path\nPath(os.environ['TEST_CAPTURE']).write_text(json.dumps(sys.argv[1:]))\nsys.exit(int(os.environ.get('TEST_EXIT', '0')))\n")
        tmux = directory / "tmux"
        tmux.write_text('''#!/bin/bash
case "$1" in
  list-sessions) exit "${TEST_SERVER:-0}" ;;
  new-session)
    if [[ "${TEST_NEW_FAIL:-0}" == 1 ]]; then exit 9; fi
    exec /bin/bash -c "${!#}"
    ;;
  *) exit 90 ;;
esac
''')
        tmux.chmod(0o755)
        os.environ.update(PATH=str(directory) + ":" + os.environ["PATH"], TEST_PYTHON=sys.executable, TEST_CAPTURE_SCRIPT=str(capture), TEST_CAPTURE=str(captured))
        args = ["--channel", "spaces ' quote \" $HOME; $(touch BAD)", "", "new\nline", "*", "--since", "2030-01-01T21:00:00+00:00"]
        result = self.command(["/bin/bash", str(self.runtime / "bin/launchd_entry.sh"), *args])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(captured.read_text()), args)
        self.assertFalse((self.runtime / "BAD").exists())
        for env in ({"TEST_SERVER":"1"}, {"TEST_SERVER":"0", "TEST_NEW_FAIL":"1"}):
            os.environ.update(env, TEST_EXIT="17")
            result = self.command(["/bin/bash", str(self.runtime / "bin/launchd_entry.sh"), *args])
            self.assertEqual(result.returncode, 17, result.stderr)
            self.assertEqual(json.loads(captured.read_text()), ["--no-repo", *args])

    def test_run_wrapper_reports_config_and_child_failure(self):
        self.stage()
        config = self.runtime / "config.env"
        config.write_text("return 23\n")
        result = self.command(["/bin/bash", str(self.runtime / "bin/run.sh"), "--dry-run"])
        self.assertEqual(result.returncode, 23)
        self.assertIn("daily-recap failed (exit 23)", result.stderr)
        config.write_text("SLACK_BOT_TOKEN=''\nSLACK_CHANNEL=''\n")
        child = self.runtime / "bin/daily_recap.py"
        child.write_text("import sys\nprint('fixture Python failure', file=sys.stderr)\nsys.exit(19)\n")
        result = self.command(["/bin/bash", str(self.runtime / "bin/run.sh"), "--dry-run"])
        self.assertEqual(result.returncode, 19)
        self.assertIn("daily-recap exit 19", result.stdout)
        self.assertIn("fixture Python failure", result.stderr)

    def test_drifty_real_fixture_database_with_special_path(self):
        self.stage()
        module = load_module(self.runtime / "bin/drifty_focus_export.py", "drifty_fixture")
        db = self.root / "fixture ? # tracker.sqlite3"
        with contextlib.closing(sqlite3.connect(db)) as connection, connection:
            connection.execute("create table activity_segments (id integer, started_at text, ended_at text, duration_seconds integer, app_name text, site_domain text)")
            connection.execute("create table activity_classifications (segment_id integer, category text, productivity text, stale integer)")
            connection.execute("insert into activity_segments values (1, '2030-01-02T12:00:00Z', '2030-01-02T13:00:00Z', 3600, 'Fixture Editor', null)")
            connection.execute("insert into activity_classifications values (1, 'workspace', 'focus', 0)")
        before = db.read_bytes()
        snapshot = module.build_snapshot(db, "fixture-user", "UTC", today=dt.date(2030, 1, 2))
        self.assertEqual(snapshot["today"]["focusSeconds"], 3600)
        self.assertEqual(snapshot["slug"], "fixture-user")
        self.assertEqual(db.read_bytes(), before)

    def test_real_node_package_resolves_from_runtime_after_source_removed(self):
        self.stage()
        dependencies = SOURCE / "node_modules"
        self.assertTrue((dependencies / "sunsama-api").is_dir(), "Run npm ci --ignore-scripts in components/daily-recap before tests")
        shutil.copytree(dependencies, self.runtime / "node_modules")
        shutil.rmtree(self.source)
        probe = self.runtime / "bin/dependency-probe.mjs"
        probe.write_text("globalThis.fetch = () => { throw new Error('network denied'); };\nconst { SunsamaClient } = await import('sunsama-api');\nconst { DatabaseSync } = await import('node:sqlite');\nif (typeof SunsamaClient !== 'function' || typeof DatabaseSync !== 'function') process.exit(1);\nconsole.log(import.meta.resolve('sunsama-api'));\n")
        result = self.command([NODE, str(probe)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.runtime).replace(" ", "%20"), result.stdout)
        self.assertNotIn(str(SOURCE), result.stdout)


    def test_full_sunsama_helper_with_local_cookie_and_stub_client(self):
        self.stage()
        shutil.rmtree(self.source)
        db = self.root / "fixture Cookies"
        with contextlib.closing(sqlite3.connect(db)) as connection, connection:
            connection.execute("create table cookies (name text, host_key text, value text, encrypted_value blob, expires_utc integer)")
            connection.execute("insert into cookies values (?, ?, ?, ?, ?)", ("sunsamaSession", ".sunsama.com", "fixture-session", b"", 20000000000000000))
        before = db.read_bytes()
        client = self.root / "fixture-client.mjs"
        client.write_text("""
export class SunsamaClient {
  constructor({ sessionToken }) { if (sessionToken !== 'fixture-session') throw new Error('wrong fixture cookie'); }
  async getUser() { return { primaryGroup: { groupId: 'fixture-group' }, profile: { firstname: 'Fixture' } }; }
  async getStreamsByGroupId() { return [{ _id: 'stream', streamName: 'Fixture stream' }]; }
  async getTasksByDay(day, tz) {
    if (tz !== 'UTC') throw new Error('wrong timezone');
    return [{ _id: day, text: 'Fixture task', completed: true, streamIds: ['stream'], actualTime: [{ duration: 120 }], timeEstimate: 3 }];
  }
  async graphqlRequest() { return { data: { objectivesByPeriod: [{ _id: 'objective', text: 'Fixture objective', completed: false, streamId: 'stream', taskIds: [] }] } }; }
  async getTasksBacklog() { return [{ _id: 'backlog' }]; }
}
""")
        loader = self.root / "fixture-loader.mjs"
        loader.write_text("export async function resolve(specifier, context, nextResolve) {\nif (specifier === 'sunsama-api') return {url: " + json.dumps(client.as_uri()) + ", shortCircuit: true};\nreturn nextResolve(specifier, context);\n}\n")
        deny = self.root / "deny-network.mjs"
        deny.write_text("""
import net from 'node:net';
import tls from 'node:tls';
const deny = () => { throw new Error('external network denied in fixture'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
""")
        os.environ.update(SUNSAMA_COOKIE_DB=str(db), SUNSAMA_TZ="UTC", SUNSAMA_TODAY="2030-01-02")
        command = [NODE, "--import", str(deny), "--experimental-loader", str(loader), str(self.runtime / "bin/sunsama_fetch.mjs")]
        result = self.command(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["today"]["date"], "2030-01-02")
        self.assertEqual(len(data["week"]["days"]), 7)
        self.assertEqual(data["today"]["tasks"][0]["actualMinutes"], 2)
        self.assertEqual(data["objectives"][0]["streamName"], "Fixture stream")
        self.assertEqual(db.read_bytes(), before)
        with contextlib.closing(sqlite3.connect(db)) as connection, connection:
            connection.execute("update cookies set expires_utc = 1")
        result = self.command(command)
        self.assertEqual(result.returncode, 1)
        self.assertIn("sunsamaSession expired", result.stderr)

    def test_commit_parser_and_model_command_with_denied_real_processes(self):
        self.stage()
        module = self.recap()
        module.RUNTIME = self.runtime
        raw = "\x1eabc1234\x1fabc1234full\x1fFixture Author\x1f2030-01-02T12:00:00+00:00\x1fFixture change\x1fFixture body\x1f\n2\t1\tapps/fixture/a.py\n-\t-\timage.png\n"
        since = dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc)
        until = dt.datetime(2030, 1, 2, tzinfo=dt.timezone.utc)
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, raw, "")) as run:
            commits = module.collect_commits(self.root, since, until)
            self.assertEqual(run.call_args.args[0][0:2], ["git", "log"])
        self.assertEqual(commits[0]["files"][0], {"path":"apps/fixture/a.py", "added":2, "deleted":1})
        self.assertEqual(commits[0]["body"], "Fixture body")
        self.assertEqual(module.parse_json_object('```json\n{"features": []}\n```'), {"features":[]})
        context = self.root / "context with spaces.md"
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"features":[]}', "")) as run:
            module.run_llm(context, "fixture instruction")
            command = run.call_args.args[0]
            self.assertEqual(command[0:2], ["prime-agent", "-p"])
            self.assertIn("-nt", command)
            self.assertIn("--offline", command)
            self.assertIn("@" + str(context), command)
            self.assertEqual(run.call_args.kwargs["cwd"], str(self.runtime))
        with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 12, "", "fixture model denied")):
            with self.assertRaisesRegex(RuntimeError, "exit 12: fixture model denied"):
                module.run_llm(context, "fixture instruction")

    def test_network_retry_failure_is_reported_without_model_or_real_waits(self):
        self.stage()
        stubs = self.root / "retry-stubs"
        stubs.mkdir()
        for name, code in (("curl", "exit 7"), ("sleep", "exit 0")):
            path = stubs / name
            path.write_text("#!/bin/bash\n" + code + "\n")
            path.chmod(0o755)
        (self.runtime / "config.env").write_text("SLACK_BOT_TOKEN=fixture\nSLACK_CHANNEL=fixture\n")
        os.environ["PATH"] = str(stubs) + ":" + os.environ["PATH"]
        result = self.command(["/bin/bash", str(self.runtime / "bin/run.sh")])
        self.assertEqual(result.returncode, 1)
        self.assertIn("failed after 30 attempts", result.stderr)
        self.assertEqual(result.stderr.count("waiting 30s"), 30)

if __name__ == "__main__":
    unittest.main()
