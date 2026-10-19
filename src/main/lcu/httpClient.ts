import https from 'node:https'
import type { LcuCredentials } from './credentials'

// Schlanker HTTPS-Client gegen die LCU. Eigener Agent mit
// rejectUnauthorized:false, da der Client ein selbstsigniertes Zertifikat nutzt.
// Jeder Request trägt den Basic-Auth-Header der Credentials.

export interface LcuResponse<T> {
  status: number
  data: T | null
}

export class LcuHttpClient {
  private readonly agent: https.Agent

  constructor(private readonly creds: LcuCredentials) {
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true })
  }

  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<LcuResponse<T>> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined

    return new Promise<LcuResponse<T>>((resolve, reject) => {
      const req = https.request(
        `${this.creds.baseUrl}${path}`,
        {
          method,
          agent: this.agent,
          headers: {
            Authorization: this.creds.authHeader,
            Accept: 'application/json',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload)
                }
              : {})
          }
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk) => (raw += chunk))
          res.on('end', () => {
            let data: T | null = null
            if (raw) {
              try {
                data = JSON.parse(raw) as T
              } catch {
                data = raw as unknown as T
              }
            }
            resolve({ status: res.statusCode ?? 0, data })
          })
        }
      )
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  get<T = unknown>(path: string): Promise<LcuResponse<T>> {
    return this.request<T>('GET', path)
  }

  post<T = unknown>(path: string, body?: unknown): Promise<LcuResponse<T>> {
    return this.request<T>('POST', path, body)
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<LcuResponse<T>> {
    return this.request<T>('PATCH', path, body)
  }

  destroy(): void {
    this.agent.destroy()
  }
}
