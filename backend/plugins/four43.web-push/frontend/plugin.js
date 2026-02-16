/**
 * Web Push Notifications Plugin (four43.web-push)
 *
 * Handles:
 * - Requesting notification permission
 * - Subscribing to Web Push via the browser Push API
 * - Sending the subscription to the backend
 */

const WebPushPlugin = (function () {
    let ctx = null;
    const PLUGIN_ID = 'four43.web-push';
    let PLUGIN_API = '';

    async function init(pluginCtx) {
        ctx = pluginCtx;
        PLUGIN_API = `${ctx.API_URL}/plugins/${PLUGIN_ID}`;

        console.log('[WebPush] Initializing...');

        // Only proceed if the browser supports Push
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('[WebPush] Push notifications not supported in this browser');
            return;
        }

        // Wait for service worker to be ready
        const registration = await navigator.serviceWorker.ready;

        // Check if already subscribed
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
            console.log('[WebPush] Already subscribed, syncing with backend');
            await sendSubscriptionToBackend(existing);
            return;
        }

        // If permission is already granted, subscribe silently
        if (Notification.permission === 'granted') {
            await subscribeToPush(registration);
            return;
        }

        // If permission hasn't been asked yet, request it
        if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                await subscribeToPush(registration);
            } else {
                console.log('[WebPush] Permission denied');
            }
        }
    }

    async function subscribeToPush(registration) {
        try {
            // Fetch VAPID public key from backend
            const response = await fetch(`${PLUGIN_API}/vapid-key`);
            if (!response.ok) {
                console.error('[WebPush] Failed to fetch VAPID key');
                return;
            }
            const { public_key } = await response.json();

            // Convert URL-safe base64 to Uint8Array
            const applicationServerKey = urlBase64ToUint8Array(public_key);

            // Subscribe via Push API
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey,
            });

            console.log('[WebPush] Subscribed to push');
            await sendSubscriptionToBackend(subscription);
        } catch (error) {
            console.error('[WebPush] Failed to subscribe:', error);
        }
    }

    async function sendSubscriptionToBackend(subscription) {
        try {
            const response = await fetch(`${PLUGIN_API}/subscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ctx.sessionToken()}`,
                },
                body: JSON.stringify({
                    endpoint: subscription.endpoint,
                    keys: {
                        p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
                        auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
                    },
                }),
            });
            if (response.ok) {
                console.log('[WebPush] Subscription sent to backend');
            } else {
                console.error('[WebPush] Backend rejected subscription:', response.status);
            }
        } catch (error) {
            console.error('[WebPush] Failed to send subscription to backend:', error);
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    return { init };
})();

// Export for plugin loader
// ID "four43.web-push" -> "Four43.web-pushPlugin"
window['Four43.web-pushPlugin'] = WebPushPlugin;
