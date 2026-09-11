import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { renderPage } from '../src/page.ts';
import { oneShotPage } from '../src/delivery.ts';
import type { HistorySnapshot, QuestionPart } from '../src/history.ts';

function nodes(node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['node'][] {
  return [node, ...('childNodes' in node ? node.childNodes.flatMap(nodes) : [])];
}
function inspect(html: string) {
  const all = nodes(parse(html));
  return {
    elements: all.filter(n => 'tagName' in n),
    text: all.filter(n => n.nodeName === '#text').map(n => 'value' in n ? n.value : '').join(''),
  };
}
function page(parts: QuestionPart[]): HistorySnapshot {
  return { orphanFinalCount: 0, groups: [{ questions: [{ parts }], finals: [{ texts: ['Final **answer**.'] }] }] };
}
function get(url: string, method = 'GET', host?: string) {
  return new Promise<{ status: number | undefined; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(url, { method, headers: host ? { host } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('hostile HTML, schemes, titles and metadata stay inert', () => {
  const attacks = [
    '<script>globalThis.PWNED=true</script><img src=x onerror="PWNED=1">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><style>body{background:url(https://evil.invalid)}</style>',
    '[quote](<https://evil.invalid/\"onclick=\"alert(1)> "\" onmouseover=\"alert(2)")',
    '[js](javascript:alert%281%29) [data](data:text/html,evil) [file](file:///etc/passwd)',
    '[entity](jav&#x61;script:alert%281%29) [control](java\tscript:alert%281%29)',
    '![remote](https://evil.invalid/image.png "\" onload=\"alert(1)")',
    '<https://evil.invalid> <a href="https://evil.invalid">raw link</a>',
    '&lt;img src=x onerror=alert(1)&gt;',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
  ];
  const html = renderPage(page([
    ...attacks.map(text => ({ kind: 'text', text } satisfies QuestionPart)),
    { kind: 'skill', name: '\"</summary><img src=x onerror=evil>', instructions: attacks.join('\n\n'), arguments: '\"<script>evil</script>' },
    { kind: 'attachment', label: 'image/png" onload=evil <img src=x>' },
  ]));
  const dom = inspect(html);
  const forbidden = new Set(['script','iframe','frame','frameset','form','base','object','embed','img','svg','math','link','a','input','video','audio','source']);
  for (const el of dom.elements) {
    assert(!forbidden.has(el.tagName), el.tagName);
    for (const attr of el.attrs) {
      assert(!/^(on|href$|src$|srcdoc$|action$|formaction$|style$)/i.test(attr.name), attr.name);
    }
  }
  assert(dom.text.includes('<script>globalThis.PWNED=true</script>'));
  assert(dom.text.includes('https://evil.invalid/image.png'));
  assert(dom.text.includes('javascript:'));
  assert(dom.text.includes('image/png" onload=evil'));
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  assert(style);
  const hash = createHash('sha256').update(style).digest('base64');
  const csp = dom.elements.find(n => n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv'))?.attrs.find(a => a.name === 'content')?.value;
  assert(csp?.includes("default-src 'none'"));
  assert(csp?.includes("script-src 'none'"));
  assert(csp?.includes(`style-src 'sha256-${hash}'`));
  assert(!csp?.includes('unsafe-inline'));
});

test('Markdown, ordered block arrays, native skill details and long content render', () => {
  const long = 'longword'.repeat(16000);
  const html = renderPage(page([
    { kind: 'text', text: '# First\n\n```html\n<img src=x onerror=evil>\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n' + long },
    { kind: 'attachment', label: 'Middle image' },
    { kind: 'skill', name: 'example', instructions: '**Hidden instructions**', arguments: 'Argument after skill' },
    { kind: 'text', text: 'LAST QUESTION BLOCK' },
  ]));
  const dom = inspect(html);
  assert.equal(dom.elements.filter(n => n.tagName === 'details').length, 2);
  assert.equal(dom.elements.filter(n => n.tagName === 'summary').length, 2);
  assert.equal(dom.elements.filter(n => n.tagName === 'table').length, 1);
  assert(dom.elements.some(n => n.tagName === 'pre'));
  assert(dom.text.includes(long));
  assert(dom.text.indexOf('Middle image') < dom.text.indexOf('Hidden instructions'));
  assert(dom.text.indexOf('Argument after skill') < dom.text.indexOf('LAST QUESTION BLOCK'));
  assert(dom.text.indexOf('LAST QUESTION BLOCK') < dom.text.indexOf('Final response'));
  assert(dom.text.includes('<img src=x onerror=evil>'));
});

test('empty page, empty blocks and missing final responses have visible labels', () => {
  assert(inspect(renderPage({ orphanFinalCount: 0, groups: [] })).text.includes('No saved questions'));
  const html = renderPage({ orphanFinalCount: 0, groups: [{ questions: [{ parts: [] }], finals: [] }] });
  const text = inspect(html).text;
  assert(text.includes('No text or attachments'));
  assert(text.includes('No marked final response saved'));
});

test('one-shot delivery requires exact host, path and GET; only one response can consume it', async () => {
  const html = renderPage(page([{ kind: 'text', text: 'SYNTHETIC SNAPSHOT' }]));
  const server = await oneShotPage(html);
  try {
    const url = new URL(server.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/[a-f0-9]{48}$/);
    assert.equal((await get(server.url, 'POST')).status, 405);
    assert.equal((await get(server.url, 'HEAD')).status, 405);
    assert.equal((await get(server.url + '?extra')).status, 404);
    assert.equal((await get(new URL('/other', server.url).href)).status, 404);
    assert.equal((await get(server.url, 'GET', 'evil.invalid')).status, 421);
    assert.equal((await get(server.url, 'GET', 'localhost:' + url.port)).status, 421);
    const [a, b] = await Promise.allSettled([get(server.url), get(server.url)]);
    const successes = [a,b].flatMap(result => result.status === 'fulfilled' && result.value.status === 200 ? [result.value] : []);
    assert.equal(successes.length, 1);
    assert.equal(successes[0]?.body, html);
    assert.equal(successes[0]?.headers['cache-control'], 'no-store');
    assert.equal(successes[0]?.headers['x-content-type-options'], 'nosniff');
    assert.equal(successes[0]?.headers['referrer-policy'], 'no-referrer');
    assert.equal(await server.closed, 'consumed');
    await assert.rejects(get(server.url));
  } finally { server.close(); }
});

test('explicit close is idempotent and stops delivery', async () => {
  const server = await oneShotPage('synthetic');
  server.close(); server.close();
  assert.equal(await server.closed, 'closed');
  await assert.rejects(get(server.url));
});

test('unused one-shot server expires after 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = await oneShotPage('synthetic');
  t.mock.timers.tick(30000);
  assert.equal(await server.closed, 'timeout');
  await assert.rejects(get(server.url));
});

test('a slow reader receives every byte of an 8 MB snapshot before successful closure', { timeout: 15000 }, async () => {
  const html = '<!doctype html><pre>' + 'Synthetic café 🧪\n'.repeat(400000) + '</pre>';
  const expected = Buffer.from(html);
  assert(expected.byteLength > 8_000_000);
  const server = await oneShotPage(html);
  let chunksRead = 0;
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const req = request(server.url, res => {
        assert.equal(res.statusCode, 200);
        assert.equal(Number(res.headers['content-length']), expected.byteLength);
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          chunksRead++;
          res.pause();
          setTimeout(() => res.resume(), 5);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Snapshot response was aborted')));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
    assert(chunksRead > 100);
    assert.equal(received.byteLength, expected.byteLength);
    assert(received.equals(expected), 'all UTF-8 snapshot bytes arrive unchanged');
    assert.equal(await server.closed, 'consumed');
    await assert.rejects(get(server.url));
  } finally { server.close(); }
});


test('latest final is prominent, earlier finals and unmarked text use separate details', () => {
  const html = renderPage({ orphanFinalCount: 2, groups: [
    { questions: [{ parts: [{ kind: 'text', text: 'Question' }] }], finals: [{ texts: ['EARLIER'] }, { texts: ['LATEST'] }] },
    { questions: [{ parts: [{ kind: 'text', text: '' }] }], finals: [], lastUnmarkedReply: { texts: ['UNMARKED'] } },
  ] });
  const dom = inspect(html);
  const details = dom.elements.filter(el => el.tagName === 'details').slice(1);
  assert.equal(details.length, 2);
  assert(!details.some(el => el.attrs.some(attr => attr.name === 'open')));
  const firstDetails = details[0];
  assert(firstDetails);
  assert(nodes(firstDetails).some(node => 'value' in node && node.value.includes('EARLIER')));
  assert(!nodes(firstDetails).some(node => 'value' in node && node.value.includes('LATEST')));
  assert(dom.text.includes('Earlier final responses (1)'));
  assert(dom.text.includes('Last reply without a final marker'));
  assert(dom.text.includes('exact question-to-response links were not recorded'));
  assert(dom.text.includes('2 final responses without an earlier saved question'));
});


test('snapshot caveats live in closed native details before the first question', () => {
  const dom = inspect(renderPage(page([{ kind: 'text', text: 'QUESTION BODY' }])));
  const about = dom.elements.find(el => el.tagName === 'details');
  assert(about);
  assert(!about.attrs.some(attr => attr.name === 'open'));
  const aboutText = nodes(about).filter(node => 'value' in node).map(node => node.value).join('');
  assert(aboutText.includes('About this snapshot'));
  for (const caveat of ['exact question-to-response links', 'human authorship', 'browser copy', 'Consecutive saved questions']) assert(aboutText.includes(caveat), caveat);
  assert(!aboutText.includes('QUESTION BODY'));
});


test('an idle TCP preconnection cannot delay successful page delivery', async () => {
  const delivery = await oneShotPage('SYNTHETIC PAGE');
  const url = new URL(delivery.url);
  const idle = connect({ host: url.hostname, port: Number(url.port) });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(idle, 'connect');
    const response = await get(delivery.url);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'SYNTHETIC PAGE');
    const status = await Promise.race([
      delivery.closed,
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('still open after delivery'), 500); }),
    ]);
    assert.equal(status, 'consumed');
  } finally {
    clearTimeout(deadline);
    idle.destroy();
    delivery.close();
    await delivery.closed;
  }
});

test('conversation layout keeps accessible groups and roles without visible card headings', () => {
  const html = renderPage({ orphanFinalCount: 0, groups: [
    { questions: [
      { parts: [{ kind: 'text', text: 'FIRST QUESTION' }] },
      { parts: [{ kind: 'text', text: 'SECOND QUESTION' }] },
    ], finals: [{ texts: ['# Answer heading\n\nFINAL BODY'] }] },
    { questions: [{ parts: [{ kind: 'text', text: 'NEXT QUESTION' }] }], finals: [] },
  ] });
  const dom = inspect(html);
  const main = dom.elements.find(el => el.tagName === 'main');
  assert(main);
  const header = dom.elements.find(el => el.tagName === 'header');
  assert(header);
  const headerText = nodes(header).filter(node => 'value' in node).map(node => node.value).join('');
  assert(headerText.includes('What did I say?'));
  assert(headerText.includes('Read-only snapshot'));
  const groups = dom.elements.filter(el => el.tagName === 'article');
  assert.equal(groups.length, 2);
  const questions = dom.elements.filter(el => el.attrs.some(a => a.name === 'class' && a.value === 'question'));
  assert.equal(questions.length, 3);
  for (const el of [...groups, ...questions]) {
    const label = el.attrs.find(a => a.name === 'aria-labelledby')?.value;
    assert(label);
    const heading = dom.elements.find(node => node.attrs.some(a => a.name === 'id' && a.value === label));
    assert(heading);
    assert(heading.attrs.some(a => a.name === 'class' && a.value === 'sr-only'));
    assert(nodes(el).includes(heading));
  }
  const finalLabel = dom.elements.find(el => el.tagName === 'h3' && nodes(el).some(node => 'value' in node && node.value === 'Final response'));
  assert(finalLabel?.attrs.some(a => a.name === 'class' && a.value === 'sr-only'));
  const answerHeading = dom.elements.find(el => el.tagName === 'h1' && nodes(el).some(node => 'value' in node && node.value === 'Answer heading'));
  assert(answerHeading);
  assert(!answerHeading.attrs.some(a => a.name === 'class' && a.value === 'sr-only'));
  const ids = dom.elements.flatMap(el => el.attrs.filter(a => a.name === 'id').map(a => a.value));
  assert.equal(ids.length, new Set(ids).size);
  for (const [first, second] of [['FIRST QUESTION', 'SECOND QUESTION'], ['SECOND QUESTION', 'FINAL BODY'], ['FINAL BODY', 'NEXT QUESTION']]) {
    assert(first && second);
    assert(dom.text.indexOf(first) < dom.text.indexOf(second));
  }
  assert(!dom.elements.some(el => ['button', 'textarea', 'nav'].includes(el.tagName)));
});

test('chat styles constrain wide content and preserve native disclosures', () => {
  const html = renderPage(page([{ kind: 'skill', name: 'example', arguments: 'VISIBLE ARGUMENTS', instructions: '# Instruction heading' }]));
  const dom = inspect(html);
  const details = dom.elements.filter(el => el.tagName === 'details');
  assert.equal(details.length, 2);
  assert(details.every(el => !el.attrs.some(a => a.name === 'open')));
  assert(!details.some(el => nodes(el).some(node => 'value' in node && node.value.includes('VISIBLE ARGUMENTS'))));
  assert(details.some(el => nodes(el).some(node => 'value' in node && node.value.includes('Instruction heading'))));
  const about = details[0];
  assert(about);
  const aboutText = nodes(about).filter(node => 'value' in node).map(node => node.value).join('');
  for (const scope of ['Current conversation branch', 'oldest saved first', 'pre-compaction history', 'latest marked final response']) assert(aboutText.includes(scope));
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  assert(style);
  assert.match(style, /main\s*\{[^}]*max-width: 48rem/);
  assert.match(style, /\.question\s*\{[^}]*max-width: 80%[^}]*margin-left: auto/);
  assert.match(style, /@media \(max-width: 600px\)[\s\S]*\.question\s*\{[^}]*max-width: 92%/);
  assert.match(style, /pre\s*\{[^}]*overflow-x: auto/);
  assert.match(style, /table\s*\{[^}]*max-width: 100%[^}]*overflow-x: auto/);
  assert.match(style, /overflow-wrap: anywhere/);
  assert.match(style, /summary:focus-visible/);
  assert(!/url\(|@import|box-shadow/.test(style));
});
