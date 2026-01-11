/**
 * PassShare Browser Extension - Background Service Worker
 *
 * Handles native messaging with PassShare desktop app and coordinates
 * between popup and content scripts.
 */

const NATIVE_APP_ID = 'net.bm1314.passshare';

interface NativeMessage {
  type: string;
  payload?: unknown;
}

interface NativeResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Native messaging port
let nativePort: chrome.runtime.Port | null = null;
let pendingRequests: Map<string, {
  resolve: (value: NativeResponse) => void;
  reject: (reason: unknown) => void;
}> = new Map();
let messageId = 0;

// Connect to native app
function connectNative(): chrome.runtime.Port | null {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_APP_ID);

    nativePort.onMessage.addListener((message: { id: string } & NativeResponse) => {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pending.resolve(message);
        pendingRequests.delete(message.id);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('Native app disconnected');
      nativePort = null;
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error('Native app disconnected'));
        pendingRequests.delete(id);
      }
    });

    return nativePort;
  } catch (error) {
    console.error('Failed to connect to native app:', error);
    return null;
  }
}

// Send message to native app
async function sendNativeMessage(message: NativeMessage): Promise<NativeResponse> {
  if (!nativePort) {
    nativePort = connectNative();
  }

  if (!nativePort) {
    return { success: false, error: 'Native app not available' };
  }

  const id = String(++messageId);

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    nativePort!.postMessage({ id, ...message });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

// Message handlers
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message: { action: string; payload?: unknown }): Promise<unknown> {
  switch (message.action) {
    case 'list':
      return sendNativeMessage({ type: 'list', payload: message.payload });

    case 'get':
      return sendNativeMessage({ type: 'get', payload: message.payload });

    case 'find':
      return sendNativeMessage({ type: 'find', payload: message.payload });

    case 'generate':
      return sendNativeMessage({ type: 'generate', payload: message.payload });

    case 'sync':
      return sendNativeMessage({ type: 'sync' });

    case 'otp':
      return sendNativeMessage({ type: 'otp', payload: message.payload });

    case 'fill':
      // Get secret and send to content script
      const secret = await sendNativeMessage({ type: 'get', payload: message.payload });
      if (secret.success && secret.data) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'fill',
            data: secret.data,
          });
        }
      }
      return secret;

    case 'getCurrentUrl':
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { success: true, data: activeTab?.url };

    case 'findForUrl':
      // Find secrets matching current URL
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!currentTab?.url) {
        return { success: false, error: 'No active tab' };
      }

      try {
        const url = new URL(currentTab.url);
        const hostname = url.hostname.replace(/^www\./, '');
        return sendNativeMessage({ type: 'find', payload: hostname });
      } catch {
        return { success: false, error: 'Invalid URL' };
      }

    case 'copyToClipboard':
      // Use offscreen document to copy to clipboard
      try {
        await navigator.clipboard.writeText(message.payload as string);
        return { success: true };
      } catch {
        return { success: false, error: 'Failed to copy' };
      }

    default:
      return { success: false, error: `Unknown action: ${message.action}` };
  }
}

// Handle keyboard commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'fill-login') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url) {
      try {
        const url = new URL(tab.url);
        const hostname = url.hostname.replace(/^www\./, '');
        const result = await sendNativeMessage({ type: 'find', payload: hostname });

        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
          // Get the first matching secret
          const secretResult = await sendNativeMessage({
            type: 'get',
            payload: result.data[0],
          });

          if (secretResult.success && secretResult.data) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'fill',
              data: secretResult.data,
            });
          }
        }
      } catch (error) {
        console.error('Fill command failed:', error);
      }
    }
  }
});

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('PassShare extension installed');
  // Try to connect to native app
  connectNative();
});

// Keep service worker alive
chrome.runtime.onStartup.addListener(() => {
  connectNative();
});
