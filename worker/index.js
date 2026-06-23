const ALLOWED_ORIGINS = new Set([
    'https://iscanonical.com',
    'https://www.iscanonical.com',
])

const MAX_REDIRECTS = 10
const REQUEST_HEADERS = {
    'User-Agent': 'elmahio-uptimebot/2.0',
    'Accept': 'text/html,*/*;q=0.1',
}

// ── Origin / CORS ────────────────────────────────────────────────────────────

function isAllowedOrigin(origin) {
    if (!origin) return false
    if (ALLOWED_ORIGINS.has(origin)) return true
    // Allow any localhost port for local development
    return /^http:\/\/localhost(:\d+)?$/.test(origin)
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json',
    }
}

function forbidden() {
    // No CORS headers — browser sees a CORS error, curl sees a 403.
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
    })
}

// ── URL safety (SSRF protection) ─────────────────────────────────────────────

function isSafeUrl(urlString) {
    let url
    try { url = new URL(urlString) } catch { return false }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

    const h = url.hostname.toLowerCase()

    // Block loopback, link-local, and private ranges
    if (h === 'localhost') return false
    if (/^127\./.test(h)) return false
    if (/^10\./.test(h)) return false
    if (/^192\.168\./.test(h)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
    if (/^169\.254\./.test(h)) return false
    if (h === '::1' || h === '[::1]') return false

    return true
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

function urlsMatch(a, b) {
    try {
        const ua = new URL(a)
        const ub = new URL(b)
        const norm = (u) => u.pathname.replace(/\/+$/, '') || '/'
        return ua.protocol === ub.protocol
            && ua.hostname.toLowerCase() === ub.hostname.toLowerCase()
            && norm(ua) === norm(ub)
            && ua.search === ub.search
    } catch {
        return false
    }
}

async function parseHtml(response) {
    let canonicalHref = null
    let hasMetaRefresh = false

    await new HTMLRewriter()
        .on('link[rel="canonical"]', { element(el) { canonicalHref = el.getAttribute('href') } })
        .on('meta[http-equiv="refresh"]', { element() { hasMetaRefresh = true } })
        .transform(response)
        .text()

    return { canonicalHref, hasMetaRefresh }
}

// ── Redirect following ───────────────────────────────────────────────────────

async function followRedirects(startUrl) {
    const chain = []
    let currentUrl = startUrl

    for (let i = 0; i < MAX_REDIRECTS; i++) {
        let response
        try {
            response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: REQUEST_HEADERS,
                signal: AbortSignal.timeout(10_000),
            })
        } catch {
            chain.push({ url: currentUrl, status: null })
            return { chain, success: false }
        }

        const status = response.status
        const location = response.headers.get('location')
        const isRedirect = status >= 300 && status < 400 && location

        chain.push({ url: currentUrl, status })

        if (isRedirect) {
            await response.body?.cancel()
            currentUrl = new URL(location, currentUrl).href
            continue
        }

        const contentType = response.headers.get('content-type') ?? ''
        if (response.ok && contentType.includes('text/html')) {
            const { canonicalHref, hasMetaRefresh } = await parseHtml(response)
            return { chain, success: true, finalUrl: currentUrl, canonicalHref, hasMetaRefresh }
        }

        await response.body?.cancel()
        return { chain, success: response.ok, finalUrl: currentUrl }
    }

    return { chain, success: false, tooManyRedirects: true }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin')

        if (request.method === 'OPTIONS') {
            // Preflight: only respond positively for allowed origins
            if (!isAllowedOrigin(origin)) return forbidden()
            return new Response(null, { headers: corsHeaders(origin) })
        }

        if (!isAllowedOrigin(origin)) return forbidden()

        const { searchParams } = new URL(request.url)
        const canonical = searchParams.get('canonical')
        const inverted  = searchParams.get('inverted')

        if (!canonical || !inverted) {
            return new Response(JSON.stringify({ error: 'Missing canonical or inverted parameter' }), {
                status: 400,
                headers: corsHeaders(origin),
            })
        }

        if (!isSafeUrl(canonical) || !isSafeUrl(inverted)) {
            return new Response(JSON.stringify({ error: 'Invalid URL' }), {
                status: 400,
                headers: corsHeaders(origin),
            })
        }

        const { chain, success, finalUrl, canonicalHref, hasMetaRefresh, tooManyRedirects } =
            await followRedirects(inverted)

        const redirectCount   = chain.filter(r => r.status >= 300 && r.status < 400).length
        const wrongStatusCode = chain.some(r => r.status >= 300 && r.status < 400 && r.status !== 301 && r.status !== 308)

        let htmlChecks = { canonicalHref: canonicalHref ?? null, hasMetaRefresh: hasMetaRefresh ?? false }
        if (success && !urlsMatch(finalUrl, canonical)) {
            try {
                const resp = await fetch(canonical, {
                    headers: REQUEST_HEADERS,
                    signal: AbortSignal.timeout(10_000),
                })
                if (resp.ok) htmlChecks = await parseHtml(resp)
            } catch { /* leave htmlChecks as-is */ }
        }

        return new Response(JSON.stringify({
            redirectChain:        chain,
            redirectCount,
            tooManyRedirects:     tooManyRedirects ?? false,
            wrongStatusCode,
            success,
            redirectsToCanonical: finalUrl ? urlsMatch(finalUrl, canonical) : false,
            canonicalHref:        htmlChecks.canonicalHref,
            hasMetaRefresh:       htmlChecks.hasMetaRefresh,
        }), { headers: corsHeaders(origin) })
    },
}
