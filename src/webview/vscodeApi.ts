import type { WebviewMessage } from './types';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

let api: VsCodeApi | undefined;

/**
 * The webview host bridge. Falls back to a no-op stub outside a real webview
 * (unit tests under jsdom), where tests spy on `post` instead.
 */
export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    const acquire = (globalThis as Record<string, unknown>)['acquireVsCodeApi'];
    api =
      typeof acquire === 'function'
        ? (acquire as () => VsCodeApi)()
        : { postMessage: () => undefined };
  }
  return api;
}

export function post(message: WebviewMessage): void {
  getVsCodeApi().postMessage(message);
}
