# Testing WebAuthn/Passkeys with Playwright

Skrīb uses WebAuthn (Passkeys) for authentication, which normally requires a physical authenticator (fingerprint, Face ID, security key). Playwright can simulate this using Chrome DevTools Protocol (CDP) virtual authenticators.

## Prerequisites

- Chromium-based browser (CDP is Chromium-only)
- Playwright with Chromium installed:
  ```bash
  cd frontend
  npm install @playwright/test
  npx playwright install chromium
  ```

## Setting Up the Virtual Authenticator

Before any WebAuthn interaction, create a CDP session and attach a virtual authenticator:

```js
const client = await page.context().newCDPSession(page);
await client.send('WebAuthn.enable');

const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
```

### Option Reference

| Option | Value | Purpose |
|--------|-------|---------|
| `protocol` | `'ctap2'` | FIDO2/WebAuthn protocol |
| `transport` | `'internal'` | Simulates platform authenticator (fingerprint/Face ID) |
| `hasResidentKey` | `true` | Supports discoverable credentials (passkeys) |
| `hasUserVerification` | `true` | Authenticator can verify user identity |
| `isUserVerified` | `true` | Auto-passes user verification (no prompt) |
| `automaticPresenceSimulation` | `true` | Auto-responds to presence checks (no manual trigger needed) |

## Registration Flow

Once the virtual authenticator is active, `navigator.credentials.create()` calls are handled automatically:

```js
// Navigate to register page
await page.goto('http://localhost:5173/register.html');

// Fill in username
await page.getByRole('textbox', { name: 'Enter username' }).fill('testuser');

// Click register - the virtual authenticator handles the WebAuthn prompt
await page.getByRole('button', { name: 'Register' }).click();

// Wait for result
await page.waitForSelector('.approval-code');
```

## Login Flow

Similarly, `navigator.credentials.get()` calls are handled automatically:

```js
await page.goto('http://localhost:5173/login.html');

// Click sign in - virtual authenticator presents stored credential
await page.getByRole('button', { name: 'Sign In' }).click();
```

Note: The credential created during registration is stored in the virtual authenticator for the duration of the session. Login will use that credential automatically.

## Inspecting Credentials

You can check what credentials the virtual authenticator has stored:

```js
const { credentials } = await client.send('WebAuthn.getCredentials', {
  authenticatorId,
});
console.log(`Stored credentials: ${credentials.length}`);
// Each credential has: credentialId, rpId, privateKey, signCount, userHandle
```

## Cleanup

Remove the virtual authenticator when done:

```js
await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
await client.send('WebAuthn.disable');
```

## Limitations

- **Chromium only**: CDP virtual authenticators are not supported in Firefox or WebKit
- **Session-scoped**: The virtual authenticator and its credentials only exist for the browser session
- **No cross-origin**: The authenticator is bound to the RP ID (origin) used during registration

## Playwright MCP Usage

When using the Playwright MCP server (e.g. from Claude Code), set up the authenticator with `browser_run_code`:

```js
// browser_run_code
async (page) => {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
};
```

Then use normal `browser_navigate`, `browser_type`, and `browser_click` tools to interact with the pages. The virtual authenticator handles all WebAuthn prompts transparently.
