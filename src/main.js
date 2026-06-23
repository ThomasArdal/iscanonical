import './style.css'
import psl from 'psl'

const WORKER_URL = import.meta.env.VITE_WORKER_URL

// ── URL helpers ──────────────────────────────────────────────────────────────

function parseUrl(input) {
    input = input.trim()
    if (!/^https?:\/\//i.test(input)) input = 'https://' + input
    try {
        return new URL(input)
    } catch {
        return null
    }
}

function invertUrl(uri) {
    let scheme = uri.protocol.slice(0, -1)
    let host   = uri.hostname.toLowerCase()
    const port = uri.port
    let changed = false

    if (scheme === 'https') {
        scheme  = 'http'
        changed = true
    }

    const parsed = psl.parse(host)
    if (parsed && !parsed.error) {
        if (parsed.subdomain === 'www') {
            host    = parsed.domain
            changed = true
        } else if (!parsed.subdomain) {
            host    = `www.${parsed.domain}`
            changed = true
        }
    }

    const portPart = port ? `:${port}` : ''
    return {
        invertedUrl: `${scheme}://${host}${portPart}${uri.pathname}${uri.search}`,
        changed,
    }
}

// ── Core check logic ─────────────────────────────────────────────────────────

function statusEmoji(status) {
    if (!status)            return '❌'
    if (status >= 200 && status < 300) return '✅'
    return '🔁'
}

function buildChainHtml(chain) {
    if (!chain?.length) return ''
    const rows = chain.map(r =>
        `<tr><td>GET</td><td><code>${esc(r.url)}</code></td><td>${r.status ?? 'ERROR'} ${statusEmoji(r.status)}</td></tr>`
    ).join('')
    return `
        <div class="chain">
            <div class="chain-label">Request chain</div>
            <table><thead><tr><th>Method</th><th>URL</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody></table>
        </div>`
}

async function runChecks(canonicalUrl) {
    const uri = parseUrl(canonicalUrl)
    if (!uri) throw new Error('Invalid URL.')

    if (uri.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(uri.hostname)) {
        throw new Error('Canonical checks are not supported for localhost or IP addresses.')
    }

    const { invertedUrl, changed } = invertUrl(uri)
    if (!changed) throw new Error('Could not determine an alternate form to check. Ensure the URL is a public hostname.')

    const workerUrl = `${WORKER_URL}/check?canonical=${encodeURIComponent(uri.href)}&inverted=${encodeURIComponent(invertedUrl)}`

    let data
    try {
        const response = await fetch(workerUrl, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`Worker returned ${response.status}`)
        data = await response.json()
    } catch (e) {
        throw new Error(`Check service unavailable: ${e.message}`)
    }

    const checks = []
    const chain  = buildChainHtml(data.redirectChain)

    // 1. Redirect to canonical
    if (data.tooManyRedirects) {
        checks.push({
            status: 'fail',
            title: 'Too Many Redirects',
            desc: `${data.redirectChain?.length ?? 50}+ redirects detected from <code>${esc(invertedUrl)}</code> — possible infinite loop.${chain}`,
        })
    } else if (!data.success) {
        checks.push({
            status: 'fail',
            title: 'Redirect Failure',
            desc: `<code>${esc(invertedUrl)}</code> did not respond or returned an error. It must redirect to <code>${esc(uri.href)}</code>.${chain}`,
        })
    } else if (!data.redirectsToCanonical) {
        checks.push({
            status: 'fail',
            title: 'Redirects to Wrong URL',
            desc: `<code>${esc(invertedUrl)}</code> did not end up at <code>${esc(uri.href)}</code>.${chain}`,
        })
    } else if (data.redirectCount > 1) {
        checks.push({
            status: 'warn',
            title: 'Multiple Redirects',
            desc: `<code>${esc(invertedUrl)}</code> needed ${data.redirectCount} redirects to reach <code>${esc(uri.href)}</code>. Collapse these into a single redirect.${chain}`,
        })
    } else {
        checks.push({
            status: 'pass',
            title: 'Redirects to Canonical URL',
            desc: `<code>${esc(invertedUrl)}</code> correctly redirects to <code>${esc(uri.href)}</code>.${chain}`,
        })
    }

    // 2. Redirect status code (only relevant when there were redirects)
    if (data.redirectCount > 0) {
        if (data.wrongStatusCode) {
            checks.push({
                status: 'fail',
                title: 'Wrong Redirect Status Code',
                desc: 'One or more redirects used a status code other than <code>301</code> or <code>308</code>. Temporary redirects (<code>302</code>, <code>307</code>) do not pass SEO authority.',
            })
        } else {
            checks.push({
                status: 'pass',
                title: 'Correct Redirect Status Code',
                desc: 'All redirects used <code>301</code> or <code>308</code>.',
            })
        }
    }

    // 3. Canonical tag
    if (data.canonicalHref !== null) {
        checks.push({
            status: 'pass',
            title: 'Canonical Tag Found',
            desc: `Found <code>&lt;link rel="canonical" href="${esc(data.canonicalHref)}"&gt;</code> in <code>&lt;head&gt;</code>.`,
        })
    } else if (data.success) {
        checks.push({
            status: 'fail',
            title: 'Missing Canonical Tag',
            desc: `No <code>&lt;link rel="canonical"&gt;</code> found on <code>${esc(uri.href)}</code>. Add this to your <code>&lt;head&gt;</code>:<br><code>&lt;link rel="canonical" href="${esc(uri.href)}"&gt;</code>`,
        })
    }

    // 4. Meta refresh
    if (data.hasMetaRefresh) {
        checks.push({
            status: 'fail',
            title: 'Meta Refresh Detected',
            desc: `A <code>&lt;meta http-equiv="refresh"&gt;</code> tag was found on <code>${esc(uri.href)}</code>. Use HTTP <code>301</code>/<code>308</code> redirects instead — meta refresh is bad for SEO.`,
        })
    } else if (data.success) {
        checks.push({
            status: 'pass',
            title: 'No Meta Refresh',
            desc: 'No <code>&lt;meta http-equiv="refresh"&gt;</code> element found.',
        })
    }

    return { canonicalUrl: uri.href, invertedUrl, checks }
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function buildCheckEl({ status, title, desc }) {
    const icons = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' }
    const el = document.createElement('div')
    el.className = `check check-${status}`
    el.innerHTML = `
        <div class="check-icon">${icons[status] ?? ''}</div>
        <div>
            <div class="check-title">${esc(title)}</div>
            ${desc ? `<div class="check-desc">${desc}</div>` : ''}
        </div>`
    return el
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const form       = document.getElementById('checkForm')
const urlInput   = document.getElementById('urlInput')
const submitBtn  = document.getElementById('submitBtn')
const inputError = document.getElementById('inputError')
const resultsEl  = document.getElementById('results')
const summaryEl  = document.getElementById('summary')
const urlInfoEl  = document.getElementById('urlInfo')
const checksEl   = document.getElementById('checks')
const introEl    = document.getElementById('intro')

form.addEventListener('submit', async (e) => {
    e.preventDefault()

    inputError.classList.add('hidden')
    resultsEl.classList.add('hidden')

    const raw = urlInput.value.trim()
    if (!raw) return

    submitBtn.disabled    = true
    submitBtn.textContent = 'Checking…'

    try {
        const { canonicalUrl, invertedUrl, checks } = await runChecks(raw)

        const failures = checks.filter(c => c.status === 'fail').length
        summaryEl.className   = `summary summary-${failures === 0 ? 'pass' : 'fail'}`
        summaryEl.textContent = failures === 0
            ? '✅ All checks passed'
            : `❌ ${failures} issue${failures !== 1 ? 's' : ''} found`

        urlInfoEl.innerHTML = `
            <div class="url-pair">
                <div class="url-col">
                    <span class="url-label">Your canonical URL</span>
                    <code>${esc(canonicalUrl)}</code>
                </div>
                <div class="url-arrow">→</div>
                <div class="url-col">
                    <span class="url-label">Tested (non-canonical)</span>
                    <code>${esc(invertedUrl)}</code>
                </div>
            </div>`

        checksEl.replaceChildren(...checks.map(buildCheckEl))
        resultsEl.classList.remove('hidden')
        introEl.classList.add('hidden')
        history.pushState(null, '', `?url=${encodeURIComponent(canonicalUrl)}`)
    } catch (err) {
        inputError.textContent = err.message || 'An unexpected error occurred.'
        inputError.classList.remove('hidden')
    } finally {
        submitBtn.disabled    = false
        submitBtn.textContent = 'Check'
    }
})

const initialUrl = new URLSearchParams(window.location.search).get('url')
if (initialUrl) {
    urlInput.value = initialUrl
    form.requestSubmit()
}
