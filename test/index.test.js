/**
 * Comprehensive test suite for express-serve-zip.
 *
 * Each describe block that needs specific middleware options creates its own
 * server fixture in beforeAll / afterAll so tests remain fully isolated.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import serveStatic from "../index.js";

// ---------------------------------------------------------------------------
// Low-level HTTP helper (no redirect following, no fetch opaque-redirect mess)
// ---------------------------------------------------------------------------

/**
 * Send an HTTP request and collect the full response.
 * Returns { status, headers, body: Buffer, text(), json() }.
 */
function rawRequest(baseUrl, urlPath, options = {}) {
  const parsed = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const chunks = [];
    // Force Connection: close so that keep-alive connection pooling never bleeds
    // leftover bytes from one response into the next request on the same socket.
    const headers = { Connection: "close", ...options.headers };
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: urlPath,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            text: () => body.toString("utf8"),
            json: () => JSON.parse(body.toString("utf8")),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

/**
 * Default next() handler: forwards status code from error or sends 404 with
 * the literal body "next() called" so tests can distinguish it clearly.
 */
function defaultNext(err, _req, res) {
  if (err) {
    res.statusCode = err.statusCode || 500;
    res.end(err.message || "error");
  } else {
    res.statusCode = 404;
    res.end("next() called");
  }
}

/**
 * Creates an HTTP server wrapping the serveStatic middleware.
 * Returns { request(path, opts), close() }.
 */
async function createFixture(options = {}, nextFn) {
  const middleware = serveStatic(testZipPath, options);
  const handleNext = nextFn ?? defaultNext;
  const server = createServer((req, res) => {
    middleware(req, res, (err) => handleNext(err, req, res));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    request: (urlPath, opts = {}) => rawRequest(baseUrl, urlPath, opts),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Zip fixture – created once for all tests
// ---------------------------------------------------------------------------

let testZipPath;

beforeAll(async () => {
  // Dynamic imports so vitest can still parse the file as ESM even though the
  // underlying packages are CJS.
  const { npath } = await import("@yarnpkg/fslib");
  const { ZipFS } = await import("@yarnpkg/libzip");

  testZipPath = path.join(
    os.tmpdir(),
    `express-serve-zip-test-${process.pid}.zip`,
  );

  const zipFs = new ZipFS(null);

  // Directories
  zipFs.mkdirSync(npath.toPortablePath("/subdir"));

  // Root-level files
  zipFs.writeFileSync(
    npath.toPortablePath("/index.html"),
    "<html><body>Hello</body></html>",
  );
  zipFs.writeFileSync(npath.toPortablePath("/hello.txt"), "hello world");
  zipFs.writeFileSync(npath.toPortablePath("/data.json"), '{"key":"value"}');
  zipFs.writeFileSync(npath.toPortablePath("/style.css"), "body{}");
  zipFs.writeFileSync(npath.toPortablePath("/script.js"), "alert(1)");
  // Used by extensions tests – request /page → resolves to /page.html
  zipFs.writeFileSync(npath.toPortablePath("/page.html"), "<html>page</html>");

  // Subdirectory files
  zipFs.writeFileSync(
    npath.toPortablePath("/subdir/index.html"),
    "subdir index",
  );
  zipFs.writeFileSync(npath.toPortablePath("/subdir/page.html"), "subdir page");

  // Dotfile
  zipFs.writeFileSync(npath.toPortablePath("/.hidden"), "dotfile content");
  zipFs.writeFileSync(
    npath.toPortablePath("/subdir/.hidden"),
    "subdir dotfile content",
  );
  // getBufferAndClose() serialises and closes the in-memory archive in one call
  writeFileSync(testZipPath, zipFs.getBufferAndClose());
});

afterAll(() => {
  try {
    unlinkSync(testZipPath);
  } catch {
    // silently ignore cleanup failures
  }
});

// ===========================================================================
// Tests
// ===========================================================================

describe("serveStatic()", () => {
  // -------------------------------------------------------------------------
  // Initialisation / argument validation
  // -------------------------------------------------------------------------
  describe("initialization", () => {
    it("throws TypeError when root is not provided", () => {
      expect(() => serveStatic()).toThrow(/root path required/);
    });

    it("throws TypeError when root is not a string", () => {
      expect(() => serveStatic(42)).toThrow(/root path must be a string/);
      expect(() => serveStatic({})).toThrow(/root path must be a string/);
    });

    it("throws TypeError when setHeaders is not a function", () => {
      expect(() =>
        serveStatic(testZipPath, { setHeaders: "not-a-function" }),
      ).toThrow(/setHeaders must be function/);
    });

    it("returns a three-argument middleware function", () => {
      const mw = serveStatic(testZipPath);
      expect(typeof mw).toBe("function");
      expect(mw.length).toBe(3);
    });

    it("exposes the mime module", () => {
      expect(serveStatic.mime).toBeDefined();
      expect(typeof serveStatic.mime.lookup).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // GET – basic file serving
  // -------------------------------------------------------------------------
  describe("GET requests", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("serves a plain-text file with 200", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("hello world");
    });

    it("serves a JSON file with 200", async () => {
      const res = await fixture.request("/data.json");
      expect(res.status).toBe(200);
      expect(res.text()).toBe('{"key":"value"}');
    });

    it("calls next() (no error) for a missing file", async () => {
      const res = await fixture.request("/missing.txt");
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });

    it("sets Content-Length matching the file size", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["content-length"]).toBe(
        String(Buffer.byteLength("hello world")),
      );
    });

    it("sets Accept-Ranges: bytes", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["accept-ranges"]).toBe("bytes");
    });

    it("sets an ETag header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["etag"]).toBeTruthy();
    });

    it("sets a Last-Modified header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["last-modified"]).toBeTruthy();
    });

    it('sets a Cache-Control header with "public"', async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["cache-control"]).toMatch(/public/);
    });
  });

  // -------------------------------------------------------------------------
  // Content-Type detection
  // -------------------------------------------------------------------------
  describe("Content-Type detection", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("serves .txt with text/plain", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
    });

    it("serves .html with text/html", async () => {
      const res = await fixture.request("/index.html");
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves .json with application/json", async () => {
      const res = await fixture.request("/data.json");
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("serves .css with text/css", async () => {
      const res = await fixture.request("/style.css");
      expect(res.headers["content-type"]).toMatch(/text\/css/);
    });

    it("serves .js with a JavaScript MIME type", async () => {
      const res = await fixture.request("/script.js");
      expect(res.headers["content-type"]).toMatch(/javascript/);
    });
  });

  // -------------------------------------------------------------------------
  // HEAD requests
  // -------------------------------------------------------------------------
  describe("HEAD requests", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 200 with headers but empty body", async () => {
      const res = await fixture.request("/hello.txt", { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers["content-length"]).toBe(
        String(Buffer.byteLength("hello world")),
      );
      expect(res.body.length).toBe(0);
    });

    it("does not send a body for HEAD on a missing file (next() is called)", async () => {
      const res = await fixture.request("/missing.txt", { method: "HEAD" });
      // next() handler sets 404 but HEAD responses have no body
      expect(res.status).toBe(404);
      expect(res.body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Non-GET/HEAD methods
  // -------------------------------------------------------------------------
  describe("non-GET/HEAD methods – fallthrough: true (default)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("calls next() (no error) for POST", async () => {
      const res = await fixture.request("/hello.txt", { method: "POST" });
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });

    it("calls next() (no error) for PUT", async () => {
      const res = await fixture.request("/hello.txt", { method: "PUT" });
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });

    it("calls next() (no error) for DELETE", async () => {
      const res = await fixture.request("/hello.txt", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  describe("non-GET/HEAD methods – fallthrough: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ fallthrough: false });
    });
    afterAll(() => fixture.close());

    it("returns 405 with Allow header for POST", async () => {
      const res = await fixture.request("/hello.txt", { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET, HEAD");
    });

    it("returns 405 for PUT", async () => {
      const res = await fixture.request("/hello.txt", { method: "PUT" });
      expect(res.status).toBe(405);
    });

    it("returns 405 for PATCH", async () => {
      const res = await fixture.request("/hello.txt", { method: "PATCH" });
      expect(res.status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // Directory handling
  // -------------------------------------------------------------------------
  describe("directory handling – redirect: true (default)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 301 and Location for a directory path without trailing slash", async () => {
      const res = await fixture.request("/subdir");
      expect(res.status).toBe(301);
      expect(res.headers["location"]).toMatch(/\/subdir\/$/);
    });

    it("serves the index.html for a directory path with trailing slash", async () => {
      const res = await fixture.request("/subdir/");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("subdir index");
    });

    it("serves root index.html for /", async () => {
      const res = await fixture.request("/");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("<html><body>Hello</body></html>");
    });
  });

  describe("directory handling – redirect: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ redirect: false });
    });
    afterAll(() => fixture.close());

    it("calls next() instead of redirecting for a directory path", async () => {
      const res = await fixture.request("/subdir");
      // With redirect:false the directory listener calls this.error(404) which
      // causes next() to be called without an error (fallthrough:true default).
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  describe("directory handling – index: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ index: false });
    });
    afterAll(() => fixture.close());

    it("calls next() for a directory request when index is disabled", async () => {
      const res = await fixture.request("/subdir/");
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  describe("directory handling – custom index filename", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ index: "page.html" });
    });
    afterAll(() => fixture.close());

    it("serves the custom index file", async () => {
      const res = await fixture.request("/subdir/");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("subdir page");
    });
  });

  // -------------------------------------------------------------------------
  // Dotfiles
  // -------------------------------------------------------------------------
  describe("dotfiles: ignore (default)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("calls next() without an error for dotfiles", async () => {
      const res = await fixture.request("/.hidden");
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  describe("dotfiles: deny (with fallthrough: false to expose the 403)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ dotfiles: "deny", fallthrough: false });
    });
    afterAll(() => fixture.close());

    it("returns 403 for dotfiles", async () => {
      const res = await fixture.request("/.hidden");
      expect(res.status).toBe(403);
    });

    it("still returns 200 for regular files", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.status).toBe(200);
    });
  });

  describe("dotfiles: allow", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ dotfiles: "allow" });
    });
    afterAll(() => fixture.close());

    it("serves dotfiles with 200", async () => {
      const res = await fixture.request("/.hidden");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("dotfile content");
    });
  });

  // -------------------------------------------------------------------------
  // options.extensions
  // -------------------------------------------------------------------------
  describe("options.extensions", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ extensions: ["html", "txt"] });
    });
    afterAll(() => fixture.close());

    it("resolves /page to /page.html via extension list", async () => {
      const res = await fixture.request("/page");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("<html>page</html>");
    });

    it("resolves /hello to /hello.txt via extension list", async () => {
      const res = await fixture.request("/hello");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("hello world");
    });

    it("still serves files requested with their explicit extension", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.status).toBe(200);
    });

    it("calls next() when no matching extension exists", async () => {
      const res = await fixture.request("/nonexistent");
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  // -------------------------------------------------------------------------
  // options.fallthrough
  // -------------------------------------------------------------------------
  describe("options.fallthrough: true (default)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("calls next() without error for a 404", async () => {
      const res = await fixture.request("/no-such-file.txt");
      expect(res.status).toBe(404);
      expect(res.text()).toBe("next() called");
    });
  });

  describe("options.fallthrough: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ fallthrough: false });
    });
    afterAll(() => fixture.close());

    it("forwards 404 error to next() for missing files", async () => {
      const res = await fixture.request("/no-such-file.txt");
      expect(res.status).toBe(404);
      // Error is forwarded to next(), so defaultNext responds with err.message –
      // NOT the literal 'next() called' string.
      expect(res.text()).not.toBe("next() called");
    });
  });

  // -------------------------------------------------------------------------
  // options.setHeaders
  // -------------------------------------------------------------------------
  describe("options.setHeaders", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({
        setHeaders(res) {
          res.setHeader("X-Custom-Header", "test-value");
        },
      });
    });
    afterAll(() => fixture.close());

    it("sets the custom header on served files", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.status).toBe(200);
      expect(res.headers["x-custom-header"]).toBe("test-value");
    });

    it("does not set the custom header when next() is called (file not found)", async () => {
      const res = await fixture.request("/missing.txt");
      expect(res.headers["x-custom-header"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // options.maxAge
  // -------------------------------------------------------------------------
  describe("options.maxAge as milliseconds", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ maxAge: 3_600_000 });
    }); // 1 h
    afterAll(() => fixture.close());

    it("sets Cache-Control with max-age=3600", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
    });
  });

  describe("options.maxAge as string", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ maxAge: "1d" });
    });
    afterAll(() => fixture.close());

    it("parses the string and sets max-age=86400", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["cache-control"]).toMatch(/max-age=86400/);
    });
  });

  // -------------------------------------------------------------------------
  // options.immutable
  // -------------------------------------------------------------------------
  describe("options.immutable", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ immutable: true, maxAge: "1y" });
    });
    afterAll(() => fixture.close());

    it('adds "immutable" to Cache-Control', async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["cache-control"]).toMatch(/immutable/);
    });
  });

  // -------------------------------------------------------------------------
  // options.etag
  // -------------------------------------------------------------------------
  describe("options.etag: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ etag: false });
    });
    afterAll(() => fixture.close());

    it("omits the ETag header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["etag"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // options.lastModified
  // -------------------------------------------------------------------------
  describe("options.lastModified: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ lastModified: false });
    });
    afterAll(() => fixture.close());

    it("omits the Last-Modified header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["last-modified"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // options.cacheControl
  // -------------------------------------------------------------------------
  describe("options.cacheControl: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ cacheControl: false });
    });
    afterAll(() => fixture.close());

    it("omits the Cache-Control header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["cache-control"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // options.acceptRanges
  // -------------------------------------------------------------------------
  describe("options.acceptRanges: false", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ acceptRanges: false });
    });
    afterAll(() => fixture.close());

    it("omits the Accept-Ranges header", async () => {
      const res = await fixture.request("/hello.txt");
      expect(res.headers["accept-ranges"]).toBeUndefined();
    });

    it("ignores Range request headers and serves the full file", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=0-4" },
      });
      // Without range support the full file is sent with 200
      expect(res.status).toBe(200);
      expect(res.text()).toBe("hello world");
    });
  });

  // -------------------------------------------------------------------------
  // Conditional GET (caching)
  // -------------------------------------------------------------------------
  describe("conditional GET", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 304 when If-None-Match matches the current ETag", async () => {
      const first = await fixture.request("/hello.txt");
      const etag = first.headers["etag"];
      expect(etag).toBeTruthy();

      const second = await fixture.request("/hello.txt", {
        headers: { "If-None-Match": etag },
      });
      expect(second.status).toBe(304);
      expect(second.body.length).toBe(0);
    });

    it("returns 200 when If-None-Match does not match the ETag", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { "If-None-Match": '"stale-etag-value"' },
      });
      expect(res.status).toBe(200);
    });

    it("returns 304 when If-Modified-Since is at or after Last-Modified", async () => {
      const first = await fixture.request("/hello.txt");
      const lastModified = first.headers["last-modified"];
      expect(lastModified).toBeTruthy();

      // Use a date well in the future to guarantee "not modified"
      const futureDate = new Date(
        Date.now() + 1000 * 60 * 60 * 24,
      ).toUTCString();
      const second = await fixture.request("/hello.txt", {
        headers: { "If-Modified-Since": futureDate },
      });
      expect(second.status).toBe(304);
    });

    it("returns 200 when If-Modified-Since is before Last-Modified", async () => {
      const pastDate = new Date(0).toUTCString(); // 1970-01-01
      const res = await fixture.request("/hello.txt", {
        headers: { "If-Modified-Since": pastDate },
      });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Range requests
  // -------------------------------------------------------------------------
  describe("range requests", () => {
    // "hello world" = 11 bytes (indices 0-10)
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 206 and the requested byte slice", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=0-4" },
      });
      expect(res.status).toBe(206);
      expect(res.text()).toBe("hello");
      expect(res.headers["content-range"]).toBe("bytes 0-4/11");
      expect(res.headers["content-length"]).toBe("5");
    });

    it("returns the correct slice for a mid-file range", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=6-10" },
      });
      expect(res.status).toBe(206);
      expect(res.text()).toBe("world");
    });

    it("returns 416 for an unsatisfiable range", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=100-200" },
      });
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe("bytes */11");
    });
  });

  // -------------------------------------------------------------------------
  // ETag stability
  // -------------------------------------------------------------------------
  describe("ETag stability", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("produces the same ETag on repeated requests for the same file", async () => {
      const a = await fixture.request("/hello.txt");
      const b = await fixture.request("/hello.txt");
      expect(a.headers["etag"]).toBe(b.headers["etag"]);
    });

    it("ETags differ across different files", async () => {
      const a = await fixture.request("/hello.txt");
      const b = await fixture.request("/data.json");
      expect(a.headers["etag"]).not.toBe(b.headers["etag"]);
    });
  });

  // -------------------------------------------------------------------------
  // options.setHeaders – callback arguments
  // -------------------------------------------------------------------------
  describe("options.setHeaders callback arguments", () => {
    let capturedArgs;
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({
        setHeaders(res, filePath, stat) {
          capturedArgs = { res, filePath, stat };
        },
      });
    });
    afterAll(() => fixture.close());

    it("receives res, path string, and stat object", async () => {
      capturedArgs = null;
      await fixture.request("/hello.txt");
      expect(capturedArgs).not.toBeNull();
      expect(typeof capturedArgs.filePath).toBe("string");
      expect(capturedArgs.filePath).toMatch(/hello\.txt/);
      expect(typeof capturedArgs.stat.size).toBe("number");
      expect(capturedArgs.stat.size).toBe(Buffer.byteLength("hello world"));
    });
  });

  // -------------------------------------------------------------------------
  // Dotfiles in subdirectories
  // -------------------------------------------------------------------------
  describe("dotfiles in subdirectories", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ dotfiles: "deny", fallthrough: false });
    });
    afterAll(() => fixture.close());

    it("denies a dotfile nested inside a directory", async () => {
      const res = await fixture.request("/subdir/.hidden");
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple index files (array fallback)
  // -------------------------------------------------------------------------
  describe("index array with fallback", () => {
    // index.htm does not exist; index.html does → should fall through to it
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ index: ["index.htm", "index.html"] });
    });
    afterAll(() => fixture.close());

    it("falls back to the second index filename when the first is absent", async () => {
      const res = await fixture.request("/subdir/");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("subdir index");
    });
  });

  // -------------------------------------------------------------------------
  // Precondition failures
  // -------------------------------------------------------------------------
  describe("If-Match precondition failure (412)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 412 when If-Match does not match the ETag", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { "If-Match": '"not-the-right-etag"' },
      });
      expect(res.status).toBe(412);
    });

    it("returns 200 when If-Match is *", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { "If-Match": "*" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("If-Unmodified-Since precondition failure (412)", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("returns 412 when resource was modified after If-Unmodified-Since", async () => {
      const pastDate = new Date(0).toUTCString(); // 1970, definitely before the file
      const res = await fixture.request("/hello.txt", {
        headers: { "If-Unmodified-Since": pastDate },
      });
      expect(res.status).toBe(412);
    });
  });

  // -------------------------------------------------------------------------
  // Range request edge cases
  // -------------------------------------------------------------------------
  describe("range request edge cases", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture();
    });
    afterAll(() => fixture.close());

    it("treats a syntactically invalid Range header as no Range (200 full)", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "totally-invalid" },
      });
      expect(res.status).toBe(200);
      expect(res.text()).toBe("hello world");
    });

    it("treats multiple ranges as no Range and returns the full file (200)", async () => {
      // RFC 7233 leaves multi-range support optional; this impl returns full file
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=0-2,6-10" },
      });
      expect(res.status).toBe(200);
      expect(res.text()).toBe("hello world");
    });

    it("sets Content-Range on 416 response", async () => {
      const res = await fixture.request("/hello.txt", {
        headers: { Range: "bytes=999-9999" },
      });
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Redirect response security headers
  // -------------------------------------------------------------------------
  // send.js writes redirect (301) responses directly, including security
  // headers. Errors, on the other hand, are always forwarded through next()
  // by index.js (which always attaches an 'error' listener), so error
  // responses never carry send.js security headers in the middleware context.
  describe("redirect response security headers", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({});
    });
    afterAll(() => fixture.close());

    it("sets Content-Security-Policy on redirect responses", async () => {
      // /subdir without trailing slash triggers a 301 redirect
      const res = await fixture.request("/subdir");
      expect(res.status).toBe(301);
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    });

    it("sets X-Content-Type-Options: nosniff on redirect responses", async () => {
      const res = await fixture.request("/subdir");
      expect(res.status).toBe(301);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  // -------------------------------------------------------------------------
  // Path / security
  // -------------------------------------------------------------------------
  // fallthrough: false is used here so that security-rejection status codes
  // (400, 403) are forwarded to the next handler instead of being swallowed
  // by the fallthrough mechanism (which calls next() without an error for any
  // statusCode < 500 when fallthrough:true).
  describe("path security", () => {
    let fixture;
    beforeAll(async () => {
      fixture = await createFixture({ fallthrough: false });
    });
    afterAll(() => fixture.close());

    it("returns 400 for a path containing a null byte", async () => {
      // %00 decodes to \0; send.js has an explicit null-byte guard
      const res = await fixture.request("/hello%00.txt");
      expect(res.status).toBe(400);
    });

    it("returns 400 for an invalid percent-encoded sequence", async () => {
      const res = await fixture.request("/hello%ZZworld");
      expect(res.status).toBe(400);
    });

    it("does not serve files above the zip root (path traversal attempt)", async () => {
      // The middleware should respond with 403, 404, or 400 – never 200
      const res = await fixture.request("/../etc/passwd");
      expect([400, 403, 404]).toContain(res.status);
    });
  });
});
