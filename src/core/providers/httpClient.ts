import * as http from 'http';
import * as https from 'https';

export interface RequestJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JsonResponse<T> {
  statusCode: number;
  body: T;
  rawText: string;
}

export class ProviderHttpError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string
  ) {
    super(message);
  }
}

export async function requestJson<T>(urlValue: string, options: RequestJsonOptions): Promise<JsonResponse<T>> {
  const response = await requestText(urlValue, options);

  let parsedBody: T;
  try {
    parsedBody = response.rawText.length > 0 ? (JSON.parse(response.rawText) as T) : ({} as T);
  } catch (error) {
    throw new Error(
      `Invalid JSON response from provider endpoint ${urlValue}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    ...response,
    body: parsedBody
  };
}

export function joinUrl(baseUrl: string, pathname: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase).toString();
}

async function requestText(
  urlValue: string,
  options: RequestJsonOptions
): Promise<{ statusCode: number; rawText: string }> {
  const url = new URL(urlValue);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 500;

          if (statusCode < 200 || statusCode >= 300) {
            reject(new ProviderHttpError(`Provider request failed with status ${statusCode}`, statusCode, rawText));
            return;
          }

          resolve({
            statusCode,
            rawText
          });
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(options.timeoutMs ?? 120000, () => {
      request.destroy(new Error('Provider request timed out'));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error('Request aborted'));
      } else {
        options.signal.addEventListener('abort', () => {
          request.destroy(new Error('Request aborted'));
        });
      }
    }

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}
