"""Client wire-format tests, against a stub bridge.

The real bridge is the app; these prove the CLIENT keeps its side of
the contract: the module connects by itself, the token header travels,
refusals raise with the app's own wording, and commands are shaped the
way the reducers expect. Functional surface throughout: the module is
the session, no client objects.
"""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import heeler


class Stub(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Stub.seen.append({"headers": dict(self.headers), "body": body})
        method = body.get("method")
        if self.headers.get("X-Heeler-Token") != "tok":
            out = {"ok": False, "error": "bad token"}
        elif method == "app.ping":
            out = {"ok": True, "data": {"heeler": 1}}
        elif method == "graph.command":
            cmd = body["params"]["command"]
            if cmd["type"] == "not_scriptable":
                out = {"ok": False, "error": 'command "not_scriptable" is not scriptable'}
            else:
                out = {"ok": True, "data": {"dispatched": cmd["type"]}}
        elif method == "hotkeys.export":
            out = {"ok": True, "data": {"json": '{"version": 1, "hotkeys": {}}'}}
        else:
            out = {"ok": True, "data": {}}
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ClientContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Stub)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        heeler.disconnect_bridge()
        heeler.connect(self.port, "tok")

    def test_http_refusals_keep_the_apps_explanation(self):
        import io
        from unittest.mock import patch
        from urllib.error import HTTPError
        for code, reason in [(400, "malformed JSON: expected value"), (413, "request body exceeds 8388608 bytes"), (408, "request read deadline exceeded"), (403, "bad token")]:
            with self.subTest(code=code):
                response = HTTPError("http://127.0.0.1", code, "refused", {}, io.BytesIO(json.dumps({"ok": False, "error": reason}).encode()))
                with patch("urllib.request.urlopen", side_effect=response):
                    with self.assertRaisesRegex(heeler.HeelerError, reason):
                        heeler.rpc("app.ping")

    def test_non_json_http_refusal_still_names_the_status(self):
        import io
        from unittest.mock import patch
        from urllib.error import HTTPError
        for body in [b"not json", b"[]", b"null", b'{"error":23}']:
            response = HTTPError("http://127.0.0.1", 503, "refused", {}, io.BytesIO(body))
            with patch("urllib.request.urlopen", side_effect=response):
                with self.assertRaisesRegex(heeler.HeelerError, "HTTP 503"):
                    heeler.rpc("app.ping")

    def test_http_error_body_read_is_bounded(self):
        import io
        from unittest.mock import patch
        from urllib.error import HTTPError
        body = io.BytesIO(b"a" * 20000)
        response = HTTPError("http://127.0.0.1", 431, "refused", {}, body)
        with patch.object(response, "read", wraps=response.read) as read:
            with patch("urllib.request.urlopen", side_effect=response):
                with self.assertRaisesRegex(heeler.HeelerError, "HTTP 431"):
                    heeler.rpc("app.ping")
            read.assert_called_once_with(16384)

    def test_the_module_is_the_session(self):
        # No objects anywhere: module functions straight through.
        self.assertEqual(heeler.ping(), {"heeler": 1})
        self.assertEqual(Stub.seen[-1]["headers"]["X-Heeler-Token"], "tok")

    def test_the_environment_connects_without_any_call(self):
        # The console and batch mode set these; a script's first call
        # must connect on its own.
        import os

        heeler.disconnect_bridge()
        os.environ["HEELER_API_PORT"] = str(self.port)
        os.environ["HEELER_API_TOKEN"] = "tok"
        try:
            self.assertEqual(heeler.ping(), {"heeler": 1})
        finally:
            del os.environ["HEELER_API_PORT"]
            del os.environ["HEELER_API_TOKEN"]
            heeler.disconnect_bridge()

    def test_connect_still_answers_like_the_old_client(self):
        # `h = heeler.connect()` from earlier scripts keeps working:
        # connect returns the module itself.
        h = heeler.connect(self.port, "tok")
        self.assertEqual(h.ping(), {"heeler": 1})

    def test_refusals_raise_with_the_apps_wording(self):
        heeler.connect(self.port, "wrong")
        with self.assertRaises(heeler.HeelerError) as ctx:
            heeler.ping()
        self.assertIn("bad token", str(ctx.exception))
        heeler.connect(self.port, "tok")
        with self.assertRaises(heeler.HeelerError) as ctx:
            heeler.command("not_scriptable")
        self.assertIn("not scriptable", str(ctx.exception))

    def test_commands_are_shaped_for_the_reducers(self):
        heeler.set_param("exposure", "exposure", 0.7)
        cmd = Stub.seen[-1]["body"]["params"]["command"]
        self.assertEqual(
            cmd, {"type": "set_param", "id": "exposure", "param": "exposure", "value": 0.7}
        )
        heeler.connect_nodes("lummask", "cbal", port="mask", kind="mask")
        wire = Stub.seen[-1]["body"]["params"]["command"]["wire"]
        self.assertEqual(wire, {"from": "lummask", "to": "cbal", "toPort": "mask", "kind": "mask"})

    def last_call(self):
        seen = Stub.seen[-1]["body"]
        return seen["method"], seen["params"]

    def test_takes_ride_the_command_bus(self):
        # Takes are commands, not a side channel: the same four the
        # takes dropdown dispatches.
        heeler.takes()
        method, _ = self.last_call()
        self.assertEqual(method, "takes.list")
        heeler.new_take("Cool", note="for the client")
        _, params = self.last_call()
        self.assertEqual(
            params["command"], {"type": "new_take", "name": "Cool", "note": "for the client"}
        )
        heeler.switch_take("take_2")
        self.assertEqual(
            Stub.seen[-1]["body"]["params"]["command"],
            {"type": "switch_take", "takeId": "take_2"},
        )
        heeler.rename_take("take_2", "Warmer")
        self.assertEqual(
            Stub.seen[-1]["body"]["params"]["command"],
            {"type": "update_take", "takeId": "take_2", "name": "Warmer"},
        )
        heeler.delete_take("take_2")
        self.assertEqual(
            Stub.seen[-1]["body"]["params"]["command"],
            {"type": "delete_take", "takeId": "take_2"},
        )

    def test_export_carries_a_requested_print_resolution(self):
        heeler.export_images("/tmp/out", dpi=240)
        method, params = self.last_call()
        self.assertEqual(method, "export.run")
        self.assertEqual(params["dpi"], 240)
        heeler.export_images("/tmp/default")
        self.assertNotIn("dpi", self.last_call()[1])

    def test_export_speaks_the_panels_vocabulary(self):
        heeler.export_images("/tmp/out", ids=["a", "b"], format="tiff", max_edge=2048)
        method, params = self.last_call()
        self.assertEqual(method, "export.run")
        self.assertEqual(
            params,
            {
                "dir": "/tmp/out",
                "ids": ["a", "b"],
                "format": "tiff",
                "quality": 92,
                "maxEdge": 2048,
                "template": "{name}",
                "keepMetadata": True,
                "matte": False,
            },
        )
        # One id is fine bare; omitted ids means the selection, so the
        # key stays out of the payload entirely.
        heeler.export_images("/tmp/out", ids="a")
        self.assertEqual(Stub.seen[-1]["body"]["params"]["ids"], ["a"])
        heeler.export_images("/tmp/out")
        self.assertNotIn("ids", Stub.seen[-1]["body"]["params"])

    def test_stacks_and_panoramas_map_to_the_bridge(self):
        heeler.stack_create(["a", "b", "c"], "hdr")
        method, params = self.last_call()
        self.assertEqual((method, params), ("stack.create", {"ids": ["a", "b", "c"], "mode": "hdr"}))
        heeler.stack_configure("s1", mode="mean", align=False)
        _, params = self.last_call()
        self.assertEqual(params, {"id": "s1", "mode": "mean", "align": False})
        heeler.stack_bake("s1", format="tiff")
        _, params = self.last_call()
        self.assertEqual(params, {"id": "s1", "format": "tiff", "quality": 92})
        heeler.pano_create(["a", "b"])
        self.assertEqual(Stub.seen[-1]["body"]["method"], "pano.create")
        # The snake_case argument arrives as the bridge's camelCase.
        heeler.pano_configure("p1", gain_compensation=False, bands=2)
        _, params = self.last_call()
        self.assertEqual(params, {"id": "p1", "gainCompensation": False, "bands": 2})

    def test_export_resolution_omits_nonfinite_and_keeps_finite_numbers(self):
        for dpi in [float("nan"), float("inf"), float("-inf")]:
            heeler.export_images("/owned/review", dpi=dpi)
            method, params = self.last_call()
            self.assertEqual(method, "export.run")
            self.assertNotIn("dpi", params)
            json.dumps(params, allow_nan=False)
        for dpi in [0, -5, 240.4, 240.5, 1.0e100]:
            heeler.export_images("/owned/review", dpi=dpi)
            _, params = self.last_call()
            self.assertEqual(params["dpi"], dpi)

    def test_settings_and_app_control(self):
        heeler.set_prefs(quickQuality=85, backupEveryDays=7)
        cmd = Stub.seen[-1]["body"]["params"]["command"]
        self.assertEqual(
            cmd,
            {"type": "set_prefs", "prefs": {"quickQuality": 85, "backupEveryDays": 7}},
        )
        self.assertEqual(heeler.hotkeys_export(), '{"version": 1, "hotkeys": {}}')
        heeler.hotkeys_import('{"version": 1}')
        method, params = self.last_call()
        self.assertEqual((method, params), ("hotkeys.import", {"json": '{"version": 1}'}))
        heeler.open_folder("/photos/wedding")
        self.assertEqual(
            self.last_call(), ("app.open_folder", {"path": "/photos/wedding"})
        )
        heeler.set_mode("canvas")
        self.assertEqual(
            Stub.seen[-1]["body"]["params"]["command"],
            {"type": "set_mode", "mode": "canvas"},
        )
        heeler.collections()
        self.assertEqual(Stub.seen[-1]["body"]["method"], "catalog.collections")

    def test_one_undo_wraps_the_block_in_one_gesture(self):
        with heeler.one_undo("exposure.exposure"):
            heeler.set_param("exposure", "exposure", 0.5)
        sent = [s["body"]["params"].get("command", {}).get("type") for s in Stub.seen[-3:]]
        self.assertEqual(sent, ["begin_gesture", "set_param", "end_gesture"])
        self.assertEqual(Stub.seen[-3]["body"]["params"]["command"]["key"], "exposure.exposure")
        # An exception inside still closes the gesture: a leaked one
        # would coalesce the user's next unrelated edit into it.
        before = len(Stub.seen)
        with self.assertRaises(RuntimeError):
            with heeler.one_undo("exposure.exposure"):
                raise RuntimeError("boom")
        self.assertEqual(
            Stub.seen[-1]["body"]["params"]["command"]["type"], "end_gesture"
        )
        self.assertGreater(len(Stub.seen), before)


if __name__ == "__main__":
    unittest.main()
