import asyncio
import json
import unittest
from unittest import mock

import httpx

import websearch

GOOGLE_BODY = {
    "data": {
        "tasks": [
            {
                "result": [
                    {
                        "se_results_count": 1200,
                        "items": [
                            {
                                "rank_absolute": 1,
                                "title": "Prime Intellect",
                                "url": "https://www.primeintellect.ai/",
                                "description": "Open superintelligence stack.",
                            }
                        ],
                    }
                ]
            }
        ]
    },
    "meta": {"cost": 0.003, "balance": 12.5},
}


class RunTests(unittest.TestCase):
    def run_with(self, handler, **kwargs):
        seen = []

        def record(request):
            seen.append(request)
            return handler(request)

        real = httpx.AsyncClient
        transport = httpx.MockTransport(record)
        with (
            mock.patch.dict(websearch.os.environ, {"VIREV_API_KEY": "kb_test", "VIREV_API_BASE": "https://api.test"}),
            mock.patch.object(websearch.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw)),
        ):
            out = asyncio.run(websearch.run("prime intellect", **kwargs))
        return out, seen

    def test_searches_google_only_and_formats_results(self):
        out, seen = self.run_with(lambda request: httpx.Response(200, json=GOOGLE_BODY), num_results=3, gl="kr", language="ko")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].url.path, "/v1/search/google")
        self.assertEqual(dict(seen[0].url.params), {"q": "prime intellect", "depth": "3", "gl": "kr", "language_code": "ko"})
        self.assertEqual(seen[0].headers["authorization"], "Bearer kb_test")
        self.assertIn("Result 1: Prime Intellect\nURL: https://www.primeintellect.ai/", out)
        self.assertIn("cost: 0.003 | balance left: 12.5", out)

    def test_keeps_only_organic_items_with_a_url_up_to_num_results(self):
        items = [
            {"type": "organic", "rank_absolute": 1, "title": "A", "url": "https://a.example/"},
            {"type": "people_also_ask", "rank_absolute": 2},
            {"type": "organic", "rank_absolute": 3, "title": "No URL"},
            {"type": "organic", "rank_absolute": 4, "title": "B", "url": "https://b.example/"},
            {"type": "organic", "rank_absolute": 5, "title": "C", "url": "https://c.example/"},
        ]
        body = {"data": {"tasks": [{"result": [{"items": items}]}]}, "meta": {}}
        out, _ = self.run_with(lambda request: httpx.Response(200, json=body), num_results=2)
        self.assertIn("Result 1: A\nURL: https://a.example/", out)
        self.assertIn("Result 4: B\nURL: https://b.example/", out)
        self.assertNotIn("Untitled", out)
        self.assertNotIn("No URL", out)
        self.assertNotIn("https://c.example/", out)

    def test_google_down_returns_the_api_error_and_makes_no_other_request(self):
        for status in (429, 502, 504):
            body = json.dumps({"error": {"message": "Upstream error"}})
            out, seen = self.run_with(lambda request, status=status: httpx.Response(status, text=body))
            self.assertEqual(len(seen), 1)
            self.assertIn(
                f"Google is unavailable on the Virev search backend right now (HTTP {status}: Upstream error). No charge was taken.",
                out,
            )
            self.assertNotIn("Result ", out)

    def test_engine_is_not_a_parameter(self):
        with self.assertRaises(TypeError):
            asyncio.run(websearch.run("q", engine="bing"))


if __name__ == "__main__":
    unittest.main()
