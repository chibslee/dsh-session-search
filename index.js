/**
 * Host half of the session full-text search panel.
 *
 * The panel's first pass goes through the official `sessions.search` gateway:
 * that keeps the index reconciled and returns one best match per session. What
 * it cannot do is show *every* matching message of a session — the gateway
 * collapses results per session and never exposes event rows. This module fills
 * that gap with one same-origin route that reads the very same FTS index
 * (`persisted_docs`) read-only, which costs a few milliseconds per query instead
 * of a reconcile pass per session.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE = '/ssv-search'
const VERSION = 1

/** Message rows are what a reader recognises; tool rows are opt-in (path/command hunting). */
const MESSAGE_TYPES = ['user/message', 'assistant/message']
const TOOL_TYPES = ['tool/call', 'tool/result']

/** `highlight()`/`snippet()` markers; `query.ts` FTS_HIGHLIGHT_START/_END use the same pair. */
const MARK_START = '\uFDD0'
const MARK_END = '\uFDD1'

const LIMITS = { ids: 40, perSession: 1000, query: 200, tokenCount: 8, sessions: 200 }

/** @returns {string} absolute path of the session-query index this deployment uses. */
export function indexPath() {
  const configured = process.env.DSH_SESSION_QUERY_DB
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'session-query.sqlite')
}

/**
 * Neutralise the reserved markers and NUL so caller text stays inert inside
 * both the MATCH expression and the stored document text.
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  return String(text)
    .replaceAll('\0', '\uFFFD')
    .replaceAll(MARK_START, '\uFFFD')
    .replaceAll(MARK_END, '\uFFFD')
}

/**
 * One quoted phrase per whitespace-separated token, ANDed together. The gateway
 * quotes the whole query as a single phrase, so "演示 文稿" only matches when the
 * two words are adjacent; splitting the tokens is what a reader expects from a
 * search box.
 * @param {string} query
 * @returns {string | null} FTS5 expression, or null when nothing tokenizable remains.
 */
function matchExpression(query, prefix = false) {
  const tokens = sanitize(query)
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .slice(0, LIMITS.tokenCount)
  if (tokens.length === 0) return null
  // prefix=true 时每个词编成 '"symbo"*' —— FTS5 的前缀查询，能命中 symbol / symbolic。
  const wrap = (token) => `"${token.replaceAll('"', '""')}"${prefix ? '*' : ''}`
  return tokens.map(wrap).join(' AND ')
}

/**
 * @param {boolean} includeTools
 * @returns {{ sql: string, params: string[] }} type/surface predicate.
 */
function scopePredicate(includeTools) {
  const types = includeTools ? [...MESSAGE_TYPES, ...TOOL_TYPES] : MESSAGE_TYPES
  return {
    sql: ` AND type IN (${types.map(() => '?').join(', ')}) AND surface IN ('current', 'log-only')`,
    params: types,
  }
}

/** @type {{ db: unknown } | { failure: string } | null} */
let connection = null

/**
 * Open the index once and keep the read-only handle. The host owns the writer,
 * so a second read-only connection is safe (WAL) and stays cheap.
 * @returns {Promise<{ db: any } | { failure: string }>}
 */
