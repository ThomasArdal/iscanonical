var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-OgnD4S/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// worker/index.js
var ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
  "https://iscanonical.com",
  "https://www.iscanonical.com"
]);
var MAX_REDIRECTS = 10;
var REQUEST_HEADERS = {
  "User-Agent": "elmahio-uptimebot/2.0",
  "Accept": "text/html,*/*;q=0.1"
};
function isAllowedOrigin(origin) {
  if (!origin)
    return false;
  if (ALLOWED_ORIGINS.has(origin))
    return true;
  return /^http:\/\/localhost(:\d+)?$/.test(origin);
}
__name(isAllowedOrigin, "isAllowedOrigin");
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
}
__name(corsHeaders, "corsHeaders");
function forbidden() {
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" }
  });
}
__name(forbidden, "forbidden");
function isSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost")
    return false;
  if (/^127\./.test(h))
    return false;
  if (/^10\./.test(h))
    return false;
  if (/^192\.168\./.test(h))
    return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h))
    return false;
  if (/^169\.254\./.test(h))
    return false;
  if (h === "::1" || h === "[::1]")
    return false;
  return true;
}
__name(isSafeUrl, "isSafeUrl");
function urlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = /* @__PURE__ */ __name((u) => u.pathname.replace(/\/+$/, "") || "/", "norm");
    return ua.protocol === ub.protocol && ua.hostname.toLowerCase() === ub.hostname.toLowerCase() && norm(ua) === norm(ub) && ua.search === ub.search;
  } catch {
    return false;
  }
}
__name(urlsMatch, "urlsMatch");
async function parseHtml(response) {
  let canonicalHref = null;
  let hasMetaRefresh = false;
  await new HTMLRewriter().on('link[rel="canonical"]', { element(el) {
    canonicalHref = el.getAttribute("href");
  } }).on('meta[http-equiv="refresh"]', { element() {
    hasMetaRefresh = true;
  } }).transform(response).text();
  return { canonicalHref, hasMetaRefresh };
}
__name(parseHtml, "parseHtml");
async function followRedirects(startUrl) {
  const chain = [];
  let currentUrl = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(1e4)
      });
    } catch {
      chain.push({ url: currentUrl, status: null });
      return { chain, success: false };
    }
    const status = response.status;
    const location = response.headers.get("location");
    const isRedirect = status >= 300 && status < 400 && location;
    chain.push({ url: currentUrl, status });
    if (isRedirect) {
      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("text/html")) {
      const { canonicalHref, hasMetaRefresh } = await parseHtml(response);
      return { chain, success: true, finalUrl: currentUrl, canonicalHref, hasMetaRefresh };
    }
    await response.body?.cancel();
    return { chain, success: response.ok, finalUrl: currentUrl };
  }
  return { chain, success: false, tooManyRedirects: true };
}
__name(followRedirects, "followRedirects");
var worker_default = {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin))
        return forbidden();
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin))
      return forbidden();
    const { searchParams } = new URL(request.url);
    const canonical = searchParams.get("canonical");
    const inverted = searchParams.get("inverted");
    if (!canonical || !inverted) {
      return new Response(JSON.stringify({ error: "Missing canonical or inverted parameter" }), {
        status: 400,
        headers: corsHeaders(origin)
      });
    }
    if (!isSafeUrl(canonical) || !isSafeUrl(inverted)) {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400,
        headers: corsHeaders(origin)
      });
    }
    const { chain, success, finalUrl, canonicalHref, hasMetaRefresh, tooManyRedirects } = await followRedirects(inverted);
    const redirectCount = chain.filter((r) => r.status >= 300 && r.status < 400).length;
    const wrongStatusCode = chain.some((r) => r.status >= 300 && r.status < 400 && r.status !== 301 && r.status !== 308);
    let htmlChecks = { canonicalHref: canonicalHref ?? null, hasMetaRefresh: hasMetaRefresh ?? false };
    if (success && !urlsMatch(finalUrl, canonical)) {
      try {
        const resp = await fetch(canonical, {
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(1e4)
        });
        if (resp.ok)
          htmlChecks = await parseHtml(resp);
      } catch {
      }
    }
    return new Response(JSON.stringify({
      redirectChain: chain,
      redirectCount,
      tooManyRedirects: tooManyRedirects ?? false,
      wrongStatusCode,
      success,
      redirectsToCanonical: finalUrl ? urlsMatch(finalUrl, canonical) : false,
      canonicalHref: htmlChecks.canonicalHref,
      hasMetaRefresh: htmlChecks.hasMetaRefresh
    }), { headers: corsHeaders(origin) });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-OgnD4S/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-OgnD4S/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
