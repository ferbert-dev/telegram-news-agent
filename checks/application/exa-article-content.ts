import assert from "node:assert/strict";
import test from "node:test";

import {
  ExaDailyContentCapError,
  exaArticleContentPort,
} from "../../src/research/content/exa-article-content.adapter.js";

const long = "word ".repeat(200);

function client(results: Array<Record<string, unknown>>, seen: string[][] = []) {
  let i = 0;
  return {
    seen,
    async getContents(urls: string[]) {
      seen.push(urls);
      return { results: [results[i++] ?? {}] };
    },
  };
}

const port = (c: ReturnType<typeof client>, over: Record<string, unknown> = {}) =>
  exaArticleContentPort(c, { dailyCap: 3, quotaKey: "k", capStore: new Map(), ...over });

test("full text comes back as plain data", async () => {
  const c = client([{ url: "https://news.example/a", title: "T", text: long }]);
  const content = await port(c).fetch("https://news.example/a");

  assert.equal(content?.text.length, long.trim().length);
  assert.equal(content?.title, "T");
  assert.deepEqual(c.seen, [["https://news.example/a"]]);
});

test("a near-empty body is not content", async () => {
  // A cookie wall or a JavaScript shell answers 200 with a few dozen
  // characters. Accepting that would put worse evidence in front of the model
  // than the RSS summary it replaced.
  for (const text of ["", "   ", "Enable JavaScript to continue.", undefined]) {
    const content = await port(client([{ text }])).fetch("https://x.example/1");
    assert.equal(content, null, `must reject ${JSON.stringify(text)}`);
  }
});

test("the daily cap counts content calls, which nothing counted before", async () => {
  const store = new Map();
  const c = client([{ text: long }, { text: long }, { text: long }, { text: long }]);
  const p = exaArticleContentPort(c, { dailyCap: 3, quotaKey: "k", capStore: store });

  for (let i = 0; i < 3; i += 1) await p.fetch(`https://x.example/${i}`);
  // The existing cap wraps exa.search only, so getContents starts out entirely
  // uncounted -- against a metered budget, on a port meant to run for every
  // article.
  await assert.rejects(() => p.fetch("https://x.example/4"), ExaDailyContentCapError);
  assert.equal(c.seen.length, 3, "the refused call must not reach the provider");
});

test("the cap is per day, not for all time", async () => {
  const store = new Map();
  let day = "2026-09-06T10:00:00.000Z";
  const c = client([{ text: long }, { text: long }]);
  const p = exaArticleContentPort(c, {
    dailyCap: 1,
    quotaKey: "k",
    capStore: store,
    now: () => new Date(day),
  });

  await p.fetch("https://x.example/1");
  await assert.rejects(() => p.fetch("https://x.example/2"), ExaDailyContentCapError);
  day = "2026-09-07T10:00:00.000Z";
  assert.ok(await p.fetch("https://x.example/3"), "a new day restores the budget");
});
