import { useEffect, useRef, useCallback } from 'react';
import { ExtensionMessage, WebviewMessage } from '../../src/models/messages';

// acquireVsCodeApi is injected by the VSCode webview runtime
declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

export function useExtension(
  onMessage: (msg: ExtensionMessage) => void
): (msg: WebviewMessage) => void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      onMessageRef.current(event.data as ExtensionMessage);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const sendMessage = useCallback((msg: WebviewMessage) => {
    vscodeApi.postMessage(msg);
  }, []);

  return sendMessage;
}
