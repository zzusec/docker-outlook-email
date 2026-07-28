function firstForwardedValue(value: string | null): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

export function rewriteExternalUrl(request: Request, publicUrl?: string): Request {
  const current = new URL(request.url);
  let externalOrigin: URL | undefined;

  if (publicUrl) {
    const configured = new URL(publicUrl);
    if (configured.pathname !== '/' || configured.search || configured.hash) {
      throw new Error('PUBLIC_URL must contain only scheme and host, for example https://mail.example.com');
    }
    externalOrigin = configured;
  } else {
    const forwardedProtocol = firstForwardedValue(request.headers.get('x-forwarded-proto'));
    const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'));
    if (forwardedProtocol || forwardedHost) {
      const protocol = forwardedProtocol
        ? forwardedProtocol.endsWith(':')
          ? forwardedProtocol
          : `${forwardedProtocol}:`
        : current.protocol;
      externalOrigin = new URL(`${protocol}//${forwardedHost || current.host}`);
    }
  }

  if (!externalOrigin) return request;
  externalOrigin.pathname = current.pathname;
  externalOrigin.search = current.search;
  externalOrigin.hash = current.hash;
  return new Request(externalOrigin, request);
}
