import asyncio
import unittest
from unittest import mock

import httpx

import websearch

GET_PAGE = """
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.primeintellect.ai%2F&amp;rut=6a" class='result-link'>Prime Intellect - The Open Superintelligence Stack</a></td></tr>
<tr><td class='result-snippet'><b>Prime</b> <b>Intellect</b> trains models.</td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/y.js?ad_domain=example.com" class='result-link'>Sponsored</a></td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FPrime_Intellect&amp;rut=cb" class='result-link'>Prime Intellect - Wikipedia</a></td></tr>
<tr><td><a rel="nofollow" href="https://github.com/PrimeIntellect-ai" class='result-link'>GitHub</a></td></tr>
<tr><td class='result-snippet'>Repositories &amp; more.</td></tr>
"""

THROTTLE_PAGE = "<html><body><form id='challenge-form'>anomaly</form></body></html>"


class ParseTests(unittest.TestCase):
    def test_unwraps_redirect_links_skips_ads_and_keeps_each_snippet_with_its_result(self):
        out = websearch._parse_ddg_lite(GET_PAGE, 5)
        self.assertEqual(
            out.split("\n\n---\n\n"),
            [
                "Result 1: Prime Intellect - The Open Superintelligence Stack\n"
                "URL: https://www.primeintellect.ai/\nPrime Intellect trains models.",
                "Result 2: Prime Intellect - Wikipedia\nURL: https://en.wikipedia.org/wiki/Prime_Intellect",
                "Result 3: GitHub\nURL: https://github.com/PrimeIntellect-ai\nRepositories & more.",
            ],
        )

    def test_stops_at_num_results(self):
        self.assertEqual(websearch._parse_ddg_lite(GET_PAGE, 1).count("Result "), 1)

    def test_throttle_page_has_no_results(self):
        self.assertEqual(websearch._parse_ddg_lite(THROTTLE_PAGE, 5), "")


class FallbackTests(unittest.TestCase):
    def run_with(self, handler):
        seen = []

        def record(request):
            seen.append(request)
            return handler(request)

        real = httpx.AsyncClient
        transport = httpx.MockTransport(record)
        with mock.patch.object(
            websearch.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw)
        ):
            out = asyncio.run(websearch._ddg_lite("prime intellect", timeout=5, num_results=5))
        return out, seen

    def test_post_202_falls_through_to_get(self):
        def handler(request):
            if request.method == "POST":
                return httpx.Response(202, text=THROTTLE_PAGE)
            return httpx.Response(200, text=GET_PAGE)

        out, seen = self.run_with(handler)
        self.assertEqual([r.method for r in seen], ["POST", "GET"])
        self.assertEqual(seen[1].url.params["q"], "prime intellect")
        self.assertIn("URL: https://www.primeintellect.ai/", out)

    def test_post_with_results_sends_one_request(self):
        out, seen = self.run_with(lambda request: httpx.Response(200, text=GET_PAGE))
        self.assertEqual([r.method for r in seen], ["POST"])
        self.assertEqual(seen[0].content, b"q=prime+intellect")
        self.assertIn("Result 3: GitHub", out)

    def test_both_throttled_is_empty(self):
        out, _ = self.run_with(lambda request: httpx.Response(202, text=THROTTLE_PAGE))
        self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
