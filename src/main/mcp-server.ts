// Polycast as an MCP server (Streamable HTTP on 127.0.0.1, bearer token), so Claude Code, Claude
// Desktop or any MCP client can draft, validate and schedule posts with the same tools as the in-app
// agent. Publishing and replies still wait for the person's click in the app.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { runTool, TOOLS, type ToolEnv } from '../core/tools'

function buildServer(env: () => ToolEnv): McpServer {
  const server = new McpServer({ name: 'polycast', version: '0.1.0' })
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema.shape }, async (input: unknown) => {
      const r = await runTool(t.name, input, env())
      return { content: [{ type: 'text' as const, text: JSON.stringify(r.result ?? null, null, 1) }], isError: !r.ok }
    })
  }
  return server
}

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 5_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })

export class PolycastMcpServer {
  private http?: Server

  constructor(private env: () => ToolEnv) {}

  get running() {
    return !!this.http
  }

  async start(port: number, token: string): Promise<void> {
    await this.stop()
    const expected = Buffer.from(`Bearer ${token}`)
    this.http = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '')
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      try {
        const body = await readBody(req)
        // Stateless: a fresh server + transport per request.
        const server = buildServer(this.env)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(port, '127.0.0.1', () => resolve())
    })
  }

  async stop(): Promise<void> {
    const h = this.http
    this.http = undefined
    if (h) await new Promise<void>((r) => h.close(() => r()))
  }
}