async function connect() {
  if (connection !== null) return 'db' in connection ? connection : { failure: connection.failure }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(indexPath(), { readOnly: true })
    connection = { db }
  } catch (error) {
    connection = { failure: error instanceof Error ? error.message : String(error) }
  }
  return 'db' in connection ? connection : { failure: connection.failure }
}

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {import('node:http').ServerResponse} res
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** @param {number} value @returns {boolean} */
function isIndex(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * @param {URL} url
 * @param {{ db: any }} handle
 */
function collect(url, handle) {
  const { db } = handle
  const query = (url.searchParams.get('q') ?? '').trim()
  if (query.length === 0) return { version: VERSION, query: '', mode: 'exact', counts: {}, hits: [] }
  if ([...query].length > LIMITS.query) return { error: 'query-too-long', max: LIMITS.query }
  const exact = matchExpression(query, false)
  if (exact === null) return { version: VERSION, query, mode: 'exact', counts: {}, hits: [] }
  const prefix = matchExpression(query, true)

  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, LIMITS.ids)
  const includeTools = url.searchParams.get('tools') === '1'
  const requested = Number(url.searchParams.get('perSession') ?? '3')
  const perSession = isIndex(requested) ? Math.min(Math.max(requested, 1), LIMITS.perSession) : 3
  const scope = scopePredicate(includeTools)
  const startedAt = Date.now()

  /**
   * One pass over the index with one FTS expression. Without `ids` the pass also
   * discovers which sessions match, so the panel can fall back to a prefix search
   * when the exact-token gateway returned nothing.
   */
  const pass = (expression, mode) => {
    /** @type {Record<string, number>} */
    const counts = {}
    /** @type {string[]} */
    let targets = ids
    if (targets.length === 0) {
      const found = db
        .prepare(
          `SELECT session_id AS sid, count(*) AS c FROM persisted_docs
            WHERE persisted_docs MATCH ?${scope.sql}
            GROUP BY session_id ORDER BY c DESC, sid ASC LIMIT ?`,
        )
        .all(expression, ...scope.params, LIMITS.sessions)
      targets = found.map((row) => String(row.sid))
      for (const row of found) counts[String(row.sid)] = Number(row.c)
    }
    /** @type {Array<Record<string, unknown>>} */
    const hits = []
    const hitStatement = db.prepare(
      `SELECT seq, type, time, surface,
              snippet(persisted_docs, 0, char(${MARK_START.codePointAt(0)}), char(${MARK_END.codePointAt(0)}), '…', 24) AS snippet
         FROM persisted_docs
        WHERE persisted_docs MATCH ? AND session_id = ?${scope.sql}
        ORDER BY seq DESC LIMIT ?`,
    )
    const countStatement = db.prepare(
      `SELECT count(*) AS c FROM persisted_docs
        WHERE persisted_docs MATCH ? AND session_id = ?${scope.sql}`,
    )
    for (const sessionId of targets) {
      try {
        if (counts[sessionId] === undefined) {
          const counted = countStatement.get(expression, sessionId, ...scope.params)
          counts[sessionId] = Number(counted?.c ?? 0)
        }
        if (counts[sessionId] === 0) continue
        const rows = hitStatement.all(expression, sessionId, ...scope.params, perSession)
        for (const row of rows) {
          hits.push({
            sessionId,
            seq: Number(row.seq),
            type: String(row.type),
            time: Number(row.time ?? 0),
            surface: String(row.surface ?? ''),
            snippet: String(row.snippet ?? ''),
          })
        }
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { stage: 'query' })
      }
    }
    return { mode, counts, hits }
  }

  let result
  try {
    result = pass(exact, 'exact')
    // 整词没命中时退回前缀匹配（"symbo" → symbol / symbolic）。
    if (result.hits.length === 0 && prefix !== exact) result = pass(prefix, 'prefix')
  } catch (error) {
    return { error: 'query-failed', message: error instanceof Error ? error.message : String(error) }
  }
  return {
    version: VERSION,
    query,
    mode: result.mode,
    tookMs: Date.now() - startedAt,
    counts: result.counts,
    hits: result.hits,
  }
}

/** @returns {string} absolute path of the workspace registry that records archived sessions. */
function registryPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'workspace.json')
}

/** @returns {string[]} ids the workspace registry marks archived (any nesting depth). */
async function archivedIds() {
  const ids = new Set()
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(registryPath(), 'utf8')
    JSON.parse(raw, (key, value) => {
      if (key === 'archivedSessionIds' && Array.isArray(value)) {
        for (const id of value) if (typeof id === 'string') ids.add(id)
      }
      return value
    })
  } catch (_) {
    /* no registry yet, or unreadable: report an empty set instead of failing the call */
  }
  return [...ids]
}

/**
 * Which ids the panel should treat as "child" and "archived". Both facts exist on
 * the host only: child sessions are `persisted_sessions` rows with a parent, and
 * archived ids live in the workspace registry rather than the index.
 * @param {{ db: any }} handle
 */
async function state(handle) {
  const { db } = handle
  let subagent = []
  try {
    subagent = db
      .prepare("SELECT id FROM persisted_sessions WHERE parent_session IS NOT NULL AND parent_session <> ''")
      .all()
      .map((row) => String(row.id))
  } catch (_) {
    /* older schema without the column: treat every session as top-level */
  }
  return { version: VERSION, subagent, archived: await archivedIds() }
}

/**
 * @param {URL} url
 * @param {{ db: any }} handle
 */
function health(url, handle) {
  const { db } = handle
  let documents = 0
  try {
    documents = Number(db.prepare('SELECT count(*) AS n FROM persisted_docs').get()?.n ?? 0)
  } catch (error) {
    return { ok: false, version: VERSION, db: indexPath(), message: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, version: VERSION, db: indexPath(), documents }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' })
    return
  }
  const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
  const connected = await connect()
  if ('failure' in connected) {
    sendJson(res, 503, { error: 'index-unavailable', db: indexPath(), message: connected.failure })
    return
  }
  if (path === '/' || path === '/health') {
    sendJson(res, 200, health(url, connected))
    return
  }
  if (path === '/state') {
    sendJson(res, 200, await state(connected))
    return
  }
  if (path !== '/events') {
    sendJson(res, 404, { error: 'not-found', path })
    return
  }
  const payload = collect(url, connected)
  sendJson(res, 'error' in payload ? 400 : 200, payload)
}

/** @param {any} ctx */
export function apply(ctx) {
  const route = {
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      handleRequest(req, res).catch((error) => {
        try {
          sendJson(res, 500, { error: 'handler-crashed', message: error instanceof Error ? error.message : String(error) })
        } catch (_) {
          /* the socket is already gone */
        }
      })
    },
  }
  const attach = (scope) => {
    const server = scope?.webServer
    if (server === undefined || server === null || typeof server.register !== 'function') return
    if (typeof scope.effect === 'function') {
      scope.effect(() => {
        const dispose = server.register(route)
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'session-search-view: events route')
      return
    }
    server.register(route)
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], attach)
    return
  }
  attach(ctx)
}
