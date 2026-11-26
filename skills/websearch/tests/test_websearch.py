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


def job_api(envelope, status="ready", error=None):
    """The portal's mode=job flow: a 202 submit, one status read, then the results read."""

    def handle(request):
        path = request.url.path
        if path == "/v1/search/google":
            job = {"batch_id": "job_1", "status": "queued", "status_url": "/v1/jobs/job_1", "results_url": "/v1/jobs/job_1/results"}
            return httpx.Response(202, json={"data": job})
        if path == "/v1/jobs/job_1":
            job = {"batch_id": "job_1", "status": status, "error": error, "cost": "$0.0030", "results_url": "/v1/jobs/job_1/results"}
            return httpx.Response(200, json={"data": job})
        if path == "/v1/jobs/job_1/results":
            return httpx.Response(200, json={"data": {"results": [{"index": 0, "operation": "serp.google", "items": [envelope]}]}})
        return httpx.Response(404)

    return handle


class RunTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(websearch, "_POLL_SECONDS", 0)
        patcher.start()
        self.addCleanup(patcher.stop)

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

    def test_searches_google_as_a_job_and_formats_its_result(self):
        """11-25: sync searches on this skill's key held prod Vercel functions 54.2 h, so the skill submits jobs."""
        out, seen = self.run_with(job_api(GOOGLE_BODY["data"]), num_results=3, gl="kr", language="ko")
        self.assertEqual([r.url.path for r in seen], ["/v1/search/google", "/v1/jobs/job_1", "/v1/jobs/job_1/results"])
        self.assertEqual(
            dict(seen[0].url.params), {"q": "prime intellect", "depth": "3", "mode": "job", "gl": "kr", "language_code": "ko"}
        )
        self.assertTrue(all(r.headers["authorization"] == "Bearer kb_test" for r in seen))
        self.assertIn("Result 1: Prime Intellect\nURL: https://www.primeintellect.ai/", out)
        self.assertIn("cost: $0.0030", out)

    def test_a_failed_job_reads_as_google_down(self):
        out, seen = self.run_with(job_api(None, status="failed", error="scrape_blocked"))
        self.assertEqual(len(seen), 2)
        self.assertIn("Google is unavailable on the Virev search backend right now (job failed: scrape_blocked).", out)
        self.assertIn("No charge was taken.", out)

    def test_keeps_only_organic_items_with_a_url_up_to_num_results(self):
        items = [
            {"type": "organic", "rank_absolute": 1, "title": "A", "url": "https://a.example/"},
            {"type": "people_also_ask", "rank_absolute": 2},
            {"type": "organic", "rank_absolute": 3, "title": "No URL"},
            {"type": "organic", "rank_absolute": 4, "title": "B", "url": "https://b.example/"},
            {"type": "organic", "rank_absolute": 5, "title": "C", "url": "https://c.example/"},
        ]
        out, _ = self.run_with(job_api({"tasks": [{"result": [{"items": items}]}]}), num_results=2)
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

    def test_a_proxy_provider_down_503_reads_as_the_proxy_hold(self):
        """Prod 2026-11-22 20:05Z: the portal passed the crawler's proxy_provider_down code on as it is."""
        held = json.dumps({"error": {"code": "proxy_provider_down", "message": "Our proxy provider is not serving reads right now. Retry after 30 s. You are not charged."}})
        out, seen = self.run_with(lambda request: httpx.Response(503, text=held))
        self.assertEqual(len(seen), 1)
        self.assertIn("Google is unavailable on the Virev search backend right now (HTTP 503: proxy_provider_down: Our proxy provider", out)
        self.assertIn("no retry helps until the owner picks a proxy", out)
        self.assertNotIn("Virev search error", out)

    def test_a_paused_workspace_reads_as_its_hold(self):
        """Prod 2026-11-23 19:37Z: Vent's crawl switch for the key's workspace came back as the portal's 503 crawl_paused."""
        for status, code, message in [
            (503, "crawl_paused", "Live reads are paused for this workspace right now, and stored reads still answer. Retry later. You are not charged."),
            (409, "crawl_unpaid_paused", "Live reads need a paid workspace. Add credit or contact support. You are not charged."),
        ]:
            body = json.dumps({"error": {"code": code, "message": message}})
            out, seen = self.run_with(lambda request, status=status, body=body: httpx.Response(status, text=body))
            self.assertEqual(len(seen), 1)
            self.assertIn(f"Google is unavailable on the Virev search backend right now (HTTP {status}: {code}: Live reads", out)
            self.assertIn("no retry helps until that pause lifts", out)
            self.assertNotIn("Virev search error", out)

    def test_a_crawler_503_reads_as_google_down_and_a_portal_503_keeps_its_own_text(self):
        """Prod 2026-11-10 to 11-12: the crawler refused every Google search while it held its proxy supply."""
        held = json.dumps({"error": {"code": "upstream_error", "message": "upstream temporarily unavailable"}})
        out, _ = self.run_with(lambda request: httpx.Response(503, text=held))
        self.assertIn("Google is unavailable on the Virev search backend right now (HTTP 503: upstream temporarily unavailable).", out)
        self.assertIn("no retry helps until the owner picks a proxy", out)
        down, _ = self.run_with(lambda request: httpx.Response(502, text=json.dumps({"error": {"code": "upstream_error", "message": "Upstream error"}})))
        self.assertNotIn("picks a proxy", down)
        keys = json.dumps({"error": {"code": "auth_unavailable", "message": "API key checks are temporarily unavailable"}})
        out, _ = self.run_with(lambda request: httpx.Response(503, text=keys))
        self.assertIn("Virev search error (503): API key checks are temporarily unavailable", out)

    def test_engine_is_not_a_parameter(self):
        with self.assertRaises(TypeError):
            asyncio.run(websearch.run("q", engine="bing"))


if __name__ == "__main__":
    unittest.main()
