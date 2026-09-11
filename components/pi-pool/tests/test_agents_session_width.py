import pathlib
import subprocess
import unittest

from fixture_isolation import isolate_test_module
from test_patch import patcher


def setUpModule():
    isolate_test_module()


ROOT = pathlib.Path(__file__).resolve().parents[3]


class AgentsSessionWidthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bundles = ROOT / "node_modules/prime-agent/dist/bundle"
        sources = [path.read_text() for path in bundles.glob("chunk-*.js")]
        source, = [text for text in sources if "function buildCompactAgentsViewLayout(" in text]
        _, anchor, replacement = next(entry for entry in patcher.TUI_PATCHES
                                      if entry[0] == "agents-session-width")
        if source.count(anchor) != 1:
            raise AssertionError("Expected one width anchor in locked Prime Agent bundle")
        original = source[source.index("function buildCompactAgentsViewLayout("):
                          source.index("function requireDaemonData(")]
        patched = original.replace(anchor, replacement, 1)
        render = source[source.index("  renderRow(row, width, layout = buildCompactAgentsViewLayout("):
                        source.index("  renderActions(width)")]
        heartbeat = source[source.index("function formatHeartbeatBadge("):
                           source.index("function findParentSummary(")]
        cls.script = r"""
import assert from 'node:assert/strict';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
Date.now = () => Date.parse('2026-09-11T12:10:00Z');
const theme = {
  fg: (_color, value) => value,
  bold: value => `\x1b[1m${value}\x1b[22m`,
  italic: value => `\x1b[3m${value}\x1b[23m`,
};
""" + patched + heartbeat + "\nconst renderer = {\n" + render + r"""
};
const makeRow = (overrides = {}) => ({
  kind: 'agent', identity: 'root', recursiveCost: 1.25,
  title: 'A session title that used to be cut off after twenty eight columns',
  summary: { model: { id: 'claude-fable-5-1' }, summary: 'Investigating layout', created: '2026-09-11T12:00:00Z' },
  depth: 0, descendantCount: 0, selectable: false, section: 'idle',
  ...overrides,
});
const view = {
  rows: [], selectedIndex: 0, expandedSubagentParents: new Set(),
  isPendingDeleteRow: () => false, isPendingKillSubagentRow: () => false,
  getRowIcon: () => '*', formatRowIcon: (_section, icon) => icon,
};
const render = (row, width, layout) => renderer.renderRow.call(view, row, width, layout);
const strip = value => value.replace(/\x1b\[[0-9;]*m/g, '');
"""
        cls.original = original[:original.index("function padCellStart(")].replace(
            "function buildCompactAgentsViewLayout(", "function originalLayout(", 1)

    def run_js(self, assertions):
        result = subprocess.run(["node", "--input-type=module"],
                                input=self.script + self.original + assertions,
                                cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_layout_at_terminal_widths(self):
        self.run_js(r"""
const row = makeRow();
for (const [width, name, model, activity] of [
  [80, 52, 14, 0], [120, 78, 16, 10], [140, 91, 16, 17], [200, 130, 16, 38],
]) {
  const layout = buildCompactAgentsViewLayout([row], width);
  assert.deepEqual(Object.keys(layout), ['legend', 'details', 'nameWidth', 'modelWidth', 'activityWidth']);
  assert.deepEqual([layout.nameWidth, layout.modelWidth, layout.activityWidth], [name, model, activity]);
  assert.equal(visibleWidth(layout.legend), width);
  assert.ok(layout.legend.endsWith('Cost  Age'));
  assert.equal(layout.details.get(row.identity), '$1.25  10m');
  const line = render(row, width, layout);
  assert.equal(visibleWidth(line), width);
  assert.ok(line.endsWith(layout.details.get(row.identity)));
}
""")

    def test_name_rendering_preserves_child_indent_and_cjk(self):
        self.run_js(r"""
for (const row of [
  makeRow(),
  makeRow({ kind: 'subagent', depth: 2, identity: 'child' }),
  makeRow({ title: '세션 제목 日本語 '.repeat(12), summary: { sessionName: 'named' } }),
]) {
  for (const width of [80, 120, 140, 200]) {
    const layout = buildCompactAgentsViewLayout([row], width);
    const line = render(row, width, layout);
    const prefix = `${'  '.repeat(row.depth)}*  `;
    const expectedTitle = truncateToWidth(prefix + row.title, layout.nameWidth, '');
    assert.ok(strip(line).startsWith(expectedTitle));
    assert.ok(visibleWidth(expectedTitle) > 28);
    assert.equal(visibleWidth(line), width);
    const before = render(row, width, originalLayout([row], width));
    assert.notEqual(strip(line), strip(before));
  }
}
const row = makeRow();
assert.ok(strip(render(row, 120, buildCompactAgentsViewLayout([row], 120))).includes(row.title));
assert.ok(!strip(render(row, 120, originalLayout([row], 120))).includes(row.title));
""")

    def test_shrinking_widths_long_models_and_empty_rows(self):
        self.run_js(r"""
const longModel = 'provider/model-with-an-extremely-long-identifier'.repeat(3);
const row = makeRow({ summary: { model: { id: longModel } } });
for (const rows of [[row], []]) {
  let previous = Infinity;
  for (let width = 200; width >= 0; width--) {
    const layout = buildCompactAgentsViewLayout(rows, width);
    const available = Math.max(0, width - (rows.length ? 14 : 13));
    assert.equal(layout.nameWidth, Math.min(Math.floor(width * 0.65), available));
    assert.ok(layout.nameWidth <= previous);
    previous = layout.nameWidth;
    for (const key of ['nameWidth', 'modelWidth', 'activityWidth']) {
      assert.ok(Number.isInteger(layout[key]) && layout[key] >= 0, `${width}: ${key}`);
    }
    assert.ok(layout.modelWidth <= 32);
    assert.equal(visibleWidth(layout.legend), width);
    assert.equal(visibleWidth(render(row, width, layout)), width);
    assert.equal(layout.details.size, rows.length);
    if (width >= 80) {
      assert.ok(layout.legend.trimEnd().endsWith('Cost  Age'));
      assert.equal(layout.modelWidth, Math.min(rows.length ? 32 : 12, available - layout.nameWidth));
    }
  }
}
const layout = buildCompactAgentsViewLayout([row], 200);
assert.equal(layout.modelWidth, 32);
assert.ok(render(row, 200, layout).includes(longModel.slice(0, 32)));
assert.ok(!render(row, 200, layout).includes(longModel.slice(0, 33)));
assert.equal(buildCompactAgentsViewLayout([]).nameWidth, 78);
""")
