import assert from "node:assert/strict";
import test from "node:test";
import {
  extractArticleText,
  fetchArticle,
} from "../src/article-extractor.js";

const ARTICLE_TEXT =
  "The research team announced a new artificial intelligence model with improved reasoning and evaluation results. ";

test("extractArticleText selects article content and removes navigation", () => {
  const html = `
    <html>
      <body>
        <nav>Unrelated navigation that should not appear in evidence.</nav>
        <article>
          <h1>Primary announcement</h1>
          <p>${ARTICLE_TEXT.repeat(2)}</p>
          <script>ignore()</script>
          <p>${ARTICLE_TEXT.repeat(2)} Additional limitations are documented.</p>
        </article>
      </body>
    </html>`;

  const text = extractArticleText(html);
  assert.match(text, /Primary announcement/);
  assert.match(text, /Additional limitations/);
  assert.doesNotMatch(text, /Unrelated navigation|ignore/);
});

test("extractArticleText rejects pages without meaningful evidence", () => {
  assert.throws(
    () => extractArticleText("<html><body><p>Too short.</p></body></html>"),
    /yielded only/,
  );
});

test("fetchArticle validates HTML and returns hashed extracted text", async () => {
  const result = await fetchArticle("https://example.com/news", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/news",
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      async text() {
        return `<article><p>${ARTICLE_TEXT.repeat(4)}</p></article>`;
      },
    }),
  });

  assert.ok(result.text.length >= 200);
  assert.equal(result.contentHash.length, 64);
  assert.equal(result.finalUrl, "https://example.com/news");
});
