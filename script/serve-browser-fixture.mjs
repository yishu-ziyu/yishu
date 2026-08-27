#!/usr/bin/env node
/**
 * Loopback static server for evals/capability/fixtures.
 * Binds 127.0.0.1 only. Substitutes {{name}} on thanks.html from the query.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_ROOT = path.join(ROOT, "evals/capability/fixtures");

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolveFixture(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const resolved = path.normalize(path.join(FIXTURE_ROOT, relative));
  const root = FIXTURE_ROOT.endsWith(path.sep) ? FIXTURE_ROOT : `${FIXTURE_ROOT}${path.sep}`;
  if (resolved !== FIXTURE_ROOT && !resolved.startsWith(root)) return undefined;
  return resolved;
}

export function startBrowserFixtureServer() {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const filePath = resolveFixture(url.pathname);
      if (filePath === undefined) {
        res.statusCode = 400;
        res.end("bad path");
        return;
      }
      try {
        let body = await readFile(filePath, "utf8");
        if (path.basename(filePath) === "thanks.html") {
          body = body.replaceAll("{{name}}", escapeHtml(url.searchParams.get("name") ?? ""));
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture server has no TCP port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { origin } = await startBrowserFixtureServer();
  process.stdout.write(`${origin}\n`);
}
